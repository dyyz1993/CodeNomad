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

describe("CrossSessionManager — e2e integration", () => {
  let logger: any
  let workspaceManager: ReturnType<typeof createMockWorkspaceManager>

  beforeEach(() => {
    logger = createStubLogger()
    workspaceManager = createMockWorkspaceManager()
    resetFetchMock()
  })

  afterEach(() => {
    mock.restoreAll()
    undici.fetch = _fetchMock
  })

  describe("auto-discovery: sendMessage without targetWorkspaceId", () => {
    it("finds session across multiple workspaces", async () => {
      _fetchMock.mock.mockImplementation((url: string) => {
        if (url.includes("prompt_async")) {
          return Promise.resolve({ ok: true, status: 200 })
        }
        if (url.includes("9001")) {
          return Promise.resolve({
            ok: true,
            json: async () => [{ id: "sess-alpha", status: "active" }],
          })
        }
        if (url.includes("9002")) {
          return Promise.resolve({
            ok: true,
            json: async () => [{ id: "sess-beta", status: "active" }],
          })
        }
        return Promise.resolve({ ok: true, json: async () => [] })
      })

      const workspaces = [
        makeWorkspace("ws-a", { status: "ready" }),
        makeWorkspace("ws-b", { status: "ready" }),
      ]

      workspaceManager = createMockWorkspaceManager({
        list: () => workspaces,
        get: (id: string) => workspaces.find((w) => w.id === id),
        getInstancePort: (id: string) => (id === "ws-a" ? 9001 : id === "ws-b" ? 9002 : undefined),
      })

      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      const result = await mgr.sendMessage({
        targetSessionId: "sess-beta",
        message: "hello from ws-a",
        sourceSessionId: "sess-alpha",
        sourceWorkspaceId: "ws-a",
      })

      assert.equal(result.success, true)
      const history = mgr.getHistory("sess-alpha")
      assert.equal(history.length, 1)
      assert.equal(history[0].toSessionId, "sess-beta")
    })

    it("returns error when session not found in any workspace", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => [{ id: "other-session", status: "active" }],
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: (id: string) => makeWorkspace(id, { status: "ready" }),
        getInstancePort: () => 9999,
      })

      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.sendMessage({
        targetSessionId: "nonexistent",
        message: "hello",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(result.success, false)
      assert.ok(result.error!.includes("not found in any workspace"))
    })

    it("skips workspaces that fail during discovery", async () => {
      let callIdx = 0
      _fetchMock.mock.mockImplementation(() => {
        callIdx++
        if (callIdx === 1) throw new Error("connection refused")
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "target-sess", status: "active" }],
        })
      })

      const workspaces = [
        makeWorkspace("ws-broken", { status: "ready" }),
        makeWorkspace("ws-ok", { status: "ready" }),
      ]

      workspaceManager = createMockWorkspaceManager({
        list: () => workspaces,
        get: (id: string) => workspaces.find((w) => w.id === id),
        getInstancePort: (id: string) => (id === "ws-broken" ? 9001 : 9002),
      })

      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      let sentBody: any = null
      _fetchMock.mock.mockImplementation((_url: string, opts: any) => {
        callIdx++
        if (callIdx === 1) throw new Error("connection refused")
        if (opts?.body) {
          sentBody = JSON.parse(opts.body)
          return Promise.resolve({ ok: true, status: 200 })
        }
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "target-sess", status: "active" }],
        })
      })

      const result = await mgr.sendMessage({
        targetSessionId: "target-sess",
        message: "hello",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(result.success, true)
    })
  })

  describe("listAllSessions — multi-workspace aggregation", () => {
    it("aggregates sessions from multiple workspaces in parallel", async () => {
      _fetchMock.mock.mockImplementation((url: string) => {
        if (url.includes("9001")) {
          return Promise.resolve({
            ok: true,
            json: async () => [
              { id: "a1", status: "active", title: "Alpha 1" },
              { id: "a2", status: "active", parentSessionId: "a1" },
            ],
          })
        }
        if (url.includes("9002")) {
          return Promise.resolve({
            ok: true,
            json: async () => [
              { id: "b1", status: "active", title: "Beta 1" },
            ],
          })
        }
        return Promise.resolve({ ok: true, json: async () => [] })
      })

      const workspaces = [
        makeWorkspace("ws-a", { status: "ready" }),
        makeWorkspace("ws-b", { status: "ready" }),
      ]

      workspaceManager = createMockWorkspaceManager({
        list: () => workspaces,
        get: (id: string) => workspaces.find((w) => w.id === id),
        getInstancePort: (id: string) => (id === "ws-a" ? 9001 : 9002),
      })

      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()

      assert.equal(result.length, 2)
      assert.ok(result.some((s: any) => s.sessionId === "a1"))
      assert.ok(result.some((s: any) => s.sessionId === "b1"))
    })

    it("caps at 5 main sessions per workspace", async () => {
      const manySessions = Array.from({ length: 8 }, (_, i) => ({
        id: `main-${i}`,
        status: "active",
        title: `Session ${i}`,
      }))

      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => manySessions,
        }),
      )

      workspaceManager = createMockWorkspaceManager({
        list: () => [makeWorkspace("ws1", { status: "ready" })],
        get: (id: string) => makeWorkspace(id, { status: "ready" }),
        getInstancePort: () => 9999,
      })

      const mgr = new CrossSessionManager(logger, workspaceManager as any)
      const result = await mgr.listAllSessions()

      assert.equal(result.length, 5)
      assert.equal(result[0].sessionId, "main-0")
      assert.equal(result[4].sessionId, "main-4")
    })
  })

  describe("sendMessage — message format edge cases", () => {
    it("truncates topic to 50 chars in history", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      const longMsg = "a".repeat(80)
      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: longMsg,
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      const history = mgr.getHistory("s1")
      assert.equal(history.length, 1)
      assert.equal(history[0].topic.length, 50)
      assert.equal(history[0].topic, "a".repeat(50))
    })

    it("encodes non-ASCII workspace path in x-opencode-directory header", async () => {
      let capturedHeaders: any = null
      _fetchMock.mock.mockImplementation((_url: string, opts: any) => {
        capturedHeaders = opts.headers
        return Promise.resolve({ ok: true, status: 200 })
      })

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready", path: "/用户/项目/codenomad" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "t1",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      assert.equal(capturedHeaders["x-opencode-directory"], encodeURIComponent("/用户/项目/codenomad"))
    })

    it("sends to correct prompt_async URL", async () => {
      let capturedUrl: string = ""
      _fetchMock.mock.mockImplementation((url: string) => {
        capturedUrl = url
        return Promise.resolve({ ok: true, status: 200 })
      })

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "sess/special+id",
        targetWorkspaceId: "ws1",
        message: "hello",
        sourceSessionId: "s1",
        sourceWorkspaceId: "ws-src",
      })

      assert.ok(capturedUrl.includes("/session/sess%2Fspecial%2Bid/prompt_async"))
      assert.ok(capturedUrl.startsWith("http://127.0.0.1:12345/"))
    })
  })

  describe("history — multi-session scenarios", () => {
    it("tracks bidirectional history for multiple sessions", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      await mgr.sendMessage({
        targetSessionId: "sess-b",
        targetWorkspaceId: "ws1",
        message: "msg1",
        sourceSessionId: "sess-a",
        sourceWorkspaceId: "ws1",
      })

      await mgr.sendMessage({
        targetSessionId: "sess-a",
        targetWorkspaceId: "ws1",
        message: "reply from b",
        sourceSessionId: "sess-b",
        sourceWorkspaceId: "ws1",
      })

      await mgr.sendMessage({
        targetSessionId: "sess-c",
        targetWorkspaceId: "ws1",
        message: "broadcast",
        sourceSessionId: "sess-a",
        sourceWorkspaceId: "ws1",
      })

      const aHistory = mgr.getHistory("sess-a")
      assert.equal(aHistory.length, 3)
      assert.equal(aHistory.filter((r) => r.fromSessionId === "sess-a").length, 2)
      assert.equal(aHistory.filter((r) => r.toSessionId === "sess-a").length, 1)

      const bHistory = mgr.getHistory("sess-b")
      assert.equal(bHistory.length, 2)

      const cHistory = mgr.getHistory("sess-c")
      assert.equal(cHistory.length, 1)
      assert.equal(cHistory[0].topic, "broadcast")
    })

    it("FIFO eviction preserves chronological order", async () => {
      _fetchMock.mock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200 }),
      )

      workspaceManager = createMockWorkspaceManager({
        get: () => makeWorkspace("ws1", { status: "ready" }),
        getInstancePort: () => 12345,
      })
      const mgr = new CrossSessionManager(logger, workspaceManager as any)

      for (let i = 0; i < 102; i++) {
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
      assert.equal(history[0].topic, "msg-2")
      assert.equal(history[99].topic, "msg-101")
    })
  })
})
