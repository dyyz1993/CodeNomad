import type { SettingsService } from "./service"

export interface OpenCodeBinaryEntry {
  path: string
  version?: string
  lastUsed?: number
  label?: string
}

export interface ResolvedBinary {
  path: string
  label: string
  version?: string
}

function prettyLabel(p: string): string {
  const parts = p.split(/[\\/]/)
  const last = parts[parts.length - 1] || p
  return last || p
}

function readUiBinariesSync(settings: SettingsService): OpenCodeBinaryEntry[] {
  const ui = settings.getOwnerSync("state", "ui")
  const list = (ui as any)?.opencodeBinaries
  if (!Array.isArray(list)) return []
  return list.filter((item) => item && typeof item === "object" && typeof (item as any).path === "string") as any
}

function readDefaultBinaryPathSync(settings: SettingsService): string | undefined {
  const server = settings.getOwnerSync("config", "server")
  const value = (server as any)?.opencodeBinary
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

async function readUiBinaries(settings: SettingsService): Promise<OpenCodeBinaryEntry[]> {
  const ui = await settings.getOwner("state", "ui")
  const list = (ui as any)?.opencodeBinaries
  if (!Array.isArray(list)) return []
  return list.filter((item) => item && typeof item === "object" && typeof (item as any).path === "string") as any
}

async function readDefaultBinaryPath(settings: SettingsService): Promise<string | undefined> {
  const server = await settings.getOwner("config", "server")
  const value = (server as any)?.opencodeBinary
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export class BinaryResolver {
  constructor(private readonly settings: SettingsService) {}

  async list(): Promise<OpenCodeBinaryEntry[]> {
    return readUiBinariesSync(this.settings) ?? readUiBinaries(this.settings)
  }

  async resolveDefault(): Promise<ResolvedBinary> {
    const binaries = readUiBinariesSync(this.settings) ?? (await readUiBinaries(this.settings))
    const configuredDefault = readDefaultBinaryPathSync(this.settings) ?? (await readDefaultBinaryPath(this.settings))
    const fallback = binaries[0]?.path
    const path = configuredDefault ?? fallback ?? "opencode"

    const entry = binaries.find((b) => b.path === path)
    return {
      path,
      label: entry?.label ?? prettyLabel(path),
      version: entry?.version,
    }
  }
}
