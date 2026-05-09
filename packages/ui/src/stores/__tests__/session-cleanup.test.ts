import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("Session cleanup on deletion", () => {
  it("should remove session from local state", () => {
    const sessions = new Map([
      ["inst1", new Map([
        ["s1", { id: "s1", title: "Session 1" }],
        ["s2", { id: "s2", title: "Session 2" }],
      ])],
    ])

    const instanceId = "inst1"
    const sessionId = "s1"
    const instanceSessions = sessions.get(instanceId)
    if (instanceSessions) {
      const next = new Map(instanceSessions)
      next.delete(sessionId)
      sessions.set(instanceId, next)
    }

    const remaining = sessions.get("inst1")
    assert.equal(remaining?.size, 1)
    assert.equal(remaining?.get("s2")?.title, "Session 2")
    assert.equal(remaining?.get("s1"), undefined)
  })
})
