import { connect } from "net"
import type { Logger } from "../logger"
import type { ProcessExitInfo } from "./runtime"

const STARTUP_STABILITY_DELAY_MS = 300
const HEALTH_PROBE_MAX_ATTEMPTS = 5
const HEALTH_PROBE_RETRY_DELAY_MS = 500

export function delay(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

export function describeExit(info: ProcessExitInfo): string {
  if (info.signal) {
    return `signal ${info.signal}`
  }
  if (info.code !== null) {
    return `code ${info.code}`
  }
  return "unknown reason"
}

export function buildStartupError(
  workspaceId: string,
  phase: string,
  exitInfo: ProcessExitInfo,
  lastOutput: string,
): Error {
  const exitDetails = describeExit(exitInfo)
  const trimmedOutput = lastOutput.trim()
  const outputDetails = trimmedOutput ? ` Last output: ${trimmedOutput}` : ""
  return new Error(`Workspace ${workspaceId} ${phase} (${exitDetails}).${outputDetails}`)
}

export function waitForPortAvailability(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let settled = false
    let retryTimer: NodeJS.Timeout | null = null

    const cleanup = () => {
      settled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const tryConnect = () => {
      if (settled) {
        return
      }
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        cleanup()
        socket.end()
        resolve()
      })
      socket.once("error", () => {
        socket.destroy()
        if (settled) {
          return
        }
        if (Date.now() >= deadline) {
          cleanup()
          reject(new Error(`Workspace port ${port} did not become ready within ${timeoutMs}ms`))
        } else {
          retryTimer = setTimeout(() => {
            retryTimer = null
            tryConnect()
          }, 100)
        }
      })
    }

    tryConnect()
  })
}

export async function probeInstance(
  workspaceId: string,
  port: number,
  authMap: Map<string, { authorization: string }>,
  logger: Logger,
): Promise<{ ok: boolean; reason?: string; version?: string }> {
  const url = `http://127.0.0.1:${port}/global/health`

  try {
    const headers: Record<string, string> = {}
    const authHeader = authMap.get(workspaceId)?.authorization
    if (authHeader) {
      headers["Authorization"] = authHeader
    }

    const response = await fetch(url, { headers })
    if (!response.ok) {
      const reason = `/global/health returned HTTP ${response.status}`
      logger.debug({ workspaceId, status: response.status }, "Health probe returned server error")
      return { ok: false, reason }
    }

    const payload = (await response.json().catch(() => null)) as null | { healthy?: unknown; version?: unknown }
    const healthy = payload?.healthy === true
    const version = typeof payload?.version === "string" ? payload.version.trim() : undefined

    if (!healthy) {
      const reason = "Instance reported unhealthy"
      logger.debug({ workspaceId, payload }, "Health probe returned unhealthy response")
      return { ok: false, reason }
    }

    return { ok: true, version: version || undefined }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.debug({ workspaceId, err: error }, "Health probe failed")
    return { ok: false, reason }
  }
}

export async function waitForInstanceHealth(params: {
  workspaceId: string
  port: number
  exitPromise: Promise<ProcessExitInfo>
  getLastOutput: () => string
  authMap: Map<string, { authorization: string }>
  logger: Logger
}): Promise<string | undefined> {
  let lastReason = "Health check failed"

  for (let attempt = 1; attempt <= HEALTH_PROBE_MAX_ATTEMPTS; attempt++) {
    const probeResult = await Promise.race([
      probeInstance(params.workspaceId, params.port, params.authMap, params.logger),
      params.exitPromise.then((info) => {
        throw buildStartupError(
          params.workspaceId,
          "exited during health checks",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    if (probeResult.ok) {
      return probeResult.version
    }

    lastReason = probeResult.reason ?? lastReason
    params.logger.debug(
      { workspaceId: params.workspaceId, attempt, maxAttempts: HEALTH_PROBE_MAX_ATTEMPTS, reason: lastReason },
      "Health probe attempt failed, will retry",
    )

    if (attempt < HEALTH_PROBE_MAX_ATTEMPTS) {
      await Promise.race([
        delay(HEALTH_PROBE_RETRY_DELAY_MS),
        params.exitPromise.then((info) => {
          throw buildStartupError(
            params.workspaceId,
            "exited during health checks",
            info,
            params.getLastOutput(),
          )
        }),
      ])
    }
  }

  const latestOutput = params.getLastOutput().trim()
  const outputContext = latestOutput ? ` Last output: ${latestOutput}` : ""
  throw new Error(
    `Workspace ${params.workspaceId} failed health check after ${HEALTH_PROBE_MAX_ATTEMPTS} attempts: ${lastReason}.${outputContext}`,
  )
}

export async function waitForWorkspaceReadiness(params: {
  workspaceId: string
  port: number
  exitPromise: Promise<ProcessExitInfo>
  getLastOutput: () => string
  authMap: Map<string, { authorization: string }>
  logger: Logger
}): Promise<string | undefined> {
  await Promise.race([
    waitForPortAvailability(params.port),
    params.exitPromise.then((info) => {
      throw buildStartupError(
        params.workspaceId,
        "exited before becoming ready",
        info,
        params.getLastOutput(),
      )
    }),
  ])

  const version = await waitForInstanceHealth(params)

  await Promise.race([
    delay(STARTUP_STABILITY_DELAY_MS),
    params.exitPromise.then((info) => {
      throw buildStartupError(
        params.workspaceId,
        "exited shortly after start",
        info,
        params.getLastOutput(),
      )
    }),
  ])

  return version
}
