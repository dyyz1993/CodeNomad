import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { VoiceModeStateResponse } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { PluginChannelManager } from "../../plugins/channel"
import { buildPingEvent, handlePluginEvent } from "../../plugins/handlers"
import { VoiceModeManager } from "../../plugins/voice-mode"
import type { CrossSessionManager } from "../../plugins/cross-session"
import type { AutoContinueManager } from "../../workspaces/auto-continue"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
  channel: PluginChannelManager
  voiceModeManager: VoiceModeManager
  crossSessionManager: CrossSessionManager
  autoContinueManager?: AutoContinueManager
}

const PluginEventSchema = z.object({
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})

const VoiceModeStateSchema = z.object({
  enabled: z.boolean(),
  clientId: z.string().trim().min(1),
  connectionId: z.string().trim().min(1),
})

export function registerPluginRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/events", (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const registration = deps.channel.register(request.params.id, reply)
    deps.voiceModeManager.syncInstance(request.params.id)

    const heartbeat = setInterval(() => {
      deps.channel.send(request.params.id, buildPingEvent())
    }, 15000)

    const close = () => {
      clearInterval(heartbeat)
      registration.close()
      reply.raw.end?.()
    }

    request.raw.on("close", close)
    request.raw.on("error", close)
  })

  app.post<{ Params: { id: string }; Body: VoiceModeStateResponse }>("/workspaces/:id/plugin/voice-mode", (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const payload = VoiceModeStateSchema.parse(request.body ?? {})
    const applied = deps.voiceModeManager.setEnabled(
      request.params.id,
      { clientId: payload.clientId, connectionId: payload.connectionId },
      payload.enabled,
    )

    if (payload.enabled && !applied) {
      reply.code(409).send({ error: "Client connection not active for voice mode enable" })
      return
    }

    return { enabled: payload.enabled }
  })

  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/cross-session/sessions", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const sessions = await deps.crossSessionManager.listAllSessions()
    return { sessions }
  })

  app.get<{ Params: { id: string }; Querystring: { sessionId?: string } }>("/workspaces/:id/plugin/cross-session/history", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const sessionId = request.query.sessionId
    if (!sessionId) {
      reply.code(400).send({ error: "sessionId query parameter is required" })
      return
    }

    const history = deps.crossSessionManager.getHistory(sessionId)
    return { history }
  })

  const SendMessageSchema = z.object({
    targetSessionId: z.string().min(1),
    targetWorkspaceId: z.string().optional(),
    message: z.string().min(1),
    sourceSessionId: z.string().min(1),
    sourceWorkspaceId: z.string().min(1),
    sourceProjectPath: z.string().optional(),
  })

  app.post<{ Params: { id: string }; Body: any }>("/workspaces/:id/plugin/cross-session/send-message", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const parsed = SendMessageSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error.issues })
      return
    }

    const result = await deps.crossSessionManager.sendMessage(parsed.data)
    if (!result.success) {
      reply.code(422).send({ error: result.error })
      return
    }

    return result
  })

  if (deps.autoContinueManager) {
    app.post<{ Params: { id: string }; Body: { sessionId?: string } }>(
      "/workspaces/:id/plugin/auto-continue/stop",
      async (request, reply) => {
        const workspace = deps.workspaceManager.get(request.params.id)
        if (!workspace) {
          reply.code(404).send({ error: "Workspace not found" })
          return
        }

        const sessionId = request.body?.sessionId
        if (!sessionId) {
          reply.code(400).send({ error: "sessionId is required in body" })
          return
        }

        deps.autoContinueManager!.setConfig(request.params.id, sessionId, { enabled: false })
        return { stopped: true }
      },
    )

    app.get<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
      "/workspaces/:id/plugin/auto-continue/status",
      async (request, reply) => {
        const workspace = deps.workspaceManager.get(request.params.id)
        if (!workspace) {
          reply.code(404).send({ error: "Workspace not found" })
          return
        }

        const sessionId = request.query.sessionId
        if (!sessionId) {
          reply.code(400).send({ error: "sessionId query parameter is required" })
          return
        }

        const state = deps.autoContinueManager!.getState(request.params.id, sessionId)
        if (!state) {
          return {
            enabled: false,
            prompt: "",
            triggerCount: 0,
            maxTriggers: 20,
            cooldownMs: 60000,
            lastTriggerAt: 0,
          }
        }
        return {
          enabled: state.config.enabled,
          prompt: state.config.prompt,
          cooldownMs: state.config.cooldownMs,
          maxTriggers: state.config.maxTriggers,
          confirmSeconds: state.config.confirmSeconds,
          triggerCount: state.triggerCount,
          lastTriggerAt: state.lastTriggerAt,
        }
      },
    )
  }

  const handleWildcard = async (request: any, reply: any) => {
    const workspaceId = request.params.id as string
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const suffix = (request.params["*"] as string | undefined) ?? ""
    const normalized = suffix.replace(/^\/+/, "")

    if (normalized === "event" && request.method === "POST") {
      const parsed = PluginEventSchema.parse(request.body ?? {})
      handlePluginEvent(workspaceId, parsed, { workspaceManager: deps.workspaceManager, eventBus: deps.eventBus, logger: deps.logger })
      reply.code(204).send()
      return
    }

    reply.code(404).send({ error: "Unknown plugin endpoint" })
  }

  app.all("/workspaces/:id/plugin/*", handleWildcard)
  app.all("/workspaces/:id/plugin", handleWildcard)
}
