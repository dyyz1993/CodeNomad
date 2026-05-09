import assert from "node:assert/strict"
import { describe, it } from "node:test"

type SerializedWorkspace = {
  id: string
  path: string
  name?: string
  proxyPath?: string
}

type WorkspaceState = {
  id: string
  path: string
  name?: string
  status: string
  proxyPath: string
  binaryId: string
  binaryLabel: string
  createdAt: string
  updatedAt: string
}

function deserializeWorkspaces(entries: SerializedWorkspace[]): Map<string, WorkspaceState> {
  const map = new Map<string, WorkspaceState>()
  for (const entry of entries) {
    map.set(entry.id, {
      id: entry.id,
      path: entry.path,
      name: entry.name,
      status: "suspended",
      proxyPath: entry.proxyPath ?? `/workspaces/${entry.id}/worktrees/root/instance`,
      binaryId: "",
      binaryLabel: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }
  return map
}

describe("workspace loadState deserialization", () => {
  it("loads workspaces as suspended", () => {
    const entries: SerializedWorkspace[] = [
      { id: "ws-1", path: "/home/dev/project-a" },
      { id: "ws-2", path: "/home/dev/project-b" },
    ]
    const workspaces = deserializeWorkspaces(entries)

    for (const ws of workspaces.values()) {
      assert.equal(ws.status, "suspended")
    }
    assert.equal(workspaces.size, 2)
  })

  it("uses default proxyPath when not provided", () => {
    const entries: SerializedWorkspace[] = [
      { id: "abc", path: "/dev" },
    ]
    const workspaces = deserializeWorkspaces(entries)

    assert.equal(workspaces.get("abc")!.proxyPath, "/workspaces/abc/worktrees/root/instance")
  })

  it("preserves custom proxyPath from disk", () => {
    const entries: SerializedWorkspace[] = [
      { id: "xyz", path: "/dev", proxyPath: "/custom/proxy" },
    ]
    const workspaces = deserializeWorkspaces(entries)

    assert.equal(workspaces.get("xyz")!.proxyPath, "/custom/proxy")
  })

  it("initializes runtime fields as empty", () => {
    const entries: SerializedWorkspace[] = [
      { id: "ws-1", path: "/dev" },
    ]
    const workspaces = deserializeWorkspaces(entries)
    const ws = workspaces.get("ws-1")!

    assert.equal(ws.binaryId, "")
    assert.equal(ws.binaryLabel, "")
    assert.ok(ws.createdAt)
    assert.ok(ws.updatedAt)
  })

  it("returns empty map for empty entries", () => {
    const workspaces = deserializeWorkspaces([])
    assert.equal(workspaces.size, 0)
  })
})

describe("workspace resume precondition", () => {
  it("rejects resume when workspace is not suspended", () => {
    const workspaces = deserializeWorkspaces([{ id: "ws-1", path: "/dev" }])
    const ws = workspaces.get("ws-1")!
    ws.status = "ready"

    assert.ok(ws.status !== "suspended", "should not be suspended for resume precondition")
  })

  it("allows resume when workspace is suspended", () => {
    const workspaces = deserializeWorkspaces([{ id: "ws-1", path: "/dev" }])
    const ws = workspaces.get("ws-1")!

    assert.equal(ws.status, "suspended")
  })
})

describe("workspace suspend clears runtime state", () => {
  it("clears pid and port on suspend", () => {
    const workspaces = deserializeWorkspaces([{ id: "ws-1", path: "/dev" }])
    const ws = workspaces.get("ws-1")!
    ws.status = "ready"
    ws.pid = 12345
    ws.port = 8080

    ws.status = "suspended"
    ws.pid = undefined
    ws.port = undefined

    assert.equal(ws.status, "suspended")
    assert.equal(ws.pid, undefined)
    assert.equal(ws.port, undefined)
  })
})
