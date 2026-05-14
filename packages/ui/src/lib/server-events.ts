import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getClientIdentity } from "./client-identity"
import { getLogger } from "./logger"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
const STALE_THRESHOLD_MS = 30_000
const HEALTH_CHECK_INTERVAL_MS = 15_000
const log = getLogger("sse")

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    log.info(message, context)
    return
  }
  log.info(message)
}

class ServerEvents {
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: WorkspaceEventPayload) => void>>()
  private openHandlers = new Set<() => void>()
  private source: EventSource | null = null
  private retryDelay = RETRY_BASE_DELAY
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnecting = false
  private lastEventTime = 0
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.connect()
  }

  private connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnecting = false
    if (this.source) {
      this.source.close()
    }
    logSse("Connecting to backend events stream")
    this.source = serverApi.connectEvents(
      (event) => this.dispatch(event),
      () => this.scheduleReconnect(),
      (payload) => {
        void serverApi
          .sendClientConnectionPong({
            ...getClientIdentity(),
            pingTs: payload.ts,
          })
          .catch((error) => {
            log.error("Failed to send client connection pong", error)
          })
      },
    )
    this.source.onopen = () => {
      logSse("Events stream connected")
      this.retryDelay = RETRY_BASE_DELAY
      this.reconnecting = false
      this.lastEventTime = Date.now()
      this.startHealthCheck()
      this.openHandlers.forEach((handler) => handler())
    }
  }

  private scheduleReconnect() {
    if (this.reconnecting) return
    this.reconnecting = true
    this.stopHealthCheck()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    if (this.source) {
      this.source.close()
      this.source = null
    }
    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      this.connect()
    }, this.retryDelay)
  }

  private dispatch(event: WorkspaceEventPayload) {
    logSse(`event ${event.type}`)
    this.lastEventTime = Date.now()
    this.handlers.get("*")?.forEach((handler) => handler(event))
    this.handlers.get(event.type)?.forEach((handler) => handler(event))
  }

  on(type: WorkspaceEventType | "*", handler: (event: WorkspaceEventPayload) => void): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    const bucket = this.handlers.get(type)!
    bucket.add(handler)
    return () => bucket.delete(handler)
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler)
    return () => this.openHandlers.delete(handler)
  }

  private startHealthCheck() {
    this.stopHealthCheck()
    this.healthCheckTimer = setInterval(() => {
      if (this.lastEventTime > 0 && Date.now() - this.lastEventTime > STALE_THRESHOLD_MS) {
        logSse("No events received for 30s, forcing reconnect")
        this.scheduleReconnect()
      }
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private stopHealthCheck() {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }
}

export const serverEvents = new ServerEvents()
