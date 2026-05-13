import assert from "node:assert/strict"
import { describe, it } from "node:test"

const buildAcUrl = (
  baseUrl: string,
  instanceId: string,
  sessionId: string,
  suffix?: string,
) => {
  const clean = baseUrl.replace(/\/+$/, "")
  const base = `${clean}/api/workspaces/${encodeURIComponent(instanceId)}/auto-continue/${encodeURIComponent(sessionId)}`
  return suffix ? `${base}/${suffix}` : base
}

describe("auto-continue URL builder", () => {
  it("builds basic URL", () => {
    assert.equal(
      buildAcUrl("https://localhost:9898", "ws-1", "sess-1"),
      "https://localhost:9898/api/workspaces/ws-1/auto-continue/sess-1",
    )
  })

  it("appends suffix", () => {
    assert.equal(
      buildAcUrl("https://localhost:9898", "ws-1", "sess-1", "cancel"),
      "https://localhost:9898/api/workspaces/ws-1/auto-continue/sess-1/cancel",
    )
  })

  it("strips trailing slash from baseUrl", () => {
    assert.equal(
      buildAcUrl("https://localhost:9898/", "ws-1", "sess-1"),
      "https://localhost:9898/api/workspaces/ws-1/auto-continue/sess-1",
    )
  })

  it("encodes special characters in IDs", () => {
    const url = buildAcUrl("http://localhost:9899", "ws/1", "sess/1")
    assert.ok(url.includes("ws%2F1"))
    assert.ok(url.includes("sess%2F1"))
    assert.equal(
      url,
      "http://localhost:9899/api/workspaces/ws%2F1/auto-continue/sess%2F1",
    )
  })

  it("preserves http scheme", () => {
    assert.equal(
      buildAcUrl("http://localhost:9899", "ws-1", "sess-1"),
      "http://localhost:9899/api/workspaces/ws-1/auto-continue/sess-1",
    )
  })

  it("strips multiple trailing slashes", () => {
    assert.equal(
      buildAcUrl("https://host///", "ws-1", "sess-1"),
      "https://host/api/workspaces/ws-1/auto-continue/sess-1",
    )
  })
})
