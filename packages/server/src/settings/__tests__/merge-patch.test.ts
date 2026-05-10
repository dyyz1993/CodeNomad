import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isPlainObject, applyMergePatch } from "../merge-patch.js"

describe("isPlainObject", () => {
  it("returns true for {}", () => {
    assert.equal(isPlainObject({}), true)
  })

  it("returns true for { a: 1 }", () => {
    assert.equal(isPlainObject({ a: 1 }), true)
  })

  it("returns false for null", () => {
    assert.equal(isPlainObject(null), false)
  })

  it("returns false for undefined", () => {
    assert.equal(isPlainObject(undefined), false)
  })

  it("returns false for [] (array)", () => {
    assert.equal(isPlainObject([]), false)
  })

  it("returns false for 42 (number)", () => {
    assert.equal(isPlainObject(42), false)
  })

  it('returns false for "str" (string)', () => {
    assert.equal(isPlainObject("str"), false)
  })

  it("returns false for new Date() (class instance)", () => {
    assert.equal(isPlainObject(new Date()), false)
  })

  it("returns true for Object.create(null)", () => {
    assert.equal(isPlainObject(Object.create(null)), true)
  })
})

describe("applyMergePatch", () => {
  it("scalar patch replaces everything", () => {
    assert.equal(applyMergePatch({ a: 1 }, 42), 42)
  })

  it("string patch replaces", () => {
    assert.equal(applyMergePatch({ a: 1 }, "hello"), "hello")
  })

  it("array patch replaces (not merge)", () => {
    assert.deepStrictEqual(applyMergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] })
  })

  it("simple object merge", () => {
    assert.deepStrictEqual(applyMergePatch({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 })
  })

  it("null deletes key", () => {
    assert.deepStrictEqual(applyMergePatch({ a: 1, b: 2 }, { b: null }), { a: 1 })
  })

  it("nested object merge", () => {
    assert.deepStrictEqual(
      applyMergePatch({ a: { x: 1, y: 2 } }, { a: { y: 3 } }),
      { a: { x: 1, y: 3 } },
    )
  })

  it("nested null delete", () => {
    assert.deepStrictEqual(
      applyMergePatch({ a: { x: 1, y: 2 } }, { a: { y: null } }),
      { a: { x: 1 } },
    )
  })

  it("non-object current treated as empty", () => {
    assert.deepStrictEqual(applyMergePatch(null, { a: 1 }), { a: 1 })
  })

  it("number current treated as empty", () => {
    assert.deepStrictEqual(applyMergePatch(42, { a: 1 }), { a: 1 })
  })

  it("empty patch returns copy", () => {
    assert.deepStrictEqual(applyMergePatch({ a: 1 }, {}), { a: 1 })
  })

  it("empty current and empty patch", () => {
    assert.deepStrictEqual(applyMergePatch({}, {}), {})
  })

  it("deep nested merge (3 levels)", () => {
    const current = { a: { b: { c: 1, d: 2 } } }
    const patch = { a: { b: { d: 3 } } }
    assert.deepStrictEqual(applyMergePatch(current, patch), { a: { b: { c: 1, d: 3 } } })
  })

  it("patch with new key adds it", () => {
    assert.deepStrictEqual(applyMergePatch({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
  })
})
