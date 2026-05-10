import { fetch } from "undici"
import WebSocket from "ws"
import type { Logger } from "../logger"
import type {
  TunnelConfig,
  TunnelInfo,
  LocalUrlMatch,
  RelayRequest,
  RelayResponse,
} from "./types"
import { detectLocalUrls, replaceLocalUrls } from "./url-detector"

interface ActiveTunnel {
  info: TunnelInfo
  ws: WebSocket | null
  pendingRequests: Map<
    string,
    {
      resolve: (response: RelayResponse) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
}

export class TunnelClient {
  private readonly tunnels = new Map<string, ActiveTunnel>()
  private readonly config: TunnelConfig
  private readonly logger: Logger

  constructor(config: TunnelConfig, logger: Logger) {
    this.config = config
    this.logger = logger.child({ component: "tunnel-client" })
  }

  get enabled(): boolean {
    return this.config.enabled && !!this.config.hubUrl
  }

  processMessage(text: string): string {
    if (!this.enabled) return text

    const localUrls = detectLocalUrls(text)
    if (localUrls.length === 0) return text

    const replacements = new Map<string, string>()

    for (const match of localUrls) {
      const key = `${match.host}:${match.port}`
      const tunnel = this.tunnels.get(key)

      if (!tunnel) {
        continue
      }

      if (tunnel.info.status === "connected") {
        const publicUrl = `${tunnel.info.publicUrl}${match.path}`
        replacements.set(match.fullUrl, publicUrl)
      }
    }

    if (replacements.size === 0) return text

    return replaceLocalUrls(text, replacements)
  }

  getUntunneledUrls(text: string): LocalUrlMatch[] {
    if (!this.enabled) return []

    const localUrls = detectLocalUrls(text)
    return localUrls.filter((match) => {
      const key = `${match.host}:${match.port}`
      return !this.tunnels.has(key)
    })
  }

  async createTunnel(
    targetHost: string,
    targetPort: number,
    name?: string,
  ): Promise<TunnelInfo> {
    const key = `${targetHost}:${targetPort}`
    const existing = this.tunnels.get(key)
    if (existing) return existing.info

    if (!this.enabled) throw new Error("Tunnel client is not enabled")

    const apiUrl = `${this.config.hubUrl.replace(/\/+$/, "")}/api/tunnels`

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name || `${targetHost}-${targetPort}`,
        targetHost,
        targetPort,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error")
      throw new Error(
        `Failed to create tunnel: ${response.status} ${errorText}`,
      )
    }

    const data = (await response.json()) as any
    const info: TunnelInfo = {
      id: data.id,
      subdomain: data.subdomain,
      publicUrl: data.publicUrl,
      relayUrl: data.relayUrl,
      targetHost,
      targetPort,
      name: name || `${targetHost}-${targetPort}`,
      status: "waiting",
      createdAt: Date.now(),
      requests: 0,
      bytesIn: 0,
      bytesOut: 0,
    }

    const tunnel: ActiveTunnel = {
      info,
      ws: null,
      pendingRequests: new Map(),
    }
    this.tunnels.set(key, tunnel)

    await this.connectRelay(key, tunnel)

    return info
  }

  private connectRelay(key: string, tunnel: ActiveTunnel): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const relayUrl = tunnel.info.relayUrl
        const ws = new WebSocket(relayUrl)

        ws.on("open", () => {
          tunnel.info.status = "connected"
          tunnel.ws = ws
          this.logger.info(
            { tunnel: tunnel.info.id, subdomain: tunnel.info.subdomain },
            "Tunnel relay connected",
          )
          resolve()
        })

        ws.on("message", (data: WebSocket.Data) => {
          this.handleRelayMessage(key, tunnel, data)
        })

        ws.on("close", () => {
          tunnel.info.status = "disconnected"
          tunnel.ws = null
          this.logger.info({ tunnel: tunnel.info.id }, "Tunnel relay disconnected")

          setTimeout(() => {
            if (this.tunnels.has(key) && !tunnel.ws) {
              this.connectRelay(key, tunnel).catch((err) => {
                this.logger.warn({ err, key }, "Tunnel relay reconnect failed")
              })
            }
          }, 5000)
        })

        ws.on("error", (err) => {
          this.logger.error({ err, tunnel: tunnel.info.id }, "Tunnel relay error")
          if (tunnel.info.status === "waiting") {
            reject(err)
          }
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  private async handleRelayMessage(
    key: string,
    tunnel: ActiveTunnel,
    data: WebSocket.Data,
  ) {
    let msg: RelayRequest
    try {
      msg = JSON.parse(data.toString())
    } catch {
      this.logger.warn({ tunnel: tunnel.info.id }, "Invalid relay message")
      return
    }

    if (msg.type !== "request") return

    const requestId = msg.id
    tunnel.info.requests++

    try {
      const targetUrl = `http://${tunnel.info.targetHost}:${tunnel.info.targetPort}${msg.path}${msg.query ? "?" + msg.query : ""}`

      const fetchHeaders: Record<string, string> = { ...msg.headers }
      delete fetchHeaders["host"]
      delete fetchHeaders["Host"]

      const response = await fetch(targetUrl, {
        method: msg.method,
        headers: fetchHeaders,
        body: msg.body || undefined,
      })

      const contentType = response.headers.get("content-type") || ""
      const isBinary =
        !contentType.startsWith("text/") &&
        !contentType.includes("json") &&
        !contentType.includes("xml") &&
        !contentType.includes("javascript")

      let relayResponse: RelayResponse

      if (isBinary) {
        const buffer = await response.arrayBuffer()
        relayResponse = {
          type: "response",
          id: requestId,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          bodyBase64: Buffer.from(buffer).toString("base64"),
        }
        tunnel.info.bytesOut += buffer.byteLength
      } else {
        const body = await response.text()
        relayResponse = {
          type: "response",
          id: requestId,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        }
        tunnel.info.bytesOut += body.length
      }

      if (tunnel.ws?.readyState === WebSocket.OPEN) {
        tunnel.ws.send(JSON.stringify(relayResponse))
      }
    } catch (err) {
      const errorResponse: RelayResponse = {
        type: "response",
        id: requestId,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `Local service error: ${(err as Error).message}`,
      }
      if (tunnel.ws?.readyState === WebSocket.OPEN) {
        tunnel.ws.send(JSON.stringify(errorResponse))
      }
    }
  }

  async deleteTunnel(
    targetHost: string,
    targetPort: number,
  ): Promise<void> {
    const key = `${targetHost}:${targetPort}`
    const tunnel = this.tunnels.get(key)
    if (!tunnel) return

    if (tunnel.ws) {
      tunnel.ws.close()
    }

    try {
      const apiUrl = `${this.config.hubUrl.replace(/\/+$/, "")}/api/tunnels/${tunnel.info.id}`
      await fetch(apiUrl, { method: "DELETE" })
    } catch (err) {
      this.logger.warn(
        { err, tunnel: tunnel.info.id },
        "Failed to delete tunnel on hub",
      )
    }

    for (const [, pending] of tunnel.pendingRequests) {
      clearTimeout(pending.timer)
    }

    this.tunnels.delete(key)
  }

  listTunnels(): TunnelInfo[] {
    return Array.from(this.tunnels.values()).map((t) => ({ ...t.info }))
  }

  getTunnel(
    targetHost: string,
    targetPort: number,
  ): TunnelInfo | undefined {
    return this.tunnels.get(`${targetHost}:${targetPort}`)?.info
  }

  async dispose(): Promise<void> {
    const keys = Array.from(this.tunnels.keys())
    await Promise.allSettled(
      keys.map((key) => {
        const tunnel = this.tunnels.get(key)!
        tunnel.ws?.close()
        const apiUrl = `${this.config.hubUrl.replace(/\/+$/, "")}/api/tunnels/${tunnel.info.id}`
        return fetch(apiUrl, { method: "DELETE" }).catch(() => {})
      }),
    )
    this.tunnels.clear()
  }
}
