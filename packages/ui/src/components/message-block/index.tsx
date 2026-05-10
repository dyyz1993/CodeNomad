import { Index, Match, Show, Switch, createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js"
import MessageItem from "../message-item"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"
import type { ClientPart, MessageInfo } from "../../types/message"
import { isHiddenSyntheticTextPart, partHasRenderableText } from "../../types/message"
import { buildRecordDisplayData, clearRecordDisplayCacheForInstance } from "../../stores/message-v2/record-display-cache"
import type { MessageRecord } from "../../stores/message-v2/types"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { useI18n } from "../../lib/i18n"
import type { DeleteHoverState } from "../../types/delete-hover"
import type { SessionSearchMatch } from "../../lib/session-search"
import {
  USER_BORDER_COLOR,
  ASSISTANT_BORDER_COLOR,
  TOOL_BORDER_COLOR,
  reasoningHasRenderableContent,
} from "./shared"
import { ToolCallItem } from "./tool-call-item"
import { StepCard, CompactionCard } from "./step-card"
import { ReasoningCard } from "./reasoning-card"

interface CachedBlockEntry {
  signature: string
  block: MessageDisplayBlock
  contentKeys: string[]
  toolKeys: string[]
}

interface SessionRenderCache {
  messageItems: Map<string, ContentDisplayItem>
  toolItems: Map<string, ToolDisplayItem>
  messageBlocks: Map<string, CachedBlockEntry>
}

const renderCaches = new Map<string, SessionRenderCache>()

function makeSessionCacheKey(instanceId: string, sessionId: string) {
  return `${instanceId}:${sessionId}`
}

export function clearSessionRenderCache(instanceId: string, sessionId: string) {
  renderCaches.delete(makeSessionCacheKey(instanceId, sessionId))
}

function getSessionRenderCache(instanceId: string, sessionId: string): SessionRenderCache {
  const key = makeSessionCacheKey(instanceId, sessionId)
  let cache = renderCaches.get(key)
  if (!cache) {
    cache = {
      messageItems: new Map(),
      toolItems: new Map(),
      messageBlocks: new Map(),
    }
    renderCaches.set(key, cache)
  }
  return cache
}

function clearInstanceCaches(instanceId: string) {
  clearRecordDisplayCacheForInstance(instanceId)
  const prefix = `${instanceId}:`
  for (const key of renderCaches.keys()) {
    if (key.startsWith(prefix)) {
      renderCaches.delete(key)
    }
  }
}

messageStoreBus.onInstanceDestroyed(clearInstanceCaches)

function removeSearchMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll("mark.session-search-match"))
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark)
    parent.normalize()
  }
}

function getPartIdForSearchContainer(container: HTMLElement): string | undefined {
  const target = container.closest<HTMLElement>("[data-part-id]") ?? container
  const id = target.dataset.partId
  return id && id.length > 0 ? id : undefined
}

function applySearchMarks(root: HTMLElement, query: string, activeMatch?: SessionSearchMatch | null, scrollActive = false) {
  removeSearchMarks(root)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return

  const containers = Array.from(root.querySelectorAll<HTMLElement>(".message-text, .tool-call, .message-reasoning-text"))
  let occurrenceInActivePart = 0
  let activeMark: HTMLElement | null = null

  for (const container of containers) {
    const containerPartId = getPartIdForSearchContainer(container)
    const canContainActiveMatch = Boolean(activeMatch) && (!activeMatch?.partId || activeMatch.partId === containerPartId)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest("button, input, textarea, select, mark.session-search-match")) return NodeFilter.FILTER_REJECT
        if (!node.nodeValue || !node.nodeValue.toLocaleLowerCase().includes(normalizedQuery)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })

    const textNodes: Text[] = []
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text)
    }

    for (const textNode of textNodes) {
      const original = textNode.nodeValue ?? ""
      const lower = original.toLocaleLowerCase()
      const fragment = document.createDocumentFragment()
      let cursor = 0
      while (cursor < original.length) {
        const index = lower.indexOf(normalizedQuery, cursor)
        if (index === -1) break
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(original.slice(cursor, index)))
        }
        const mark = document.createElement("mark")
        const isActive = Boolean(canContainActiveMatch && activeMatch && occurrenceInActivePart === activeMatch.occurrence)
        mark.className = isActive ? "session-search-match session-search-match-active" : "session-search-match"
        mark.textContent = original.slice(index, index + normalizedQuery.length)
        fragment.appendChild(mark)
        if (canContainActiveMatch) {
          if (isActive) activeMark = mark
          occurrenceInActivePart += 1
        }
        cursor = index + normalizedQuery.length
      }
      if (cursor < original.length) {
        fragment.appendChild(document.createTextNode(original.slice(cursor)))
      }
      textNode.parentNode?.replaceChild(fragment, textNode)
    }
  }

  if (activeMark && scrollActive) {
    requestAnimationFrame(() => activeMark?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }))
  }
}

interface ContentDisplayItem {
  type: "content"
  key: string
  messageId: string
  startPartId: string
}

interface ToolDisplayItem {
  type: "tool"
  key: string
  messageId: string
  partId: string
}

interface StepDisplayItem {
  type: "step-start" | "step-finish"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  accentColor?: string
}

type ReasoningDisplayItem = {
  type: "reasoning"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  showAgentMeta?: boolean
  defaultExpanded: boolean
  messageId: string
  partId: string
}

type CompactionDisplayItem = {
  type: "compaction"
  key: string
  part: ClientPart
  messageInfo?: MessageInfo
  accentColor?: string
  messageId: string
  partId: string
}

type MessageBlockItem = ContentDisplayItem | ToolDisplayItem | StepDisplayItem | ReasoningDisplayItem | CompactionDisplayItem

interface MessageDisplayBlock {
  record: MessageRecord
  items: MessageBlockItem[]
}

interface MessageContentItemProps {
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageId: string
  startPartId: string
  messageIndex: number
  lastAssistantIndex: () => number
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

function isSupportedPartType(part: unknown): boolean {
  const type = (part as any)?.type
  return !(typeof type === "string" && type === "patch")
}

function isContentPartType(type: unknown): boolean {
  return type === "text" || type === "file"
}

function isVisibleContentPart(part: ClientPart): boolean {
  if (!part || !isContentPartType((part as any).type)) return false
  if (isHiddenSyntheticTextPart(part)) return false
  return partHasRenderableText(part)
}

function MessageContentItem(props: MessageContentItemProps) {
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))

  const isQueued = createMemo(() => {
    const current = record()
    if (!current) return false
    if (current.role !== "user") return false
    const lastAssistant = props.lastAssistantIndex()
    return lastAssistant === -1 || props.messageIndex > lastAssistant
  })

  const parts = createMemo<ClientPart[]>(() => {
    const current = record()
    if (!current) return []
    const ids = current.partIds
    const startIndex = ids.indexOf(props.startPartId)
    if (startIndex === -1) return []

    const resolved: ClientPart[] = []
    for (let idx = startIndex; idx < ids.length; idx++) {
      const partId = ids[idx]
      const part = current.parts[partId]?.data
      if (!part) continue
      if (!isSupportedPartType(part)) continue

      if (!isContentPartType((part as any).type)) break
      resolved.push(part)
    }

    return resolved
  })

  const visibleParts = createMemo(() => parts().filter((part) => isVisibleContentPart(part)))

  const showAgentMeta = createMemo(() => {
    const current = record()
    if (!current) return false
    if (current.role !== "assistant") return false

    const currentParts = parts()
    if (visibleParts().length === 0) {
      return false
    }

    const ids = current.partIds
    const startIndex = ids.indexOf(props.startPartId)
    if (startIndex === -1) return false

    for (let idx = 0; idx < startIndex; idx++) {
      const partId = ids[idx]
      const part = current.parts[partId]?.data
      if (!part) continue
      if (!isSupportedPartType(part)) continue

      if (!isContentPartType((part as any).type)) continue
        if (isVisibleContentPart(part)) {
          return false
        }
      }

    return true
  })

  return (
    <Show when={record()}>
      {(resolvedRecord) => (
        <MessageItem
          record={resolvedRecord()}
          messageInfo={messageInfo()}
          parts={visibleParts()}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
          isQueued={isQueued()}
          showAgentMeta={showAgentMeta()}
          showDeleteMessage={props.showDeleteMessage}
          onDeleteHoverChange={props.onDeleteHoverChange}
          selectedMessageIds={props.selectedMessageIds}
          onToggleSelectedMessage={props.onToggleSelectedMessage}
          onRevert={props.onRevert}
          onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
          onFork={props.onFork}
          onContentRendered={props.onContentRendered}
        />
      )}
    </Show>
  )
}

interface MessageBlockProps {
  messageId: string
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageIndex: number
  lastAssistantIndex: () => number
  showThinking: () => boolean
  thinkingDefaultExpanded: () => boolean
  showUsageMetrics: () => boolean
  deleteHover?: () => DeleteHoverState
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  selectedMessageIds?: () => Set<string>
  selectedToolPartKeys?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  searchQuery?: Accessor<string>
  searchResultMessageIds?: Accessor<Set<string>>
  activeSearchMatch?: Accessor<SessionSearchMatch | null>
}

export default function MessageBlock(props: MessageBlockProps) {
  const { t } = useI18n()
  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const sessionCache = getSessionRenderCache(props.instanceId, props.sessionId)
  let blockRef: HTMLDivElement | undefined
  const isDeleteMessageHovered = () => {
    const hover = props.deleteHover?.() ?? ({ kind: "none" } as DeleteHoverState)

    const selected = props.selectedMessageIds?.() ?? new Set<string>()
    if (selected.has(props.messageId)) {
      return true
    }

    if (hover.kind === "message") {
      return hover.messageId === props.messageId
    }

    if (hover.kind === "deleteUpTo") {
      const ids = props.store().getSessionMessageIds(props.sessionId)
      const targetIndex = ids.indexOf(hover.messageId)
      if (targetIndex === -1) return false
      const currentIndex = ids.indexOf(props.messageId)
      if (currentIndex === -1) return false
      return currentIndex >= targetIndex
    }

    return false
  }

  const isSearchResult = () => Boolean(props.searchResultMessageIds?.().has(props.messageId))
  const activeSearchMatch = () => props.activeSearchMatch?.() ?? null
  const isActiveSearchResult = () => activeSearchMatch()?.messageId === props.messageId
  let lastInlineScrolledSearchMatchId: string | null = null

  createEffect(() => {
    const query = props.searchQuery?.() ?? ""
    const active = activeSearchMatch()
    const relevantActiveMatch = active?.messageId === props.messageId ? active : null
    const shouldScrollActive = Boolean(relevantActiveMatch && relevantActiveMatch.id !== lastInlineScrolledSearchMatchId)
    if (shouldScrollActive && relevantActiveMatch) {
      lastInlineScrolledSearchMatchId = relevantActiveMatch.id
    }
    const current = record()
    if (current) void current.revision
    const element = blockRef
    if (!element) return

    const frame = requestAnimationFrame(() => applySearchMarks(element, query, relevantActiveMatch, shouldScrollActive))
    onCleanup(() => {
      cancelAnimationFrame(frame)
      removeSearchMarks(element)
    })
  })

  const block = createMemo<MessageDisplayBlock | null>(() => {
    const current = record()
    if (!current) return null

    const index = props.messageIndex
    const lastAssistantIdx = props.lastAssistantIndex()
    const isQueued = current.role === "user" && (lastAssistantIdx === -1 || index > lastAssistantIdx)

    const messageInfoVersion = props.store().state.messageInfoVersion[current.id] ?? 0

    const cacheSignature = [
      current.id,
      current.revision,
      messageInfoVersion,
      isQueued ? 1 : 0,
      props.showThinking() ? 1 : 0,
      props.thinkingDefaultExpanded() ? 1 : 0,
      props.showUsageMetrics() ? 1 : 0,
    ].join("|")

    const cachedBlock = sessionCache.messageBlocks.get(current.id)
    if (cachedBlock && cachedBlock.signature === cacheSignature) {
      return cachedBlock.block
    }

    const info = untrack(messageInfo)

    const { orderedParts } = buildRecordDisplayData(props.instanceId, current)
    const items: MessageBlockItem[] = []
    const blockContentKeys: string[] = []
    const blockToolKeys: string[] = []
    let pendingParts: ClientPart[] = []
    let agentMetaAttached = current.role !== "assistant"
    const defaultAccentColor = current.role === "user" ? USER_BORDER_COLOR : ASSISTANT_BORDER_COLOR
    let lastAccentColor = defaultAccentColor

    const flushContent = () => {
      if (pendingParts.length === 0) return
      const startPartId = typeof (pendingParts[0] as any)?.id === "string" ? ((pendingParts[0] as any).id as string) : ""
      if (!startPartId) {
        pendingParts = []
        return
      }

      if (!agentMetaAttached && pendingParts.some((part) => partHasRenderableText(part))) {
        agentMetaAttached = true
      }

      const segmentKey = `${current.id}:content:${startPartId}`
      let cached = sessionCache.messageItems.get(segmentKey)
      if (!cached) {
        cached = {
          type: "content",
          key: segmentKey,
          messageId: current.id,
          startPartId,
        }
        sessionCache.messageItems.set(segmentKey, cached)
      }

      items.push(cached)
      blockContentKeys.push(segmentKey)
      lastAccentColor = defaultAccentColor
      pendingParts = []
    }

    orderedParts.forEach((part, partIndex) => {
      if (!isSupportedPartType(part)) {
        return
      }
      if (part.type === "tool") {
        flushContent()
        const partId = part.id
        if (!partId) {
          return
        }
        const key = `${current.id}:${partId}`
        let toolItem = sessionCache.toolItems.get(key)
        if (!toolItem) {
          toolItem = {
            type: "tool",
            key,
            messageId: current.id,
            partId,
          }
          sessionCache.toolItems.set(key, toolItem)
        } else {
          toolItem.key = key
          toolItem.messageId = current.id
          toolItem.partId = partId
        }
        items.push(toolItem)
        blockToolKeys.push(key)
        lastAccentColor = TOOL_BORDER_COLOR
        return
      }

      if (part.type === "compaction") {
        flushContent()
        const partId = part.id ?? ""
        const key = `${current.id}:${partId || partIndex}:compaction`
        const isAuto = Boolean((part as any)?.auto)
        items.push({
          type: "compaction",
          key,
          part,
          messageInfo: info,
          accentColor: isAuto ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR,
          messageId: current.id,
          partId,
        })
        lastAccentColor = isAuto ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR
        return
      }

      if (part.type === "step-start") {
        flushContent()
        return
      }

      if (part.type === "step-finish") {
        flushContent()
        if (props.showUsageMetrics()) {
          const key = `${current.id}:${part.id ?? partIndex}:${part.type}`
          const accentColor = lastAccentColor || defaultAccentColor
          items.push({ type: part.type, key, part, messageInfo: info, accentColor })
          lastAccentColor = accentColor
        }
        return
      }

      if (part.type === "reasoning") {
        flushContent()
        if (props.showThinking() && reasoningHasRenderableContent(part)) {
          const partId = part.id ?? ""
          const key = `${current.id}:${partId || partIndex}:reasoning`
          const showAgentMeta = current.role === "assistant" && !agentMetaAttached
          if (showAgentMeta) {
            agentMetaAttached = true
          }
          items.push({
            type: "reasoning",
            key,
            part,
            messageInfo: info,
            showAgentMeta,
            defaultExpanded: props.thinkingDefaultExpanded(),
            messageId: current.id,
            partId,
          })
          lastAccentColor = ASSISTANT_BORDER_COLOR
        }
        return
      }

      pendingParts.push(part)
    })

    flushContent()

    const resultBlock: MessageDisplayBlock = { record: current, items }
    sessionCache.messageBlocks.set(current.id, {
      signature: cacheSignature,
      block: resultBlock,
      contentKeys: blockContentKeys.slice(),
      toolKeys: blockToolKeys.slice(),
    })

    const messagePrefix = `${current.id}:`
    for (const [key] of sessionCache.messageItems) {
      if (key.startsWith(messagePrefix) && !blockContentKeys.includes(key)) {
        sessionCache.messageItems.delete(key)
      }
    }
    for (const [key] of sessionCache.toolItems) {
      if (key.startsWith(messagePrefix) && !blockToolKeys.includes(key)) {
        sessionCache.toolItems.delete(key)
      }
    }

    return resultBlock
  })

  return (
    <Show when={block()}>
      {(resolvedBlock) => (
        <div
          ref={(el) => {
            blockRef = el
          }}
          class="message-stream-block"
          data-message-id={resolvedBlock().record.id}
          data-delete-message-hover={isDeleteMessageHovered() ? "true" : undefined}
          data-search-result={isSearchResult() ? "true" : undefined}
          data-search-active={isActiveSearchResult() ? "true" : undefined}
        >
          <Index each={resolvedBlock().items}>
            {(item, index) => (
              <Switch>
                <Match when={item().type === "content"}>
                  <MessageContentItem
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    store={props.store}
                    messageId={(item() as ContentDisplayItem).messageId}
                    startPartId={(item() as ContentDisplayItem).startPartId}
                    messageIndex={props.messageIndex}
                    lastAssistantIndex={props.lastAssistantIndex}
                    showDeleteMessage={index === 0}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onRevert={props.onRevert}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                    onFork={props.onFork}
                    onContentRendered={props.onContentRendered}
                  />
                </Match>
                <Match when={item().type === "tool"}>
                  {(() => {
                    const toolItem = item() as ToolDisplayItem
                    return (
                      <div class="tool-call-message" data-key={toolItem.key} data-part-id={toolItem.partId}>
                          <ToolCallItem
                            instanceId={props.instanceId}
                            sessionId={props.sessionId}
                            store={props.store}
                            messageId={toolItem.messageId}
                            partId={toolItem.partId}
                            showDeleteMessage={index === 0}
                          deleteHover={props.deleteHover}
                           onDeleteHoverChange={props.onDeleteHoverChange}
                           onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                           selectedMessageIds={props.selectedMessageIds}
                           selectedToolPartKeys={props.selectedToolPartKeys}
                           onToggleSelectedMessage={props.onToggleSelectedMessage}
                           onContentRendered={props.onContentRendered}
                         />
                       </div>
                     )
                   })()}
                </Match>
                <Match when={item().type === "step-start"}>
                  <StepCard
                    kind="start"
                    part={(item() as StepDisplayItem).part}
                    messageInfo={(item() as StepDisplayItem).messageInfo}
                    showAgentMeta
                    showDeleteMessage={index === 0}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={props.messageId}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
                <Match when={item().type === "step-finish"}>
                  <StepCard
                    kind="finish"
                    part={(item() as StepDisplayItem).part}
                    messageInfo={(item() as StepDisplayItem).messageInfo}
                    showUsage={props.showUsageMetrics()}
                    borderColor={(item() as StepDisplayItem).accentColor}
                    showDeleteMessage={index === 0}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={props.messageId}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
                <Match when={item().type === "compaction"}>
                  <CompactionCard
                    part={(item() as CompactionDisplayItem).part}
                    messageInfo={(item() as CompactionDisplayItem).messageInfo}
                    borderColor={(item() as CompactionDisplayItem).accentColor}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item() as CompactionDisplayItem).messageId}
                    showDeleteMessage={index === 0}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                  />
                </Match>
                <Match when={item().type === "reasoning"}>
                  <ReasoningCard
                    part={(item() as ReasoningDisplayItem).part}
                    messageInfo={(item() as ReasoningDisplayItem).messageInfo}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    messageId={(item() as ReasoningDisplayItem).messageId}
                    showAgentMeta={(item() as ReasoningDisplayItem).showAgentMeta}
                    defaultExpanded={(item() as ReasoningDisplayItem).defaultExpanded}
                    showDeleteMessage={index === 0}
                    onDeleteHoverChange={props.onDeleteHoverChange}
                    onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
                    selectedMessageIds={props.selectedMessageIds}
                    onToggleSelectedMessage={props.onToggleSelectedMessage}
                    onContentRendered={props.onContentRendered}
                    forceExpanded={activeSearchMatch()?.partId === (item() as ReasoningDisplayItem).partId}
                  />
                </Match>
              </Switch>
            )}
          </Index>
        </div>
      )}
    </Show>
  )
}
