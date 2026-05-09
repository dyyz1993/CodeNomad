import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { ClientConnectionManager } from "../connection-manager"

const noop = () => {}

function createLogger() {
  return {
    debug: noop,
    warn: noop,
    trace: noop,
    isLevelEnabled: () => false,
  } as any
}

function createRef(clientId: string, connectionId: string) {
  return {
    clientId,
    connectionId,
    close: noop,
  }
}

describe("ClientConnectionManager", () => {
  let manager: ClientConnectionManager

  afterEach(() => {
    manager?.shutdown()
  })

  it("registers a connection and reports it as connected", () => {
    manager = new ClientConnectionManager(createLogger())
    const ref = createRef("client-1", "conn-1")

    manager.register(ref)

    assert.ok(manager.isConnected({ clientId: "client-1", connectionId: "conn-1" }))
  })

  it("disconnect removes the connection", () => {
    manager = new ClientConnectionManager(createLogger())
    const closeCalls: string[] = []
    const ref = { clientId: "c1", connectionId: "c1", close: () => closeCalls.push("close") }

    const unregister = manager.register(ref)
    unregister()

    assert.ok(!manager.isConnected({ clientId: "c1", connectionId: "c1" }))
    assert.deepEqual(closeCalls, ["close"])
  })

  it("pong updates lastSeenAt and returns true for known connection", () => {
    manager = new ClientConnectionManager(createLogger())
    manager.register(createRef("c1", "c1"))

    const result = manager.pong({ clientId: "c1", connectionId: "c1" })

    assert.equal(result, true)
  })

  it("pong returns false for unknown connection", () => {
    manager = new ClientConnectionManager(createLogger())

    const result = manager.pong({ clientId: "unknown", connectionId: "unknown" })

    assert.equal(result, false)
  })

  it("emits connected event on register", () => {
    manager = new ClientConnectionManager(createLogger())
    const events: string[] = []
    manager.subscribe((e) => events.push(e.type))

    manager.register(createRef("c1", "c1"))

    assert.deepEqual(events, ["connected"])
  })

  it("emits disconnected event on unregister", () => {
    manager = new ClientConnectionManager(createLogger())
    const events: string[] = []
    manager.subscribe((e) => events.push(e.type))

    const unregister = manager.register(createRef("c1", "c1"))
    unregister()

    assert.deepEqual(events, ["connected", "disconnected"])
  })

  it("replacing a connection emits disconnected then connected", () => {
    manager = new ClientConnectionManager(createLogger())
    const events: string[] = []
    manager.subscribe((e) => events.push(e.type))

    manager.register(createRef("c1", "c1"))
    manager.register(createRef("c1", "c1"))

    assert.deepEqual(events, ["connected", "disconnected", "connected"])
  })

  it("sweepStaleConnections disconnects connections that have not ponged", () => {
    manager = new ClientConnectionManager(createLogger())
    const ref = createRef("stale", "stale")
    manager.register(ref)

    const events: string[] = []
    manager.subscribe((e) => events.push(e.type))

    ;(manager as any).sweepStaleConnections()

    assert.deepEqual(events, [])
  })

  it("subscribe returns unsubscribe function", () => {
    manager = new ClientConnectionManager(createLogger())
    const events: string[] = []
    const unsub = manager.subscribe((e) => events.push(e.type))

    unsub()
    manager.register(createRef("c1", "c1"))

    assert.deepEqual(events, [])
  })
})
