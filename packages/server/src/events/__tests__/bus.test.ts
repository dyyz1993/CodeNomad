import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { EventBus } from "../bus"
import type { WorkspaceEventPayload } from "../../api-types"

describe("EventBus", () => {
  it("publish emits event to subscriber registered with on", () => {
    const bus = new EventBus()
    const received: WorkspaceEventPayload[] = []
    bus.on("workspace.created", (e) => received.push(e))

    const event: WorkspaceEventPayload = {
      type: "workspace.created",
      workspace: { id: "w1", path: "/tmp/w1" } as any,
    }
    bus.publish(event)

    assert.equal(received.length, 1)
    assert.equal(received[0].type, "workspace.created")
  })

  it("publish returns true when a listener exists", () => {
    const bus = new EventBus()
    bus.on("workspace.started", () => {})

    const result = bus.publish({
      type: "workspace.started",
      workspace: { id: "w1", path: "/tmp" } as any,
    })

    assert.equal(result, true)
  })

  it("publish returns false when no listener exists", () => {
    const bus = new EventBus()

    const result = bus.publish({
      type: "workspace.stopped",
      workspaceId: "w1",
    })

    assert.equal(result, false)
  })

  it("onEvent receives all workspace event types", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.onEvent((e) => received.push(e.type))

    bus.publish({ type: "workspace.created", workspace: {} as any })
    bus.publish({ type: "workspace.started", workspace: {} as any })
    bus.publish({ type: "workspace.error", workspace: {} as any })
    bus.publish({ type: "workspace.stopped", workspaceId: "w1" })
    bus.publish({ type: "workspace.suspended", workspace: {} as any })
    bus.publish({ type: "workspace.resumed", workspace: {} as any })

    assert.deepEqual(received, [
      "workspace.created",
      "workspace.started",
      "workspace.error",
      "workspace.stopped",
      "workspace.suspended",
      "workspace.resumed",
    ])
  })

  it("onEvent unsubscribe stops receiving events", () => {
    const bus = new EventBus()
    const received: string[] = []
    const unsub = bus.onEvent((e) => received.push(e.type))

    bus.publish({ type: "workspace.created", workspace: {} as any })
    unsub()
    bus.publish({ type: "workspace.started", workspace: {} as any })

    assert.deepEqual(received, ["workspace.created"])
  })

  it("multiple subscribers all receive the same event", () => {
    const bus = new EventBus()
    const received1: string[] = []
    const received2: string[] = []

    bus.on("workspace.log", (e) => received1.push(e.type))
    bus.on("workspace.log", (e) => received2.push(e.type))

    bus.publish({ type: "workspace.log", entry: {} as any })

    assert.equal(received1.length, 1)
    assert.equal(received2.length, 1)
  })
})
