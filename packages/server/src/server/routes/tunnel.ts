import { FastifyInstance } from "fastify"
import { fetch } from "undici"
import type { TunnelClient } from "../../tunnel/tunnel-client"

interface RouteDeps {
  tunnelClient: TunnelClient
}

export function registerTunnelRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/tunnels", async () => {
    return { tunnels: deps.tunnelClient.listTunnels() }
  })

  app.post<{
    Body: { targetHost: string; targetPort: number; name?: string }
  }>("/api/tunnels", async (request, reply) => {
    const { targetHost, targetPort, name } = request.body ?? {}

    if (!targetHost || !targetPort) {
      reply
        .code(400)
        .send({ error: "targetHost and targetPort are required" })
      return
    }

    try {
      const tunnel = await deps.tunnelClient.createTunnel(
        targetHost,
        targetPort,
        name,
      )
      return tunnel
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message })
    }
  })

  app.delete<{
    Body: { targetHost: string; targetPort: number }
  }>("/api/tunnels", async (request, reply) => {
    const { targetHost, targetPort } = request.body ?? {}

    if (!targetHost || !targetPort) {
      reply
        .code(400)
        .send({ error: "targetHost and targetPort are required" })
      return
    }

    await deps.tunnelClient.deleteTunnel(targetHost, targetPort)
    return { status: "deleted" }
  })

  app.get("/api/tunnels/status", async () => {
    return {
      enabled: deps.tunnelClient.enabled,
      tunnelCount: deps.tunnelClient.listTunnels().length,
    }
  })

  app.post<{
    Body: { text: string }
  }>("/api/tunnels/detect", async (request) => {
    const { text } = request.body ?? {}
    if (!text) return { urls: [] }

    const urls = deps.tunnelClient.getUntunneledUrls(text)
    return { urls }
  })

  app.post<{
    Body: { hubUrl: string }
  }>("/api/tunnels/test-connection", async (request, reply) => {
    const { hubUrl } = request.body ?? {}

    if (!hubUrl) {
      reply.code(400).send({ error: "hubUrl is required" })
      return
    }

    try {
      const url = hubUrl.replace(/\/+$/, "")
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(5000),
      })

      if (response.ok) {
        const body = await response.json()
        return { connected: true, hubUrl, status: body }
      } else {
        return { connected: false, hubUrl, error: `HTTP ${response.status}` }
      }
    } catch (err) {
      return { connected: false, hubUrl, error: (err as Error).message }
    }
  })
}
