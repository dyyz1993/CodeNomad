import crypto from "crypto"
import os from "os"
import path from "path"
import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { Logger } from "../logger"

const SESSION_TTL_MS = 315360000 * 1000 // 10 years in ms
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000

export interface SessionInfo {
  id: string
  createdAt: number
  username: string
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()
  private cleanupTimer?: ReturnType<typeof setInterval>
  private readonly stateFilePath: string
  private readonly logger: Logger

  constructor(configDir?: string, logger?: Logger) {
    this.stateFilePath = path.join(
      configDir ?? path.join(os.homedir(), ".config", "codenomad"),
      "sessions-state.json",
    )
    this.logger = logger ?? { warn: (...args: any[]) => console.warn("[session-manager]", ...args) } as any
    void this.loadState()
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS)
  }

  createSession(username: string): SessionInfo {
    const id = crypto.randomBytes(32).toString("base64url")
    const info: SessionInfo = { id, createdAt: Date.now(), username }
    this.sessions.set(id, info)
    void this.saveState()
    return info
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    const info = this.sessions.get(id)
    if (!info) return undefined
    if (Date.now() - info.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(id)
      return undefined
    }
    return info
  }

  validateSession(sessionId: string): SessionInfo | null {
    const info = this.sessions.get(sessionId)
    if (!info) return null
    if (Date.now() - info.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(sessionId)
      return null
    }
    return info
  }

  private cleanupExpired(): void {
    const now = Date.now()
    let changed = false
    for (const [id, info] of this.sessions) {
      if (now - info.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(id)
        changed = true
      }
    }
    if (changed) {
      void this.saveState()
    }
  }

  private async saveState(): Promise<void> {
    const data = Array.from(this.sessions.entries()).map(([id, info]) => ({
      id,
      username: info.username,
      createdAt: info.createdAt,
    }))
    try {
      await mkdir(path.dirname(this.stateFilePath), { recursive: true })
      const tmpPath = this.stateFilePath + ".tmp"
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8")
      await rename(tmpPath, this.stateFilePath)
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to save session state")
    }
  }

  private async loadState(): Promise<void> {
    try {
      if (!existsSync(this.stateFilePath)) return
      const content = await readFile(this.stateFilePath, "utf-8")
      const entries = JSON.parse(content) as Array<{
        id: string
        username: string
        createdAt: number
      }>
      for (const entry of entries) {
        this.sessions.set(entry.id, {
          id: entry.id,
          username: entry.username,
          createdAt: entry.createdAt,
        })
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load session state")
    }
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    this.sessions.clear()
  }
}
