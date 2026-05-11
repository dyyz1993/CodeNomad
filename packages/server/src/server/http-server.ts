import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import cors from "@fastify/cors"
import replyFrom from "@fastify/reply-from"
import fs from "fs"
import path from "path"
import type { Logger } from "../logger"
import { WorkspaceManager } from "../workspaces/manager"
import type { AutoContinueManager } from "../workspaces/auto-continue"
import type { SettingsService } from "../settings/service"
import { FileSystemBrowser } from "../filesystem/browser"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "./routes/workspaces"
import { registerSettingsRoutes } from "./routes/settings"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerMetaRoutes } from "./routes/meta"
import { registerEventRoutes } from "./routes/events"
import { registerStorageRoutes } from "./routes/storage"
import { registerPluginRoutes } from "./routes/plugin"
import { registerTunnelRoutes } from "./routes/tunnel"
import { registerBackgroundProcessRoutes } from "./routes/background-processes"
import { registerWorktreeRoutes } from "./routes/worktrees"
import { registerSpeechRoutes } from "./routes/speech"
import { registerRemoteServerRoutes } from "./routes/remote-servers"
import { registerRemoteProxyRoutes } from "./routes/remote-proxy"
import { registerSideCarRoutes } from "./routes/sidecars"
import { ServerMeta } from "../api-types"
import { InstanceStore } from "../storage/instance-store"
import { BackgroundProcessManager } from "../background-processes/manager"
import type { AuthManager } from "../auth/manager"
import { registerAuthRoutes } from "./routes/auth"
import { sendUnauthorized, wantsHtml } from "../auth/http-auth"
import type { SpeechService } from "../speech/service"
import { ClientConnectionManager } from "../clients/connection-manager"
import { PluginChannelManager } from "../plugins/channel"
import { VoiceModeManager } from "../plugins/voice-mode"
import { CrossSessionManager } from "../plugins/cross-session"
import type { SideCarManager } from "../sidecars/manager"
import type { RemoteProxySessionManager } from "./remote-proxy"
import type { TunnelClient } from "../tunnel/tunnel-client"
import { registerInstanceProxyRoutes } from "./proxy/instance-proxy"
import { registerSideCarProxyRoutes, setupSideCarWebSocketProxy } from "./proxy/sidecar-proxy"
import { setupStaticUi, setupDevProxy, proxyToDevServer, getIndexHtml } from "./ui-serving"

interface HttpServerDeps {
  bindHost: string
  bindPort: number
  /** When bindPort is 0, try this first. */
  defaultPort: number
  protocol: "http" | "https"
  httpsOptions?: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer }
  workspaceManager: WorkspaceManager
  autoContinueManager?: AutoContinueManager
  settings: SettingsService
  fileSystemBrowser: FileSystemBrowser
  eventBus: EventBus
  serverMeta: ServerMeta
  instanceStore: InstanceStore
  speechService: SpeechService
  sidecarManager: SideCarManager
  authManager: AuthManager
  clientConnectionManager: ClientConnectionManager
  pluginChannel: PluginChannelManager
  voiceModeManager: VoiceModeManager
  crossSessionManager: CrossSessionManager
  remoteProxySessionManager: RemoteProxySessionManager
  tunnelClient?: TunnelClient
  uiStaticDir: string
  uiDevServerUrl?: string
  logger: Logger
}

interface HttpServerStartResult {
  port: number
  url: string
  displayHost: string
}

export function createHttpServer(deps: HttpServerDeps) {
  // Fastify's type-level RawServer inference gets noisy when toggling HTTP vs HTTPS.
  // We keep the runtime behavior correct and cast the instance to a generic FastifyInstance.
  const app = Fastify(
    ({
      logger: false,
      ...(deps.protocol === "https" && deps.httpsOptions ? { https: deps.httpsOptions } : {}),
    } as unknown) as any,
  ) as unknown as FastifyInstance
  const proxyLogger = deps.logger.child({ component: "proxy" })
  const apiLogger = deps.logger.child({ component: "http" })
  const sseLogger = deps.logger.child({ component: "sse" })

  const sseClients = new Set<() => void>()
  const registerSseClient = (cleanup: () => void) => {
    sseClients.add(cleanup)
    return () => sseClients.delete(cleanup)
  }
  const closeSseClients = () => {
    for (const cleanup of Array.from(sseClients)) {
      cleanup()
    }
    sseClients.clear()
  }

  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as FastifyRequest & { __logMeta?: { start: bigint } }).__logMeta = {
      start: process.hrtime.bigint(),
    }
    done()
  })

  app.addHook("onResponse", (request, reply, done) => {
    const meta = (request as FastifyRequest & { __logMeta?: { start: bigint } }).__logMeta
    const durationMs = meta ? Number((process.hrtime.bigint() - meta.start) / BigInt(1_000_000)) : undefined
    const base = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      durationMs,
    }
    apiLogger.debug(base, "HTTP request completed")
    if (apiLogger.isLevelEnabled("trace")) {
      apiLogger.trace({ ...base, params: request.params, query: request.query, body: request.body }, "HTTP request payload")
    }
    done()
  })

  const allowedDevOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"])
  const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host.startsWith("127.")

  const getSelfOrigins = (): Set<string> => {
    const origins = new Set<string>()
    const candidates: Array<string | undefined> = [deps.serverMeta.localUrl, deps.serverMeta.remoteUrl]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        origins.add(new URL(candidate).origin)
      } catch {
        // ignore
      }
    }
    for (const addr of deps.serverMeta.addresses ?? []) {
      try {
        origins.add(new URL(addr.remoteUrl).origin)
      } catch {
        // ignore
      }
    }
    return origins
  }

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true)
        return
      }

      const selfOrigins = getSelfOrigins()
      if (selfOrigins.has(origin)) {
        cb(null, true)
        return
      }

       if (allowedDevOrigins.has(origin)) {
         cb(null, true)
         return
       }

        // When we bind to a non-loopback host (e.g., 0.0.0.0 or LAN IP), allow cross-origin UI access
        // only from known self origins or dev origins to prevent CSRF.
        if (deps.bindHost === "0.0.0.0" || !isLoopbackHost(deps.bindHost)) {
          const selfOriginsSet = getSelfOrigins()
          if (selfOriginsSet.has(origin) || allowedDevOrigins.has(origin)) {
            cb(null, true)
            return
          }
          cb(null, false)
          return
        }


      cb(null, false)
    },
    credentials: true,
  })

  app.register(replyFrom, {
    contentTypesToEncode: [],
    undici: {
      connections: 16,
      pipelining: 1,
      bodyTimeout: 0,
      headersTimeout: 0,
    },
  })

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500
    const message = statusCode === 500 ? "Internal Server Error" : error.message

    deps.logger.error(
      { error: error.message, url: request.url, method: request.method, statusCode },
      "Unhandled request error",
    )

    reply.status(statusCode).send({
      error: message,
      statusCode,
    })
  })

  const backgroundProcessManager = new BackgroundProcessManager({
    workspaceManager: deps.workspaceManager,
    eventBus: deps.eventBus,
    logger: deps.logger.child({ component: "background-processes" }),
  })

  registerAuthRoutes(app, { authManager: deps.authManager })

  app.addHook("preHandler", (request, reply, done) => {
    const rawUrl = request.raw.url ?? request.url
    const pathname = (rawUrl.split("?")[0] ?? "").trim()

    const publicApiPaths = new Set(["/api/auth/login", "/api/auth/token", "/api/auth/status", "/api/auth/logout"])
    const publicPagePaths = new Set(["/login"])
    if (deps.authManager.isTokenBootstrapEnabled()) {
      publicPagePaths.add("/auth/token")
    }

    const isLoopbackRemoteProxyDelete =
      request.method === "DELETE" &&
      pathname.startsWith("/api/remote-proxy/sessions/") &&
      deps.authManager.isLoopbackRequest(request)

    if (publicApiPaths.has(pathname) || publicPagePaths.has(pathname) || isLoopbackRemoteProxyDelete) {
      done()
      return
    }

    const session = deps.authManager.getSessionFromRequest(request)

    const requiresAuthForApi = pathname.startsWith("/api/") || pathname.startsWith("/workspaces/") || pathname.startsWith("/sidecars/")
    if (requiresAuthForApi && !session) {
      // Allow OpenCode plugin -> CodeNomad calls with per-instance basic auth.
      const pluginMatch = pathname.match(/^\/workspaces\/([^/]+)\/plugin(?:\/|$)/)
      if (pluginMatch) {
        const workspaceId = pluginMatch[1]
        const expected = deps.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
        const provided = Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization

        if (expected && provided && provided === expected) {
          done()
          return
        }
      }

      sendUnauthorized(request, reply)
      return
    }

    if (!session && wantsHtml(request)) {
      reply.redirect("/login")
      return
    }

    done()
  })

  app.get("/", async (request, reply) => {
    const session = deps.authManager.getSessionFromRequest(request)
    if (!session) {
      reply.redirect("/login")
      return
    }

    if (deps.uiDevServerUrl) {
      await proxyToDevServer(request, reply, deps.uiDevServerUrl)
      return
    }

    const uiDir = deps.uiStaticDir
    const indexPath = path.join(uiDir, "index.html")
    if (uiDir && fs.existsSync(indexPath)) {
      reply.type("text/html").send(getIndexHtml(indexPath))
      return
    }

    reply.code(404).send({ message: "UI bundle missing" })
  })

  registerWorkspaceRoutes(app, { workspaceManager: deps.workspaceManager, autoContinueManager: deps.autoContinueManager })
  registerSettingsRoutes(app, { settings: deps.settings, logger: apiLogger })
  registerFilesystemRoutes(app, { fileSystemBrowser: deps.fileSystemBrowser })
  registerMetaRoutes(app, { serverMeta: deps.serverMeta })
  registerEventRoutes(app, {
    eventBus: deps.eventBus,
    registerClient: registerSseClient,
    logger: sseLogger,
    connectionManager: deps.clientConnectionManager,
  })
  registerWorktreeRoutes(app, { workspaceManager: deps.workspaceManager })
  registerStorageRoutes(app, {
    instanceStore: deps.instanceStore,
    eventBus: deps.eventBus,
    workspaceManager: deps.workspaceManager,
  })
  registerRemoteServerRoutes(app, { logger: apiLogger })
  registerRemoteProxyRoutes(app, { logger: proxyLogger, sessionManager: deps.remoteProxySessionManager })
  registerSpeechRoutes(app, { speechService: deps.speechService })
  registerSideCarRoutes(app, { sidecarManager: deps.sidecarManager })
  registerSideCarProxyRoutes(app, { sidecarManager: deps.sidecarManager, logger: proxyLogger })
  setupSideCarWebSocketProxy(app, {
    sidecarManager: deps.sidecarManager,
    authManager: deps.authManager,
    logger: proxyLogger,
  })
  registerPluginRoutes(app, {
    workspaceManager: deps.workspaceManager,
    eventBus: deps.eventBus,
    logger: proxyLogger,
    channel: deps.pluginChannel,
    voiceModeManager: deps.voiceModeManager,
    crossSessionManager: deps.crossSessionManager,
    autoContinueManager: deps.autoContinueManager,
  })
  registerBackgroundProcessRoutes(app, { backgroundProcessManager })
  if (deps.tunnelClient?.enabled) {
    registerTunnelRoutes(app, { tunnelClient: deps.tunnelClient })
  }
  registerInstanceProxyRoutes(app, { workspaceManager: deps.workspaceManager, logger: proxyLogger })

  app.get("/api/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() }
  })


  if (deps.uiDevServerUrl) {
    setupDevProxy(app, deps.uiDevServerUrl, deps.authManager)
  } else {
    setupStaticUi(app, deps.uiStaticDir, deps.authManager)
  }

  return {
    instance: app,
    start: async (): Promise<HttpServerStartResult> => {
      const attemptListen = async (requestedPort: number) => {
        const addressInfo = await app.listen({ port: requestedPort, host: deps.bindHost })
        return { addressInfo, requestedPort }
      }

      const autoPortRequested = deps.bindPort === 0
      const primaryPort = autoPortRequested ? deps.defaultPort : deps.bindPort

      const shouldRetryWithEphemeral = (error: unknown) => {
        if (!autoPortRequested) return false
        const err = error as NodeJS.ErrnoException | undefined
        return Boolean(err && err.code === "EADDRINUSE")
      }

      let listenResult

      try {
        listenResult = await attemptListen(primaryPort)
      } catch (error) {
        if (!shouldRetryWithEphemeral(error)) {
          throw error
        }
        deps.logger.warn({ err: error, port: primaryPort }, "Preferred port unavailable, retrying on ephemeral port")
        listenResult = await attemptListen(0)
      }

      let actualPort = listenResult.requestedPort

      if (typeof listenResult.addressInfo === "string") {
        try {
          const parsed = new URL(listenResult.addressInfo)
          actualPort = Number(parsed.port) || listenResult.requestedPort
        } catch {
          actualPort = listenResult.requestedPort
        }
      } else {
        const address = app.server.address()
        if (typeof address === "object" && address) {
          actualPort = address.port
        }
      }

      const displayHost = deps.bindHost === "127.0.0.1" ? "localhost" : deps.bindHost
      const serverUrl = `${deps.protocol}://${displayHost}:${actualPort}`

      deps.logger.info({ port: actualPort, host: deps.bindHost, protocol: deps.protocol }, "HTTP server listening")

      return { port: actualPort, url: serverUrl, displayHost }
    },
    stop: () => {
      closeSseClients()
      return app.close()
    },
  }
}
