import assert from "node:assert/strict"
import { describe, it } from "node:test"

const PATTERN =
  /^\/(?:workspaces|api\/workspaces)\/([^/]+)(?:\/plugin|\/auto-continue)(?:\/|$)/

describe("instance auth bypass regex", () => {
  const cases: [string, string | null][] = [
    ["/workspaces/abc123/plugin/events", "abc123"],
    ["/workspaces/abc123/plugin/", "abc123"],
    ["/workspaces/abc123/plugin", "abc123"],
    ["/api/workspaces/abc123/auto-continue/session1", "abc123"],
    ["/api/workspaces/abc123/auto-continue/session1/cancel", "abc123"],
    ["/api/workspaces/def456/auto-continue/", "def456"],
    ["/workspaces/abc123/auto-continue/session1", "abc123"],
    ["/workspaces/abc123/auto-continue/session1/cancel", "abc123"],
  ]

  for (const [pathname, expectedId] of cases) {
    it(`${pathname} → matches with workspaceId=${expectedId}`, () => {
      const match = pathname.match(PATTERN)
      assert.notEqual(match, null)
      assert.equal(match![1], expectedId)
    })
  }

  const noMatchCases = [
    "/api/workspaces/xyz/sessions/test",
    "/api/sessions/abc123",
    "/workspaces/abc123/other",
  ]

  for (const pathname of noMatchCases) {
    it(`${pathname} → does NOT match`, () => {
      const match = pathname.match(PATTERN)
      assert.equal(match, null)
    })
  }
})
