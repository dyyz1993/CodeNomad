import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildOpencodeBasicAuthHeader, resolveOpencodeServerAuth } from "./opencode-auth"

describe("resolveOpencodeServerAuth", () => {
  it("uses configured OpenCode auth from workspace environment", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {
        OPENCODE_SERVER_USERNAME: "alice",
        OPENCODE_SERVER_PASSWORD: "secret",
      },
      processEnv: {},
      generatePassword: () => "generated",
    })

    assert.deepEqual(auth, { username: "alice", password: "secret" })
  })

  it("uses process environment when workspace environment does not provide credentials", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {},
      processEnv: {
        OPENCODE_SERVER_PASSWORD: "process-secret",
      },
      generatePassword: () => "generated",
    })

    assert.deepEqual(auth, { username: "codenomad", password: "process-secret" })
  })

  it("falls back to generated credentials", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {},
      processEnv: {},
      generatePassword: () => "generated",
    })

    assert.deepEqual(auth, { username: "codenomad", password: "generated" })
  })

  it("ignores whitespace-only values and falls through to next source", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {
        OPENCODE_SERVER_PASSWORD: "   ",
      },
      processEnv: {
        OPENCODE_SERVER_PASSWORD: "real-password",
      },
      generatePassword: () => "generated",
    })

    assert.equal(auth.password, "real-password")
  })

  it("prefers workspace env username over process env username", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {
        OPENCODE_SERVER_USERNAME: "ws-user",
      },
      processEnv: {
        OPENCODE_SERVER_USERNAME: "proc-user",
      },
      generatePassword: () => "generated",
    })

    assert.equal(auth.username, "ws-user")
  })
})

describe("buildOpencodeBasicAuthHeader", () => {
  it("returns Basic auth header with base64-encoded credentials", () => {
    const header = buildOpencodeBasicAuthHeader({ username: "alice", password: "s3cret" })

    assert.equal(header, "Basic " + Buffer.from("alice:s3cret", "utf8").toString("base64"))
  })

  it("returns undefined when username is missing", () => {
    assert.equal(buildOpencodeBasicAuthHeader({ password: "s3cret" }), undefined)
  })

  it("returns undefined when password is missing", () => {
    assert.equal(buildOpencodeBasicAuthHeader({ username: "alice" }), undefined)
  })

  it("returns undefined when both are missing", () => {
    assert.equal(buildOpencodeBasicAuthHeader({}), undefined)
  })

  it("returns undefined when both are provided as empty strings", () => {
    assert.equal(buildOpencodeBasicAuthHeader({ username: "", password: "" }), undefined)
  })
})
