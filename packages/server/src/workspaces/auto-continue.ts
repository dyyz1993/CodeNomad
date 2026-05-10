import { fetch } from "undici"
import type { Logger } from "pino"
import type { WorkspaceManager } from "./manager"

interface AutoContinueConfig {
  enabled: boolean
  prompt: string
  cooldownMs: number
  maxTriggers: number
  confirmSeconds: number
}

interface SessionAutoContinueState {
  config: AutoContinueConfig
  triggerCount: number
  lastTriggerAt: number
  confirmTimer: ReturnType<typeof setTimeout> | null
  idleCheckCount: number
}

const DEFAULT_CONFIG: AutoContinueConfig = {
  enabled: false,
  prompt:
    "如果当前任务尚未完成，请继续执行。如果没有疑问，请继续。否则请用提问的形式询问用户。如果暂时不需要询问，请略过。",
  cooldownMs: 60_000,
  maxTriggers: 20,
  confirmSeconds: 5,
}

export class AutoContinueManager {
  private readonly sessions = new Map<string, SessionAutoContinueState>()
  private readonly logger: Logger

  constructor(
    logger: Logger,
    private readonly workspaceManager: WorkspaceManager,
  ) {
    this.logger = logger.child({ component: "auto-continue" })
  }

  private key(workspaceId: string, sessionId: string): string {
    return `${workspaceId}:${sessionId}`
  }

  getConfig(workspaceId: string, sessionId: string): AutoContinueConfig {
    return this.sessions.get(this.key(workspaceId, sessionId))?.config ?? { ...DEFAULT_CONFIG }
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
      }
      this.sessions.set(k, state)
    }
    Object.assign(state.config, updates)
    return state.config
  }

  getState(workspaceId: string, sessionId: string): {
    config: AutoContinueConfig
    triggerCount: number
    lastTriggerAt: number
  } | null {
    const state = this.sessions.get(this.key(workspaceId, sessionId))
    if (!state) return null
    return {
      config: { ...state.config },
      triggerCount: state.triggerCount,
      lastTriggerAt: state.lastTriggerAt,
    }
  }

  onSessionIdle(workspaceId: string, sessionId: string, isMainSession: boolean): void {
    if (!isMainSession) return

    const k = this.key(workspaceId, sessionId)
    const state = this.sessions.get(k)
    if (!state || !state.config.enabled) return

    state.idleCheckCount = 0

    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer)
    }

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
  }

  private startIdleConfirmation(
    workspaceId: string,
    sessionId: string,
    state: SessionAutoContinueState,
  ): void {
    const requiredChecks = state.config.confirmSeconds

    const check = () => {
      state.idleCheckCount++

      if (state.idleCheckCount >= requiredChecks) {
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

      const response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parts: [{ type: "text", text: state.config.prompt, synthetic: true }],
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

  dispose(): void {
    for (const state of this.sessions.values()) {
      if (state.confirmTimer) clearTimeout(state.confirmTimer)
    }
    this.sessions.clear()
  }
}

export type { AutoContinueConfig }
