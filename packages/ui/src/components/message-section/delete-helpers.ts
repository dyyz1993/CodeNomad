import type { Setter } from "solid-js"
import type { TimelineSegment } from "../message-timeline"
import type { DeleteHoverState } from "../../types/delete-hover"
import { buildRecordDisplayData } from "../../stores/message-v2/record-display-cache"
import { getPartCharCount } from "../../lib/token-utils"
import { deleteMessage, deleteMessagePart } from "../../stores/session-actions"
import { showAlertDialog } from "../../stores/alerts"
type TranslateFn = (key: string, params?: Record<string, unknown>) => string
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"

export interface DeleteStateSignals {
  selectedTimelineIds: () => Set<string>
  setSelectedTimelineIds: Setter<Set<string>>
  setSelectedForDeletion: Setter<Set<string>>
  selectedForDeletion: () => Set<string>
  setDeleteHover: Setter<DeleteHoverState>
  setLastSelectionAnchorId: Setter<string | null>
  setIsDeleteMenuOpen: Setter<boolean>
  setSelectionMode: Setter<"all" | "tools">
  timelineSegments: () => TimelineSegment[]
  deletableMessageIds: () => Set<string>
  isMessageDeletable: (messageId: string) => boolean
  messageIds: () => string[]
  store: () => InstanceMessageStore
  instanceId: string
  sessionId: string
  t: TranslateFn
}

export function makeSelectedToolParts(
  selectedTimelineIds: () => Set<string>,
  timelineSegments: () => TimelineSegment[],
) {
  const selected = selectedTimelineIds()
  if (selected.size === 0) return [] as { messageId: string; partId: string }[]
  const segments = timelineSegments()
  const segmentById = new Map<string, TimelineSegment>()
  for (const segment of segments) segmentById.set(segment.id, segment)
  const toolParts: { messageId: string; partId: string }[] = []
  const seen = new Set<string>()
  for (const segId of selected) {
    const segment = segmentById.get(segId)
    if (!segment || segment.type !== "tool") continue
    for (const partId of segment.toolPartIds ?? []) {
      if (!partId) continue
      const key = `${segment.messageId}:${partId}`
      if (seen.has(key)) continue
      seen.add(key)
      toolParts.push({ messageId: segment.messageId, partId })
    }
  }
  return toolParts
}

export function computeDeleteToolParts(
  deleteMessageIds: () => Set<string>,
  selectedToolParts: () => { messageId: string; partId: string }[],
  deletableMessageIds: () => Set<string>,
) {
  const messageIds = deleteMessageIds()
  const allowed = deletableMessageIds()
  return selectedToolParts().filter((entry) => allowed.has(entry.messageId) && !messageIds.has(entry.messageId))
}

export function computeDeleteToolPartKeys(deleteToolParts: () => { messageId: string; partId: string }[]) {
  const set = new Set<string>()
  for (const entry of deleteToolParts()) {
    set.add(`${entry.messageId}:${entry.partId}`)
  }
  return set
}

export function computeSelectedTokenTotal(
  deleteMessageIds: () => Set<string>,
  deleteToolParts: () => { messageId: string; partId: string }[],
  store: () => InstanceMessageStore,
  instanceId: string,
  timelineSegments: () => TimelineSegment[],
) {
  const selected = deleteMessageIds()
  const toolParts = deleteToolParts()
  if (selected.size === 0 && toolParts.length === 0) return 0
  const s = store()
  let total = 0
  for (const messageId of selected) {
    let chars = 0
    const record = s.getMessage(messageId)
    if (record) {
      const displayData = buildRecordDisplayData(instanceId, record)
      for (const part of displayData.orderedParts) {
        chars += getPartCharCount(part)
      }
    } else {
      for (const seg of timelineSegments()) {
        if (seg.messageId === messageId) chars += seg.totalChars
      }
    }
    total += Math.max(Math.round(chars / 4), 1)
  }
  if (toolParts.length > 0) {
    const partFallbackChars = new Map<string, number>()
    for (const segment of timelineSegments()) {
      if (segment.type !== "tool") continue
      for (const partId of segment.toolPartIds ?? []) {
        if (!partId || partFallbackChars.has(partId)) continue
        partFallbackChars.set(partId, segment.totalChars)
      }
    }
    for (const { messageId, partId } of toolParts) {
      let chars = 0
      const record = s.getMessage(messageId)
      const partRecord = record?.parts?.[partId]
      if (partRecord?.data) {
        chars = getPartCharCount(partRecord.data)
      } else {
        chars = partFallbackChars.get(partId) ?? 0
      }
      total += Math.max(Math.round(chars / 4), 1)
    }
  }
  return total
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(tokens)
}

export function makeClearDeleteMode(signals: DeleteStateSignals) {
  return () => {
    signals.setSelectedForDeletion(new Set<string>())
    signals.setDeleteHover({ kind: "none" })
    signals.setSelectedTimelineIds(new Set<string>())
    signals.setLastSelectionAnchorId(null)
    signals.setIsDeleteMenuOpen(false)
  }
}

export function makeSetMessageSelectedForDeletion(signals: DeleteStateSignals) {
  return (messageId: string, selected: boolean) => {
    if (!messageId) return
    if (!signals.isMessageDeletable(messageId)) return
    signals.setSelectedForDeletion((prev) => {
      const next = new Set(prev)
      if (selected) {
        next.add(messageId)
      } else {
        next.delete(messageId)
      }
      return next
    })
  }
}

export function makeSelectAllForDeletion(signals: DeleteStateSignals, clearDeleteMode: () => void) {
  return () => {
    const allMessageIds = [...signals.deletableMessageIds()]
    signals.setSelectedForDeletion(new Set<string>(allMessageIds))
    const segments = signals.timelineSegments()
    signals.setSelectedTimelineIds(new Set(segments.filter((s) => signals.isMessageDeletable(s.messageId)).map((s) => s.id)))
  }
}

export function makeDeleteSelectedMessages(
  signals: DeleteStateSignals,
  clearDeleteMode: () => void,
) {
  return async () => {
    const selected = signals.selectedForDeletion()
    const toolParts = computeDeleteToolParts(
      signals.selectedForDeletion,
      () => makeSelectedToolParts(signals.selectedTimelineIds, signals.timelineSegments),
      signals.deletableMessageIds,
    )
    if (selected.size === 0 && toolParts.length === 0) return

    const allowed = signals.deletableMessageIds()
    const idsInSessionOrder = signals.messageIds()
    const toDelete: string[] = []
    for (let idx = idsInSessionOrder.length - 1; idx >= 0; idx -= 1) {
      const id = idsInSessionOrder[idx]
      if (allowed.has(id) && selected.has(id)) {
        toDelete.push(id)
      }
    }

    try {
      for (const messageId of toDelete) {
        await deleteMessage(signals.instanceId, signals.sessionId, messageId)
      }
      for (const { messageId, partId } of toolParts) {
        if (!allowed.has(messageId)) continue
        await deleteMessagePart(signals.instanceId, signals.sessionId, messageId, partId)
      }
      clearDeleteMode()
    } catch (error) {
      showAlertDialog(signals.t("messageSection.bulkDelete.failedMessage"), {
        title: signals.t("messageSection.bulkDelete.failedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }
}
