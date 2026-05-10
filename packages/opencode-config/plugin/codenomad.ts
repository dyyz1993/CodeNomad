import type { PluginInput } from "@opencode-ai/plugin"
import { createCodeNomadClient, getCodeNomadConfig } from "./lib/client"
import { createBackgroundProcessTools } from "./lib/background-process"
import { createCrossSessionTools } from "./lib/cross-session"

let voiceModeEnabled = false

export async function CodeNomadPlugin(input: PluginInput) {
  const config = getCodeNomadConfig()
  const client = createCodeNomadClient(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })
  const crossSessionTools = createCrossSessionTools(config)

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
      ...crossSessionTools,
    },
    async "chat.message"(_input: { sessionID: string }, output: { message: { system?: string } }) {
      const parts: string[] = []

      if (voiceModeEnabled) {
        parts.push(buildVoiceModePrompt())
      }

      try {
        const commHistory = await fetchCommunicationHistory(config, _input.sessionID)
        if (commHistory) {
          parts.push(commHistory)
        }
      } catch {
        // non-critical: don't block chat if history fetch fails
      }

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

async function fetchCommunicationHistory(config: { instanceId: string; baseUrl: string }, sessionId: string): Promise<string | null> {
  const { createCodeNomadRequester } = await import("./lib/request")
  const requester = createCodeNomadRequester(config)
  const response = await requester.requestJson<{ history: Array<{
    fromSessionId: string
    fromWorkspaceId: string
    toSessionId: string
    toWorkspaceId: string
    topic: string
    sentAt: number
  }> }>(`/cross-session/history?sessionId=${encodeURIComponent(sessionId)}`)

  if (!response.history || response.history.length === 0) {
    return null
  }

  const lines = response.history.map((r) => {
    const isSender = r.fromSessionId === sessionId
    const direction = isSender ? "→" : "←"
    const peerId = isSender ? r.toSessionId : r.fromSessionId
    const time = new Date(r.sentAt).toLocaleString()
    const role = isSender ? "发送给" : "收到来自"
    return `- ${direction} ${role} ${peerId} 于 ${time}，话题: "${r.topic}"`
  })

  return `[通信记录] 你曾与以下会话通信:\n${lines.join("\n")}`
}
