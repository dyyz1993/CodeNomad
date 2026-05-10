import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import type { WorkspaceDescriptor } from "../../api-types"

const require = createRequire(import.meta.url)

function createMockWorkspaceManager(overrides: Partial<{
  list: () => WorkspaceDescriptor[]
  get: (id: string) => WorkspaceDescriptor | undefined
  getInstancePort: (id: string) => number | undefined
  getInstanceAuthorizationHeader: (id: string) => string | undefined
}> = {}) {
  return {
    list: overrides.list ?? (() => []),
    get: overrides.get ?? (() => undefined),
    getInstancePort: overrides.getInstancePort ?? (() => undefined),
    getInstanceAuthorizationHeader: overrides.getInstanceAuthorizationHeader ?? (() => undefined),
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

function makeWorkspace(id: string, overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
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

const _fetchMock = mock.fn(async () => ({ ok: true, status: 200 } as any))

const undici = require("undici")
const _originalFetch = undici.fetch
undici.fetch = _fetchMock

const { CrossSessionManager } = require("../cross-session")

function resetFetchMock() {
  _fetchMock.mock.resetCalls()
}

describe("CrossSessionManager", () => {
  let logger: any
  let workspaceManager: ReturnType<typeof createMockWorkspaceManager>

  beforeEach(() => {
    logger = createStubLogger()
    workspaceManager = createMockWorkspaceManager()
    resetFetchMock()
  })

  describe("listAllSessions", () => {
    it("returns empty when no workspaces", async () => {
      workspaceManager = createMockWorkspaceManager({ list: () => [] })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.deepEqual(result, [])
    })

    it("filters out non-ready workspaces", async () => {
      workspaceManager = createMockWorkspaceManager({
        list: () => [
          makeWorkspace("ws1", { status: "starting" }),
          makeWorkspace("ws2", { status: "suspended" }),
        ],
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.deepEqual(result, [])
    })

    it("skips workspaces with no instance port", async () => {
      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        getInstancePort: () => undefined,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.deepEqual(result, [])
    })

    it("returns sessions from ready workspaces with ports", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => [
            { id: "sess-1", status: "active", title: "Main" },
            { id: "sess-2", status: "active", parentSessionId: "sess-1" },
          ],
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: (id: string) => makeWorkspace(id, { status: "ready" }),
        getInstancePort: () => 9999,
        getInstanceAuthorizationHeader: () => undefined,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()

      assert.equal(_fetchMock.mock.callCount(), 1)
      assert.equal(result.length, 1)
      assert.equal(result[0].sessionId, "sess-1")
      assert.equal(result[0].isMainSession, true)
      assert.equal(result[0].workspaceId, "ws1")
      assert.equal(result[0].workspaceName, "ws1")
    })

    it("handles fetch failure gracefully", async () => {
      _fetchMock.mock.mockImplementation(() => {
        throw new Error("Connection refused")
      })

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 9999,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.deepEqual(result, [])
    })

    it("parses sessions wrapped in { data: [...] }", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            data: [{ id: "sess-d", status: "active" }],
          }),
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 9999,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.equal(result.length, 1)
      assert.equal(result[0].sessionId, "sess-d")
    })

    it("parses sessions wrapped in { sessions: [...] }", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [{ id: "sess-s", status: "active" }],
          }),
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 9999,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.equal(result.length, 1)
      assert.equal(result[0].sessionId, "sess-s")
    })

    it("returns empty for unknown response shapes", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({ foo: "bar" }),
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 9999,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.deepEqual(result, [])
    })

    it("handles non-ok fetch responses", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 9999,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()
      assert.deepEqual(result, [])
    })
  })

  describe("sendMessage", () => {
    it("fails when target workspace not found", async () => {
      workspaceManager = createMockWorkspaceManager({
        get: () => undefined,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.sendMessage({
        targetSessionId: "sess-1",
        targetWorkspaceId: "ws-x",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })
      assert.equal(result.success, false)
      assert.ok(result.error!.includes("Workspace ws-x not found"))
    })

    it("fails when workspace is not ready", async () => {
      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "starting" }),
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.sendMessage({
        targetSessionId: "sess-1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })
      assert.equal(result.success, false)
      assert.ok(result.error!.includes("not ready"))
    })

    it("fails when no instance port", async () => {
      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => undefined,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.sendMessage({
        targetSessionId: "sess-1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })
      assert.equal(result.success, false)
      assert.ok(result.error!.includes("no instance port"))
    })

    it("fails when session not found and no workspace specified", async () => {
      workspaceManager = createMockWorkspaceManager({
        list: () => [],
        get: () => undefined,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.sendMessage({
        targetSessionId: "unknown-sess",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })
      assert.equal(result.success, false)
      assert.ok(result.error!.includes("not found in any workspace"))
    })

    it("succeeds and records communication", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
        getInstanceAuthorizationHeader: () => "Bearer test",
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      const result = await mgr.sendMessage({
        targetSessionId: "sess-target",
        targetWorkspaceId: "ws1",
        message: "hello world",
        sourceSessionId: "sess-src",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(result.success, true)
      assert.equal(result.error, undefined)

      const history = mgr.getHistory("sess-src")
      assert.equal(history.length, 1)
      assert.equal(history[0].fromSessionId, "sess-src")
      assert.equal(history[0].toSessionId, "sess-target")
      assert.equal(history[0].topic, "hello world")

      const targetHistory = mgr.getHistory("sess-target")
      assert.equal(targetHistory.length, 1)
    })

    it("returns error on fetch failure", async () => {
      _fetchMock.mock.mockImplementation(() => {
        throw new Error("ECONNREFUSED")
      })

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      const result = await mgr.sendMessage({
        targetSessionId: "sess-1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(result.success, false)
      assert.ok(result.error!.includes("ECONNREFUSED"))
    })

    it("returns error on non-ok response", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      const result = await mgr.sendMessage({
        targetSessionId: "sess-1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(result.success, false)
      assert.ok(result.error!.includes("Internal Server Error"))
    })

    it("uses fallback error when response.text() fails on non-ok", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          text: async () => {
            throw new Error("text parse failed")
          },
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      const result = await mgr.sendMessage({
        targetSessionId: "sess-1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "src-1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(result.success, false)
      assert.ok(result.error!.includes("Prompt request failed with 503"))
    })
  })

  describe("getHistory", () => {
    it("returns empty for session with no records", () => {
      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      assert.deepEqual(mgr.getHistory("unknown"), [])
    })

    it("returns records matching fromSessionId", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "msg1",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })
      await mgr.sendMessage({
        targetSessionId: "t2",
        targetWorkspaceId: "ws1",
        message: "msg2",
        sourceSessionId: "s2",
        sourceWorkspaceId: "ws-src",
      })

      const s1History = mgr.getHistory("s1")
      assert.equal(s1History.length, 1)
      assert.equal(s1History[0].fromSessionId, "s1")

      const s2History = mgr.getHistory("s2")
      assert.equal(s2History.length, 1)
    })

    it("returns records matching toSessionId", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "msg1",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      const t1History = mgr.getHistory("t1")
      assert.equal(t1History.length, 1)
      assert.equal(t1History[0].toSessionId, "t1")
    })

    it("caps history at 100 records", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      for (let i = 0; i < 105; i++) {
        await mgr.sendMessage({
          targetSessionId: `t-${i}`,
          targetWorkspaceId: "ws1",
          message: `msg-${i}`,
          sourceSessionId: "s1",
          sourceWorkspaceId: "ws-src",
        })
      }

      const history = mgr.getHistory("s1")
      assert.equal(history.length, 100)
      assert.equal(history[0].toSessionId, "t-5")
      assert.equal(history[99].toSessionId, "t-104")
    })
  })

  describe("buildCrossSessionMessage (via sendMessage)", () => {
    it("sends message with correct format including sourceProjectPath", async () => {
      let capturedBody: any = null
      _fetchMock.mock.mockImplementation((_url: any, opts: any) => {
        capturedBody = JSON.parse(opts.body)
        return Promise.resolve({ ok: true, status: 200 })
      })

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
        getInstanceAuthorizationHeader: () => "Bearer tok",
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "check this",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
        sourceProjectPath: "/my/project",
      })

      const text = capturedBody.parts[0].text
      assert.ok(text.includes("[跨会话消息 from=s1@ws-src]"))
      assert.ok(text.includes("来源项目: /my/project"))
      assert.ok(text.includes("check this"))
      assert.ok(capturedBody.parts[0].synthetic)
    })

    it("sends message without sourceProjectPath", async () => {
      let capturedBody: any = null
      _fetchMock.mock.mockImplementation((_url: any, opts: any) => {
        capturedBody = JSON.parse(opts.body)
        return Promise.resolve({ ok: true, status: 200 })
      })

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "simple msg",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      const text = capturedBody.parts[0].text
      assert.ok(text.includes("[跨会话消息 from=s1@ws-src]"))
      assert.ok(!text.includes("来源项目:"))
      assert.ok(text.includes("simple msg"))
    })

    it("sets authorization header when auth is available", async () => {
      let capturedOpts: any = null
      _fetchMock.mock.mockImplementation((_url: any, opts: any) => {
        capturedOpts = opts
        return Promise.resolve({ ok: true, status: 200 })
      })

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
        getInstanceAuthorizationHeader: () => "Bearer secret-token",
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(capturedOpts.headers.authorization, "Bearer secret-token")
    })
  })

  afterEach(() => {
    mock.restoreAll()
    undici.fetch = _fetchMock
  })
})
