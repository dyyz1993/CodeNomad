import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Logger } from "../../logger"
import { resolveHttpsOptions } from "../tls"

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-tls-test-"))
  tempDirs.push(dir)
  return dir
}

function createStubLogger(): Logger {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger
    },
  }
  return logger as unknown as Logger
}

describe("resolveHttpsOptions", () => {
  it("returns null when disabled", () => {
    const result = resolveHttpsOptions({
      enabled: false,
      configDir: "/tmp/unused",
      host: "localhost",
      logger: createStubLogger(),
    })
    assert.equal(result, null)
  })

  it("returns provided certs when key+cert paths are given", () => {
    const dir = makeTempDir()
    const keyContent = "-----BEGIN FAKE KEY-----\nabc123\n-----END FAKE KEY-----\n"
    const certContent = "-----BEGIN FAKE CERT-----\ndef456\n-----END FAKE CERT-----\n"

    fs.writeFileSync(path.join(dir, "key.pem"), keyContent)
    fs.writeFileSync(path.join(dir, "cert.pem"), certContent)

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "localhost",
      tlsKeyPath: path.join(dir, "key.pem"),
      tlsCertPath: path.join(dir, "cert.pem"),
      logger: createStubLogger(),
    })

    assert.ok(result)
    assert.equal(result.mode, "provided")
    assert.equal(result.httpsOptions.key, keyContent)
    assert.equal(result.httpsOptions.cert, certContent)
    assert.equal(result.httpsOptions.ca, undefined)
    assert.equal(result.caCertPath, undefined)
  })

  it("returns provided certs with optional CA", () => {
    const dir = makeTempDir()
    const keyContent = "-----BEGIN FAKE KEY-----\nabc\n-----END FAKE KEY-----\n"
    const certContent = "-----BEGIN FAKE CERT-----\ndef\n-----END FAKE CERT-----\n"
    const caContent = "-----BEGIN FAKE CA-----\nghi\n-----END FAKE CA-----\n"

    fs.writeFileSync(path.join(dir, "key.pem"), keyContent)
    fs.writeFileSync(path.join(dir, "cert.pem"), certContent)
    fs.writeFileSync(path.join(dir, "ca.pem"), caContent)

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "localhost",
      tlsKeyPath: path.join(dir, "key.pem"),
      tlsCertPath: path.join(dir, "cert.pem"),
      tlsCaPath: path.join(dir, "ca.pem"),
      logger: createStubLogger(),
    })

    assert.ok(result)
    assert.equal(result.mode, "provided")
    assert.equal(result.httpsOptions.ca, caContent)
    assert.equal(result.caCertPath, path.join(dir, "ca.pem"))
  })

  it("generates self-signed certs when no paths provided", () => {
    const dir = makeTempDir()

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "localhost",
      logger: createStubLogger(),
    })

    assert.ok(result)
    assert.equal(result.mode, "generated")
    assert.ok(result.httpsOptions.key)
    assert.ok(result.httpsOptions.cert)
    assert.ok(result.caCertPath)

    const tlsDir = path.join(dir, "tls")
    assert.ok(fs.existsSync(path.join(tlsDir, "ca-key.pem")))
    assert.ok(fs.existsSync(path.join(tlsDir, "ca-cert.pem")))
    assert.ok(fs.existsSync(path.join(tlsDir, "server-key.pem")))
    assert.ok(fs.existsSync(path.join(tlsDir, "server-cert.pem")))

    const serverCert = fs.readFileSync(path.join(tlsDir, "server-cert.pem"), "utf-8")
    const caCert = fs.readFileSync(path.join(tlsDir, "ca-cert.pem"), "utf-8")
    assert.ok(result.httpsOptions.cert.includes(serverCert.trim()))
    assert.ok(result.httpsOptions.cert.includes(caCert.trim()))
  })

  it("reuses existing generated certs on second call", () => {
    const dir = makeTempDir()

    const result1 = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "localhost",
      logger: createStubLogger(),
    })
    assert.ok(result1)

    const result2 = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "localhost",
      logger: createStubLogger(),
    })
    assert.ok(result2)

    assert.equal(result1.httpsOptions.cert, result2.httpsOptions.cert)
    assert.equal(result1.httpsOptions.key, result2.httpsOptions.key)
  })

  it("uses CN=localhost for host 0.0.0.0", () => {
    const dir = makeTempDir()

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "0.0.0.0",
      logger: createStubLogger(),
    })
    assert.ok(result)

    const certPem = result.httpsOptions.cert as string
    const firstCert = extractFirstCert(certPem)
    const x509 = new crypto.X509Certificate(firstCert)
    assert.equal(x509.subject, "CN=localhost")
  })

  it("uses CN=localhost for host 127.0.0.1", () => {
    const dir = makeTempDir()

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "127.0.0.1",
      logger: createStubLogger(),
    })
    assert.ok(result)

    const certPem = result.httpsOptions.cert as string
    const firstCert = extractFirstCert(certPem)
    const x509 = new crypto.X509Certificate(firstCert)
    assert.equal(x509.subject, "CN=localhost")
  })

  it("uses CN=hostname for a named host", () => {
    const dir = makeTempDir()

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "myhost.local",
      logger: createStubLogger(),
    })
    assert.ok(result)

    const certPem = result.httpsOptions.cert as string
    const firstCert = extractFirstCert(certPem)
    const x509 = new crypto.X509Certificate(firstCert)
    assert.equal(x509.subject, "CN=myhost.local")
  })

  it("includes SAN entries for host and extra SANs", () => {
    const dir = makeTempDir()

    const result = resolveHttpsOptions({
      enabled: true,
      configDir: dir,
      host: "myhost.local",
      tlsSANs: "10.0.0.1,extra.local",
      logger: createStubLogger(),
    })
    assert.ok(result)

    const certPem = result.httpsOptions.cert as string
    const firstCert = extractFirstCert(certPem)
    const x509 = new crypto.X509Certificate(firstCert)

    const san = x509.subjectAltName
    assert.ok(san)
    assert.match(san, /DNS:localhost/)
    assert.match(san, /DNS:myhost\.local/)
    assert.match(san, /DNS:extra\.local/)
    assert.match(san, /IP Address:127\.0\.0\.1/)
    assert.match(san, /IP Address:10\.0\.0\.1/)
  })
})

function extractFirstCert(chain: string): string {
  const start = chain.indexOf("-----BEGIN CERTIFICATE-----")
  const end = chain.indexOf("-----END CERTIFICATE-----", start)
  assert.ok(start !== -1 && end !== -1, "No certificate found in chain")
  return chain.slice(start, end + "-----END CERTIFICATE-----".length)
}
