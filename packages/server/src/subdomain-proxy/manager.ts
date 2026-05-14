import { connect } from "net"
import type { Logger } from "pino"
import type { SettingsService } from "../settings/service"

interface SubdomainMapping {
  id: string
  subdomain: string
  targetPort: number
  targetHost: string
  name: string
  fullUrl?: string
  createdAt: string
  updatedAt: string
}

interface SubdomainProxyOptions {
  settings: SettingsService
  baseDomain: string
  externalPort?: number
  logger: Logger
  shanboxApiUrl?: string
}

export class SubdomainProxyManager {
  private readonly mappings = new Map<string, SubdomainMapping>()
  private readonly logger: Logger

  constructor(private readonly options: SubdomainProxyOptions) {
    this.logger = options.logger.child({ component: "subdomain-proxy" })
    for (const record of this.loadFromSettings()) {
      this.mappings.set(record.subdomain.toLowerCase(), record)
    }
    this.logger.info({ count: this.mappings.size, baseDomain: options.baseDomain }, "Subdomain proxy manager initialized")
  }

  get baseDomain(): string {
    return this.options.baseDomain
  }

  list(): SubdomainMapping[] {
    return Array.from(this.mappings.values())
  }

  get(subdomain: string): SubdomainMapping | undefined {
    return this.mappings.get(subdomain.toLowerCase())
  }

  getByHost(host: string): SubdomainMapping | undefined {
    const normalized = host.split(":")[0]?.toLowerCase()
    if (!normalized) return undefined

    const direct = this.mappings.get(normalized)
    if (direct) return direct

    const domain = this.options.baseDomain.toLowerCase()
    if (normalized.endsWith(`.${domain}`)) {
      const sub = normalized.slice(0, -(domain.length + 1))
      return this.mappings.get(sub)
    }

    return undefined
  }

  resolveTargetUrl(mapping: SubdomainMapping, requestPath: string, search: string): string {
    const protocol = mapping.targetHost === "127.0.0.1" ? "http" : "http"
    const path = requestPath || "/"
    return `${protocol}://${mapping.targetHost}:${mapping.targetPort}${path}${search}`
  }

  async create(input: {
    subdomain?: string
    targetPort: number
    targetHost?: string
    name?: string
  }): Promise<SubdomainMapping> {
    const targetHost = input.targetHost ?? "127.0.0.1"
    const address = `${targetHost}:${input.targetPort}`

    let subdomain: string
    let fullUrl: string | undefined
    if (this.options.shanboxApiUrl) {
      try {
        this.logger.info({ address, shanboxApiUrl: this.options.shanboxApiUrl }, "Registering with Shanbox")
        const response = await fetch(`${this.options.shanboxApiUrl}/__api__/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address }),
        })
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Shanbox API error: ${response.status} ${text}`)
        }
        const result = await response.json() as { subdomain: string; url?: string }
        subdomain = result.subdomain
        fullUrl = result.url
        this.logger.info({ subdomain, address, fullUrl }, "Shanbox registration successful")
      } catch (error) {
        this.logger.error({ err: error }, "Failed to register with Shanbox")
        throw new Error(`Failed to register with Shanbox: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      subdomain = input.subdomain?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-|-$/g, "") ?? ""
      if (!subdomain || subdomain.length < 1) {
        throw new Error("Subdomain must contain at least one alphanumeric character")
      }
      if (subdomain.length > 63) {
        throw new Error("Subdomain too long (max 63 characters)")
      }
    }

    if (this.mappings.has(subdomain!)) {
      throw new Error(`Subdomain '${subdomain}' already registered`)
    }

    const now = new Date().toISOString()
    const mapping: SubdomainMapping = {
      id: subdomain!,
      subdomain: subdomain!,
      targetPort: input.targetPort,
      targetHost,
      name: input.name ?? subdomain!,
      fullUrl,
      createdAt: now,
      updatedAt: now,
    }

    this.mappings.set(subdomain!, mapping)
    this.persist()
    return mapping
  }

  update(subdomain: string, input: {
    targetPort?: number
    targetHost?: string
    name?: string
  }): SubdomainMapping {
    const mapping = this.mappings.get(subdomain.toLowerCase())
    if (!mapping) throw new Error(`Subdomain '${subdomain}' not found`)

    if (input.targetPort !== undefined) mapping.targetPort = input.targetPort
    if (input.targetHost !== undefined) mapping.targetHost = input.targetHost
    if (input.name !== undefined) mapping.name = input.name
    mapping.updatedAt = new Date().toISOString()

    this.persist()
    return mapping
  }

  async delete(subdomain: string): Promise<boolean> {
    const normalized = subdomain.toLowerCase()
    const mapping = this.mappings.get(normalized)
    const removed = this.mappings.delete(normalized)
    if (removed) {
      if (this.options.shanboxApiUrl && mapping) {
        try {
          await fetch(`${this.options.shanboxApiUrl}/__api__/routes/${normalized}`, {
            method: "DELETE",
          })
          this.logger.info({ subdomain: normalized }, "Shanbox route deleted")
        } catch (error) {
          this.logger.warn({ err: error, subdomain: normalized }, "Failed to delete Shanbox route")
        }
      }
      this.persist()
      this.logger.info({ subdomain: normalized }, "Subdomain mapping deleted")
    }
    return removed
  }

  async checkPort(port: number, host = "127.0.0.1"): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ port, host }, () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  getFullUrl(subdomain: string, protocol = "https"): string {
    const mapping = this.mappings.get(subdomain.toLowerCase())
    if (mapping?.fullUrl) return mapping.fullUrl
    const port = this.options.externalPort
    const portSuffix = port && port !== 80 && port !== 443 ? `:${port}` : ""
    return `${protocol}://${subdomain}.${this.options.baseDomain}${portSuffix}`
  }

  private persist(): void {
    const data = Array.from(this.mappings.values()).map((m) => ({ ...m }))
    this.options.settings.mergePatchOwner("config", "server", { subdomainProxies: data })
  }

  private loadFromSettings(): SubdomainMapping[] {
    const serverConfig = this.options.settings.getOwner("config", "server") as { subdomainProxies?: unknown }
    const list = Array.isArray(serverConfig?.subdomainProxies) ? serverConfig.subdomainProxies : []
    const records: SubdomainMapping[] = []
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const r = item as Record<string, unknown>
      const subdomain = typeof r.subdomain === "string" ? r.subdomain.trim().toLowerCase() : null
      const targetPort = typeof r.targetPort === "number" ? r.targetPort : null
      if (!subdomain || !targetPort) continue

      records.push({
        id: subdomain,
        subdomain,
        targetPort,
        targetHost: typeof r.targetHost === "string" ? r.targetHost : "127.0.0.1",
        name: typeof r.name === "string" ? r.name : subdomain,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
        updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
      })
    }
    return records
  }

  dispose(): void {
    this.mappings.clear()
  }
}

export type { SubdomainMapping }
