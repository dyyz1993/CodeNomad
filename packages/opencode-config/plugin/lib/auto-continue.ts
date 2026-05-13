import { tool } from "@opencode-ai/plugin/tool"
import type { CodeNomadConfig } from "./request"

/**
 * Auto-continue tools: let the AI cancel or pause the auto-continue countdown.
 *
 * The server's AutoContinueManager exposes:
 *  - POST /api/workspaces/:id/auto-continue/:sessionId/cancel  → cancel countdown
 *  - PUT   /api/workspaces/:id/auto-continue/:sessionId        → update config (set enabled=false to pause)
 *  - GET   /api/workspaces/:id/auto-continue/:sessionId        → read state (including countdownRemaining)
 */
export function createAutoContinueTools(config: CodeNomadConfig) {
  return {
    auto_continue_cancel: tool({
      description: [
        "Cancel the auto-continue countdown timer for the current session.",
        "Use this when the task is complete and no further auto-continue is needed.",
        "This stops the countdown and prevents the system from automatically sending another prompt.",
      ].join(" "),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) {
          return "Error: no session ID available in context."
        }

        try {
          const baseUrl = config.baseUrl.replace(/\/+$/, "")
          const url = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}/cancel`

          const response = await fetch(url, {
            method: "POST",
          })

          if (!response.ok) {
            const text = await response.text().catch(() => "")
            return `Failed to cancel auto-continue (${response.status}): ${text}`
          }

          const data = (await response.json()) as { cancelled: boolean }
          return data.cancelled
            ? "Auto-continue countdown cancelled successfully."
            : "No active countdown to cancel (may have already triggered or was not active)."
        } catch (err) {
          return `Error cancelling auto-continue: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    auto_continue_pause: tool({
      description: [
        "Pause auto-continue for the current session. The countdown will stop and auto-continue will not trigger.",
        "Use this when the task is paused or waiting for user input and you don't want auto-continue to fire.",
        "The user can re-enable it later if needed.",
      ].join(" "),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) {
          return "Error: no session ID available in context."
        }

        try {
          const baseUrl = config.baseUrl.replace(/\/+$/, "")
          const url = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`

          // Cancel any running countdown AND disable auto-continue
          const cancelUrl = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}/cancel`
          await fetch(cancelUrl, { method: "POST" }).catch(() => {})

          const response = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          })

          if (!response.ok) {
            const text = await response.text().catch(() => "")
            return `Failed to pause auto-continue (${response.status}): ${text}`
          }

          const data = (await response.json()) as { enabled: boolean }
          return `Auto-continue paused (enabled=${data.enabled}). The countdown has been stopped.`
        } catch (err) {
          return `Error pausing auto-continue: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    auto_continue_status: tool({
      description: [
        "Check the current auto-continue status: whether it's enabled, countdown remaining, trigger count, etc.",
        "Use this to check if auto-continue is active before deciding to cancel or pause.",
      ].join(" "),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) {
          return "Error: no session ID available in context."
        }

        try {
          const baseUrl = config.baseUrl.replace(/\/+$/, "")
          const url = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`

          const response = await fetch(url, {
            headers: { Accept: "application/json" },
          })

          if (!response.ok) {
            return `Auto-continue not configured for this session (status ${response.status}).`
          }

          const data = (await response.json()) as {
            enabled: boolean
            prompt: string
            cooldownMs: number
            maxTriggers: number
            confirmSeconds: number
            triggerCount: number
            lastTriggerAt: number
            countdownRemaining: number
          }

          const lines = [
            `Enabled: ${data.enabled}`,
            `Countdown: ${data.countdownRemaining}s remaining`,
            `Confirm seconds: ${data.confirmSeconds}s`,
            `Triggers: ${data.triggerCount}/${data.maxTriggers}`,
            `Cooldown: ${data.cooldownMs / 1000}s`,
            `Last triggered: ${data.lastTriggerAt ? new Date(data.lastTriggerAt).toISOString() : "never"}`,
          ]

          return lines.join("\n")
        } catch (err) {
          return `Error checking auto-continue status: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  }
}
