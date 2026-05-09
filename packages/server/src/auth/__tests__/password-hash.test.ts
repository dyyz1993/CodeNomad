import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { hashPassword, verifyPassword } from "../password-hash"

describe("hashPassword", () => {
  it("generates a valid scrypt hash record", () => {
    const record = hashPassword("secret123")

    assert.equal(record.algorithm, "scrypt")
    assert.equal(record.keyLength, 64)
    assert.ok(record.saltBase64)
    assert.ok(record.hashBase64)
    assert.equal(record.params.N, 16384)
    assert.equal(record.params.r, 8)
    assert.equal(record.params.p, 1)
  })

  it("produces different hashes for the same password (random salt)", () => {
    const a = hashPassword("same-password")
    const b = hashPassword("same-password")

    assert.notEqual(a.saltBase64, b.saltBase64)
    assert.notEqual(a.hashBase64, b.hashBase64)
  })
})

describe("verifyPassword", () => {
  it("returns true for the correct password", () => {
    const record = hashPassword("my-password")

    assert.equal(verifyPassword("my-password", record), true)
  })

  it("returns false for an incorrect password", () => {
    const record = hashPassword("my-password")

    assert.equal(verifyPassword("wrong-password", record), false)
  })

  it("returns false for an unsupported algorithm", () => {
    const record = hashPassword("test")
    const bad = { ...record, algorithm: "bcrypt" as const }

    assert.equal(verifyPassword("test", bad), false)
  })
})
