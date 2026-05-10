import { fetch } from "undici"
import type { Logger } from "pino"
import type { WorkspaceManager } from "../workspaces/manager"

interface SendMessageRequest {
  targetSessionId: string
  targetWorkspaceId?: string
  message: string
  sourceSessionId: string
  sourceWorkspaceId: string
  sourceProjectPath?: string
}

interface SessionInfo {
  sessionId: string
  workspaceId: string
  workspacePath: string
  status: string
  title?: string
}

export class CrossSessionManager {
  private readonly logger: Logger

  constructor(
    private readonly baseLogger: Logger,
    private readonly workspaceManager: WorkspaceManager,
  ) {
    this.logger = baseLogger.child({ component: "cross-session" })
  }

  async listAllSessions(): Promise<SessionInfo[]> {
    const workspaces = this.workspaceManager.list()
    const readyWorkspaces = workspaces.filter((w) => w.status === "ready")
    const results: SessionInfo[] = []

    const workspaceSessions = await Promise.allSettled(
      readyWorkspaces.map(async (ws) => {
        const port = this.workspaceManager.getInstancePort(ws.id)
        if (!port) return []
        return this.fetchWorkspaceSessions(ws.id, port)
      }),
    )

    for (const result of workspaceSessions) {
      if (result.status === "fulfilled") {
        results.push(...result.value)
      }
    }

    return results
  }

  async sendMessage(req: SendMessageRequest): Promise<{ success: boolean; error?: string }> {
    let targetWorkspaceId = req.targetWorkspaceId

    if (!targetWorkspaceId) {
      const found = await this.findSessionWorkspace(req.targetSessionId)
      if (!found) {
        return { success: false, error: `Target session ${req.targetSessionId} not found in any workspace` }
      }
      targetWorkspaceId = found
    }

    const workspace = this.workspaceManager.get(targetWorkspaceId)
    if (!workspace) {
      return { success: false, error: `Workspace ${targetWorkspaceId} not found` }
    }

    if (workspace.status !== "ready") {
      return { success: false, error: `Workspace ${targetWorkspaceId} is not ready (status: ${workspace.status})` }
    }

    const port = this.workspaceManager.getInstancePort(targetWorkspaceId)
    if (!port) {
      return { success: false, error: `Workspace ${targetWorkspaceId} has no instance port` }
    }

    const auth = this.workspaceManager.getInstanceAuthorizationHeader(targetWorkspaceId)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": /[^\x00-\x7F]/.test(workspace.path) ? encodeURIComponent(workspace.path) : workspace.path,
    }
    if (auth) headers.authorization = auth

    const xmlMessage = this.buildCrossSessionMessage(req)

    try {
      const targetUrl = `http://127.0.0.1:${port}/session/${encodeURIComponent(req.targetSessionId)}/prompt_async`
      this.logger.info(
        { sourceSession: req.sourceSessionId, targetSession: req.targetSessionId, targetWorkspace: targetWorkspaceId },
        "Sending cross-session message",
      )

      const response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parts: [
            {
              type: "text",
              text: xmlMessage,
              synthetic: true,
            },
          ],
        }),
      })

      if (!response.ok) {
        const message = await response.text().catch(() => "")
        return { success: false, error: message || `Prompt request failed with ${response.status}` }
      }

      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.logger.error({ err: error, targetSessionId: req.targetSessionId }, "Failed to send cross-session message")
      return { success: false, error: msg }
    }
  }

  private async fetchWorkspaceSessions(workspaceId: string, port: number): Promise<SessionInfo[]> {
    const workspace = this.workspaceManager.get(workspaceId)
    if (!workspace) return []

    const auth = this.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": /[^\x00-\x7F]/.test(workspace.path) ? encodeURIComponent(workspace.path) : workspace.path,
    }
    if (auth) headers.authorization = auth

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session`, {
        method: "GET",
        headers,
      })

      if (!response.ok) {
        this.logger.debug({ workspaceId, status: response.status }, "Failed to fetch sessions from workspace")
        return []
      }

      const data = (await response.json()) as unknown
      const sessions = parseSessionList(data)

      return sessions.map((s: any) => ({
        sessionId: s.id ?? s.sessionID ?? "",
        workspaceId,
        workspacePath: workspace.path,
        status: s.status ?? "unknown",
        title: s.title ?? s.name ?? undefined,
      }))
    } catch (error) {
      this.logger.debug({ err: error, workspaceId }, "Failed to fetch sessions from workspace")
      return []
    }
  }

  private async findSessionWorkspace(targetSessionId: string): Promise<string | undefined> {
    const workspaces = this.workspaceManager.list().filter((w) => w.status === "ready")

    for (const ws of workspaces) {
      const port = this.workspaceManager.getInstancePort(ws.id)
      if (!port) continue

      const sessions = await this.fetchWorkspaceSessions(ws.id, port)
      if (sessions.some((s) => s.sessionId === targetSessionId)) {
        return ws.id
      }
    }

    return undefined
  }

  private buildCrossSessionMessage(req: SendMessageRequest): string {
    return `<cross-session-message>
  <source>
    <session-id>${this.escapeXml(req.sourceSessionId)}</session-id>
    <workspace-id>${this.escapeXml(req.sourceWorkspaceId)}</workspace-id>
    ${req.sourceProjectPath ? `<project-path>${this.escapeXml(req.sourceProjectPath)}</project-path>` : ""}
  </source>
  <target-session-id>${this.escapeXml(req.targetSessionId)}</target-session-id>
  <content>${this.escapeXml(req.message)}</content>
</cross-session-message>`
  }

  private escapeXml(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  }
}

function parseSessionList(data: unknown): any[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === "object" && Array.isArray((data as any).sessions)) return (data as any).sessions
  if (data && typeof data === "object" && Array.isArray((data as any).data)) return (data as any).data
  return []
}

export type { SendMessageRequest, SessionInfo }
