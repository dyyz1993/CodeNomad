import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { WorktreeGitStatusEntry } from "../../api-types"
import { getWorktreeGitStatus } from "../git-status"

function createTempRepo(): string {
  const dir = `${tmpdir()}/git-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir, { recursive: true })
  execSync("git init", { cwd: dir, stdio: "pipe" })
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" })
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" })
  return dir
}

function commit(dir: string, message = "init") {
  execSync("git add -A", { cwd: dir, stdio: "pipe" })
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: "pipe" })
}

let tmpDir: string

beforeEach(() => {
  tmpDir = createTempRepo()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("git-status parsing (via getWorktreeGitStatus)", () => {
  it("empty repo returns empty status", async () => {
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.deepEqual(entries, [])
  })

  it("detects untracked file", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "hello")
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "hello.txt")
    assert.equal(entries[0].unstagedStatus, "untracked")
    assert.equal(entries[0].stagedStatus, null)
  })

  it("detects staged new file (added)", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "hello")
    execSync("git add hello.txt", { cwd: tmpDir, stdio: "pipe" })
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "hello.txt")
    assert.equal(entries[0].stagedStatus, "added")
    assert.equal(entries[0].unstagedStatus, null)
  })

  it("detects modified tracked file", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "hello")
    commit(tmpDir)
    writeFileSync(join(tmpDir, "hello.txt"), "hello world")
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "hello.txt")
    assert.equal(entries[0].unstagedStatus, "modified")
    assert.equal(entries[0].stagedStatus, null)
  })

  it("detects staged modification", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "hello")
    commit(tmpDir)
    writeFileSync(join(tmpDir, "hello.txt"), "hello world")
    execSync("git add hello.txt", { cwd: tmpDir, stdio: "pipe" })
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "hello.txt")
    assert.equal(entries[0].stagedStatus, "modified")
  })

  it("detects deleted file", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "hello")
    commit(tmpDir)
    execSync("rm hello.txt", { cwd: tmpDir, stdio: "pipe" })
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "hello.txt")
    assert.equal(entries[0].unstagedStatus, "deleted")
    assert.equal(entries[0].stagedStatus, null)
  })

  it("detects renamed file", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "content")
    commit(tmpDir)
    execSync("git mv a.txt b.txt", { cwd: tmpDir, stdio: "pipe" })
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "b.txt")
    assert.equal(entries[0].stagedStatus, "renamed")
    assert.equal(entries[0].originalPath, "a.txt")
  })

  it("counts numstat additions and deletions for staged changes", async () => {
    writeFileSync(join(tmpDir, "num.txt"), "line1\nline2\nline3\n")
    commit(tmpDir)
    writeFileSync(join(tmpDir, "num.txt"), "line1\nline4\nline5\nline6\n")
    execSync("git add num.txt", { cwd: tmpDir, stdio: "pipe" })
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "num.txt")
    assert.equal(entries[0].stagedStatus, "modified")
    assert.ok(entries[0].stagedAdditions > 0, `expected stagedAdditions > 0, got ${entries[0].stagedAdditions}`)
    assert.ok(entries[0].stagedDeletions > 0, `expected stagedDeletions > 0, got ${entries[0].stagedDeletions}`)
  })

  it("counts numstat for untracked files", async () => {
    writeFileSync(join(tmpDir, "new.txt"), "a\nb\nc\n")
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].unstagedStatus, "untracked")
    assert.equal(entries[0].unstagedAdditions, 3)
    assert.equal(entries[0].unstagedDeletions, 0)
  })

  it("returns multiple files sorted by path", async () => {
    writeFileSync(join(tmpDir, "c.txt"), "c")
    writeFileSync(join(tmpDir, "a.txt"), "a")
    writeFileSync(join(tmpDir, "b.txt"), "b")
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 3)
    assert.equal(entries[0].path, "a.txt")
    assert.equal(entries[1].path, "b.txt")
    assert.equal(entries[2].path, "c.txt")
  })

  it("handles subdirectory file paths", async () => {
    mkdirSync(join(tmpDir, "src", "foo"), { recursive: true })
    writeFileSync(join(tmpDir, "src", "foo", "bar.ts"), "export const x = 1")
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "src/foo/bar.ts")
    assert.equal(entries[0].unstagedStatus, "untracked")
  })

  it("tracks both staged and unstaged changes on the same file", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "v1")
    commit(tmpDir)
    writeFileSync(join(tmpDir, "hello.txt"), "v2")
    execSync("git add hello.txt", { cwd: tmpDir, stdio: "pipe" })
    writeFileSync(join(tmpDir, "hello.txt"), "v3")
    const entries = await getWorktreeGitStatus({ workspaceFolder: tmpDir })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].stagedStatus, "modified")
    assert.equal(entries[0].unstagedStatus, "modified")
  })
})
