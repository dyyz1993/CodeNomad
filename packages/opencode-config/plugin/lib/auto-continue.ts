import fs from "fs"
import { tool } from "@opencode-ai/plugin/tool"
import type { CodeNomadConfig } from "./request"
import { createCodeNomadRequester } from "./request"

interface ChecklistResult {
  ok: boolean
  filePath: string
  exists: boolean
  total: number
  checked: number
  unchecked: string[]
}

interface AutoContinueResponse {
  enabled: boolean
  prompt: string
  cooldownMs: number
  maxTriggers: number
  confirmSeconds: number
  triggerCount: number
  lastTriggerAt: number
  countdownRemaining: number
  checklistPath?: string
}

function verifyChecklistFile(filePath: string): ChecklistResult {
  const exists = fs.existsSync(filePath)

  if (!exists) {
    return { ok: false, filePath, exists: false, total: 0, checked: 0, unchecked: ["Checklist file not found"] }
  }

  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.split("\n")

  const checkedItems: string[] = []
  const uncheckedItems: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
      checkedItems.push(trimmed.replace(/^- \[[xX]\] /, ""))
    } else if (trimmed.startsWith("- [ ] ")) {
      uncheckedItems.push(trimmed.replace(/^- \[ \] /, ""))
    }
  }

  const total = checkedItems.length + uncheckedItems.length
  const allDone = total > 0 && uncheckedItems.length === 0

  return {
    ok: allDone,
    filePath,
    exists: true,
    total,
    checked: checkedItems.length,
    unchecked: uncheckedItems,
  }
}

function buildRejectionMessage(checklist: ChecklistResult): string {
  const msg = [
    "AUTO-CONTINUE GUARD: Cannot cancel/pause — checklist has unchecked items.",
    "You must complete ALL items before auto-continue can be stopped.",
    "Continue working on the remaining tasks. Do NOT call cancel/pause again until all items are checked.",
    "",
  ]
  if (!checklist.exists) {
    msg.push(
      `Checklist file not found: ${checklist.filePath}`,
      `The checklist path is configured per-session. Default: {workspace}/.codenomad/{sessionId}-auto-continue-checklist.md`,
      "You can customize the path in the auto-continue config (checklistRelativePath).",
      "",
      "Create this file with checkboxes like:",
      "  - [ ] Task description",
      "  - [ ] Another task",
      "",
      "Check off items as you complete them with `- [x] Done task`.",
    )
  } else {
    msg.push(
      `File: ${checklist.filePath}`,
      `Progress: ${checklist.checked}/${checklist.total} completed`,
      "",
      "Unchecked items:",
      ...checklist.unchecked.map((item) => `  - [ ] ${item}`),
      "",
      "Complete all items and check them off before calling cancel/pause.",
    )
  }
  return msg.join("\n")
}

export function createAutoContinueTools(config: CodeNomadConfig) {
  const api = createCodeNomadRequester(config)
  const baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "")

  const acUrl = (sessionId: string, suffix?: string) => {
    const base = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`
    return suffix ? `${base}/${suffix}` : base
  }

  async function fetchChecklistPath(sessionId: string): Promise<string | null> {
    try {
      const data = await api.requestJson<AutoContinueResponse>(acUrl(sessionId))
      return data.checklistPath ?? null
    } catch {
      return null
    }
  }

  return {
    auto_continue_cancel: tool({
      description: [
        "Cancel the auto-continue countdown timer for the current session.",
        "",
        "GUARD: Before this tool can execute, it reads the session's checklist file.",
        "The checklist path is configured per-session via the auto-continue settings.",
        "Default: {workspace}/.codenomad/{sessionId}-auto-continue-checklist.md",
        "If ANY checkbox is unchecked (`- [ ]`), the cancel is REJECTED.",
        "Only when ALL items are checked (`- [x]`) will the cancel proceed.",
        "Do NOT call this tool on your own initiative — only when the USER explicitly asks.",
      ].join("\n"),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        const checklistPath = await fetchChecklistPath(sessionId)
        if (!checklistPath) {
          return "Error: cannot determine checklist path. Is auto-continue configured?"
        }

        const checklist = verifyChecklistFile(checklistPath)
        if (!checklist.ok) {
          return buildRejectionMessage(checklist)
        }

        try {
          const data = await api.requestJson<{ cancelled: boolean }>(acUrl(sessionId, "cancel"), { method: "POST" })
          return data.cancelled
            ? `Auto-continue cancelled. All ${checklist.total}/${checklist.total} checklist items completed.`
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
        "GUARD: Before this tool can execute, it reads the session's checklist file.",
        "The checklist path is configured per-session via the auto-continue settings.",
        "Default: {workspace}/.codenomad/{sessionId}-auto-continue-checklist.md",
        "If ANY checkbox is unchecked (`- [ ]`), the pause is REJECTED.",
        "Only when ALL items are checked (`- [x]`) will the pause proceed.",
        "Only call this when the USER explicitly asks to pause.",
      ].join("\n"),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        const checklistPath = await fetchChecklistPath(sessionId)
        if (!checklistPath) {
          return "Error: cannot determine checklist path. Is auto-continue configured?"
        }

        const checklist = verifyChecklistFile(checklistPath)
        if (!checklist.ok) {
          return buildRejectionMessage(checklist)
        }

        try {
          await api.requestVoid(acUrl(sessionId, "cancel"), { method: "POST" }).catch(() => {})

          const data = await api.requestJson<{ enabled: boolean }>(acUrl(sessionId), {
            method: "PUT",
            body: JSON.stringify({ enabled: false }),
          })

          return `Auto-continue paused (enabled=${data.enabled}). All ${checklist.total}/${checklist.total} checklist items completed.`
        } catch (err) {
          return `Error pausing auto-continue: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    auto_continue_status: tool({
      description: [
        "Check the current auto-continue status: whether it's enabled, countdown remaining, trigger count, etc.",
        "Also shows the checklist verification status.",
      ].join(" "),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        try {
          const data = await api.requestJson<AutoContinueResponse>(acUrl(sessionId))

          let checklist: ChecklistResult | null = null
          if (data.checklistPath) {
            checklist = verifyChecklistFile(data.checklistPath)
          }

          const lines = [
            `Enabled: ${data.enabled}`,
            `Countdown: ${data.countdownRemaining}s remaining`,
            `Confirm seconds: ${data.confirmSeconds}s`,
            `Triggers: ${data.triggerCount}/${data.maxTriggers}`,
            `Cooldown: ${data.cooldownMs / 1000}s`,
            `Last triggered: ${data.lastTriggerAt ? new Date(data.lastTriggerAt).toISOString() : "never"}`,
          ]

          if (checklist) {
            const status = checklist.ok ? "ALL DONE ✅" : "INCOMPLETE ⚠️"
            lines.push(
              "",
              `Checklist (${checklist.checked}/${checklist.total}): ${status}`,
              `Path: ${checklist.filePath}`,
            )
            if (checklist.unchecked.length > 0) {
              lines.push("Remaining:")
              for (const item of checklist.unchecked) {
                lines.push(`  - [ ] ${item}`)
              }
            }
          } else {
            lines.push(
              "",
              "No checklist path configured. Use the default: {workspace}/.codenomad/{sessionId}-auto-continue-checklist.md",
            )
          }

          return lines.join("\n")
        } catch (err) {
          return `Error checking auto-continue status: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  }
}
