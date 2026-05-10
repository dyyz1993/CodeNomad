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
  workspaceName: string
  workspacePath: string
  status: string
  title?: string
  lastActivity?: string
  isMainSession: boolean
}

interface CommunicationRecord {
  fromSessionId: string
  fromWorkspaceId: string
  toSessionId: string
  toWorkspaceId: string
  topic: string
  sentAt: number
  respondedAt?: number
}

export class CrossSessionManager {
  private readonly logger: Logger
  private readonly history: CommunicationRecord[] = []

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

      this.recordCommunication(req)
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
      const workspaceName = workspace.path.split("/").pop() ?? workspace.path

      const mapped = sessions
        .map((s: any) => ({
          sessionId: s.id ?? s.sessionID ?? "",
          workspaceId,
          workspaceName,
          workspacePath: workspace.path,
          status: s.status ?? "unknown",
          title: s.title ?? s.name ?? undefined,
          lastActivity: s.lastActivity ?? s.updatedAt ?? s.lastMessageAt ?? undefined,
          isMainSession: !s.parentSessionId && !s.parent_session_id,
        }))
        .filter((s) => s.isMainSession)
        .slice(0, 5)

      return mapped
    } catch (error) {
      this.logger.debug({ err: error, workspaceId }, "Failed to fetch sessions from workspace")
      return []
    }
  }

  private async findSessionWorkspace(targetSessionId: string): Promise<string | undefined> {
    const workspaces = this.workspaceManager.list().filter((w) => w.status === "ready")

    const results = await Promise.allSettled(
      workspaces.map(async (ws) => {
        const port = this.workspaceManager.getInstancePort(ws.id)
        if (!port) return null

        const sessions = await this.fetchWorkspaceSessions(ws.id, port)
        if (sessions.some((s) => s.sessionId === targetSessionId)) {
          return ws.id
        }
        return null
      }),
    )

    const found = results.find(
      (r) => r.status === "fulfilled" && r.value !== null,
    )
    return found && found.status === "fulfilled" ? (found.value as string | undefined) : undefined
  }

  private buildCrossSessionMessage(req: SendMessageRequest): string {
    const parts = [`[跨会话消息 from=${req.sourceSessionId}@${req.sourceWorkspaceId}]`, req.message]
    if (req.sourceProjectPath) {
      parts.splice(1, 0, `来源项目: ${req.sourceProjectPath}`)
    }
    return parts.join("\n")
  }

  private recordCommunication(req: SendMessageRequest): void {
    this.history.push({
      fromSessionId: req.sourceSessionId,
      fromWorkspaceId: req.sourceWorkspaceId,
      toSessionId: req.targetSessionId,
      toWorkspaceId: req.targetWorkspaceId ?? "",
      topic: req.message.slice(0, 50),
      sentAt: Date.now(),
    })
    if (this.history.length > 100) {
      this.history.shift()
    }
  }

  getHistory(sessionId: string): CommunicationRecord[] {
    return this.history.filter(
      (r) => r.fromSessionId === sessionId || r.toSessionId === sessionId,
    )
  }
}

function parseSessionList(data: unknown): any[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === "object" && Array.isArray((data as any).sessions)) return (data as any).sessions
  if (data && typeof data === "object" && Array.isArray((data as any).data)) return (data as any).data
  return []
}

export type { SendMessageRequest, SessionInfo, CommunicationRecord }
