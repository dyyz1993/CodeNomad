import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

let fetchCalls: Array<{ url: string; method: string; body: string }> = []
let mockFetchOk = true

const require = createRequire(import.meta.url)
const undici = require("undici")
const originalFetch = undici.fetch

undici.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  fetchCalls.push({
    url: String(url),
    method: init?.method ?? "GET",
    body: init?.body ? String(init.body) : "",
  })
  return {
    ok: mockFetchOk,
    status: mockFetchOk ? 200 : 500,
  } as Response
}

const { AutoContinueManager } = await import("../auto-continue.js")

function createMockLogger() {
  const logger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  }
  return logger as any
}

function createMockWorkspaceManager(port = 3210, workspacePath = "/tmp/ws") {
  return {
    getInstancePort: () => port,
    getInstanceAuthorizationHeader: () => "Bearer test-token",
    get: () => ({ path: workspacePath }),
  } as any
}

let tmpDir: string

describe("AutoContinueManager", () => {
  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fetchCalls = []
    mockFetchOk = true
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  async function createManager(port = 3210) {
    const mgr = new AutoContinueManager(createMockLogger(), createMockWorkspaceManager(port), tmpDir, 0)
    await mgr.ready()
    return mgr
  }

  it("getConfig returns defaults for unknown session", async () => {
    const mgr = await createManager()
    const config = mgr.getConfig("ws1", "s1")
    assert.equal(config.enabled, false)
    assert.equal(config.cooldownMs, 60_000)
    assert.equal(config.maxTriggers, 20)
    assert.equal(config.confirmSeconds, 5)
  })

  it("setConfig creates new session and updates config", async () => {
    const mgr = await createManager()
    const result = mgr.setConfig("ws1", "s1", { enabled: true })
    assert.equal(result.enabled, true)
    assert.equal(mgr.getConfig("ws1", "s1").enabled, true)
  })

  it("setConfig merges partial updates", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true, prompt: "hello" })
    const result = mgr.setConfig("ws1", "s1", { prompt: "world" })
    assert.equal(result.enabled, true)
    assert.equal(result.prompt, "world")
  })

  it("getState returns null for unknown session", async () => {
    const mgr = await createManager()
    assert.equal(mgr.getState("ws1", "s1"), null)
  })

  it("getState returns state after setConfig", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true })
    const state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state.config.enabled, true)
    assert.equal(state.triggerCount, 0)
    assert.equal(state.lastTriggerAt, 0)
  })

  it("cancelCountdown returns false for unknown session", async () => {
    const mgr = await createManager()
    assert.equal(mgr.cancelCountdown("ws1", "s1"), false)
  })

  it("cancelCountdown clears timer without disabling for existing session", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true, confirmSeconds: 1 })
    mgr.onSessionIdle("ws1", "s1", true)
    assert.equal(mgr.cancelCountdown("ws1", "s1"), true)
    assert.equal(mgr.getConfig("ws1", "s1").enabled, true)
    const state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state.countdownRemaining, 0)
  })

  it("onSessionIdle does nothing if not main session", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true })
    mgr.onSessionIdle("ws1", "s1", false)
    const state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state.countdownRemaining, 0)
  })

  it("onSessionIdle does nothing if session not enabled", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: false })
    mgr.onSessionIdle("ws1", "s1", true)
    const state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state.countdownRemaining, 0)
  })

  it("onSessionIdle starts countdown when enabled and triggers auto-continue", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true, confirmSeconds: 1 })
    mgr.onSessionIdle("ws1", "s1", true)

    await new Promise((r) => setTimeout(r, 100))

    const state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state.countdownRemaining, 1)

    await new Promise((r) => setTimeout(r, 1500))

    assert.equal(fetchCalls.length, 1)
    assert.ok(fetchCalls[0].url.includes("/session/s1/prompt_async"))
    assert.equal(fetchCalls[0].method, "POST")

    const afterState = mgr.getState("ws1", "s1")
    assert.ok(afterState)
    assert.equal(afterState.triggerCount, 1)
    assert.ok(afterState.lastTriggerAt > 0)
    assert.equal(afterState.countdownRemaining, 0)
  })

  it("onSessionBusy clears the countdown timer", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true, confirmSeconds: 60 })
    mgr.onSessionIdle("ws1", "s1", true)

    await new Promise((r) => setTimeout(r, 200))

    let state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.ok(state!.countdownRemaining > 0)

    mgr.onSessionBusy("ws1", "s1")

    state = mgr.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state!.countdownRemaining, 0)

    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(fetchCalls.length, 0)
  })

  it("removeSession cleans up", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true, confirmSeconds: 60 })
    mgr.onSessionIdle("ws1", "s1", true)

    mgr.removeSession("ws1", "s1")
    assert.equal(mgr.getState("ws1", "s1"), null)
    const config = mgr.getConfig("ws1", "s1")
    assert.equal(config.enabled, false)
    assert.equal(typeof config.prompt, "string")
    assert.equal(config.cooldownMs, 60_000)
    assert.equal(config.maxTriggers, 20)
    assert.equal(config.confirmSeconds, 5)
  })

  it("removeWorkspaceSessions removes all sessions for a workspace", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true })
    mgr.setConfig("ws1", "s2", { enabled: true })
    mgr.setConfig("ws2", "s3", { enabled: true })

    mgr.removeWorkspaceSessions("ws1")

    assert.equal(mgr.getState("ws1", "s1"), null)
    assert.equal(mgr.getState("ws1", "s2"), null)
    assert.ok(mgr.getState("ws2", "s3"))
  })

  it("dispose cleans up all timers", async () => {
    const mgr = await createManager()
    mgr.setConfig("ws1", "s1", { enabled: true, confirmSeconds: 60 })
    mgr.setConfig("ws2", "s2", { enabled: true, confirmSeconds: 60 })
    mgr.onSessionIdle("ws1", "s1", true)
    mgr.onSessionIdle("ws2", "s2", true)

    mgr.dispose()

    assert.equal(mgr.getState("ws1", "s1"), null)
    assert.equal(mgr.getState("ws2", "s2"), null)

    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(fetchCalls.length, 0)
  })

  it("persists state to disk and reloads", async () => {
    const logger = createMockLogger()
    const wm = createMockWorkspaceManager()
    const mgr1 = new AutoContinueManager(logger, wm, tmpDir, 0)
    await mgr1.ready()

    mgr1.setConfig("ws1", "s1", { enabled: true, prompt: "test-prompt", confirmSeconds: 3 })
    await new Promise((r) => setTimeout(r, 100))

    const mgr2 = new AutoContinueManager(logger, wm, tmpDir, 0)
    await mgr2.ready()

    const config = mgr2.getConfig("ws1", "s1")
    assert.equal(config.enabled, true)
    assert.equal(config.prompt, "test-prompt")
    assert.equal(config.confirmSeconds, 3)

    const state = mgr2.getState("ws1", "s1")
    assert.ok(state)
    assert.equal(state.triggerCount, 0)
  })
})
