import type { SetStoreFunction } from "solid-js/store"
import type { ClientPart } from "../../types/message"
import type { InstanceMessageState, LatestTodoSnapshot, MessageRecord } from "./types"

const TODO_TOOL_NAME = "todowrite"

export interface TodoOps {
  isCompletedTodoPart: (part: ClientPart | undefined) => boolean
  recordLatestTodoSnapshot: (sessionId: string, snapshot: LatestTodoSnapshot) => void
  maybeUpdateLatestTodoFromRecord: (record: MessageRecord | undefined) => void
  clearLatestTodoSnapshot: (sessionId: string) => void
}

export function createTodoOps(
  state: InstanceMessageState,
  setState: SetStoreFunction<InstanceMessageState>,
): TodoOps {
  function isCompletedTodoPart(part: ClientPart | undefined): boolean {
    if (!part || (part as any).type !== "tool") {
      return false
    }
    const toolName = typeof (part as any).tool === "string" ? (part as any).tool : ""
    if (toolName !== TODO_TOOL_NAME) {
      return false
    }
    const toolState = (part as any).state
    if (!toolState || typeof toolState !== "object") {
      return false
    }
    return (toolState as { status?: string }).status === "completed"
  }

  function recordLatestTodoSnapshot(sessionId: string, snapshot: LatestTodoSnapshot) {
    if (!sessionId) return
    setState("latestTodos", sessionId, (existing) => {
      if (existing && existing.timestamp > snapshot.timestamp) {
        return existing
      }
      return snapshot
    })
  }

  function maybeUpdateLatestTodoFromRecord(record: MessageRecord | undefined) {
    if (!record || !Array.isArray(record.partIds) || record.partIds.length === 0) {
      return
    }
    for (let index = record.partIds.length - 1; index >= 0; index -= 1) {
      const partId = record.partIds[index]
      const partRecord = record.parts[partId]
      if (!partRecord) continue
      if (isCompletedTodoPart(partRecord.data)) {
        const timestamp = typeof record.updatedAt === "number" ? record.updatedAt : Date.now()
        recordLatestTodoSnapshot(record.sessionId, { messageId: record.id, partId, timestamp })
        break
      }
    }
  }

  function clearLatestTodoSnapshot(sessionId: string) {
    setState("latestTodos", sessionId, undefined)
  }

  return { isCompletedTodoPart, recordLatestTodoSnapshot, maybeUpdateLatestTodoFromRecord, clearLatestTodoSnapshot }
}
