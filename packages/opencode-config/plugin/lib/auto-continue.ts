import { tool } from "@opencode-ai/plugin/tool"
import type { CodeNomadConfig } from "./request"
import { createCodeNomadRequester } from "./request"

export function createAutoContinueTools(config: CodeNomadConfig) {
  const api = createCodeNomadRequester(config)
  const baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "")

  const acUrl = (sessionId: string, suffix?: string) => {
    const base = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`
    return suffix ? `${base}/${suffix}` : base
  }

  return {
    auto_continue_cancel: tool({
      description: [
        "Cancel the auto-continue countdown timer for the current session.",
        "",
        "IMPORTANT: Do NOT call this tool automatically after completing a task.",
        "This tool should ONLY be called when the USER explicitly asks to stop auto-continue.",
        "Never call this on your own initiative — the auto-continue system is designed to keep",
        "the session alive so you can continue working. Let it run unless the user says otherwise.",
      ].join("\n"),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        try {
          const data = await api.requestJson<{ cancelled: boolean }>(acUrl(sessionId, "cancel"), { method: "POST" })
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
        "",
        "IMPORTANT: Do NOT call this tool automatically.",
        "Only call this when the USER explicitly asks to pause, or when you need to ask the user",
        "a question and want to prevent auto-continue from firing while waiting for their response.",
      ].join("\n"),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        try {
          await api.requestVoid(acUrl(sessionId, "cancel"), { method: "POST" }).catch(() => {})

          const data = await api.requestJson<{ enabled: boolean }>(acUrl(sessionId), {
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
          }>(acUrl(sessionId))

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
