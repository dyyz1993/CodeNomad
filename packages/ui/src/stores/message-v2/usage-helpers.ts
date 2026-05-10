import type { MessageInfo } from "../../types/message"
import type { SessionUsageState, UsageEntry } from "./types"

export function createEmptyUsageState(): SessionUsageState {
  return {
    entries: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    actualUsageTokens: 0,
    latestMessageId: undefined,
  }
}

export function extractUsageEntry(info: MessageInfo | undefined): UsageEntry | null {
  if (!info || info.role !== "assistant") return null
  const messageId = typeof info.id === "string" ? info.id : undefined
  if (!messageId) return null
  const tokens = info.tokens
  if (!tokens) return null
  const inputTokens = tokens.input ?? 0
  const outputTokens = tokens.output ?? 0
  const reasoningTokens = tokens.reasoning ?? 0
  const cacheReadTokens = tokens.cache?.read ?? 0
  const cacheWriteTokens = tokens.cache?.write ?? 0
  if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return null
  }
  const combinedTokens = info.summary ? outputTokens : inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens
  return {
    messageId,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    combinedTokens,
    cost: info.cost ?? 0,
    timestamp: info.time?.created ?? 0,
    hasContextUsage: inputTokens + cacheReadTokens + cacheWriteTokens > 0,
  }
}

export function applyUsageState(state: SessionUsageState, entry: UsageEntry | null) {
  if (!entry) return
  state.entries[entry.messageId] = entry
  state.totalInputTokens += entry.inputTokens
  state.totalOutputTokens += entry.outputTokens
  state.totalReasoningTokens += entry.reasoningTokens
  state.totalCost += entry.cost
  if (!state.latestMessageId || entry.timestamp >= (state.entries[state.latestMessageId]?.timestamp ?? 0)) {
    state.latestMessageId = entry.messageId
    state.actualUsageTokens = entry.combinedTokens
  }
}

export function removeUsageEntry(state: SessionUsageState, messageId: string | undefined) {
  if (!messageId) return
  const existing = state.entries[messageId]
  if (!existing) return
  state.totalInputTokens -= existing.inputTokens
  state.totalOutputTokens -= existing.outputTokens
  state.totalReasoningTokens -= existing.reasoningTokens
  state.totalCost -= existing.cost
  delete state.entries[messageId]
  if (state.latestMessageId === messageId) {
    state.latestMessageId = undefined
    state.actualUsageTokens = 0
    let latest: UsageEntry | null = null
    for (const candidate of Object.values(state.entries) as UsageEntry[]) {
      if (!latest || candidate.timestamp >= latest.timestamp) {
        latest = candidate
      }
    }
    if (latest) {
      state.latestMessageId = latest.messageId
      state.actualUsageTokens = latest.combinedTokens
    }
  }
}

export function rebuildUsageStateFromInfos(infos: Iterable<MessageInfo>): SessionUsageState {
  const usageState = createEmptyUsageState()
  for (const info of infos) {
    const entry = extractUsageEntry(info)
    if (entry) {
      applyUsageState(usageState, entry)
    }
  }
  return usageState
}
