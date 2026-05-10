import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { compareVersionStrings, stripTagPrefix } from "../release-monitor"

describe("stripTagPrefix", () => {
  it("removes lowercase v prefix", () => {
    assert.equal(stripTagPrefix("v1.2.3"), "1.2.3")
  })

  it("removes uppercase V prefix", () => {
    assert.equal(stripTagPrefix("V1.2.3"), "1.2.3")
  })

  it("returns version unchanged when no prefix", () => {
    assert.equal(stripTagPrefix("1.2.3"), "1.2.3")
  })

  it("returns null for undefined", () => {
    assert.equal(stripTagPrefix(undefined), null)
  })

  it("returns null for empty string", () => {
    assert.equal(stripTagPrefix(""), null)
  })

  it("returns null for whitespace-only string", () => {
    assert.equal(stripTagPrefix("  "), null)
  })

  it("trims whitespace before stripping prefix", () => {
    assert.equal(stripTagPrefix(" v1.2.3 "), "1.2.3")
  })
})

describe("compareVersionStrings", () => {
  it("returns 0 for equal versions", () => {
    assert.equal(compareVersionStrings("1.0.0", "1.0.0"), 0)
  })

  it("returns 1 when major is greater", () => {
    assert.equal(compareVersionStrings("2.0.0", "1.0.0"), 1)
  })

  it("returns -1 when major is lesser", () => {
    assert.equal(compareVersionStrings("1.0.0", "2.0.0"), -1)
  })

  it("returns 1 when minor is greater", () => {
    assert.equal(compareVersionStrings("1.2.0", "1.1.0"), 1)
  })

  it("returns 1 when patch is greater", () => {
    assert.equal(compareVersionStrings("1.0.2", "1.0.1"), 1)
  })

  it("returns 1 when release vs prerelease", () => {
    assert.equal(compareVersionStrings("1.0.0", "1.0.0-alpha"), 1)
  })

  it("returns -1 when prerelease vs release", () => {
    assert.equal(compareVersionStrings("1.0.0-alpha", "1.0.0"), -1)
  })

  it("returns 0 for equal prereleases", () => {
    assert.equal(compareVersionStrings("1.0.0-alpha", "1.0.0-alpha"), 0)
  })

  it("returns 1 when beta > alpha via localeCompare", () => {
    assert.equal(compareVersionStrings("1.0.0-beta", "1.0.0-alpha"), 1)
  })

  it("returns -1 for 0.15.30 vs 0.15.31", () => {
    assert.equal(compareVersionStrings("0.15.30", "0.15.31"), -1)
  })

  it("returns 1 for 0.15.31 vs 0.15.30", () => {
    assert.equal(compareVersionStrings("0.15.31", "0.15.30"), 1)
  })

  it("strips tag prefix before comparing", () => {
    assert.equal(compareVersionStrings("v1.0.0", "1.0.0"), 0)
  })

  it("treats missing patch as 0", () => {
    assert.equal(compareVersionStrings("1.0", "1.0.0"), 0)
  })

  it("treats non-numeric as 0.0.0", () => {
    assert.equal(compareVersionStrings("abc", "0.0.0"), 0)
  })

  it("compares dev prereleases via localeCompare", () => {
    assert.equal(compareVersionStrings("1.0.0-dev.1", "1.0.0-dev.2"), -1)
  })
})
