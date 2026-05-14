import { fetch } from "undici"
import type { Logger } from "pino"
import type { WorkspaceManager } from "./manager"
import os from "os"
import path from "path"
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"

interface AutoContinueConfig {
  enabled: boolean
  prompt: string
  cooldownMs: number
  maxTriggers: number
  confirmSeconds: number
  checklistRelativePath?: string  // Checklist path relative to workspace root
}

interface SessionAutoContinueState {
  config: AutoContinueConfig
  triggerCount: number
  lastTriggerAt: number
  confirmTimer: ReturnType<typeof setTimeout> | null
  idleCheckCount: number
  countdownRemaining: number
}

const DEFAULT_CONFIG: AutoContinueConfig = {
  enabled: false,
  prompt:
    "如果当前任务尚未完成，请继续执行。如果没有疑问，请继续。否则请用提问的形式询问用户。如果暂时不需要询问，请略过。",
  cooldownMs: 60_000,
  maxTriggers: 20,
  confirmSeconds: 5,
  checklistRelativePath: ".codenomad/{sessionId}-auto-continue-checklist.md",  // Default: per-session checklist
}

export class AutoContinueManager {
  private readonly sessions = new Map<string, SessionAutoContinueState>()
  private readonly logger: Logger
  private readonly stateFilePath: string
  private loadStatePromise: Promise<void> | null = null

  constructor(
    logger: Logger,
    private readonly workspaceManager: WorkspaceManager,
    configDir?: string,
  ) {
    this.logger = logger.child({ component: "auto-continue" })
    this.stateFilePath = path.join(
      configDir ?? path.join(os.homedir(), ".config", "codenomad"),
      "auto-continue-state.json",
    )
    this.loadStatePromise = this.loadState()
  }

  async ready(): Promise<void> {
    if (this.loadStatePromise) {
      await this.loadStatePromise
      this.loadStatePromise = null
    }
  }

  private key(workspaceId: string, sessionId: string): string {
    return `${workspaceId}:${sessionId}`
  }

  getConfig(workspaceId: string, sessionId: string): AutoContinueConfig {
    return this.sessions.get(this.key(workspaceId, sessionId))?.config ?? { ...DEFAULT_CONFIG }
  }

  getChecklistPath(workspaceId: string, sessionId: string, workspaceRoot: string): string {
    const config = this.sessions.get(this.key(workspaceId, sessionId))?.config ?? DEFAULT_CONFIG
    // Supports {sessionId} template variable
    const relativePath = config.checklistRelativePath ?? DEFAULT_CONFIG.checklistRelativePath ?? ".codenomad/{sessionId}-auto-continue-checklist.md"
    const resolved = relativePath.replace(/\{sessionId\}/g, sessionId)
    return path.resolve(workspaceRoot, resolved)
  }

  setConfig(workspaceId: string, sessionId: string, updates: Partial<AutoContinueConfig>): AutoContinueConfig {
    const k = this.key(workspaceId, sessionId)
    let state = this.sessions.get(k)
    if (!state) {
      state = {
        config: { ...DEFAULT_CONFIG },
        triggerCount: 0,
        lastTriggerAt: 0,
        confirmTimer: null,
        idleCheckCount: 0,
        countdownRemaining: 0,
      }
      this.sessions.set(k, state)
    }
    Object.assign(state.config, updates)
    void this.saveState()
    return state.config
  }

  private async saveState(): Promise<void> {
    const data = Array.from(this.sessions.entries()).map(([key, state]) => ({
      key,
      workspaceId: key.split(":")[0],
      sessionId: key.split(":")[1],
      config: state.config,
      triggerCount: state.triggerCount,
      lastTriggerAt: state.lastTriggerAt,
    }))
    try {
      await mkdir(path.dirname(this.stateFilePath), { recursive: true })
      const tmpPath = this.stateFilePath + ".tmp"
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8")
      await copyFile(tmpPath, this.stateFilePath)
      await unlink(tmpPath).catch(() => {})
    } catch (err) {
      this.logger.warn({ err }, "Failed to save auto-continue state")
    }
  }

  private async loadState(): Promise<void> {
    try {
      if (!existsSync(this.stateFilePath)) return
      const content = await readFile(this.stateFilePath, "utf-8")
      const entries = JSON.parse(content) as Array<{
        key: string
        workspaceId: string
        sessionId: string
        config: AutoContinueConfig
        triggerCount: number
        lastTriggerAt: number
      }>
      for (const entry of entries) {
        this.sessions.set(entry.key, {
          config: entry.config,
          triggerCount: entry.triggerCount,
          lastTriggerAt: entry.lastTriggerAt,
          confirmTimer: null,
          idleCheckCount: 0,
          countdownRemaining: 0,
        })
      }
      if (entries.length > 0) {
        this.logger.info({ count: entries.length }, "Restored auto-continue state from disk")
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to load auto-continue state")
    }
  }

  getState(workspaceId: string, sessionId: string): {
    config: AutoContinueConfig
    triggerCount: number
    lastTriggerAt: number
    countdownRemaining: number
  } | null {
    const state = this.sessions.get(this.key(workspaceId, sessionId))
    if (!state) return null
    return {
      config: { ...state.config },
      triggerCount: state.triggerCount,
      lastTriggerAt: state.lastTriggerAt,
      countdownRemaining: state.countdownRemaining,
    }
  }

  onSessionIdle(workspaceId: string, sessionId: string, isMainSession: boolean): void {
    this.logger.info({ workspaceId, sessionId, isMainSession }, "AutoContinue.onSessionIdle called")

    if (!isMainSession) {
      this.logger.debug({ workspaceId, sessionId }, "AutoContinue skipped: not main session")
      return
    }

    const k = this.key(workspaceId, sessionId)
    const state = this.sessions.get(k)

    this.logger.debug({
      workspaceId,
      sessionId,
      stateExists: !!state,
      enabled: state?.config.enabled,
      triggerCount: state?.triggerCount
    }, "AutoContinue state check")

    if (!state || !state.config.enabled) return

    state.idleCheckCount = 0

    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer)
    }

    this.logger.info({ workspaceId, sessionId }, "AutoContinue starting confirmation timer")
    this.startIdleConfirmation(workspaceId, sessionId, state)
  }

  onSessionBusy(workspaceId: string, sessionId: string): void {
    const k = this.key(workspaceId, sessionId)
    const state = this.sessions.get(k)
    if (!state) return

    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer)
      state.confirmTimer = null
    }
    state.idleCheckCount = 0
    state.countdownRemaining = 0
  }

  private startIdleConfirmation(
    workspaceId: string,
    sessionId: string,
    state: SessionAutoContinueState,
  ): void {
    const requiredChecks = state.config.confirmSeconds
    state.countdownRemaining = requiredChecks

    // 🐛 FIX: If cooldown hasn't expired, don't restart confirmation
    // Prevents repeated countdown restarts when onSessionIdle is called during cooldown period
    if (state.lastTriggerAt > 0) {
      const elapsed = Date.now() - state.lastTriggerAt
      if (elapsed < state.config.cooldownMs) {
        this.logger.debug({
          workspaceId,
          sessionId,
          elapsed,
          cooldownMs: state.config.cooldownMs,
        }, "AutoContinue: cooldown period not expired, skip restarting confirmation")
        return
      }
    }

    const check = () => {
      state.idleCheckCount++
      state.countdownRemaining = Math.max(0, requiredChecks - state.idleCheckCount)
      if (state.idleCheckCount >= requiredChecks) {
        state.countdownRemaining = 0
        this.triggerAutoContinue(workspaceId, sessionId, state)
      } else {
        state.confirmTimer = setTimeout(check, 1000)
      }
    }

    state.confirmTimer = setTimeout(check, 1000)
  }

  private async triggerAutoContinue(
    workspaceId: string,
    sessionId: string,
    state: SessionAutoContinueState,
  ): Promise<void> {
    state.confirmTimer = null

    const now = Date.now()
    if (now - state.lastTriggerAt < state.config.cooldownMs) {
      this.logger.debug({ workspaceId, sessionId }, "Auto-continue skipped: cooldown not met")
      return
    }

    if (state.triggerCount >= state.config.maxTriggers) {
      this.logger.info(
        { workspaceId, sessionId, count: state.triggerCount },
        "Auto-continue skipped: max triggers reached",
      )
      return
    }

    const port = this.workspaceManager.getInstancePort(workspaceId)
    if (!port) {
      this.logger.warn({ workspaceId }, "Auto-continue skipped: no instance port")
      return
    }

    const ws = this.workspaceManager.get(workspaceId)
    if (!ws) return

    const directory = ws.path
    const auth = this.workspaceManager.getInstanceAuthorizationHeader(workspaceId)

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": /[^\x00-\x7F]/.test(directory) ? encodeURIComponent(directory) : directory,
    }
    if (auth) headers.authorization = auth

    try {
      const targetUrl = `http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}/prompt_async`
      this.logger.info({ workspaceId, sessionId }, "Auto-continue: sending prompt")

      const wrappedPrompt = [
        `<auto-continue count="${state.triggerCount + 1}/${state.config.maxTriggers}" at="${new Date().toISOString()}">`,
        state.config.prompt,
        `</auto-continue>`,
      ].join("\n")

      const response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parts: [{ type: "text", text: wrappedPrompt }],
        }),
      })

      if (response.ok) {
        state.triggerCount++
        state.lastTriggerAt = Date.now()
        this.logger.info(
          { workspaceId, sessionId, count: state.triggerCount },
          "Auto-continue: sent successfully",
        )
      } else {
        this.logger.warn(
          { workspaceId, sessionId, status: response.status },
          "Auto-continue: failed to send",
        )
      }
    } catch (error) {
      this.logger.error({ workspaceId, sessionId, err: error }, "Auto-continue: error sending prompt")
    }
  }

  cancelCountdown(workspaceId: string, sessionId: string): boolean {
    const k = this.key(workspaceId, sessionId)
    const state = this.sessions.get(k)
    if (!state) return false

    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer)
      state.confirmTimer = null
    }
    state.idleCheckCount = 0
    state.countdownRemaining = 0
    state.config.enabled = false  // 真正关掉，防止 idle 后重新触发
    return true
  }

  removeSession(workspaceId: string, sessionId: string): void {
    const k = this.key(workspaceId, sessionId)
    const state = this.sessions.get(k)
    if (state?.confirmTimer) clearTimeout(state.confirmTimer)
    this.sessions.delete(k)
  }

  removeWorkspaceSessions(workspaceId: string): void {
    for (const [key, state] of this.sessions.entries()) {
      if (key.startsWith(`${workspaceId}:`)) {
        if (state.confirmTimer) clearTimeout(state.confirmTimer)
        this.sessions.delete(key)
      }
    }
  }

  dispose(): void {
    for (const state of this.sessions.values()) {
      if (state.confirmTimer) clearTimeout(state.confirmTimer)
    }
    this.sessions.clear()
  }
}

export type { AutoContinueConfig }
