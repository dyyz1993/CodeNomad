import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("SSE reconnect dedup", () => {
  it("should skip suspended instances on reconnect", () => {
    const instances = new Map([
      ["a", { status: "ready" }],
      ["b", { status: "suspended" }],
      ["c", { status: "ready" }],
    ])
    const toRefresh = []
    for (const [id, inst] of instances) {
      if (inst.status !== "suspended") {
        toRefresh.push(id)
      }
    }
    assert.deepEqual(toRefresh, ["a", "c"])
  })

  it("should debounce fetchSessions for same instance", () => {
    const lastFetchTime = new Map<string, number>()
    const DEBOUNCE_MS = 3000

    const call = (instanceId: string, now: number) => {
      const lastTime = lastFetchTime.get(instanceId) ?? 0
      if (now - lastTime > DEBOUNCE_MS) {
        lastFetchTime.set(instanceId, now)
        return true
      }
      return false
    }

    assert.equal(call("a", 5000), true)
    assert.equal(call("a", 6000), false)
    assert.equal(call("a", 7999), false)
    assert.equal(call("a", 8001), true)
    assert.equal(call("b", 8001), true)
  })
})
