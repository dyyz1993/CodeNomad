import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isLoopbackAddress, parseCookies } from "../http-auth"

describe("isLoopbackAddress", () => {
  it("returns true for 127.0.0.1", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true)
  })

  it("returns true for ::1", () => {
    assert.equal(isLoopbackAddress("::1"), true)
  })

  it("returns true for ::ffff:127.0.0.1", () => {
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
  })

  it("returns false for external IPv4", () => {
    assert.equal(isLoopbackAddress("192.168.1.1"), false)
  })

  it("returns false for undefined", () => {
    assert.equal(isLoopbackAddress(undefined), false)
  })

  it("returns false for random string", () => {
    assert.equal(isLoopbackAddress("not-an-ip"), false)
  })
})

describe("parseCookies", () => {
  it("parses a standard cookie header", () => {
    const result = parseCookies("session=abc123; theme=dark")

    assert.deepEqual(result, { session: "abc123", theme: "dark" })
  })

  it("handles URL-encoded values", () => {
    const result = parseCookies("name=hello%20world")

    assert.equal(result.name, "hello world")
  })

  it("returns empty object for undefined header", () => {
    assert.deepEqual(parseCookies(undefined), {})
  })

  it("returns empty object for empty string", () => {
    assert.deepEqual(parseCookies(""), {})
  })

  it("skips entries without an equals sign", () => {
    const result = parseCookies("flag; session=abc")

    assert.deepEqual(result, { session: "abc" })
  })

  it("handles values containing equals signs", () => {
    const result = parseCookies("token=abc=def=ghi")

    assert.equal(result.token, "abc=def=ghi")
  })

  it("trims whitespace around keys and values", () => {
    const result = parseCookies("  key  =  value  ")

    assert.equal(result.key, "value")
  })
})
