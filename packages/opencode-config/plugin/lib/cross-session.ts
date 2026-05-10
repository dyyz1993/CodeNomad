import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request"

type SessionInfo = {
  sessionId: string
  workspaceId: string
  workspaceName: string
  workspacePath: string
  status: string
  title?: string
  lastActivity?: string
  isMainSession: boolean
}

type CommunicationRecord = {
  fromSessionId: string
  fromWorkspaceId: string
  toSessionId: string
  toWorkspaceId: string
  topic: string
  sentAt: number
  respondedAt?: number
}

export function createCrossSessionTools(config: CodeNomadConfig) {
  const requester = createCodeNomadRequester(config)

  return {
    list_sessions: tool({
      description:
        "列出所有活跃项目的会话信息。返回项目名、会话ID、会话标题、状态。只显示主会话（非子任务）。你可以通过 send_message 向任意会话发送消息进行协作。",
      args: {},
      async execute() {
        const response = await requester.requestJson<{ sessions: SessionInfo[] }>(
          "/cross-session/sessions",
        )
        if (!response.sessions || response.sessions.length === 0) {
          return "No active sessions found."
        }

        return response.sessions
          .map((s) => {
            const title = s.title ? ` | ${s.title}` : ""
            const lastActivity = s.lastActivity ? ` | Last: ${s.lastActivity}` : ""
            return `- Session: ${s.sessionId}\n  Project: ${s.workspaceName} (${s.workspacePath})\n  Workspace: ${s.workspaceId}\n  Status: ${s.status}${title}${lastActivity}`
          })
          .join("\n\n")
      },
    }),

    send_message: tool({
      description:
        "Send a message to another session. The target session will receive the message and can continue working.",
      args: {
        target_session_id: tool.schema
          .string()
          .describe("The session ID to send the message to"),
        message: tool.schema.string().describe("The message content to send"),
        target_workspace_id: tool.schema
          .string()
          .optional()
          .describe(
            "Optional: the workspace ID of the target session. If not provided, will search all workspaces.",
          ),
      },
      async execute(args, context) {
        const payload = {
          targetSessionId: args.target_session_id,
          targetWorkspaceId: args.target_workspace_id,
          message: args.message,
          sourceSessionId: context.sessionID,
          sourceWorkspaceId: config.instanceId,
          sourceProjectPath: context.directory,
        }

        const result = await requester.requestJson<{ success: boolean; error?: string }>(
          "/cross-session/send-message",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        )

        if (!result.success) {
          return `Failed to send message: ${result.error ?? "unknown error"}`
        }

        return `Message sent successfully to session ${args.target_session_id}.`
      },
    }),

    get_communication_history: tool({
      description:
        "查询当前会话的跨会话通信记录。返回你发送和接收过的所有消息历史。",
      args: {},
      async execute(_args, context) {
        const response = await requester.requestJson<{ history: CommunicationRecord[] }>(
          `/cross-session/history?sessionId=${encodeURIComponent(context.sessionID)}`,
        )

        if (!response.history || response.history.length === 0) {
          return "No communication history found for this session."
        }

        const lines = response.history.map((r) => {
          const isSender = r.fromSessionId === context.sessionID
          const direction = isSender ? "→" : "←"
          const peerId = isSender ? r.toSessionId : r.fromSessionId
          const peerWorkspace = isSender ? r.toWorkspaceId : r.fromWorkspaceId
          const time = new Date(r.sentAt).toLocaleString()
          const role = isSender ? "发送给" : "收到来自"
          return `- ${direction} ${role} ${peerId} (workspace: ${peerWorkspace}) 于 ${time}，话题: "${r.topic}"`
        })

        return `[通信记录]\n${lines.join("\n")}`
      },
    }),
  }
}
