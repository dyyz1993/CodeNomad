import crypto from "crypto"

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000

export interface SessionInfo {
  id: string
  createdAt: number
  username: string
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()
  private cleanupTimer?: ReturnType<typeof setInterval>

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS)
  }

  createSession(username: string): SessionInfo {
    const id = crypto.randomBytes(32).toString("base64url")
    const info: SessionInfo = { id, createdAt: Date.now(), username }
    this.sessions.set(id, info)
    return info
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    return this.sessions.get(id)
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
    for (const [id, info] of this.sessions) {
      if (now - info.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(id)
      }
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
