import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { YamlDocStore } from "../yaml-doc-store.js"
import type { Logger } from "../../logger.js"

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "yaml-store-test-"))
}

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
}

describe("YamlDocStore", () => {
  let tmp: string
  let filePath: string

  beforeEach(() => {
    tmp = createTempDir()
    filePath = join(tmp, "settings.yaml")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("getSync returns undefined before load", () => {
    const store = new YamlDocStore(filePath, logger)
    assert.equal(store.getSync(), undefined)
  })

  it("load on non-existent file returns empty object", async () => {
    const store = new YamlDocStore(filePath, logger)
    const doc = await store.load()
    assert.deepStrictEqual(doc, {})
  })

  it("load reads existing YAML file", async () => {
    writeFileSync(filePath, "foo: bar\nbaz: 42\n")
    const store = new YamlDocStore(filePath, logger)
    const doc = await store.load()
    assert.deepStrictEqual(doc, { foo: "bar", baz: 42 })
  })

  it("get returns loaded content", async () => {
    writeFileSync(filePath, "key: value\n")
    const store = new YamlDocStore(filePath, logger)
    const doc = await store.get()
    assert.deepStrictEqual(doc, { key: "value" })
  })

  it("replace writes to file and updates cache", async () => {
    const store = new YamlDocStore(filePath, logger)
    const result = await store.replace({ alpha: 1, beta: 2 })
    assert.deepStrictEqual(result, { alpha: 1, beta: 2 })

    const content = readFileSync(filePath, "utf-8")
    assert.ok(content.includes("alpha"))
    assert.ok(content.includes("beta"))

    assert.deepStrictEqual(store.getSync(), { alpha: 1, beta: 2 })
  })

  it("replace normalizes non-object to empty", async () => {
    const store = new YamlDocStore(filePath, logger)
    const result = await store.replace("not-an-object")
    assert.deepStrictEqual(result, {})
  })

  it("mergePatch merges into current doc", async () => {
    writeFileSync(filePath, "a: 1\nb: 2\n")
    const store = new YamlDocStore(filePath, logger)
    await store.load()
    const doc = await store.mergePatch({ b: 3, c: 4 })
    assert.deepStrictEqual(doc, { a: 1, b: 3, c: 4 })
  })

  it("mergePatch with null deletes key", async () => {
    writeFileSync(filePath, "a: 1\nb: 2\n")
    const store = new YamlDocStore(filePath, logger)
    await store.load()
    const doc = await store.mergePatch({ b: null })
    assert.deepStrictEqual(doc, { a: 1 })
  })

  it("mergePatch throws on non-object patch", async () => {
    const store = new YamlDocStore(filePath, logger)
    await assert.rejects(() => store.mergePatch("string-patch"), {
      message: "Patch must be a JSON object",
    })
  })

  it("getOwner returns sub-key as object", async () => {
    writeFileSync(filePath, "mySection:\n  x: 10\n  y: 20\nother: value\n")
    const store = new YamlDocStore(filePath, logger)
    const owner = await store.getOwner("mySection")
    assert.deepStrictEqual(owner, { x: 10, y: 20 })
  })

  it("getOwner returns empty for missing key", async () => {
    writeFileSync(filePath, "existing: true\n")
    const store = new YamlDocStore(filePath, logger)
    const owner = await store.getOwner("nonexistent")
    assert.deepStrictEqual(owner, {})
  })

  it("replaceOwner sets sub-key", async () => {
    writeFileSync(filePath, "a: 1\n")
    const store = new YamlDocStore(filePath, logger)
    await store.load()
    const result = await store.replaceOwner("b", { nested: true })
    assert.deepStrictEqual(result, { nested: true })

    assert.deepStrictEqual(store.getSync(), { a: 1, b: { nested: true } })
  })

  it("mergePatchOwner merges into sub-key", async () => {
    writeFileSync(filePath, "section:\n  x: 1\n  y: 2\n")
    const store = new YamlDocStore(filePath, logger)
    await store.load()
    const result = await store.mergePatchOwner("section", { y: 99, z: 100 })
    assert.deepStrictEqual(result, { x: 1, y: 99, z: 100 })
  })

  it("getSync returns cache after load", async () => {
    writeFileSync(filePath, "loaded: true\n")
    const store = new YamlDocStore(filePath, logger)
    assert.equal(store.getSync(), undefined)
    await store.load()
    assert.deepStrictEqual(store.getSync(), { loaded: true })
  })

  it("round-trip: write complex YAML, reload, verify", async () => {
    const original = {
      topLevel: "value",
      nested: {
        inner: {
          deep: 42,
          list: [1, 2, 3],
        },
        flag: true,
      },
      empty: null,
    }

    const store1 = new YamlDocStore(filePath, logger)
    await store1.replace(original)

    const store2 = new YamlDocStore(filePath, logger)
    const reloaded = await store2.load()

    assert.deepStrictEqual(reloaded, original)
  })
})
