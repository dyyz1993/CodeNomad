import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

const GIT_VERSION = parseInt(
  (execSync("git --version", { encoding: "utf8" }).match(/(\d+)\.(\d+)/) || ["0", "0", "0"])[2],
  10,
  10,
)
const HAS_WORKTREE_REMOVE = GIT_VERSION >= 17
import {
  createManagedWorktree,
  isGitAvailable,
  isValidWorktreeSlug,
  listWorktrees,
  removeWorktree,
  resolveRepoRoot,
} from "../git-worktrees"

function createTempRepo(): string {
  const raw = mkdtempSync(path.join(tmpdir(), "worktree-test-"))
  const dir = realpathSync(raw)
  execSync("git init", { cwd: dir })
  execSync("git config user.email test@test.com", { cwd: dir })
  execSync("git config user.name Test", { cwd: dir })
  writeFileSync(path.join(dir, "README.md"), "# test")
  execSync("git add .", { cwd: dir })
  execSync('git commit -m "init"', { cwd: dir })
  return dir
}

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs.length = 0
})

function track(dir: string): string {
  dirs.push(dir)
  return dir
}

describe("isValidWorktreeSlug", () => {
  it('accepts "feature-branch"', () => {
    assert.equal(isValidWorktreeSlug("feature-branch"), true)
  })

  it("rejects empty string", () => {
    assert.equal(isValidWorktreeSlug(""), false)
  })

  it("rejects whitespace-only string", () => {
    assert.equal(isValidWorktreeSlug("   "), false)
  })

  it("accepts branch-like slug with slashes", () => {
    assert.equal(isValidWorktreeSlug("a/b/c"), true)
  })

  it("rejects slug longer than 200 chars", () => {
    assert.equal(isValidWorktreeSlug("a".repeat(201)), false)
  })

  it("rejects slug with null byte", () => {
    assert.equal(isValidWorktreeSlug("branch\x00name"), false)
  })

  it("rejects slug with control character", () => {
    assert.equal(isValidWorktreeSlug("branch\x01name"), false)
  })

  it('accepts "root" as a valid string', () => {
    assert.equal(isValidWorktreeSlug("root"), true)
  })

  it("accepts slug exactly 200 chars", () => {
    assert.equal(isValidWorktreeSlug("a".repeat(200)), true)
  })

  it("rejects slug of 201 chars", () => {
    assert.equal(isValidWorktreeSlug("a".repeat(201)), false)
  })
})

describe("resolveRepoRoot", () => {
  it("returns repoRoot and isGitRepo true for a valid git repo", async () => {
    const repo = track(createTempRepo())
    const result = await resolveRepoRoot(repo)
    assert.equal(result.isGitRepo, true)
    assert.equal(result.repoRoot, repo)
  })

  it("returns isGitRepo false for a non-git temp dir", async () => {
    const dir = track(realpathSync(mkdtempSync(path.join(tmpdir(), "non-git-"))))
    const result = await resolveRepoRoot(dir)
    assert.equal(result.isGitRepo, false)
    assert.equal(result.repoRoot, dir)
  })

  it("resolves to repo root from a nested subdirectory", async () => {
    const repo = track(createTempRepo())
    const nested = path.join(repo, "src", "lib")
    mkdirSync(nested, { recursive: true })
    const result = await resolveRepoRoot(nested)
    assert.equal(result.isGitRepo, true)
    assert.equal(result.repoRoot, repo)
  })
})

describe("isGitAvailable", () => {
  it("returns true when git is installed", async () => {
    const dir = track(realpathSync(mkdtempSync(path.join(tmpdir(), "git-avail-"))))
    const available = await isGitAvailable(dir)
    assert.equal(available, true)
  })
})

describe("listWorktrees", () => {
  it("returns single root worktree for a plain repo", async () => {
    const repo = track(createTempRepo())
    const trees = await listWorktrees({ repoRoot: repo, workspaceFolder: repo })
    assert.equal(trees.length, 1)
    assert.equal(trees[0].slug, "root")
    assert.equal(trees[0].kind, "root")
    assert.equal(trees[0].directory, repo)
  })

  it("root descriptor has a branch", async () => {
    const repo = track(createTempRepo())
    const trees = await listWorktrees({ repoRoot: repo, workspaceFolder: repo })
    assert.equal(trees.length, 1)
    assert.ok(trees[0].branch, "root descriptor should have a branch")
  })

  it("returns both root and worktree after creating one", async () => {
    const repo = track(createTempRepo())
    await createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "feat-x" })
    const trees = await listWorktrees({ repoRoot: repo, workspaceFolder: repo })
    assert.equal(trees.length, 2)
    const slugs = trees.map((t) => t.slug)
    assert.ok(slugs.includes("root"))
    assert.ok(slugs.includes("feat-x"))
  })

  it("worktree has correct slug derived from branch name", async () => {
    const repo = track(createTempRepo())
    await createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "feature/cool-stuff" })
    const trees = await listWorktrees({ repoRoot: repo, workspaceFolder: repo })
    const wt = trees.find((t) => t.kind === "worktree")
    assert.ok(wt, "should find a worktree entry")
    assert.equal(wt.branch, "feature/cool-stuff")
  })

  it("returns root-only fallback when git fails on non-repo dir", async () => {
    const nonRepo = track(realpathSync(mkdtempSync(path.join(tmpdir(), "not-a-repo-"))))
    const trees = await listWorktrees({ repoRoot: nonRepo, workspaceFolder: nonRepo })
    assert.equal(trees.length, 1)
    assert.equal(trees[0].slug, "root")
    assert.equal(trees[0].kind, "root")
  })
})

describe("createManagedWorktree + removeWorktree (integration)", () => {
  it("creates a worktree with a valid slug", async () => {
    const repo = track(createTempRepo())
    const result = await createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "feat-new" })
    assert.equal(result.slug, "feat-new")
    assert.ok(result.directory)
    assert.equal(result.branch, "feat-new")
  })

  it("created directory exists and is a git worktree", async () => {
    const repo = track(createTempRepo())
    const result = await createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "feat-check" })
    assert.ok(existsSync(result.directory))
    const output = execSync("git worktree list --porcelain", { cwd: repo, encoding: "utf8" })
    assert.ok(output.includes(result.directory))
  })

  it('rejects slug "root"', async () => {
    const repo = track(createTempRepo())
    await assert.rejects(
      () => createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "root" }),
      { message: "Invalid worktree slug" },
    )
  })

  it("rejects empty slug", async () => {
    const repo = track(createTempRepo())
    await assert.rejects(
      () => createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "" }),
      { message: "Invalid worktree slug" },
    )
  })

  it("rejects slug with control characters", async () => {
    const repo = track(createTempRepo())
    await assert.rejects(
      () => createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "bad\x01name" }),
      { message: "Invalid worktree slug" },
    )
  })

  it("removes a worktree and cleans up directory", async () => {
    if (!HAS_WORKTREE_REMOVE) return
    const repo = track(createTempRepo())
    const result = await createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "to-remove" })
    assert.ok(existsSync(result.directory))
    await removeWorktree({ workspaceFolder: repo, directory: result.directory })
    assert.ok(!existsSync(result.directory))
  })

  it("removes a worktree with force flag", async () => {
    if (!HAS_WORKTREE_REMOVE) return
    const repo = track(createTempRepo())
    const result = await createManagedWorktree({ repoRoot: repo, workspaceFolder: repo, slug: "force-remove" })
    writeFileSync(path.join(result.directory, "untracked.txt"), "dirty")
    await removeWorktree({ workspaceFolder: repo, directory: result.directory, force: true })
    assert.ok(!existsSync(result.directory))
  })
})
