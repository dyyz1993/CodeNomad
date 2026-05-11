import { createEffect, onCleanup, untrack } from "solid-js"
import type { Setter } from "solid-js"
import type { TimelineSegment } from "../message-timeline"
import { buildTimelineSegments } from "../message-timeline"
import { seedTimeline, appendTimelineForMessage, makeTimelineKey } from "./timeline-helpers"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"

type TranslateFn = (key: string, params?: Record<string, unknown>) => string

interface TimelineSyncDeps {
  props: {
    loading?: boolean
    instanceId: string
    sessionId: string
  }
  messageIds: () => string[]
  store: () => InstanceMessageStore
  sessionRevision: () => number
  timelineSegments: () => TimelineSegment[]
  setTimelineSegments: Setter<TimelineSegment[]>
  selectedTimelineIds: () => Set<string>
  setSelectedTimelineIds: Setter<Set<string>>
  handleClearTimelineSelection: () => void
  t: TranslateFn
}

export function installTimelineEffects(deps: TimelineSyncDeps) {
  const {
    props,
    messageIds,
    store,
    sessionRevision,
    setTimelineSegments,
    selectedTimelineIds,
    setSelectedTimelineIds,
    handleClearTimelineSelection,
    t,
  } = deps

  const seenTimelineMessageIds = new Set<string>()
  const seenTimelineSegmentKeys = new Set<string>()
  const timelinePartCountsByMessageId = new Map<string, number>()
  let pendingTimelineMessagePartUpdates = new Set<string>()
  let pendingTimelinePartUpdateFrame: number | null = null
  let previousTimelineIds: string[] = []

  function clearPendingTimelinePartUpdateFrame() {
    if (pendingTimelinePartUpdateFrame !== null) {
      cancelAnimationFrame(pendingTimelinePartUpdateFrame)
      pendingTimelinePartUpdateFrame = null
    }
  }

  function scheduleTimelinePartUpdateFlush() {
    if (pendingTimelinePartUpdateFrame !== null) return
    pendingTimelinePartUpdateFrame = requestAnimationFrame(() => {
      pendingTimelinePartUpdateFrame = null
      if (pendingTimelineMessagePartUpdates.size === 0) return
      const changedIds = Array.from(pendingTimelineMessagePartUpdates)
      pendingTimelineMessagePartUpdates = new Set<string>()

      const ids = messageIds()
      const resolvedStore = store()

      setTimelineSegments((prev) => {
        let next = prev

        for (const changedId of changedIds) {
          next = next.filter((segment) => segment.messageId !== changedId)
          const record = resolvedStore.getMessage(changedId)
          const rebuilt = record ? buildTimelineSegments(props.instanceId, record, t) : []
          if (rebuilt.length > 0) {
            let insertAt = next.length
            const changedIndex = ids.indexOf(changedId)
            if (changedIndex >= 0) {
              for (let i = changedIndex + 1; i < ids.length; i++) {
                const followingId = ids[i]
                const existingIndex = next.findIndex((segment) => segment.messageId === followingId)
                if (existingIndex >= 0) {
                  insertAt = existingIndex
                  break
                }
              }
            }
            next = [...next.slice(0, insertAt), ...rebuilt, ...next.slice(insertAt)]
          }
        }

        seenTimelineSegmentKeys.clear()
        next.forEach((segment) => seenTimelineSegmentKeys.add(makeTimelineKey(segment)))
        return next
      })

      setSelectedTimelineIds((prev) => {
        if (prev.size === 0) return prev
        const currentIds = new Set(deps.timelineSegments().map((s) => s.id))
        const pruned = new Set([...prev].filter((id) => currentIds.has(id)))
        return pruned.size === prev.size ? prev : pruned
      })
    })
  }

  createEffect(() => {
    const loading = Boolean(props.loading)
    const ids = messageIds()

    untrack(() => {
      if (loading) {
        handleClearTimelineSelection()
        previousTimelineIds = []
        setTimelineSegments([])
        seenTimelineMessageIds.clear()
        seenTimelineSegmentKeys.clear()
        timelinePartCountsByMessageId.clear()
        pendingTimelineMessagePartUpdates.clear()
        if (pendingTimelinePartUpdateFrame !== null) {
          cancelAnimationFrame(pendingTimelinePartUpdateFrame)
          pendingTimelinePartUpdateFrame = null
        }
        return
      }

      if (previousTimelineIds.length === 0 && ids.length > 0) {
        seedTimeline(
          messageIds, store, props.instanceId, t,
          seenTimelineMessageIds, seenTimelineSegmentKeys,
          timelinePartCountsByMessageId,
          (segments) => setTimelineSegments(segments),
        )
        previousTimelineIds = [...ids]
        return
      }

      if (ids.length < previousTimelineIds.length) {
        seedTimeline(
          messageIds, store, props.instanceId, t,
          seenTimelineMessageIds, seenTimelineSegmentKeys,
          timelinePartCountsByMessageId,
          (segments) => setTimelineSegments(segments),
        )
        previousTimelineIds = [...ids]
        return
      }

      if (ids.length === previousTimelineIds.length) {
        let changedIndex = -1
        let changeCount = 0
        for (let index = 0; index < ids.length; index++) {
          if (ids[index] !== previousTimelineIds[index]) {
            changedIndex = index
            changeCount += 1
            if (changeCount > 1) break
          }
        }
        if (changeCount === 1 && changedIndex >= 0) {
          const oldId = previousTimelineIds[changedIndex]
          const newId = ids[changedIndex]
          if (seenTimelineMessageIds.has(oldId) && !seenTimelineMessageIds.has(newId)) {
            seenTimelineMessageIds.delete(oldId)
            seenTimelineMessageIds.add(newId)
            setTimelineSegments((prev) => {
              const next = prev.map((segment) => {
                if (segment.messageId !== oldId) return segment
                const updatedId = segment.id.replace(oldId, newId)
                return { ...segment, messageId: newId, id: updatedId }
              })
              seenTimelineSegmentKeys.clear()
              next.forEach((segment) => seenTimelineSegmentKeys.add(makeTimelineKey(segment)))
              return next
            })

            const existingPartCount = timelinePartCountsByMessageId.get(oldId)
            if (existingPartCount !== undefined) {
              timelinePartCountsByMessageId.delete(oldId)
              timelinePartCountsByMessageId.set(newId, existingPartCount)
            }

            previousTimelineIds = [...ids]
            return
          }
        }
      }

      const newIds: string[] = []
      ids.forEach((id) => {
        if (!seenTimelineMessageIds.has(id)) {
          newIds.push(id)
        }
      })

      if (newIds.length > 0) {
        newIds.forEach((id) => {
          seenTimelineMessageIds.add(id)
          appendTimelineForMessage(
            id, store, props.instanceId, t,
            seenTimelineSegmentKeys, timelinePartCountsByMessageId,
            (setter) => setTimelineSegments(setter),
          )
        })
      }

      previousTimelineIds = [...ids]
    })
  })

  createEffect(() => {
    if (props.loading) return
    const ids = messageIds()
    sessionRevision()

    untrack(() => {
      const resolvedStore = store()
      const idsSet = new Set(ids)
      let hasChanges = false

      for (const messageId of ids) {
        const record = resolvedStore.getMessage(messageId)
        const partCount = record?.partIds.length ?? 0
        const previousCount = timelinePartCountsByMessageId.get(messageId)

        if (previousCount === undefined) {
          timelinePartCountsByMessageId.set(messageId, partCount)
          continue
        }

        if (previousCount !== partCount) {
          timelinePartCountsByMessageId.set(messageId, partCount)
          pendingTimelineMessagePartUpdates.add(messageId)
          hasChanges = true
        }
      }

      for (const trackedId of Array.from(timelinePartCountsByMessageId.keys())) {
        if (!idsSet.has(trackedId)) {
          timelinePartCountsByMessageId.delete(trackedId)
        }
      }

      if (hasChanges) {
        scheduleTimelinePartUpdateFlush()
      }
    })
  })

  return () => {
    clearPendingTimelinePartUpdateFrame()
  }
}
