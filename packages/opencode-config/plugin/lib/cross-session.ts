import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request"

type SessionInfo = {
  sessionId: string
  workspaceId: string
  workspacePath: string
  status: string
  title?: string
}

export function createCrossSessionTools(config: CodeNomadConfig) {
  const requester = createCodeNomadRequester(config)

  return {
    list_sessions: tool({
      description:
        "List all active opencode sessions across all workspaces. Returns session ID, workspace info, and status.",
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
            return `- Session: ${s.sessionId}\n  Workspace: ${s.workspaceId} (${s.workspacePath})\n  Status: ${s.status}${title}`
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
  }
}
