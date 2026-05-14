import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SubdomainProxyManager } from "../../subdomain-proxy/manager"

interface RouteDeps {
  subdomainProxyManager: SubdomainProxyManager
}

const SubdomainCreateSchema = z.object({
  subdomain: z.string().trim().min(1).max(63).optional(),
  targetPort: z.number().int().min(1).max(65535),
  targetHost: z.string().trim().optional(),
  name: z.string().trim().optional(),
})

const SubdomainUpdateSchema = z.object({
  targetPort: z.number().int().min(1).max(65535).optional(),
  targetHost: z.string().trim().optional(),
  name: z.string().trim().optional(),
})

export function registerSubdomainProxyRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/subdomain-proxies", async () => {
    const mappings = deps.subdomainProxyManager.list()
    return mappings.map((m) => ({
      ...m,
      fullUrl: deps.subdomainProxyManager.getFullUrl(m.subdomain),
    }))
  })

  app.post("/api/subdomain-proxies", async (request, reply) => {
    try {
      const body = SubdomainCreateSchema.parse(request.body ?? {})
      const mapping = await deps.subdomainProxyManager.create(body)
      reply.code(201)
      return { ...mapping, fullUrl: deps.subdomainProxyManager.getFullUrl(mapping.subdomain) }
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to create mapping" }
    }
  })

  app.put<{ Params: { subdomain: string } }>("/api/subdomain-proxies/:subdomain", async (request, reply) => {
    try {
      const body = SubdomainUpdateSchema.parse(request.body ?? {})
      const mapping = deps.subdomainProxyManager.update(request.params.subdomain, body)
      return { ...mapping, fullUrl: deps.subdomainProxyManager.getFullUrl(mapping.subdomain) }
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to update mapping" }
    }
  })

  app.delete<{ Params: { subdomain: string } }>("/api/subdomain-proxies/:subdomain", async (request, reply) => {
    const removed = await deps.subdomainProxyManager.delete(request.params.subdomain)
    if (!removed) {
      reply.code(404)
      return { error: "Mapping not found" }
    }
    reply.code(204)
  })

  app.get("/api/subdomain-proxies/:subdomain/check", async (request) => {
    const params = request.params as { subdomain: string }
    const mapping = deps.subdomainProxyManager.get(params.subdomain)
    if (!mapping) {
      return { available: false }
    }
    const available = await deps.subdomainProxyManager.checkPort(mapping.targetPort, mapping.targetHost)
    return { available, targetPort: mapping.targetPort, targetHost: mapping.targetHost }
  })
}
