import { untrack } from "solid-js"
import type { TimelineSegment } from "../message-timeline"
import { buildTimelineSegments } from "../message-timeline"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"
type TranslateFn = (key: string, params?: Record<string, unknown>) => string

export function makeTimelineKey(segment: TimelineSegment) {
  return `${segment.messageId}:${segment.id}:${segment.type}`
}

export function seedTimeline(
  messageIds: () => string[],
  store: () => InstanceMessageStore,
  instanceId: string,
  t: TranslateFn,
  seenTimelineMessageIds: Set<string>,
  seenTimelineSegmentKeys: Set<string>,
  timelinePartCountsByMessageId: Map<string, number>,
  setTimelineSegments: (segments: TimelineSegment[]) => void,
) {
  seenTimelineMessageIds.clear()
  seenTimelineSegmentKeys.clear()
  timelinePartCountsByMessageId.clear()
  const ids = untrack(messageIds)
  const resolvedStore = untrack(store)
  const segments: TimelineSegment[] = []
  ids.forEach((messageId) => {
    const record = resolvedStore.getMessage(messageId)
    if (!record) return
    seenTimelineMessageIds.add(messageId)
    timelinePartCountsByMessageId.set(messageId, record.partIds.length)
    const built = buildTimelineSegments(instanceId, record, t)
    built.forEach((segment) => {
      const key = makeTimelineKey(segment)
      if (seenTimelineSegmentKeys.has(key)) return
      seenTimelineSegmentKeys.add(key)
      segments.push(segment)
    })
  })
  setTimelineSegments(segments)
}

export function appendTimelineForMessage(
  messageId: string,
  store: () => InstanceMessageStore,
  instanceId: string,
  t: TranslateFn,
  seenTimelineSegmentKeys: Set<string>,
  timelinePartCountsByMessageId: Map<string, number>,
  setTimelineSegments: (setter: (prev: TimelineSegment[]) => TimelineSegment[]) => void,
) {
  const record = untrack(() => store().getMessage(messageId))
  if (!record) return
  timelinePartCountsByMessageId.set(messageId, record.partIds.length)
  const built = buildTimelineSegments(instanceId, record, t)
  if (built.length === 0) return
  const newSegments: TimelineSegment[] = []
  built.forEach((segment) => {
    const key = makeTimelineKey(segment)
    if (seenTimelineSegmentKeys.has(key)) return
    seenTimelineSegmentKeys.add(key)
    newSegments.push(segment)
  })
  if (newSegments.length > 0) {
    setTimelineSegments((prev) => [...prev, ...newSegments])
  }
}

export function segmentMatchesSearch(
  segment: TimelineSegment,
  match: { messageId: string; partId?: string; partType?: string },
): boolean {
  if (segment.messageId !== match.messageId) return false
  if (!match.partId) return true
  if (segment.partId === match.partId) return true
  if (segment.partIds?.includes(match.partId)) return true
  if (segment.toolPartIds?.includes(match.partId)) return true
  return false
}

export function getAdjacentGroup(_clickedIndex: number, segments: TimelineSegment[]): TimelineSegment[] {
  const clicked = segments[_clickedIndex]
  if (clicked.type === "assistant") {
    let currentTurn = -1
    const turnByMessageId = new Map<string, number>()
    for (const segment of segments) {
      if (segment.type === "user") {
        currentTurn += 1
        continue
      }
      if (currentTurn === -1) currentTurn = 0
      if (!turnByMessageId.has(segment.messageId)) {
        turnByMessageId.set(segment.messageId, currentTurn)
      }
    }
    const turnIndex = turnByMessageId.get(clicked.messageId)
    if (turnIndex === undefined) {
      return segments.filter((s) => s.messageId === clicked.messageId)
    }
    return segments.filter((s) => s.type !== "user" && turnByMessageId.get(s.messageId) === turnIndex)
  }
  return [clicked]
}
