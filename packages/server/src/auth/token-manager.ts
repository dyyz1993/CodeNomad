import crypto from "crypto"

export interface BootstrapToken {
  token: string
  createdAt: number
  consumed: boolean
}

export class TokenManager {
  private token: BootstrapToken | null = null

  constructor(private readonly ttlMs: number) {}

  generate(): string {
    const token = crypto.randomBytes(32).toString("base64url")
    this.token = { token, createdAt: Date.now(), consumed: false }
    return token
  }

  consume(token: string): boolean {
    if (!this.token) return false
    if (this.token.consumed) return false
    if (Date.now() - this.token.createdAt > this.ttlMs) return false
    const a = Buffer.from(token)
    const b = Buffer.from(this.token.token)
    if (a.length !== b.length) return false
    if (!crypto.timingSafeEqual(a, b)) return false
    this.token.consumed = true
    return true
  }

  peek(): string | null {
    return this.token?.token ?? null
  }
}
