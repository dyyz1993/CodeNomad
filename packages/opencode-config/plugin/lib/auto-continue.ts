import fs from "fs"
import path from "path"
import { tool } from "@opencode-ai/plugin/tool"
import type { CodeNomadConfig } from "./request"
import { createCodeNomadRequester } from "./request"

const CHECKLIST_RELATIVE_PATH = ".codenomad/auto-continue-checklist.md"

function getWorkspaceRoot(): string {
  const rootDir = process.env.CODENOMAD_ROOT_DIR
  if (rootDir) return rootDir
  return process.cwd()
}

interface ChecklistResult {
  ok: boolean
  filePath: string
  exists: boolean
  total: number
  checked: number
  unchecked: string[]
}

function verifyChecklist(): ChecklistResult {
  const root = getWorkspaceRoot()
  const filePath = path.join(root, CHECKLIST_RELATIVE_PATH)
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

export function createAutoContinueTools(config: CodeNomadConfig) {
  const api = createCodeNomadRequester(config)
  const baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "")

  const acUrl = (sessionId: string, suffix?: string) => {
    const base = `${baseUrl}/api/workspaces/${encodeURIComponent(config.instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`
    return suffix ? `${base}/${suffix}` : base
  }

  const GUARD_MESSAGE = [
    "AUTO-CONTINUE GUARD: Cannot cancel/pause — checklist has unchecked items.",
    "You must complete ALL items before auto-continue can be stopped.",
    "Continue working on the remaining tasks. Do NOT call cancel/pause again until all items are checked.",
  ].join("\n")

  return {
    auto_continue_cancel: tool({
      description: [
        "Cancel the auto-continue countdown timer for the current session.",
        "",
        "GUARD: Before this tool can execute, it reads `.codenomad/auto-continue-checklist.md` in the workspace.",
        "If ANY checkbox is unchecked (`- [ ]`), the cancel is REJECTED and you must continue working.",
        "Only when ALL items are checked (`- [x]`) will the cancel proceed.",
        "Do NOT call this tool on your own initiative — only when the USER explicitly asks to stop.",
      ].join("\n"),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        const checklist = verifyChecklist()
        if (!checklist.ok) {
          if (!checklist.exists) {
            return [
              GUARD_MESSAGE,
              "",
              `Checklist file not found: ${checklist.filePath}`,
              "Create it with checkboxes like `- [ ] Task description` and check them off as you complete tasks.",
            ].join("\n")
          }
          return [
            GUARD_MESSAGE,
            "",
            `File: ${checklist.filePath}`,
            `Progress: ${checklist.checked}/${checklist.total} completed`,
            "",
            "Unchecked items:",
            ...checklist.unchecked.map((item) => `  - [ ] ${item}`),
          ].join("\n")
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
        "GUARD: Before this tool can execute, it reads `.codenomad/auto-continue-checklist.md` in the workspace.",
        "If ANY checkbox is unchecked (`- [ ]`), the pause is REJECTED and you must continue working.",
        "Only when ALL items are checked (`- [x]`) will the pause proceed.",
        "Only call this when the USER explicitly asks to pause.",
      ].join("\n"),
      args: {},
      async execute(_args, ctx) {
        const sessionId = ctx.sessionID
        if (!sessionId) return "Error: no session ID available in context."

        const checklist = verifyChecklist()
        if (!checklist.ok) {
          if (!checklist.exists) {
            return [
              GUARD_MESSAGE,
              "",
              `Checklist file not found: ${checklist.filePath}`,
              "Create it with checkboxes like `- [ ] Task description` and check them off as you complete tasks.",
            ].join("\n")
          }
          return [
            GUARD_MESSAGE,
            "",
            `File: ${checklist.filePath}`,
            `Progress: ${checklist.checked}/${checklist.total} completed`,
            "",
            "Unchecked items:",
            ...checklist.unchecked.map((item) => `  - [ ] ${item}`),
          ].join("\n")
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

          const checklist = verifyChecklist()

          const lines = [
            `Enabled: ${data.enabled}`,
            `Countdown: ${data.countdownRemaining}s remaining`,
            `Confirm seconds: ${data.confirmSeconds}s`,
            `Triggers: ${data.triggerCount}/${data.maxTriggers}`,
            `Cooldown: ${data.cooldownMs / 1000}s`,
            `Last triggered: ${data.lastTriggerAt ? new Date(data.lastTriggerAt).toISOString() : "never"}`,
            "",
            `Checklist (${checklist.exists ? `${checklist.checked}/${checklist.total}` : "not found"}): ${checklist.ok ? "ALL DONE" : "INCOMPLETE"}`,
          ]

          if (checklist.exists && checklist.unchecked.length > 0) {
            lines.push("Remaining:")
            for (const item of checklist.unchecked) {
              lines.push(`  - [ ] ${item}`)
            }
          }

          return lines.join("\n")
        } catch (err) {
          return `Error checking auto-continue status: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  }
}
