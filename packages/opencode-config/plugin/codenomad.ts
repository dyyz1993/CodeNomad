import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadClient, getCodeNomadConfig } from "./lib/client"
import { createBackgroundProcessTools } from "./lib/background-process"
import { createPreviewTool } from "./lib/preview"
import { createAutoContinueTools } from "./lib/auto-continue"

let voiceModeEnabled = false

export async function CodeNomadPlugin(input: PluginInput) {
  const config = getCodeNomadConfig()
  const client = createCodeNomadClient(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })
  const previewTool = createPreviewTool(config)
  const autoContinueTools = createAutoContinueTools(config)

  await client.startEvents((event) => {
    if (event.type === "codenomad.ping") {
      void client.postEvent({
        type: "codenomad.pong",
        properties: {
          ts: Date.now(),
          pingTs: (event.properties as any)?.ts,
        },
      }).catch(() => {})
      return
    }

    if (event.type === "codenomad.voiceMode") {
      voiceModeEnabled = Boolean((event.properties as { enabled?: unknown } | undefined)?.enabled)
    }
  })

  return {
    tool: {
      ...backgroundProcessTools,
      ...previewTool,
      ...autoContinueTools,
    },
    async "chat.message"(_input: { sessionID: string }, output: { message: { system?: string } }) {
      const parts: string[] = []

      if (voiceModeEnabled) {
        parts.push(buildVoiceModePrompt())
      }

      parts.push(buildAutoContinuePrompt())

      if (parts.length > 0) {
        output.message.system = [output.message.system, ...parts].filter(Boolean).join("\n\n")
      }
    },
    async event(input: { event: any }) {
      const opencodeEvent = input?.event
      if (!opencodeEvent || typeof opencodeEvent !== "object") return

    },
  }
}

function buildVoiceModePrompt(): string {
  return [
    "Voice conversation mode is enabled.",
    "Prepend your reply with a fenced code block using language `spoken`.",
    "The `spoken` block should be the natural conversational reply you would say out loud to the user. It should be a concise spoken gist of the full response in 2 to 4 natural sentences.",
    "In the spoken block, summarize the main outcome, recommendation, or next step. Sound conversational and natural, not like a document summary.",
    "Do not include code, bullet lists, markdown formatting, or long technical detail in the spoken block.",
    "Do not add generic phrases about whether the user should read more.",
    "Only mention additional written detail when there is something specific that may matter for the user's next response, such as a tradeoff, caveat, risk, open question, exact diff, or test result.",
    "When referring to that written detail, say `below` or `in the message` rather than `detailed section`.",
    "After the `spoken` block, continue with your normal detailed response.",
    "Example:",
    "```spoken\nI implemented the relay-based voice-mode flow and it works with the current plugin bridge. The reconnect caveat is explained below.\n```",
  ].join("\n\n")
}

function buildAutoContinuePrompt(): string {
  return [
    "## Auto-Continue Guidance",
    "This session has auto-continue enabled. A countdown timer will automatically send a follow-up prompt when the session goes idle.",
    "You have three tools to control this behavior:",
    "- **auto_continue_cancel**: Call this when the task is FULLY COMPLETE and no further work is needed. This permanently disables auto-continue.",
    "- **auto_continue_pause**: Call this when you need to WAIT for the user (e.g., asking a question, waiting for confirmation, or the task is blocked). The user can re-enable later.",
    "- **auto_continue_status**: Call this to check the current auto-continue state before deciding what to do.",
    "Rules:",
    "1. If you asked the user a question and need their answer, call `auto_continue_pause` to stop the countdown.",
    "2. If the task is fully done and nothing more is needed, call `auto_continue_cancel`.",
    "3. If you are still working and making progress, do nothing — auto-continue will keep the session alive.",
    "4. When in doubt, call `auto_continue_status` first to check the current state.",
  ].join("\n")
}
