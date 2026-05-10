import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, it } from "node:test"
import { FileSystemBrowser } from "../browser"

const tempRoots: string[] = []

function createTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fs-browser-test-"))
  mkdirSync(join(root, "src"))
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "readme.md"), "# Hello")
  writeFileSync(join(root, "src", "index.ts"), "export {}")
  tempRoots.push(root)
  return root
}

function cleanup() {
  for (const directory of tempRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("FileSystemBrowser - restricted mode", () => {
  afterEach(cleanup)

  it("list() returns entries in root", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list()
    const names = entries.map((e) => e.name)
    assert.ok(names.includes("src"))
    assert.ok(names.includes("docs"))
    assert.ok(names.includes("readme.md"))
  })

  it("list() with includeFiles: false returns only directories", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list(".", { includeFiles: false })
    const types = entries.map((e) => e.type)
    assert.ok(types.every((t) => t === "directory"))
    assert.ok(!entries.some((e) => e.name === "readme.md"))
  })

  it("list('src') returns entries in subdirectory", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list("src")
    assert.ok(entries.some((e) => e.name === "index.ts"))
  })

  it("list() entries have correct types (file/directory)", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list()
    const src = entries.find((e) => e.name === "src")
    const readme = entries.find((e) => e.name === "readme.md")
    assert.equal(src?.type, "directory")
    assert.equal(readme?.type, "file")
  })

  it("list() entries are sorted alphabetically", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list()
    const names = entries.map((e) => e.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    assert.deepEqual(names, sorted)
  })

  it("list() throws on path traversal: '../..'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("../.."), /Access outside of root/)
  })

  it("list() throws on absolute path outside root", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("/etc"), /Access outside of root/)
  })

  it("browse() returns metadata with scope 'restricted'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const result = browser.browse()
    assert.equal(result.metadata.scope, "restricted")
  })

  it("browse() metadata includes parentPath for subdirectory", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const result = browser.browse("src")
    assert.equal(result.metadata.parentPath, ".")
  })

  it("browse('.') metadata.parentPath is undefined", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const result = browser.browse(".")
    assert.equal(result.metadata.parentPath, undefined)
  })

  it("createFolder creates a new folder inside root", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const result = browser.createFolder(".", "new-folder")
    assert.ok(result.path.includes("new-folder"))
    assert.ok(statSync(result.absolutePath).isDirectory())
  })

  it("createFolder inside subdirectory works", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const result = browser.createFolder("src", "sub-module")
    assert.ok(statSync(result.absolutePath).isDirectory())
  })

  it("createFolder throws on empty name", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder(".", ""), /Folder name is required/)
  })

  it("createFolder throws on '..'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder(".", ".."), /Invalid folder name/)
  })

  it("createFolder throws on name with '/'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder(".", "a/b"), /path separators/)
  })

  it("createFolder throws on name starting with '~'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder(".", "~evil"), /Invalid folder name/)
  })

  it("createFolder throws on name with null bytes", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder(".", "bad\u0000name"), /Invalid folder name/)
  })

  it("createFolder throws if parent doesn't exist", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder("nonexistent", "folder"), /does not exist/)
  })

  it("writeFile creates file in restricted mode", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    browser.writeFile("written.txt", "hello world")
    const content = readFileSync(join(root, "written.txt"), "utf-8")
    assert.equal(content, "hello world")
  })

  it("readFile reads file in restricted mode", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const content = browser.readFile("readme.md")
    assert.equal(content, "# Hello")
  })

  it("writeFile + readFile round-trip", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    browser.writeFile("roundtrip.txt", "test data \u00e9")
    assert.equal(browser.readFile("roundtrip.txt"), "test data \u00e9")
  })
})

describe("FileSystemBrowser - unrestricted mode", () => {
  afterEach(cleanup)

  it("list() throws 'Relative listing is unavailable'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    assert.throws(() => browser.list(), /Relative listing is unavailable/)
  })

  it("writeFile() throws 'not available in unrestricted mode'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    assert.throws(() => browser.writeFile("foo.txt", "data"), /not available in unrestricted mode/)
  })

  it("readFile() throws 'not available in unrestricted mode'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    assert.throws(() => browser.readFile("foo.txt"), /not available in unrestricted mode/)
  })

  it("browse() returns metadata with scope 'unrestricted'", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    const result = browser.browse()
    assert.equal(result.metadata.scope, "unrestricted")
  })

  it("browse() with absolute path works", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    const result = browser.browse(root)
    assert.equal(result.metadata.currentPath, root)
  })

  it("browse() without path defaults to rootDir", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    const result = browser.browse(undefined)
    assert.equal(result.metadata.currentPath, root)
  })

  it("createFolder creates folder at absolute path", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    const result = browser.createFolder(root, "unrestricted-dir")
    assert.ok(statSync(result.absolutePath).isDirectory())
  })

  it("createFolder entries have absolute paths", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root, unrestricted: true })
    const result = browser.createFolder(root, "abs-check")
    assert.equal(result.path, result.absolutePath)
    assert.ok(result.absolutePath.startsWith(root))
  })
})

describe("FileSystemBrowser - path traversal prevention", () => {
  afterEach(cleanup)

  it("list('../../etc') throws access denied", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("../../etc"), /Access outside of root/)
  })

  it("list('src/../../..') throws access denied", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("src/../../.."), /Access outside of root/)
  })

  it("browse('/etc/passwd') in restricted mode throws (absolute outside root)", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.browse("/etc/passwd"), /Access outside of root/)
  })

  it("createFolder('.', '../../../etc') throws (path traversal via parent)", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.createFolder(".", "../../../etc"), /path separators/)
  })

  it("readFile('../../etc/passwd') throws access denied", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.readFile("../../etc/passwd"), /Access outside of root/)
  })

  it("writeFile('../../tmp/evil', 'data') throws access denied", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.writeFile("../../tmp/evil", "data"), /Access outside of root/)
  })
})

describe("FileSystemBrowser - edge cases", () => {
  afterEach(cleanup)

  it("list('.') same as list()", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const dotEntries = browser.list(".")
    const defaultEntries = browser.list()
    assert.deepEqual(
      dotEntries.map((e) => e.name),
      defaultEntries.map((e) => e.name),
    )
  })

  it("list('') same as list()", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const emptyEntries = browser.list("")
    const defaultEntries = browser.list()
    assert.deepEqual(
      emptyEntries.map((e) => e.name),
      defaultEntries.map((e) => e.name),
    )
  })

  it("browse(undefined) works", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const result = browser.browse(undefined)
    assert.ok(result.entries.length > 0)
    assert.equal(result.metadata.scope, "restricted")
  })

  it("entries have size for files, undefined for directories", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list()
    const file = entries.find((e) => e.type === "file")
    const dir = entries.find((e) => e.type === "directory")
    assert.equal(typeof file?.size, "number")
    assert.ok((file?.size ?? 0) > 0)
    assert.equal(dir?.size, undefined)
  })

  it("entries have modifiedAt as ISO string", () => {
    const root = createTestRoot()
    const browser = new FileSystemBrowser({ rootDir: root })
    const entries = browser.list()
    for (const entry of entries) {
      assert.ok(entry.modifiedAt, `missing modifiedAt for ${entry.name}`)
      assert.ok(
        /^\d{4}-\d{2}-\d{2}T/.test(entry.modifiedAt!),
        `invalid ISO format for ${entry.name}: ${entry.modifiedAt}`,
      )
    }
  })
})
