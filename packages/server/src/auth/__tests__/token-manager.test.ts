import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { TokenManager } from "../token-manager.js"

describe("TokenManager", () => {
  let mgr: TokenManager

  beforeEach(() => {
    mgr = new TokenManager(50)
  })

  it("peek() returns null before generate()", () => {
    assert.equal(mgr.peek(), null)
  })

  it("generate() returns a non-empty string", () => {
    const token = mgr.generate()
    assert.equal(typeof token, "string")
    assert.ok(token.length > 0)
  })

  it("peek() returns the generated token after generate()", () => {
    const token = mgr.generate()
    assert.equal(mgr.peek(), token)
  })

  it("consume() with correct token returns true", () => {
    const token = mgr.generate()
    assert.equal(mgr.consume(token), true)
  })

  it("consume() marks token as consumed, second consume returns false", () => {
    const token = mgr.generate()
    mgr.consume(token)
    assert.equal(mgr.consume(token), false)
  })

  it("consume() with wrong token returns false", () => {
    mgr.generate()
    assert.equal(mgr.consume("wrong-token"), false)
  })

  it("consume() before generate returns false", () => {
    assert.equal(mgr.consume("anything"), false)
  })

  it("consume() after TTL expires returns false", async () => {
    const token = mgr.generate()
    await delay(100)
    assert.equal(mgr.consume(token), false)
  })

  it("generate() replaces old token, old token no longer consumable", () => {
    const old = mgr.generate()
    mgr.generate()
    assert.equal(mgr.consume(old), false)
  })

  it("two consecutive generate() calls return different tokens", () => {
    const a = mgr.generate()
    const b = mgr.generate()
    assert.notEqual(a, b)
  })
})
