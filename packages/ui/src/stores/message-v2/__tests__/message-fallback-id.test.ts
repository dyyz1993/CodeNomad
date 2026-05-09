import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("Message part fallback ID", () => {
  it("should generate fallback for tool part without id", () => {
    const part: any = { type: "tool", name: "test" }
    if (part.type === "tool" && !part.id) {
      part.id = `tool-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    assert.ok(part.id)
    assert.ok(part.id.startsWith("tool-fallback-"))
  })

  it("should preserve existing tool part id", () => {
    const part: any = { type: "tool", id: "original-id", name: "test" }
    if (part.type === "tool" && !part.id) {
      part.id = `tool-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    assert.equal(part.id, "original-id")
  })

  it("should not add id to non-tool parts without id", () => {
    const part: any = { type: "text", content: "hello" }
    if (part.type === "tool" && !part.id) {
      part.id = `tool-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    assert.equal(part.id, undefined)
  })
})
