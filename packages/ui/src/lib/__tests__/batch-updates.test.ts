import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { createBatchProcessor } from "../batch-updates.ts"

let rafCalls: Array<() => void> = []
;(globalThis as any).requestAnimationFrame = (fn: () => void) => {
  rafCalls.push(fn)
  return rafCalls.length
}

describe("createBatchProcessor", () => {
  beforeEach(() => {
    rafCalls = []
  })

  it("push collects items, flush fires callback with items", () => {
    const items: number[] = []
    const bp = createBatchProcessor((batch: number[]) => items.push(...batch))

    bp.push(1)
    bp.push(2)
    assert.equal(items.length, 0)

    bp.flush()
    assert.deepEqual(items, [1, 2])
  })

  it("items are drained from pending after flush", () => {
    const items: number[] = []
    const bp = createBatchProcessor((batch: number[]) => items.push(...batch))

    bp.push(1)
    bp.flush()
    assert.deepEqual(items, [1])

    bp.flush()
    assert.deepEqual(items, [1])
  })

  it("maxSize limits batch size", () => {
    const calls: number[][] = []
    const bp = createBatchProcessor((batch: number[]) => calls.push(batch), { maxSize: 3 })

    for (let i = 0; i < 10; i++) bp.push(i)

    bp.flush()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].length, 3)
    assert.deepEqual(calls[0], [0, 1, 2])

    bp.flush()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].length, 3)
    assert.deepEqual(calls[1], [3, 4, 5])
  })

  it("maxPending drops oldest items when limit exceeded", () => {
    const items: number[] = []
    const bp = createBatchProcessor((batch: number[]) => items.push(...batch), { maxPending: 5, maxSize: 100 })

    for (let i = 0; i < 10; i++) bp.push(i)

    bp.flush()
    assert.equal(items.length, 5)
    assert.deepEqual(items, [5, 6, 7, 8, 9])
  })

  it("multiple push before rAF fires are batched into one call", () => {
    const calls: number[][] = []
    const bp = createBatchProcessor((batch: number[]) => calls.push(batch))

    bp.push(1)
    bp.push(2)
    assert.equal(rafCalls.length, 1)

    rafCalls[0]()

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], [1, 2])
  })

  it("manual flush works and clears scheduled flag", () => {
    const items: number[] = []
    const bp = createBatchProcessor((batch: number[]) => items.push(...batch))

    bp.push(1)
    bp.flush()
    assert.deepEqual(items, [1])

    const countBefore = rafCalls.length
    bp.push(2)
    assert.equal(rafCalls.length, countBefore + 1)
  })

  it("empty flush does nothing", () => {
    let called = false
    const bp = createBatchProcessor(() => { called = true })

    bp.flush()
    assert.equal(called, false)
  })
})
