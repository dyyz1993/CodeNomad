import { For, Show, createSignal } from "solid-js"
import { FoldVertical, Trash } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { formatTokenTotal } from "../../lib/formatters"
import { showAlertDialog } from "../../stores/alerts"
import { deleteMessage } from "../../stores/session-actions"
import type { DeleteHoverState } from "../../types/delete-hover"
import type { ClientPart, MessageInfo } from "../../types/message"
import { DeleteUpToIcon, USER_BORDER_COLOR } from "./shared"

function formatCostValue(value: number) {
  if (!value) return "$0.00"
  if (value < 0.01) return `$${value.toPrecision(2)}`
  return `$${value.toFixed(2)}`
}

interface StepCardProps {
  kind: "start" | "finish"
  part: ClientPart
  messageInfo?: MessageInfo
  showAgentMeta?: boolean
  showUsage?: boolean
  borderColor?: string
  showDeleteMessage?: boolean
  instanceId?: string
  sessionId?: string
  messageId?: string
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

interface CompactionCardProps {
  part: ClientPart
  messageInfo?: MessageInfo
  borderColor?: string
  instanceId: string
  sessionId: string
  messageId: string
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

export function CompactionCard(props: CompactionCardProps) {
  const { t } = useI18n()
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)
  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.messageId))
  const isAuto = () => Boolean((props.part as any)?.auto)
  const label = () => (isAuto() ? t("messageBlock.compaction.autoLabel") : t("messageBlock.compaction.manualLabel"))
  const borderColor = () => props.borderColor ?? (isAuto() ? "var(--session-status-compacting-fg)" : USER_BORDER_COLOR)

  const containerClass = () =>
    `message-compaction-card ${isAuto() ? "message-compaction-card--auto" : "message-compaction-card--manual"}`

  const canDeleteMessage = () => Boolean(props.showDeleteMessage) && !deletingMessage()

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!canDeleteMessage()) return
    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId, props.sessionId, props.messageId)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.showDeleteMessage) return
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return

    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.messageId)
    } finally {
      setDeletingUpTo(false)
    }
  }

  return (
    <div
      class={`delete-hover-scope ${containerClass()} relative`}
      style={{ "border-left": `4px solid ${borderColor()}` }}
      role="status"
      aria-label={t("messageBlock.compaction.ariaLabel")}
    >
      <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        <Show when={props.showDeleteMessage}>
          <button
            type="button"
            class="tool-call-header-button"
            disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
            onClick={handleDeleteUpTo}
            onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId })}
            onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
            title={t("messageItem.actions.deleteMessagesUpTo")}
            aria-label={t("messageItem.actions.deleteMessagesUpTo")}
          >
            <DeleteUpToIcon />
          </button>

          <button
            type="button"
            class="tool-call-header-button"
            disabled={!canDeleteMessage()}
            onClick={handleDeleteMessage}
            onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId })}
            onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
            title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
            aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
          >
            <Trash class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </Show>
      </div>

      <div class="message-compaction-row">
        <Show when={props.showDeleteMessage}>
          <input
            class="message-select-checkbox"
            type="checkbox"
            checked={isSelectedForDeletion()}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onChange={(event) => {
              event.stopPropagation()
              const next = Boolean((event.currentTarget as HTMLInputElement).checked)
              props.onToggleSelectedMessage?.(props.messageId, next)
            }}
            aria-label={t("messageItem.selection.checkboxAriaLabel")}
            title={t("messageItem.selection.checkboxAriaLabel")}
          />
        </Show>

        <FoldVertical class="message-compaction-icon w-4 h-4" aria-hidden="true" />
        <span class="message-compaction-label">{label()}</span>
      </div>
    </div>
  )
}

export function StepCard(props: StepCardProps) {
  const { t } = useI18n()
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)
  const isSelectedForDeletion = () => Boolean(props.messageId && props.selectedMessageIds?.().has(props.messageId))
  const timestamp = () => {
    const value = props.messageInfo?.time?.created ?? (props.part as any)?.time?.start ?? Date.now()
    const date = new Date(value)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const agentIdentifier = () => {
    if (!props.showAgentMeta) return ""
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    return info.mode || ""
  }

  const modelIdentifier = () => {
    if (!props.showAgentMeta) return ""
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    const modelID = info.modelID || ""
    const providerID = info.providerID || ""
    if (modelID && providerID) return `${providerID}/${modelID}`
    return modelID
  }

  const usageStats = () => {
    if (props.kind !== "finish" || !props.showUsage) {
      return null
    }
    const info = props.messageInfo
    const part = props.part as any

    const partTokens = part?.tokens
    const infoTokens = info && info.role === "assistant" ? info.tokens : undefined
    const tokens = partTokens ?? infoTokens
    if (!tokens) {
      return null
    }

    return {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
      cost: (part?.cost ?? (info && info.role === "assistant" ? info.cost : 0)) ?? 0,
    }
  }

  const finishStyle = () => (props.borderColor ? { "border-left-color": props.borderColor } : undefined)

  const canDeleteMessage = () =>
    Boolean(props.showDeleteMessage && props.instanceId && props.sessionId && props.messageId) && !deletingMessage()

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!canDeleteMessage()) return
    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId!, props.sessionId!, props.messageId!)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.messageId) return
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return

    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.messageId)
    } finally {
      setDeletingUpTo(false)
    }
  }


  const renderUsageChips = (usage: NonNullable<ReturnType<typeof usageStats>>) => {
    const entries = [
      { label: t("messageBlock.usage.input"), value: usage.input, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.output"), value: usage.output, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.reasoning"), value: usage.reasoning, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.cacheRead"), value: usage.cacheRead, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.cacheWrite"), value: usage.cacheWrite, formatter: formatTokenTotal },
      { label: t("messageBlock.usage.cost"), value: usage.cost, formatter: formatCostValue },
    ]

    return (
      <div class="message-step-usage">
        <For each={entries}>
          {(entry) => (
            <span class="message-step-usage-chip" data-label={entry.label}>
              {entry.formatter(entry.value)}
            </span>
          )}
        </For>
      </div>
    )
  }

  if (props.kind === "finish") {
    const usage = usageStats()
    if (!usage) {
      return null
    }
    return (
      <div class={`message-step-card message-step-finish message-step-finish-flush relative`} style={finishStyle()}>
        <Show when={props.showDeleteMessage && props.messageId}>
          <input
            class="message-select-checkbox absolute left-2 top-1/2 -translate-y-1/2"
            type="checkbox"
            checked={isSelectedForDeletion()}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onChange={(event) => {
              event.stopPropagation()
              const next = Boolean((event.currentTarget as HTMLInputElement).checked)
              props.onToggleSelectedMessage?.(props.messageId!, next)
            }}
            aria-label={t("messageItem.selection.checkboxAriaLabel")}
            title={t("messageItem.selection.checkboxAriaLabel")}
          />
        </Show>

        <Show when={props.showDeleteMessage}>
          <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              type="button"
              class="message-action-button"
              disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
              onClick={handleDeleteUpTo}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId! })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              title={t("messageItem.actions.deleteMessagesUpTo")}
              aria-label={t("messageItem.actions.deleteMessagesUpTo")}
            >
              <DeleteUpToIcon />
            </button>

            <button
              type="button"
              class="message-action-button"
              disabled={!canDeleteMessage()}
              onClick={handleDeleteMessage}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId! })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
              aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
            >
              <Trash class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </Show>

        {renderUsageChips(usage)}
      </div>
    )
  }

  return (
    <div class={`message-step-card message-step-start relative`}>
      <div class="message-step-heading">
        <div class="message-step-title">
          <div class="message-step-title-left">
            <Show when={props.showDeleteMessage && props.messageId}>
              <input
                class="message-select-checkbox"
                type="checkbox"
                checked={isSelectedForDeletion()}
                onClick={(event) => {
                  event.stopPropagation()
                }}
                onChange={(event) => {
                  event.stopPropagation()
                  const next = Boolean((event.currentTarget as HTMLInputElement).checked)
                  props.onToggleSelectedMessage?.(props.messageId!, next)
                }}
                aria-label={t("messageItem.selection.checkboxAriaLabel")}
                title={t("messageItem.selection.checkboxAriaLabel")}
              />
            </Show>

            <Show when={props.showAgentMeta && (agentIdentifier() || modelIdentifier())}>
              <span class="message-step-meta-inline">
                <Show when={agentIdentifier()}>{(value) => <span>{t("messageBlock.step.agentLabel", { agent: value() })}</span>}</Show>
                <Show when={modelIdentifier()}>{(value) => <span>{t("messageBlock.step.modelLabel", { model: value() })}</span>}</Show>
              </span>
            </Show>
          </div>
          <span class="message-step-time">{timestamp()}</span>
        </div>
      </div>
    </div>
  )
}
