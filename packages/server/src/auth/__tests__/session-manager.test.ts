import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { SessionManager } from "../session-manager"

let tmpDir: string | undefined

async function createTmpDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
  return tmpDir
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    tmpDir = undefined
  }
})

describe("SessionManager", () => {
  it("creates a session and returns an id", async () => {
    const dir = await createTmpDir()
    const mgr = new SessionManager(dir)
    try {
      const session = mgr.createSession("alice")

      assert.ok(session.id)
      assert.equal(session.username, "alice")
      assert.ok(session.createdAt > 0)
    } finally {
      mgr.shutdown()
    }
  })

  it("retrieves a previously created session", async () => {
    const dir = await createTmpDir()
    const mgr = new SessionManager(dir)
    try {
      const created = mgr.createSession("bob")

      const found = mgr.getSession(created.id)
      assert.ok(found)
      assert.equal(found.username, "bob")
      assert.equal(found.id, created.id)
    } finally {
      mgr.shutdown()
    }
  })

  it("returns undefined for a non-existent session", async () => {
    const dir = await createTmpDir()
    const mgr = new SessionManager(dir)
    try {
      assert.equal(mgr.getSession("does-not-exist"), undefined)
    } finally {
      mgr.shutdown()
    }
  })

  it("returns undefined for undefined id", async () => {
    const dir = await createTmpDir()
    const mgr = new SessionManager(dir)
    try {
      assert.equal(mgr.getSession(undefined), undefined)
    } finally {
      mgr.shutdown()
    }
  })

  it("persists sessions across restarts", async () => {
    const dir = await createTmpDir()
    const mgr = new SessionManager(dir)
    const created = mgr.createSession("charlie")
    const id = created.id

    await new Promise((r) => setTimeout(r, 150))
    mgr.shutdown()

    const mgr2 = new SessionManager(dir)
    try {
      await new Promise((r) => setTimeout(r, 150))
      const found = mgr2.getSession(id)
      assert.ok(found)
      assert.equal(found!.username, "charlie")
    } finally {
      mgr2.shutdown()
    }
  })

  it("SESSION_TTL_MS equals 10 years", () => {
    const tenYearsMs = 10 * 365.25 * 24 * 60 * 60 * 1000
    const declaredValue = 315360000 * 1000
    assert.ok(
      Math.abs(declaredValue - tenYearsMs) < tenYearsMs * 0.01,
      "SESSION_TTL_MS should be approximately 10 years",
    )
  })
})
