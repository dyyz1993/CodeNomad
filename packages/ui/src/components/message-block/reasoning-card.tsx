import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { ChevronsDownUp, ChevronsUpDown, Trash } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import type { DeleteHoverState } from "../../types/delete-hover"
import type { ClientPart, MessageInfo } from "../../types/message"
import { useSpeech } from "../../lib/hooks/use-speech"
import SpeechActionButton from "../speech-action-button"
import { createFollowScroll } from "../../lib/follow-scroll"
import { showAlertDialog } from "../../stores/alerts"
import { deleteMessage } from "../../stores/session-actions"
import { DeleteUpToIcon, REASONING_SCROLL_SENTINEL_MARGIN_PX } from "./shared"

interface ReasoningCardProps {
  part: ClientPart
  messageInfo?: MessageInfo
  instanceId: string
  sessionId: string
  messageId: string
  showAgentMeta?: boolean
  defaultExpanded?: boolean
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
  onContentRendered?: () => void
  forceExpanded?: boolean
}

function ReasoningStreamOutput(props: {
  text: () => string
  scrollTopSnapshot: () => number
  setScrollTopSnapshot: (next: number) => void
  onContentRendered?: () => void
  ariaLabel: string
}) {
  let preRef: HTMLPreElement | undefined
  let pendingRenderNotificationFrame: number | null = null

  const followScroll = createFollowScroll({
    getScrollTopSnapshot: props.scrollTopSnapshot,
    setScrollTopSnapshot: props.setScrollTopSnapshot,
    sentinelMarginPx: REASONING_SCROLL_SENTINEL_MARGIN_PX,
    sentinelClassName: "reasoning-scroll-sentinel",
  })

  const notifyContentRendered = () => {
    if (!props.onContentRendered || typeof requestAnimationFrame !== "function") return
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
    }
    pendingRenderNotificationFrame = requestAnimationFrame(() => {
      pendingRenderNotificationFrame = null
      props.onContentRendered?.()
    })
  }

  createEffect(() => {
    const nextText = props.text()
    if (preRef && preRef.textContent !== nextText) {
      preRef.textContent = nextText
    }
    followScroll.restoreAfterRender()
    notifyContentRendered()
  })

  onCleanup(() => {
    if (pendingRenderNotificationFrame !== null) {
      cancelAnimationFrame(pendingRenderNotificationFrame)
      pendingRenderNotificationFrame = null
    }
  })

  return (
    <div
      ref={followScroll.registerContainer}
      class="message-reasoning-output"
      role="region"
      aria-label={props.ariaLabel}
      onScroll={followScroll.handleScroll}
    >
      <pre
        ref={(element) => {
          preRef = element || undefined
          if (preRef) {
            preRef.textContent = props.text() || ""
          }
        }}
        class="message-reasoning-text"
        dir="auto"
      />
      {followScroll.renderSentinel()}
    </div>
  )
}

export function ReasoningCard(props: ReasoningCardProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal(Boolean(props.defaultExpanded))
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)
  const [scrollTopSnapshot, setScrollTopSnapshot] = createSignal(0)
  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.messageId))

  createEffect(() => {
    setExpanded(Boolean(props.defaultExpanded))
  })

  createEffect(() => {
    if (props.forceExpanded) {
      setExpanded(true)
    }
  })

  const timestamp = () => {
    const value = props.messageInfo?.time?.created ?? (props.part as any)?.time?.start ?? Date.now()
    const date = new Date(value)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const agentIdentifier = () => {
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    return info.mode || ""
  }

  const modelIdentifier = () => {
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    const modelID = info.modelID || ""
    const providerID = info.providerID || ""
    if (modelID && providerID) return `${providerID}/${modelID}`
    return modelID
  }

  const hasMeta = () => Boolean(props.showAgentMeta && (agentIdentifier() || modelIdentifier()))

  const reasoningText = () => {
    const part = props.part as any
    if (!part) return ""

    const stringifySegment = (segment: unknown): string => {
      if (typeof segment === "string") {
        return segment
      }
      if (segment && typeof segment === "object") {
        const obj = segment as { text?: unknown; value?: unknown; content?: unknown[] }
        const pieces: string[] = []
        if (typeof obj.text === "string") {
          pieces.push(obj.text)
        }
        if (typeof obj.value === "string") {
          pieces.push(obj.value)
        }
        if (Array.isArray(obj.content)) {
          pieces.push(obj.content.map((entry) => stringifySegment(entry)).join("\n"))
        }
        return pieces.filter((piece) => piece && piece.trim().length > 0).join("\n")
      }
      return ""
    }

    const textValue = stringifySegment(part.text)
    if (textValue.trim().length > 0) {
      return textValue
    }
    if (Array.isArray(part.content)) {
      return part.content.map((entry: unknown) => stringifySegment(entry)).join("\n")
    }
    return ""
  }

  const toggle = () => setExpanded((prev) => !prev)

  const viewHideLabel = () =>
    expanded() ? t("messageBlock.reasoning.indicator.hide") : t("messageBlock.reasoning.indicator.view")

  const speech = useSpeech({
    id: () => `${props.instanceId}:${props.sessionId}:${props.messageId}:${(props.part as any)?.id ?? "reasoning"}`,
    text: reasoningText,
  })

  const canSpeakReasoning = () => reasoningText().trim().length > 0 && speech.canUseSpeech()

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
      class="delete-hover-scope message-reasoning-card"
      data-part-id={typeof (props.part as any)?.id === "string" ? (props.part as any).id : undefined}
    >
      <div class="message-reasoning-header">
        <button
          type="button"
          class="message-reasoning-toggle"
          onClick={toggle}
          aria-expanded={expanded()}
          aria-label={expanded() ? t("messageBlock.reasoning.collapseAriaLabel") : t("messageBlock.reasoning.expandAriaLabel")}
        >
          <span class="message-reasoning-label">
            <span class="message-reasoning-label-primary">
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

              <span>{t("messageBlock.reasoning.thinkingLabel")}</span>
            </span>
          </span>
        </button>

        <div class="message-reasoning-actions">
          <Show when={canSpeakReasoning()}>
            <SpeechActionButton
              class="message-action-button"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void speech.toggle()
              }}
              title={speech.buttonTitle()}
              isLoading={speech.isLoading()}
              isPlaying={speech.isPlaying()}
            />
          </Show>

          <button
            type="button"
            class="message-action-button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              toggle()
            }}
            aria-label={viewHideLabel()}
            title={viewHideLabel()}
          >
            <Show when={expanded()} fallback={<ChevronsUpDown class="w-3.5 h-3.5" aria-hidden="true" />}>
              <ChevronsDownUp class="w-3.5 h-3.5" aria-hidden="true" />
            </Show>
          </button>

          <Show when={props.showDeleteMessage}>
            <button
              type="button"
              class="message-action-button"
              onClick={handleDeleteUpTo}
              disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.messageId })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              aria-label={t("messageItem.actions.deleteMessagesUpTo")}
              title={t("messageItem.actions.deleteMessagesUpTo")}
            >
              <DeleteUpToIcon />
            </button>

            <button
              type="button"
              class="message-action-button"
              onClick={handleDeleteMessage}
              disabled={!canDeleteMessage()}
              onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.messageId })}
              onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
              aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
              title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
            >
              <Trash class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Show>

          <span class="message-reasoning-time">{timestamp()}</span>
        </div>
      </div>

      <Show when={hasMeta()}>
        <div class="message-reasoning-meta-row">
          <span class="message-step-meta-inline">
            <Show when={agentIdentifier()}>
              {(value) => (
                <span class="font-medium text-[var(--message-assistant-border)]">{t("messageBlock.step.agentLabel", { agent: value() })}</span>
              )}
            </Show>
            <Show when={modelIdentifier()}>
              {(value) => (
                <span class="font-medium text-[var(--message-assistant-border)]">{t("messageBlock.step.modelLabel", { model: value() })}</span>
              )}
            </Show>
          </span>
        </div>
      </Show>

      <Show when={expanded()}>
        <div class="message-reasoning-expanded">
          <div class="message-reasoning-body">
            <ReasoningStreamOutput
              text={reasoningText}
              scrollTopSnapshot={scrollTopSnapshot}
              setScrollTopSnapshot={setScrollTopSnapshot}
              onContentRendered={props.onContentRendered}
              ariaLabel={t("messageBlock.reasoning.detailsAriaLabel")}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
