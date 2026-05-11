import { access, mkdir, readFile, stat, writeFile, rename } from "node:fs/promises"
import { constants } from "node:fs"
import path from "path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { Logger } from "../logger"
import { applyMergePatch, isPlainObject } from "./merge-patch"

export type SettingsDoc = Record<string, unknown>

function ensureTrailingNewline(content: string): string {
  if (!content) return "\n"
  return content.endsWith("\n") ? content : `${content}\n`
}

function normalizeDoc(input: unknown): SettingsDoc {
  if (!isPlainObject(input)) {
    return {}
  }
  return input
}

export class YamlDocStore {
  private cache: SettingsDoc = {}
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  getSync(): SettingsDoc | undefined {
    if (this.loaded) return this.cache
    return undefined
  }

  async load(): Promise<SettingsDoc> {
    if (this.loaded) {
      return this.cache
    }

    try {
      try {
        await access(this.filePath, constants.F_OK)
      } catch {
        this.cache = {}
        this.loaded = true
        return this.cache
      }

      const content = await readFile(this.filePath, "utf-8")
      const parsed = parseYaml(content)
      this.cache = normalizeDoc(parsed)
      this.loaded = true
      return this.cache
    } catch (error) {
      this.logger.warn({ err: error, filePath: this.filePath }, "Failed to read YAML doc; using empty object")
      this.cache = {}
      this.loaded = true
      return this.cache
    }
  }

  async get(): Promise<SettingsDoc> {
    return this.load()
  }

  async replace(next: unknown): Promise<SettingsDoc> {
    const normalized = normalizeDoc(next)
    this.cache = normalized
    this.loaded = true
    await this.persist()
    return this.cache
  }

  async mergePatch(patch: unknown): Promise<SettingsDoc> {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const current = await this.get()
    const next = applyMergePatch(current, patch)
    return this.replace(next)
  }

  async getOwner(owner: string): Promise<SettingsDoc> {
    const doc = await this.get()
    const value = (doc as any)?.[owner]
    return normalizeDoc(value)
  }

  async replaceOwner(owner: string, value: unknown): Promise<SettingsDoc> {
    const doc = await this.get()
    const nextDoc: SettingsDoc = { ...doc, [owner]: normalizeDoc(value) }
    await this.replace(nextDoc)
    return nextDoc[owner] as SettingsDoc
  }

  async mergePatchOwner(owner: string, patch: unknown): Promise<SettingsDoc> {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const doc = await this.get()
    const currentOwner = normalizeDoc((doc as any)?.[owner])
    const nextOwner = normalizeDoc(applyMergePatch(currentOwner, patch))
    const nextDoc: SettingsDoc = { ...doc, [owner]: nextOwner }
    await this.replace(nextDoc)
    return nextOwner
  }

  private async persist() {
    try {
      const dir = path.dirname(this.filePath)
      await mkdir(dir, { recursive: true })
      const yaml = stringifyYaml(this.cache as any)
      const tmpPath = this.filePath + ".tmp"
      await writeFile(tmpPath, ensureTrailingNewline(yaml), "utf-8")
      await rename(tmpPath, this.filePath)
    } catch (error) {
      this.logger.warn({ err: error, filePath: this.filePath }, "Failed to persist YAML doc")
    }
  }
}
