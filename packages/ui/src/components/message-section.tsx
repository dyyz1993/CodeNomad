import { Show, createEffect, createMemo, createSignal, onCleanup, on, untrack } from "solid-js"
import { ChevronDown, ChevronUp, MoreHorizontal, Pause, Search, Trash, X } from "lucide-solid"
import Kbd from "./kbd"
import MessageBlock from "./message-block"
import { getMessageAnchorId, getMessageIdFromAnchorId } from "./message-anchors"
import MessageTimeline, { buildTimelineSegments, type TimelineSegment } from "./message-timeline"
import VirtualFollowList, { type VirtualFollowListApi, type VirtualFollowListState } from "./virtual-follow-list"
import { useConfig } from "../stores/preferences"
import { getSessionInfo } from "../stores/sessions"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useI18n } from "../lib/i18n"
import { useScrollCache } from "../lib/hooks/use-scroll-cache"
import { partHasRenderableText } from "../types/message"
import { buildRecordDisplayData } from "../stores/message-v2/record-display-cache"
import { buildSessionSearchMatches } from "../lib/session-search"
import type { SessionSearchMatch } from "../lib/session-search"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { DeleteHoverState } from "../types/delete-hover"

import { segmentMatchesSearch, getAdjacentGroup } from "./message-section/timeline-helpers"
import {
  makeSelectedToolParts,
  computeDeleteToolParts,
  computeDeleteToolPartKeys,
  computeSelectedTokenTotal,
  formatTokenCount,
  makeClearDeleteMode,
  makeSetMessageSelectedForDeletion,
  makeSelectAllForDeletion,
  makeDeleteSelectedMessages,
} from "./message-section/delete-helpers"
import { SEARCH_MIN_CHARS } from "./message-section/search-helpers"
import {
  makeClearQuoteSelection,
  makeUpdateQuoteSelectionFromSelection,
  makeHandleQuoteSelectionRequest,
  makeHandleCopySelectionRequest,
} from "./message-section/quote-helpers"
import { installTimelineEffects } from "./message-section/use-timeline-effects"
import { installEventEffects } from "./message-section/use-event-effects"

const SCROLL_SENTINEL_MARGIN_PX = 8
const MESSAGE_SCROLL_CACHE_SCOPE = "message-stream"
const STREAMING_TEXT_HOLD_TOP_THRESHOLD_PX = 8
const SEARCH_DEBOUNCE_MS = 250
const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

export interface MessageSectionProps {
  instanceId: string
  sessionId: string
  loading?: boolean
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  registerScrollToBottom?: (fn: () => void) => void
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  onQuoteSelection?: (text: string, mode: "quote" | "code") => void
  isActive?: boolean
}

export default function MessageSection(props: MessageSectionProps) {
  const { preferences, updatePreferences } = useConfig()
  const { t } = useI18n()
  const showUsagePreference = () => preferences().showUsageMetrics ?? true
  const showTimelineToolsPreference = () => preferences().showTimelineTools ?? true
  const holdLongAssistantRepliesEnabled = () => preferences().holdLongAssistantReplies ?? true
  const store = createMemo<InstanceMessageStore>(() => messageStoreBus.getOrCreate(props.instanceId))
  const messageIds = createMemo(() => store().getSessionMessageIds(props.sessionId))
  const visibleMessageIds = createMemo(() => {
    const resolvedStore = store()
    return messageIds().filter((messageId) => {
      const record = resolvedStore.getMessage(messageId)
      if (!record) return false

      if (buildTimelineSegments(props.instanceId, record, t).length > 0) {
        return true
      }

      if (record.role !== "assistant") {
        return false
      }

      const info = resolvedStore.getMessageInfo(messageId)
      if (!info || info.role !== "assistant") {
        return false
      }

      if (info.error) {
        return true
      }

      const timeInfo = info.time as { created: number; end?: number } | undefined
      return Boolean(timeInfo && (timeInfo.end === undefined || timeInfo.end === 0))
    })
  })

  const scrollCache = useScrollCache({
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    scope: MESSAGE_SCROLL_CACHE_SCOPE,
  })

  const sessionRevision = createMemo(() => store().getSessionRevision(props.sessionId))
  const usageSnapshot = createMemo(() => store().getSessionUsage(props.sessionId))
  const sessionInfo = createMemo(() =>
    getSessionInfo(props.instanceId, props.sessionId) ?? {
      cost: 0,
      contextWindow: 0,
      isSubscriptionModel: false,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      actualUsageTokens: 0,
      modelOutputLimit: 0,
      contextAvailableTokens: null,
    },
  )

  const tokenStats = createMemo(() => {
    const usage = usageSnapshot()
    const info = sessionInfo()
    return {
      used: usage?.actualUsageTokens ?? info.actualUsageTokens ?? 0,
      avail: info.contextAvailableTokens,
    }
  })

  const preferenceSignature = createMemo(() => {
    const pref = preferences()
    const showThinking = pref.showThinkingBlocks ? 1 : 0
    const thinkingExpansion = pref.thinkingBlocksExpansion ?? "expanded"
    const showUsage = (pref.showUsageMetrics ?? true) ? 1 : 0
    return `${showThinking}|${thinkingExpansion}|${showUsage}`
  })

  const [selectedTimelineIds, setSelectedTimelineIds] = createSignal<Set<string>>(new Set())
  const [lastSelectionAnchorId, setLastSelectionAnchorId] = createSignal<string | null>(null)
  const [expandedMessageIds, setExpandedMessageIds] = createSignal<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = createSignal<"all" | "tools">("all")
  const [isDeleteMenuOpen, setIsDeleteMenuOpen] = createSignal(false)
  const [isSearchOpen, setIsSearchOpen] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [debouncedSearchQuery, setDebouncedSearchQuery] = createSignal("")
  const [searchedQuery, setSearchedQuery] = createSignal("")
  const [isSearchPending, setIsSearchPending] = createSignal(false)
  const [searchMatches, setSearchMatches] = createSignal<SessionSearchMatch[]>([])
  const [activeSearchIndex, setActiveSearchIndex] = createSignal(0)
  let deleteMenuRef: HTMLDivElement | undefined
  let deleteMenuButtonRef: HTMLButtonElement | undefined
  let searchInputRef: HTMLInputElement | undefined

  const messageIndexById = createMemo(() => {
    const ids = messageIds()
    const map = new Map<string, number>()
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], i)
    }
    return map
  })

  const lastAssistantMessageId = createMemo(() => store().getLastAssistantMessageId(props.sessionId))

  const activeSearchMatch = createMemo(() => {
    const matches = searchMatches()
    if (matches.length === 0) return null
    const index = Math.min(Math.max(activeSearchIndex(), 0), matches.length - 1)
    return matches[index] ?? null
  })

  const searchResultMessageIds = createMemo(() => new Set(searchMatches().map((match) => match.messageId)))

  const trimmedSearchQuery = createMemo(() => searchQuery().trim())
  const isSearchSettled = createMemo(() => {
    const query = trimmedSearchQuery()
    return query.length >= SEARCH_MIN_CHARS && !isSearchPending() && searchedQuery().trim() === query
  })

  const lastCompactionIndex = createMemo(() => {
    sessionRevision()
    return untrack(() => store().getLastCompactionMessageIndex(props.sessionId))
  })

  const deletableStartIndex = createMemo(() => {
    const idx = lastCompactionIndex()
    return idx === -1 ? 0 : idx + 1
  })

  const deletableMessageIds = createMemo<Set<string>>(() => {
    const ids = messageIds()
    const start = deletableStartIndex()
    return new Set(ids.slice(start))
  })

  const isMessageDeletable = (messageId: string): boolean => {
    const idx = messageIndexById().get(messageId)
    if (idx === undefined) return false
    return idx >= deletableStartIndex()
  }

  const [timelineSegments, setTimelineSegments] = createSignal<TimelineSegment[]>([])
  const hasTimelineSegments = () => timelineSegments().length > 0

  const searchMatchedTimelineSegmentIds = createMemo(() => {
    const matches = searchMatches()
    if (matches.length === 0) return new Set<string>()
    const result = new Set<string>()
    for (const segment of timelineSegments()) {
      if (matches.some((match) => segmentMatchesSearch(segment, match))) {
        result.add(segment.id)
      }
    }
    return result
  })

  const activeSearchTimelineSegmentId = createMemo(() => {
    const match = activeSearchMatch()
    if (!match) return null
    return timelineSegments().find((segment) => segmentMatchesSearch(segment, match))?.id ?? null
  })

  const [activeSegmentId, setActiveSegmentId] = createSignal<string | null>(null)
  const [deleteHover, setDeleteHover] = createSignal<DeleteHoverState>({ kind: "none" })
  const [selectedForDeletion, setSelectedForDeletion] = createSignal<Set<string>>(new Set<string>())

  const selectedToolParts = createMemo(() => makeSelectedToolParts(selectedTimelineIds, timelineSegments))
  const deleteMessageIds = createMemo(() => selectedForDeletion())
  const deleteToolParts = createMemo(() => computeDeleteToolParts(deleteMessageIds, selectedToolParts, deletableMessageIds))
  const deleteToolPartKeys = createMemo(() => computeDeleteToolPartKeys(deleteToolParts))
  const isDeleteMode = createMemo(() => deleteMessageIds().size > 0 || deleteToolParts().length > 0)
  const selectedDeleteCount = createMemo(() => deleteMessageIds().size + deleteToolParts().length)
  const selectedTokenTotal = createMemo(() => computeSelectedTokenTotal(deleteMessageIds, deleteToolParts, store, props.instanceId, timelineSegments))

  const deleteSignals = {
    selectedTimelineIds,
    setSelectedTimelineIds,
    setSelectedForDeletion,
    selectedForDeletion,
    setDeleteHover,
    setLastSelectionAnchorId,
    setIsDeleteMenuOpen,
    setSelectionMode,
    timelineSegments,
    deletableMessageIds,
    isMessageDeletable,
    messageIds,
    store,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    t,
  }

  const clearDeleteMode = makeClearDeleteMode(deleteSignals)
  const setMessageSelectedForDeletion = makeSetMessageSelectedForDeletion(deleteSignals)
  const selectAllForDeletion = makeSelectAllForDeletion(deleteSignals, clearDeleteMode)
  const deleteSelectedMessages = makeDeleteSelectedMessages(deleteSignals, clearDeleteMode)

  createEffect(() => {
    const timelineIds = selectedTimelineIds()
    if (timelineIds.size === 0) return
    const segments = timelineSegments()
    const segmentById = new Map<string, TimelineSegment>()
    for (const segment of segments) segmentById.set(segment.id, segment)
    const affectedMessageIds = new Set<string>()
    for (const segId of timelineIds) {
      const segment = segmentById.get(segId)
      if (segment && segment.type !== "tool" && isMessageDeletable(segment.messageId)) {
        affectedMessageIds.add(segment.messageId)
      }
    }
    setSelectedForDeletion(affectedMessageIds)
  })

  const lastAssistantIndex = createMemo(() => {
    const messageId = lastAssistantMessageId()
    if (!messageId) return -1
    return messageIndexById().get(messageId) ?? -1
  })

  const handleTimelineSegmentClick = (segment: TimelineSegment) => {
    const scrollToMessage = () => {
      const api = listApi()
      if (api) {
        api.scrollToKey(segment.messageId, { behavior: "smooth", block: "start" })
        return
      }
      if (typeof document === "undefined") return
      const anchor = document.getElementById(getMessageAnchorId(segment.messageId))
      anchor?.scrollIntoView({ block: "start", behavior: "smooth" })
    }

    if (selectionMode() === "tools" && segment.type !== "tool") {
      setActiveSegmentId(segment.id)
      scrollToMessage()
      return
    }

    setLastSelectionAnchorId(segment.id)
    setActiveSegmentId(segment.id)
    scrollToMessage()
  }

  const handleToggleTimelineSelection = (id: string) => {
    const segments = timelineSegments()
    const segmentIndex = segments.findIndex((s) => s.id === id)
    if (segmentIndex === -1) return
    const segment = segments[segmentIndex]

    if (!isMessageDeletable(segment.messageId)) return

    setLastSelectionAnchorId(id)

    if (selectionMode() === "tools" && segment.type !== "tool") return

    const selected = selectedTimelineIds()
    const isCurrentlySelected = selected.has(id)
    const group = getAdjacentGroup(segmentIndex, segments)
    const hasToolsInGroup = group.some((s) => s.type === "tool")
    const isGroupCandidate = segment.type === "assistant" && hasToolsInGroup
    const selectedInGroup = isGroupCandidate
      ? group.reduce((count, s) => (selected.has(s.id) ? count + 1 : count), 0)
      : 0
    const isGroupEmpty = isGroupCandidate && selectedInGroup === 0

    if (isGroupCandidate && !isCurrentlySelected && isGroupEmpty) {
      setSelectedTimelineIds((prev) => {
        const next = new Set(prev)
        for (const s of group) next.add(s.id)
        return next
      })
    } else if (isCurrentlySelected) {
      const newSelected = new Set(selected)
      newSelected.delete(id)
      setSelectedTimelineIds(newSelected)
    } else {
      setSelectedTimelineIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
    }
  }

  const handleLongPressTimelineSelection = (segment: TimelineSegment) => {
    const segments = timelineSegments()
    const segmentIndex = segments.findIndex((s) => s.id === segment.id)
    if (segmentIndex === -1) return

    if (!isMessageDeletable(segment.messageId)) return

    setLastSelectionAnchorId(segment.id)

    if (selectionMode() === "tools" && segment.type !== "tool") return
    const group = getAdjacentGroup(segmentIndex, segments)
    const hasToolsInGroup = group.some((s) => s.type === "tool")
    const isGroupCandidate = segment.type === "assistant" && hasToolsInGroup
    if (!isGroupCandidate) {
      handleToggleTimelineSelection(segment.id)
      return
    }
    const selected = selectedTimelineIds()
    const hasAnySelected = group.some((s) => selected.has(s.id))
    if (!hasAnySelected) {
      setSelectedTimelineIds((prev) => {
        const next = new Set(prev)
        for (const s of group) next.add(s.id)
        return next
      })
      return
    }
    const newSelected = new Set(selected)
    for (const s of group) newSelected.delete(s.id)
    setSelectedTimelineIds(newSelected)
  }

  const handleSelectRangeTimeline = (id: string) => {
    const anchorId = lastSelectionAnchorId()
    if (!anchorId) {
      handleToggleTimelineSelection(id)
      return
    }

    const segments = timelineSegments()
    const anchorIndex = segments.findIndex((s) => s.id === anchorId)
    const targetIndex = segments.findIndex((s) => s.id === id)

    if (anchorIndex === -1 || targetIndex === -1) {
      handleToggleTimelineSelection(id)
      return
    }

    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)

    const rangeSegments = selectionMode() === "tools"
      ? segments.slice(start, end + 1).filter((s) => s.type === "tool" && isMessageDeletable(s.messageId))
      : segments.slice(start, end + 1).filter((s) => isMessageDeletable(s.messageId))
    setSelectedTimelineIds(new Set(rangeSegments.map((segment) => segment.id)))
  }

  const handleClearTimelineSelection = () => {
    clearDeleteMode()
  }

  const applySelectionMode = (mode: "all" | "tools") => {
    setSelectionMode(mode)
    if (mode !== "tools") return
    const segments = timelineSegments()
    const toolIds = new Set(
      segments
        .filter((segment) => segment.type === "tool" && isMessageDeletable(segment.messageId))
        .map((segment) => segment.id),
    )
    setSelectedTimelineIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => toolIds.has(id)))
      if (next.size === 0) setLastSelectionAnchorId(null)
      return next
    })
  }

  const isActive = createMemo(() => props.isActive !== false)
  const [listApi, setListApi] = createSignal<VirtualFollowListApi | null>(null)
  const [listState, setListState] = createSignal<VirtualFollowListState | null>(null)
  const scrollButtonsCount = createMemo(() => listState()?.scrollButtonsCount() ?? 0)

  const [streamElement, setStreamElement] = createSignal<HTMLDivElement | undefined>()
  const [streamShellElement, setStreamShellElement] = createSignal<HTMLDivElement | undefined>()

  const followToken = createMemo(() => preferenceSignature())

  const initialScrollSnapshot = createMemo(() => store().getScrollSnapshot(props.sessionId, MESSAGE_SCROLL_CACHE_SCOPE))
  const initialAutoScroll = createMemo(() => initialScrollSnapshot()?.atBottom ?? true)

  const [didRestoreScroll, setDidRestoreScroll] = createSignal(false)
  createEffect(
    on(
      () => props.sessionId,
      () => {
        setDidRestoreScroll(false)
      },
    ),
  )

  createEffect(() => {
    const sessionId = props.sessionId
    onCleanup(() => {
      const element = streamElement()
      if (!element) return
      const scrollTop = element.scrollTop
      const atBottom = element.scrollHeight - (element.scrollTop + element.clientHeight) <= 48
      store().setScrollSnapshot(sessionId, MESSAGE_SCROLL_CACHE_SCOPE, { scrollTop, atBottom })
    })
  })

  const [quoteSelection, setQuoteSelection] = createSignal<{ text: string; top: number; left: number } | null>(null)

  const lastVisibleMessageId = createMemo(() => {
    const ids = visibleMessageIds()
    return ids[ids.length - 1] ?? null
  })

  const autoPinHoldTargetKey = createMemo(() => {
    if (!holdLongAssistantRepliesEnabled()) return null
    const messageId = lastVisibleMessageId()
    return isStreamingAssistantTextMessage(messageId) ? messageId : null
  })

  function toggleHoldLongAssistantReplies() {
    updatePreferences({ holdLongAssistantReplies: !holdLongAssistantRepliesEnabled() })
  }

  function isStreamingAssistantTextMessage(messageId: string | null | undefined) {
    if (!messageId) return false
    const resolvedStore = store()
    const record = resolvedStore.getMessage(messageId)
    if (!record || record.role !== "assistant") return false
    if (record.status !== "streaming") return false

    const info = resolvedStore.getMessageInfo(messageId)
    if (!info) return false
    const timeInfo = info?.time as { end?: number } | undefined
    const isStreaming = timeInfo?.end === undefined || timeInfo.end === 0
    if (!isStreaming) return false

    const { orderedParts } = buildRecordDisplayData(props.instanceId, record)
    return orderedParts.some((part) => {
      if ((part as any)?.type !== "text") return false
      if (partHasRenderableText(part)) return true
      return typeof (part as { text?: unknown }).text === "string"
    })
  }

  createEffect(() => {
    const api = listApi()
    if (!api) return
    if (props.registerScrollToBottom) {
      props.registerScrollToBottom(() => api.scrollToBottom({ immediate: true }))
    }
  })

  createEffect(() => {
    const element = streamElement()
    const api = listApi()
    if (!element || !api) return
    if (props.loading) return
    if (visibleMessageIds().length === 0) return
    if (didRestoreScroll()) return

    scrollCache.restore(element, {
      behavior: "auto",
      fallback: () => {
        api.setAutoScroll(true)
        api.scrollToBottom({ immediate: true })
      },
      onApplied: (snapshot) => {
        api.setAutoScroll(snapshot?.atBottom ?? true)
        setDidRestoreScroll(true)
      },
    })
  })

  onCleanup(() => {
    scrollCache.persist(streamElement())
  })

  const quoteState = {
    quoteSelection,
    setQuoteSelection,
    streamElement,
    streamShellElement,
    onQuoteSelection: props.onQuoteSelection,
    t,
  }

  const clearQuoteSelection = makeClearQuoteSelection(quoteState)
  const updateQuoteSelectionFromSelection = makeUpdateQuoteSelectionFromSelection(quoteState, clearQuoteSelection)
  const handleQuoteSelectionRequest = makeHandleQuoteSelectionRequest(quoteState, clearQuoteSelection)
  const handleCopySelectionRequest = makeHandleCopySelectionRequest(quoteState, clearQuoteSelection)

  function openSearch() {
    setIsSearchOpen(true)
    requestAnimationFrame(() => searchInputRef?.focus())
  }

  function closeSearch() {
    setIsSearchOpen(false)
    setSearchQuery("")
    setDebouncedSearchQuery("")
    setSearchedQuery("")
    setIsSearchPending(false)
    setSearchMatches([])
    setActiveSearchIndex(0)
  }

  function moveSearchMatch(direction: 1 | -1) {
    const count = searchMatches().length
    if (count === 0) return
    setActiveSearchIndex((index) => (index + direction + count) % count)
  }

  function handleStreamMouseUp() {
    updateQuoteSelectionFromSelection()
  }

  function handleContentRendered() {
    if (props.loading) return
    listApi()?.notifyContentRendered()
  }

  const cleanupTimelineEffects = installTimelineEffects({
    props,
    messageIds,
    store,
    sessionRevision,
    timelineSegments,
    setTimelineSegments,
    selectedTimelineIds,
    setSelectedTimelineIds,
    handleClearTimelineSelection,
    t,
  })

  createEffect(() => {
    if (!props.onQuoteSelection) {
      clearQuoteSelection()
    }
  })

  createEffect(() => {
    const query = searchQuery()
    if (query.trim().length < SEARCH_MIN_CHARS) {
      setDebouncedSearchQuery("")
      setActiveSearchIndex(0)
      setSearchedQuery("")
      setIsSearchPending(false)
      setSearchMatches([])
      return
    }
    setIsSearchPending(true)
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(query)
    }, SEARCH_DEBOUNCE_MS)
    onCleanup(() => window.clearTimeout(timeout))
  })

  createEffect(() => {
    sessionRevision()
    const query = debouncedSearchQuery()
    const includeThinking = Boolean(preferences().showThinkingBlocks)
    if (query.trim().length < SEARCH_MIN_CHARS) return

    setIsSearchPending(true)
    const frame = requestAnimationFrame(() => {
      const matches = buildSessionSearchMatches({
        store: store(),
        sessionId: props.sessionId,
        query,
        includeThinking,
      })
      setSearchMatches(matches)
      setSearchedQuery(query)
      setActiveSearchIndex(0)
      setIsSearchPending(false)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  createEffect(() => {
    const count = searchMatches().length
    if (count === 0) {
      if (activeSearchIndex() !== 0) setActiveSearchIndex(0)
      return
    }
    if (activeSearchIndex() >= count) {
      setActiveSearchIndex(count - 1)
    }
  })

  let lastScrolledSearchMatchId: string | null = null
  createEffect(() => {
    const match = activeSearchMatch()
    if (!match || !isSearchOpen()) return
    if (match.id === lastScrolledSearchMatchId) return
    lastScrolledSearchMatchId = match.id
    listApi()?.scrollToKey(match.messageId, { behavior: "smooth", block: "start", setAutoScroll: false })
  })

  installEventEffects({
    isActive,
    isSearchOpen,
    isDeleteMenuOpen,
    selectedTimelineIds,
    selectedForDeletion,
    streamShellElement,
    updateQuoteSelectionFromSelection,
    clearQuoteSelection,
    openSearch,
    closeSearch,
    clearDeleteMode,
    setIsDeleteMenuOpen,
    deleteMenuRef: () => deleteMenuRef,
    deleteMenuButtonRef: () => deleteMenuButtonRef,
    cleanupTimelineEffects,
  })

  createEffect(() => {
    if (props.loading) {
      clearQuoteSelection()
    }
  })

  return (
    <div
      class="message-stream-container"
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-stream-active={isActive() ? "true" : "false"}
    >
      <div
        class={`message-layout${hasTimelineSegments() ? " message-layout--with-timeline" : ""}`}
        data-scroll-buttons={scrollButtonsCount()}
      >
        <VirtualFollowList
          items={visibleMessageIds}
          getKey={(messageId) => messageId}
          getAnchorId={getMessageAnchorId}
          getKeyFromAnchorId={getMessageIdFromAnchorId}
          overscanPx={800}
          scrollSentinelMarginPx={SCROLL_SENTINEL_MARGIN_PX}
          suspendMeasurements={() => !isActive()}
          loading={() => Boolean(props.loading)}
          isActive={isActive}
          scrollToBottomOnActivate={() => false}
          initialScrollToBottom={() => false}
          initialAutoScroll={initialAutoScroll}
          resetKey={() => props.sessionId}
          followToken={followToken}
          autoPinHoldTargetKey={autoPinHoldTargetKey}
          autoPinHoldTopThresholdPx={STREAMING_TEXT_HOLD_TOP_THRESHOLD_PX}
          resolveAutoPinHoldElement={(itemWrapper, key) => {
            const candidates = Array.from(itemWrapper.querySelectorAll<HTMLElement>(`.message-item-base[data-message-id="${key}"][data-message-role="assistant"]`))
            return candidates[candidates.length - 1] ?? null
          }}
          onScroll={() => {
            clearQuoteSelection()
            scrollCache.persist(streamElement())
          }}
          onMouseUp={() => handleStreamMouseUp()}
          onClick={(e) => {
            if (selectedTimelineIds().size === 0) return
            const target = e.target as HTMLElement
            if (target.closest("button, a, input, [role='button']")) return
            handleClearTimelineSelection()
          }}
          onActiveKeyChange={(messageId) => {
            if (!messageId) return
            const firstSeg = timelineSegments().find((s) => s.messageId === messageId)
            if (firstSeg) {
              setActiveSegmentId((current) => (current === firstSeg.id ? current : firstSeg.id))
            }
          }}
          onScrollElementChange={(element) => {
            setStreamElement(element)
            if (!element) clearQuoteSelection()
          }}
          onShellElementChange={(element) => {
            setStreamShellElement(element)
            if (!element) clearQuoteSelection()
          }}
          scrollToTopAriaLabel={() => t("messageSection.scroll.toFirstAriaLabel")}
          scrollToBottomAriaLabel={() => t("messageSection.scroll.toLatestAriaLabel")}
          registerApi={(api) => setListApi(api)}
          registerState={(state) => setListState(state)}
          renderControls={(state, api) => (
            <div class="message-scroll-button-wrapper">
              <button
                type="button"
                class="message-scroll-button"
                data-active={holdLongAssistantRepliesEnabled() ? "true" : "false"}
                onClick={toggleHoldLongAssistantReplies}
                aria-label={
                  holdLongAssistantRepliesEnabled()
                    ? t("messageSection.scroll.disableHoldAriaLabel")
                    : t("messageSection.scroll.enableHoldAriaLabel")
                }
                title={
                  holdLongAssistantRepliesEnabled()
                    ? t("messageSection.scroll.disableHoldAriaLabel")
                    : t("messageSection.scroll.enableHoldAriaLabel")
                }
              >
                <Pause class="message-scroll-icon message-scroll-icon--toggle w-4 h-4" aria-hidden="true" />
              </button>
              <Show when={state.showScrollTopButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={() => api.scrollToTop()}
                  aria-label={t("messageSection.scroll.toFirstAriaLabel")}
                >
                  <span class="message-scroll-icon" aria-hidden="true">
                    ↑
                  </span>
                </button>
              </Show>
              <Show when={state.showScrollBottomButton()}>
                <button
                  type="button"
                  class="message-scroll-button"
                  onClick={() => api.scrollToBottom()}
                  aria-label={t("messageSection.scroll.toLatestAriaLabel")}
                >
                  <span class="message-scroll-icon" aria-hidden="true">
                    ↓
                  </span>
                </button>
              </Show>
            </div>
          )}
          renderBeforeItems={() => (
            <>
              <Show when={!props.loading && visibleMessageIds().length === 0}>
                <div class="empty-state">
                  <div class="empty-state-content">
                    <div class="flex flex-col items-center gap-3 mb-6">
                      <img src={codeNomadLogo} alt={t("messageSection.empty.logoAlt")} class="h-48 w-auto" loading="lazy" />
                      <h1 class="text-3xl font-semibold text-primary">{t("messageSection.empty.brandTitle")}</h1>
                    </div>
                    <h3>{t("messageSection.empty.title")}</h3>
                    <p>{t("messageSection.empty.description")}</p>
                    <ul>
                      <li>
                        <span>{t("messageSection.empty.tips.commandPalette")}</span>
                        <Kbd shortcut="cmd+shift+p" class="ml-2 kbd-hint" />
                      </li>
                      <li>{t("messageSection.empty.tips.askAboutCodebase")}</li>
                      <li>
                        {t("messageSection.empty.tips.attachFilesPrefix")} <code>@</code>
                      </li>
                    </ul>
                  </div>
                </div>
              </Show>

              <Show when={props.loading}>
                <div class="loading-state">
                  <div class="spinner" />
                  <p>{t("messageSection.loading.messages")}</p>
                </div>
              </Show>
            </>
          )}
          renderItem={(messageId, index) => (
            <MessageBlock
              messageId={messageId}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              store={store}
              messageIndex={index}
              lastAssistantIndex={lastAssistantIndex}
              showThinking={() => preferences().showThinkingBlocks}
              thinkingDefaultExpanded={() => (preferences().thinkingBlocksExpansion ?? "expanded") === "expanded"}
              showUsageMetrics={showUsagePreference}
              deleteHover={deleteHover}
              onDeleteHoverChange={setDeleteHover}
              selectedMessageIds={selectedForDeletion}
              selectedToolPartKeys={deleteToolPartKeys}
              onToggleSelectedMessage={setMessageSelectedForDeletion}
              onRevert={props.onRevert}
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              onFork={props.onFork}
              onContentRendered={handleContentRendered}
              searchQuery={debouncedSearchQuery}
              searchResultMessageIds={searchResultMessageIds}
              activeSearchMatch={activeSearchMatch}
            />
          )}
          renderOverlay={() => (
            <>
              <Show when={isSearchOpen()}>
                <div class="message-search-popover modal-surface" role="search" aria-label={t("messageSection.search.ariaLabel")}>
                  <div class="modal-search-container message-search-container">
                    <div class="message-search-input-row">
                      <Search class="w-4 h-4 modal-search-icon" aria-hidden="true" />
                      <input
                        ref={(el) => {
                          searchInputRef = el
                        }}
                        class="modal-search-input message-search-input"
                        type="search"
                        value={searchQuery()}
                        placeholder={t("messageSection.search.placeholder")}
                        onInput={(event) => {
                          setSearchQuery(event.currentTarget.value)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            moveSearchMatch(event.shiftKey ? -1 : 1)
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeSearch()
                          }
                        }}
                      />
                      <span class="message-search-count" aria-live="polite">
                        {searchQuery().trim().length === 0
                          ? t("messageSection.search.count.empty")
                          : trimmedSearchQuery().length < SEARCH_MIN_CHARS
                            ? t("messageSection.search.count.minChars", { count: String(SEARCH_MIN_CHARS) })
                            : isSearchPending()
                              ? t("messageSection.search.count.searching")
                              : searchMatches().length === 0
                                ? t("messageSection.search.count.none")
                                : t("messageSection.search.count.matches", {
                                    current: String(activeSearchIndex() + 1),
                                    total: String(searchMatches().length),
                                  })}
                      </span>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={() => moveSearchMatch(-1)}
                        disabled={searchMatches().length === 0}
                        aria-label={t("messageSection.search.previousAriaLabel")}
                        title={t("messageSection.search.previousAriaLabel")}
                      >
                        <ChevronUp class="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={() => moveSearchMatch(1)}
                        disabled={searchMatches().length === 0}
                        aria-label={t("messageSection.search.nextAriaLabel")}
                        title={t("messageSection.search.nextAriaLabel")}
                      >
                        <ChevronDown class="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        class="message-search-button"
                        onClick={closeSearch}
                        aria-label={t("messageSection.search.closeAriaLabel")}
                        title={t("messageSection.search.closeAriaLabel")}
                      >
                        <X class="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <Show when={trimmedSearchQuery().length >= SEARCH_MIN_CHARS && isSearchPending()}>
                    <div class="modal-empty-state message-search-empty">{t("messageSection.search.searching")}</div>
                  </Show>
                  <Show when={isSearchSettled() && searchMatches().length === 0}>
                    <div class="modal-empty-state message-search-empty">{t("messageSection.search.noVisibleMatches")}</div>
                  </Show>
                </div>
              </Show>

              <Show when={quoteSelection()}>
                {(selection) => (
                  <div class="message-quote-popover" style={{ top: `${selection().top}px`, left: `${selection().left}px` }}>
                    <div class="message-quote-button-group">
                      <button type="button" class="message-quote-button" onClick={() => handleQuoteSelectionRequest("quote")}>
                        {t("messageSection.quote.addAsQuote")}
                      </button>
                      <button type="button" class="message-quote-button" onClick={() => handleQuoteSelectionRequest("code")}>
                        {t("messageSection.quote.addAsCode")}
                      </button>
                      <button type="button" class="message-quote-button" onClick={() => void handleCopySelectionRequest()}>
                        {t("messageSection.quote.copy")}
                      </button>
                    </div>
                  </div>
                )}
              </Show>
            </>
          )}
        />

        <Show when={isDeleteMode()}>
          <div
            class="message-delete-mode-toolbar"
            role="toolbar"
            aria-label={t("messageSection.bulkDelete.toolbarAriaLabel", { count: selectedDeleteCount() })}
          >
            <div class="message-delete-mode-toolbar-row" aria-hidden="true">
              <span class="message-delete-mode-token-group">
                <span class="message-delete-mode-count message-delete-mode-count--before" title={`${tokenStats().used} tokens currently in context`}>
                  {formatTokenCount(tokenStats().used)}
                </span>
                <span class="message-delete-mode-arrow" aria-hidden="true">{"\u203A"}</span>
                <span
                  class="message-delete-mode-count message-delete-mode-count--selection"
                  title={`${selectedTokenTotal()} tokens selected (${selectedDeleteCount()} messages)`}
                >
                  {formatTokenCount(selectedTokenTotal())}
                </span>
                <span class="message-delete-mode-arrow" aria-hidden="true">{"\u203A"}</span>
                <span
                  class="message-delete-mode-count message-delete-mode-count--after"
                  title={`${Math.max(0, tokenStats().used - selectedTokenTotal())} tokens remaining after deletion`}
                >
                  {formatTokenCount(Math.max(0, tokenStats().used - selectedTokenTotal()))}
                </span>
              </span>

              <button
                type="button"
                class="message-delete-mode-button message-delete-mode-button--delete"
                onClick={() => void deleteSelectedMessages()}
                title={t("messageSection.bulkDelete.deleteSelectedTitle")}
                aria-label={t("messageSection.bulkDelete.deleteSelectedTitle")}
              >
                <Trash class="w-4 h-4" aria-hidden="true" />
              </button>

              <div class="message-delete-mode-menu-container">
                <button
                  ref={(el) => {
                    deleteMenuButtonRef = el
                  }}
                  type="button"
                  class="message-delete-mode-button message-delete-mode-button--menu"
                  onClick={() => setIsDeleteMenuOpen((prev) => !prev)}
                  title={t("messageSection.bulkDelete.moreOptionsTitle")}
                  aria-label={t("messageSection.bulkDelete.moreOptionsTitle")}
                >
                  <MoreHorizontal class="w-4 h-4" aria-hidden="true" />
                </button>
                <Show when={isDeleteMenuOpen()}>
                  <div
                    ref={(el) => {
                      deleteMenuRef = el
                    }}
                    class="message-delete-mode-menu dropdown-surface"
                  >
                    <button
                      type="button"
                      class="dropdown-item"
                      onClick={() => {
                        selectAllForDeletion()
                        setIsDeleteMenuOpen(false)
                      }}
                    >
                      {t("messageSection.bulkDelete.selectAllTitle")}
                    </button>
                    <div class="message-delete-mode-menu-divider" aria-hidden="true" />
                    <div class="message-delete-mode-menu-row">
                      <span class="message-delete-mode-menu-label">{t("messageSection.bulkDelete.selectionModeLabel")}</span>
                      <div class="message-delete-mode-menu-toggle">
                        <button
                          type="button"
                          class="message-delete-mode-menu-toggle-button"
                          data-mode="all"
                          data-active={selectionMode() === "all"}
                          onClick={() => applySelectionMode("all")}
                        >
                          {t("messageSection.bulkDelete.selectionModeAll")}
                        </button>
                        <button
                          type="button"
                          class="message-delete-mode-menu-toggle-button"
                          data-mode="tools"
                          data-active={selectionMode() === "tools"}
                          onClick={() => applySelectionMode("tools")}
                        >
                          {t("messageSection.bulkDelete.selectionModeTools")}
                        </button>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>

              <button
                type="button"
                class="message-delete-mode-button message-delete-mode-button--cancel"
                onClick={clearDeleteMode}
                title={t("messageSection.bulkDelete.cancelTitle")}
                aria-label={t("messageSection.bulkDelete.cancelTitle")}
              >
                <X class="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div class="message-delete-mode-hint-row keyboard-hints" aria-hidden="true">
              <Kbd shortcut="cmd+click" />
              <span class="message-delete-mode-hint-text">{t("messageSection.bulkDelete.selectionHint.toggle")}</span>
              <span class="message-delete-mode-hint-sep">·</span>
              <Kbd shortcut="shift+click" />
              <span class="message-delete-mode-hint-text">{t("messageSection.bulkDelete.selectionHint.range")}</span>
              <span class="message-delete-mode-hint-sep">·</span>
              <Kbd shortcut="esc" />
              <span class="message-delete-mode-hint-text">{t("messageSection.bulkDelete.selectionHint.clear")}</span>
            </div>
          </div>
        </Show>

        <Show when={hasTimelineSegments()}>
          <div class="message-timeline-sidebar">
            <MessageTimeline
              segments={timelineSegments()}
              onSegmentClick={handleTimelineSegmentClick}
              onToggleSelection={handleToggleTimelineSelection}
              onLongPressSelection={handleLongPressTimelineSelection}
              onSelectRange={handleSelectRangeTimeline}
              onClearSelection={handleClearTimelineSelection}
              selectedIds={selectedTimelineIds}
              expandedMessageIds={expandedMessageIds}
              deletableMessageIds={deletableMessageIds}
              activeSegmentId={activeSegmentId()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              showToolSegments={showTimelineToolsPreference()}
              deleteHover={deleteHover}
              onDeleteHoverChange={setDeleteHover}
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              selectedMessageIds={selectedForDeletion}
              onToggleSelectedMessage={setMessageSelectedForDeletion}
              searchMatchedSegmentIds={searchMatchedTimelineSegmentIds}
              activeSearchSegmentId={activeSearchTimelineSegmentId}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
