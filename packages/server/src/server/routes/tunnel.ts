import { FastifyInstance } from "fastify"
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
}
