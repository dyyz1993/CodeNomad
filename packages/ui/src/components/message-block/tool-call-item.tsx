import { Show, Suspense, createMemo, createSignal, lazy } from "solid-js"
import { ExternalLink, Trash } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import type { DeleteHoverState } from "../../types/delete-hover"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"
import type { ClientPart } from "../../types/message"
import { sessions, setActiveParentSession, setActiveSession } from "../../stores/sessions"
import { selectInstanceTab } from "../../stores/app-tabs"
import { showAlertDialog } from "../../stores/alerts"
import { deleteMessage } from "../../stores/session-actions"
import { DeleteUpToIcon, TOOL_ICON } from "./shared"

const LazyToolCall = lazy(() => import("../tool-call"))

function ToolCallFallback() {
  return <div class="tool-call tool-call-loading" />
}

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

type ToolState = import("@opencode-ai/sdk/v2").ToolState
type ToolStateRunning = import("@opencode-ai/sdk/v2").ToolStateRunning
type ToolStateCompleted = import("@opencode-ai/sdk/v2").ToolStateCompleted
type ToolStateError = import("@opencode-ai/sdk/v2").ToolStateError

function isToolStateRunning(state: ToolState | undefined): state is ToolStateRunning {
  return Boolean(state && state.status === "running")
}

function isToolStateCompleted(state: ToolState | undefined): state is ToolStateCompleted {
  return Boolean(state && state.status === "completed")
}

function isToolStateError(state: ToolState | undefined): state is ToolStateError {
  return Boolean(state && state.status === "error")
}

function extractTaskSessionId(state: ToolState | undefined): string {
  if (!state) return ""
  const metadata = (state as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
  const directId = metadata?.sessionId ?? metadata?.sessionID
  return typeof directId === "string" ? directId : ""
}

interface TaskSessionLocation {
  sessionId: string
  instanceId: string
  parentId: string | null
}

function findTaskSessionLocation(sessionId: string, preferredInstanceId?: string): TaskSessionLocation | null {
  if (!sessionId) return null

  if (preferredInstanceId) {
    const session = sessions().get(preferredInstanceId)?.get(sessionId)
    if (session) {
      return {
        sessionId: session.id,
        instanceId: preferredInstanceId,
        parentId: session.parentId ?? null,
      }
    }
  }

  const allSessions = sessions()
  for (const [instanceId, sessionMap] of allSessions) {
    const session = sessionMap?.get(sessionId)
    if (session) {
      return {
        sessionId: session.id,
        instanceId,
        parentId: session.parentId ?? null,
      }
    }
  }
  return null
}

function navigateToTaskSession(location: TaskSessionLocation) {
  selectInstanceTab(location.instanceId)
  const parentToActivate = location.parentId ?? location.sessionId
  setActiveParentSession(location.instanceId, parentToActivate)
  if (location.parentId) {
    setActiveSession(location.instanceId, location.sessionId)
  }
}

export interface ToolCallItemProps {
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageId: string
  partId: string
  onContentRendered?: () => void
  showDeleteMessage?: boolean
  deleteHover?: () => DeleteHoverState
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  selectedMessageIds?: () => Set<string>
  selectedToolPartKeys?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
}

export function ToolCallItem(props: ToolCallItemProps) {
  const { t } = useI18n()
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)

  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.messageId))

  const isSelectedToolPartForDeletion = () => Boolean(props.selectedToolPartKeys?.().has(`${props.messageId}:${props.partId}`))

  const isDeleteOverlayActive = () => {
    if (isSelectedForDeletion()) return true
    if (isSelectedToolPartForDeletion()) return true
    const hover = props.deleteHover?.() ?? ({ kind: "none" } as DeleteHoverState)
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

  const record = createMemo(() => props.store().getMessage(props.messageId))
  const messageInfo = createMemo(() => props.store().getMessageInfo(props.messageId))
  const partEntry = createMemo(() => record()?.parts?.[props.partId])

  const toolPart = createMemo(() => {
    const part = partEntry()?.data as ClientPart | undefined
    if (!part || part.type !== "tool") return undefined
    return part as ToolCallPart
  })

  const toolState = createMemo(() => toolPart()?.state as ToolState | undefined)
  const toolName = createMemo(() => toolPart()?.tool || "")
  const messageVersion = createMemo(() => record()?.revision ?? 0)
  const partVersion = createMemo(() => partEntry()?.revision ?? 0)

  const taskSessionId = createMemo(() => {
    const state = toolState()
    if (!state) return ""
    if (!(isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state))) {
      return ""
    }
    return extractTaskSessionId(state)
  })

  const taskLocation = createMemo(() => {
    const id = taskSessionId()
    if (!id) return null
    return findTaskSessionLocation(id, props.instanceId)
  })

  const handleGoToTaskSession = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const location = taskLocation()
    if (!location) return
    navigateToTaskSession(location)
  }

  const handleDeleteMessage = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    if (!props.showDeleteMessage) return
    if (deletingMessage()) return

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
    <Show when={toolPart()}>
      {(resolvedToolPart) => (
        <div class="delete-hover-scope" data-delete-part-hover={isDeleteOverlayActive() ? "true" : undefined}>
          <div class="tool-call-header-label">
            <div class="tool-call-header-meta">
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

              <span class="tool-call-icon">{TOOL_ICON}</span>
              <span>{t("messageBlock.tool.header")}</span>
              <span class="tool-name">{toolName() || t("messageBlock.tool.unknown")}</span>
            </div>

            <div class="flex items-center gap-0">
              <Show when={taskSessionId()}>
                <button
                  class="tool-call-header-button"
                  type="button"
                  disabled={!taskLocation()}
                  onClick={handleGoToTaskSession}
                  title={t("messageBlock.tool.goToSession.label")}
                  aria-label={t("messageBlock.tool.goToSession.label")}
                >
                  <ExternalLink class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Show>

              <Show when={props.showDeleteMessage}>
                <button
                  class="tool-call-header-button"
                  type="button"
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
                  class="tool-call-header-button"
                  type="button"
                  disabled={deletingMessage()}
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
          </div>

          <Suspense fallback={<ToolCallFallback />}>
            <LazyToolCall
              toolCall={resolvedToolPart()}
              toolCallId={props.partId}
              messageId={props.messageId}
              messageVersion={messageVersion()}
              partVersion={partVersion()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              onContentRendered={props.onContentRendered}
            />
          </Suspense>
        </div>
      )}
    </Show>
  )
}
