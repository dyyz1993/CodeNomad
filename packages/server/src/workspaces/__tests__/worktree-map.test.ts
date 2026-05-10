import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import { readWorktreeMap, writeWorktreeMap, worktreeMapExists, ensureCodenomadGitExclude } from "../worktree-map"

const DEFAULT_MAP = { version: 1 as const, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} }
const dirs: string[] = []

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktree-map-test-"))
  dirs.push(dir)
  execSync("git init", { cwd: dir, stdio: "pipe" })
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" })
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" })
  writeFileSync(join(dir, "README.md"), "# test")
  execSync("git add .", { cwd: dir, stdio: "pipe" })
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" })
  return dir
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktree-map-nongit-"))
  dirs.push(dir)
  return dir
}

function readExclude(repoRoot: string): string {
  return readFileSync(join(repoRoot, ".git", "info", "exclude"), "utf-8")
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()
    if (d) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  }
})

describe("worktreeMap", () => {
  it("readWorktreeMap returns default when no map file exists", async () => {
    const dir = createTempRepo()
    const map = await readWorktreeMap(dir)
    assert.deepEqual(map, DEFAULT_MAP)
  })

  it("writeWorktreeMap creates .codenomad/worktreeMap.json", async () => {
    const dir = createTempRepo()
    const next = { version: 1 as const, defaultWorktreeSlug: "dev", parentSessionWorktreeSlug: { s1: "dev" } }
    await writeWorktreeMap(dir, next)
    const filePath = join(dir, ".codenomad", "worktreeMap.json")
    assert.ok(existsSync(filePath))
    const map = await readWorktreeMap(dir)
    assert.deepEqual(map, next)
  })

  it("readWorktreeMap returns default for invalid JSON", async () => {
    const dir = createTempRepo()
    const cnDir = join(dir, ".codenomad")
    const { mkdirSync: mkdir } = await import("node:fs")
    mkdir(cnDir, { recursive: true })
    writeFileSync(join(cnDir, "worktreeMap.json"), "not json")
    const map = await readWorktreeMap(dir)
    assert.deepEqual(map, DEFAULT_MAP)
  })

  it("readWorktreeMap returns default for wrong version", async () => {
    const dir = createTempRepo()
    const cnDir = join(dir, ".codenomad")
    const { mkdirSync: mkdir } = await import("node:fs")
    mkdir(cnDir, { recursive: true })
    writeFileSync(join(cnDir, "worktreeMap.json"), JSON.stringify({ version: 2, defaultWorktreeSlug: "x", parentSessionWorktreeSlug: {} }))
    const map = await readWorktreeMap(dir)
    assert.deepEqual(map, DEFAULT_MAP)
  })

  it("readWorktreeMap returns default for non-object values", async () => {
    const dir = createTempRepo()
    const cnDir = join(dir, ".codenomad")
    const { mkdirSync: mkdir } = await import("node:fs")
    mkdir(cnDir, { recursive: true })

    writeFileSync(join(cnDir, "worktreeMap.json"), "null")
    assert.deepEqual(await readWorktreeMap(dir), DEFAULT_MAP)

    writeFileSync(join(cnDir, "worktreeMap.json"), "42")
    assert.deepEqual(await readWorktreeMap(dir), DEFAULT_MAP)
  })

  it("readWorktreeMap handles valid map with missing optional fields", async () => {
    const dir = createTempRepo()
    const cnDir = join(dir, ".codenomad")
    const { mkdirSync: mkdir } = await import("node:fs")
    mkdir(cnDir, { recursive: true })
    writeFileSync(join(cnDir, "worktreeMap.json"), JSON.stringify({ version: 1 }))
    const map = await readWorktreeMap(dir)
    assert.equal(map.version, 1)
    assert.equal(map.defaultWorktreeSlug, "root")
    assert.deepEqual(map.parentSessionWorktreeSlug, {})
  })

  it("worktreeMapExists returns false when no map", async () => {
    const dir = createTempRepo()
    assert.equal(worktreeMapExists(dir), false)
  })

  it("worktreeMapExists returns true after writeWorktreeMap", async () => {
    const dir = createTempRepo()
    await writeWorktreeMap(dir, { version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} })
    assert.equal(worktreeMapExists(dir), true)
  })

  it("writeWorktreeMap creates git exclude entries", async () => {
    const dir = createTempRepo()
    await writeWorktreeMap(dir, { version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} })
    const exclude = readExclude(dir)
    assert.ok(exclude.includes(".codenomad/worktrees/"))
    assert.ok(exclude.includes(".codenomad/worktreeMap.json"))
  })

  it("ensureCodenomadGitExclude adds entries to .git/info/exclude", async () => {
    const dir = createTempRepo()
    await ensureCodenomadGitExclude(dir)
    const exclude = readExclude(dir)
    assert.ok(exclude.includes(".codenomad/worktrees/"))
    assert.ok(exclude.includes(".codenomad/worktreeMap.json"))
  })

  it("ensureCodenomadGitExclude is idempotent", async () => {
    const dir = createTempRepo()
    await ensureCodenomadGitExclude(dir)
    await ensureCodenomadGitExclude(dir)
    const exclude = readExclude(dir)
    const countWt = exclude.split(".codenomad/worktrees/").length - 1
    const countMap = exclude.split(".codenomad/worktreeMap.json").length - 1
    assert.equal(countWt, 1, "worktrees entry should appear exactly once")
    assert.equal(countMap, 1, "worktreeMap.json entry should appear exactly once")
  })

  it("readWorktreeMap on non-git directory returns default", async () => {
    const dir = createTempDir()
    const map = await readWorktreeMap(dir)
    assert.deepEqual(map, DEFAULT_MAP)
  })

  it("writeWorktreeMap overwrites existing map", async () => {
    const dir = createTempRepo()
    const mapA = { version: 1 as const, defaultWorktreeSlug: "aaa", parentSessionWorktreeSlug: { s1: "aaa" } }
    const mapB = { version: 1 as const, defaultWorktreeSlug: "bbb", parentSessionWorktreeSlug: { s2: "bbb" } }
    await writeWorktreeMap(dir, mapA)
    await writeWorktreeMap(dir, mapB)
    const map = await readWorktreeMap(dir)
    assert.deepEqual(map, mapB)
  })

  it("writeWorktreeMap defaults empty defaultWorktreeSlug to root", async () => {
    const dir = createTempRepo()
    await writeWorktreeMap(dir, { version: 1, defaultWorktreeSlug: "", parentSessionWorktreeSlug: {} })
    const map = await readWorktreeMap(dir)
    assert.equal(map.defaultWorktreeSlug, "root")
  })
})
