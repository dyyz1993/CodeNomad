import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const undici = require("undici")
const _originalFetch = undici.fetch
const _fetchMock = mock.fn(async () => ({ ok: true, status: 200 } as any))
undici.fetch = _fetchMock

const Fastify = require("fastify").default || require("fastify")
const { CrossSessionManager } = require("../cross-session")
const { EventBus } = require("../../events/bus")
const { PluginChannelManager } = require("../../plugins/channel")
const { registerPluginRoutes } = require("../../server/routes/plugin")

function makeWorkspace(id: string, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    path: `/workspaces/${id}`,
    name: id,
    status: "ready",
    pid: 1234,
    port: 9999,
    proxyPath: `/proxy/${id}`,
    binaryId: "opencode",
    binaryLabel: "OpenCode",
    binaryVersion: "1.0.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function createStubLogger() {
  const stub: any = {
    child: () => stub,
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    level: "silent",
  }
  return stub
}

async function buildTestServer(workspaceOverrides: any = {}) {
  const logger = createStubLogger()
  const eventBus = new EventBus(logger)
  const channel = new PluginChannelManager()

  const workspaceManager = {
    list: workspaceOverrides.list ?? (() => []),
    get: workspaceOverrides.get ?? ((id: string) => makeWorkspace(id)),
    getInstancePort: workspaceOverrides.getInstancePort ?? (() => 9999),
    getInstanceAuthorizationHeader: workspaceOverrides.getInstanceAuthorizationHeader ?? (() => undefined),
  }

  const crossSessionManager = new CrossSessionManager(logger, workspaceManager)

  const app = Fastify()
  registerPluginRoutes(app, {
    workspaceManager: workspaceManager as any,
    eventBus: eventBus as any,
    logger: logger as any,
    channel: channel as any,
    voiceModeManager: null as any,
    crossSessionManager,
  })

  return { app, crossSessionManager }
}

describe("Cross-session REST API endpoints", () => {
  beforeEach(() => {
    _fetchMock.mock.resetCalls()
    undici.fetch = _fetchMock
  })

  afterEach(async () => {
    mock.restoreAll()
    undici.fetch = _originalFetch
  })

  describe("GET /workspaces/:id/plugin/cross-session/sessions", () => {
    it("returns 404 for unknown workspace", async () => {
      const { app } = await buildTestServer({ get: () => undefined })
      const response = await app.inject({
        method: "GET",
        url: "/workspaces/nonexistent/plugin/cross-session/sessions",
      })
      assert.equal(response.statusCode, 404)
      assert.equal(JSON.parse(response.body).error, "Workspace not found")
      await app.close()
    })

    it("returns sessions list for valid workspace", async () => {
      _fetchMock.mock.mockImplementation((url: string) => {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "sess-1", status: "active", title: "Main" }],
        })
      })

      const { app } = await buildTestServer({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
      })
      const response = await app.inject({
        method: "GET",
        url: "/workspaces/ws1/plugin/cross-session/sessions",
      })
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.ok(Array.isArray(body.sessions))
      assert.equal(body.sessions.length, 1)
      assert.equal(body.sessions[0].sessionId, "sess-1")
      await app.close()
    })
  })

  describe("GET /workspaces/:id/plugin/cross-session/history", () => {
    it("returns 400 when sessionId is missing", async () => {
      const { app } = await buildTestServer()
      const response = await app.inject({
        method: "GET",
        url: "/workspaces/ws1/plugin/cross-session/history",
      })
      assert.equal(response.statusCode, 400)
      assert.equal(JSON.parse(response.body).error, "sessionId query parameter is required")
      await app.close()
    })

    it("returns empty history for session with no records", async () => {
      const { app } = await buildTestServer()
      const response = await app.inject({
        method: "GET",
        url: "/workspaces/ws1/plugin/cross-session/history?sessionId=unknown",
      })
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.deepEqual(body.history, [])
      await app.close()
    })

    it("returns history after sending a message", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      const { app, crossSessionManager } = await buildTestServer()
      await crossSessionManager.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "test msg",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      const response = await app.inject({
        method: "GET",
        url: "/workspaces/ws1/plugin/cross-session/history?sessionId=s1",
      })
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.equal(body.history.length, 1)
      assert.equal(body.history[0].fromSessionId, "s1")
      assert.equal(body.history[0].toSessionId, "t1")
      await app.close()
    })
  })

  describe("POST /workspaces/:id/plugin/cross-session/send-message", () => {
    it("returns 404 for unknown workspace", async () => {
      const { app } = await buildTestServer({ get: () => undefined })
      const response = await app.inject({
        method: "POST",
        url: "/workspaces/nonexistent/plugin/cross-session/send-message",
        payload: {
          targetSessionId: "t1",
          message: "hello",
          sourceSessionId: "s1",
          sourceWorkspaceId: "ws-src",
        },
      })
      assert.equal(response.statusCode, 404)
      await app.close()
    })

    it("returns 400 for invalid request body", async () => {
      const { app } = await buildTestServer()
      const response = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/plugin/cross-session/send-message",
        payload: {},
      })
      assert.equal(response.statusCode, 400)
      const body = JSON.parse(response.body)
      assert.equal(body.error, "Invalid request")
      assert.ok(body.details)
      await app.close()
    })

    it("returns 400 when message is empty", async () => {
      const { app } = await buildTestServer()
      const response = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/plugin/cross-session/send-message",
        payload: {
          targetSessionId: "t1",
          message: "",
          sourceSessionId: "s1",
          sourceWorkspaceId: "ws-src",
        },
      })
      assert.equal(response.statusCode, 400)
      await app.close()
    })

    it("returns success and records message", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      const { app } = await buildTestServer()
      const response = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/plugin/cross-session/send-message",
        payload: {
          targetSessionId: "t1",
          targetWorkspaceId: "ws1",
          message: "hello from test",
          sourceSessionId: "s1",
          sourceWorkspaceId: "ws-src",
          sourceProjectPath: "/my/project",
        },
      })
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.equal(body.success, true)
      await app.close()
    })

    it("returns 422 when target workspace is not ready", async () => {
      const { app } = await buildTestServer({
        get: () => makeWorkspace("ws1", { status: "starting" }),
      })
      const response = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/plugin/cross-session/send-message",
        payload: {
          targetSessionId: "t1",
          targetWorkspaceId: "ws1",
          message: "hello",
          sourceSessionId: "s1",
          sourceWorkspaceId: "ws-src",
        },
      })
      assert.equal(response.statusCode, 422)
      assert.ok(JSON.parse(response.body).error.includes("not ready"))
      await app.close()
    })

    it("handles all optional fields correctly", async () => {
      let capturedBody: any = null
      _fetchMock.mock.mockImplementation((_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body)
        return Promise.resolve({ ok: true, status: 200 })
      })

      const { app } = await buildTestServer()
      const response = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/plugin/cross-session/send-message",
        payload: {
          targetSessionId: "t1",
          message: "optional fields test",
          sourceSessionId: "s1",
          sourceWorkspaceId: "ws-src",
          targetWorkspaceId: "ws1",
          sourceProjectPath: "/path/with/unicode/项目",
        },
      })
      assert.equal(response.statusCode, 200)

      const text = capturedBody.parts[0].text
      assert.ok(text.includes("[跨会话消息 from=s1@ws-src]"))
      assert.ok(text.includes("来源项目: /path/with/unicode/项目"))
      assert.ok(text.includes("optional fields test"))
      assert.ok(capturedBody.parts[0].synthetic)

      await app.close()
    })
  })
})
