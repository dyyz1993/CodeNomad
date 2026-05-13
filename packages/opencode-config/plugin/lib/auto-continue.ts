import { tool } from "@opencode-ai/plugin/tool"
import type { CodeNomadConfig } from "./request"
import { createCodeNomadRequester } from "./request"

export function createAutoContinueTools(config: CodeNomadConfig) {
  const api = createCodeNomadRequester(config)

  const acPath = (sessionId: string, suffix?: string) => {
    const base = `/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`
    return suffix ? `${base}/${suffix}` : base
  }

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
        if (!sessionId) return "Error: no session ID available in context."

        try {
          const data = await api.requestJson<{ cancelled: boolean }>(acPath(sessionId, "cancel"), { method: "POST" })
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
        if (!sessionId) return "Error: no session ID available in context."

        try {
          await api.requestVoid(acPath(sessionId, "cancel"), { method: "POST" }).catch(() => {})

          const data = await api.requestJson<{ enabled: boolean }>(acPath(sessionId), {
            method: "PUT",
            body: JSON.stringify({ enabled: false }),
          })

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
        if (!sessionId) return "Error: no session ID available in context."

        try {
          const data = await api.requestJson<{
            enabled: boolean
            prompt: string
            cooldownMs: number
            maxTriggers: number
            confirmSeconds: number
            triggerCount: number
            lastTriggerAt: number
            countdownRemaining: number
          }>(acPath(sessionId))

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
