import { Component, createMemo, createEffect, Show } from "solid-js"
import type { Session, SessionStatus } from "../../types/session"
import type { SessionThread } from "../../stores/session-state"
import { getRetrySeconds, getSessionRetry, getSessionStatus, shouldShowSessionStatus } from "../../stores/session-status"
import { Bot, User, Copy, Trash2, Pencil, ShieldAlert, ChevronDown, Split, RotateCw } from "lucide-solid"
import type { TranslateParams } from "../../lib/i18n"

function formatSessionStatus(status: SessionStatus): string {
  return status
}

interface SessionRowProps {
  sessionId: string
  isChild?: boolean
  isLastChild?: boolean
  hasChildren?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  instanceId: string
  activeSessionId: string | null
  enableFilterBar?: boolean
  t: (key: string, params?: TranslateParams) => string
  now: () => number
  selectedSessionIds: () => Set<string>
  isSessionDeleting: (sessionId: string) => boolean
  isSessionReloading: (sessionId: string) => boolean
  selectSession: (sessionId: string) => void
  copySessionId: (event: MouseEvent, sessionId: string) => void
  handleDeleteSession: (event: MouseEvent, sessionId: string) => void
  handleReloadSession: (event: MouseEvent, sessionId: string) => void
  openRenameDialog: (sessionId: string) => void
  setSelectedMany: (sessionIds: string[], checked: boolean) => void
  getSelectableThreadIds: (parentId: string) => string[]
  getInstanceSession: (instanceId: string, sessionId: string) => Session | undefined
  getWorktreeSlugForParentSession: (instanceId: string, sessionId: string) => string
  getGitRepoStatus: (instanceId: string) => boolean | null
}

const SessionRow: Component<SessionRowProps> = (props) => {
  const session = createMemo(() => props.getInstanceSession(props.instanceId, props.sessionId))
  if (!session()) {
    return <></>
  }

  const worktreeSlug = createMemo(() => {
    if (props.isChild) return "root"
    return props.getWorktreeSlugForParentSession(props.instanceId, props.sessionId)
  })

  const showWorktreeBadge = createMemo(() => {
    if (props.isChild) return false
    if (props.getGitRepoStatus(props.instanceId) === false) return false
    const slug = worktreeSlug()
    return Boolean(slug) && slug !== "root"
  })

  const isActive = () => props.activeSessionId === props.sessionId
  const title = () => session()?.title || props.t("sessionList.session.untitled")
  const status = () => getSessionStatus(props.instanceId, props.sessionId)
  const retry = () => getSessionRetry(props.instanceId, props.sessionId)
  const statusLabel = () => {
    const retryState = retry()
    if (retryState) {
      const seconds = getRetrySeconds(retryState.next, props.now())
      return seconds > 0 ? props.t("sessionList.status.retryingIn", { seconds: String(seconds) }) : props.t("sessionList.status.retrying")
    }
    switch (formatSessionStatus(status())) {
      case "working":
        return props.t("sessionList.status.working")
      case "compacting":
        return props.t("sessionList.status.compacting")
      default:
        return props.t("sessionList.status.idle")
    }
  }
  const needsPermission = () => Boolean(session()?.pendingPermission)
  const needsQuestion = () => Boolean((session() as any)?.pendingQuestion)
  const needsInput = () => needsPermission() || needsQuestion()
  const statusClassName = () => (needsInput() ? "session-permission" : `session-${retry() ? "retrying" : status()}`)
  const showStatus = () => needsInput() || shouldShowSessionStatus(props.instanceId, props.sessionId)
  const statusText = () =>
    needsPermission()
      ? props.t("sessionList.status.needsPermission")
      : needsQuestion()
        ? props.t("sessionList.status.needsInput")
        : statusLabel()
  const statusTooltip = () => {
    const retryState = retry()
    if (!retryState) return undefined
    return props.t("sessionList.status.retryTooltip", {
      message: retryState.message,
      attempt: String(retryState.attempt),
    })
  }

  const isSelected = () => props.selectedSessionIds().has(props.sessionId)

  const parentGroupState = createMemo(() => {
    if (props.isChild) {
      return { checked: isSelected(), indeterminate: false, ids: [props.sessionId] }
    }

    const ids = props.getSelectableThreadIds(props.sessionId)
    const selected = props.selectedSessionIds()
    const selectedInGroup = ids.reduce((count, id) => (selected.has(id) ? count + 1 : count), 0)
    return {
      checked: selectedInGroup > 0 && selectedInGroup === ids.length,
      indeterminate: selectedInGroup > 0 && selectedInGroup < ids.length,
      ids,
    }
  })

  let rowCheckboxEl: HTMLInputElement | null = null
  createEffect(() => {
    if (!rowCheckboxEl) return
    rowCheckboxEl.indeterminate = parentGroupState().indeterminate
  })

  return (
    <div class="session-list-item group">
      <button
        class={`session-item-base ${props.isChild ? `session-item-child${props.isLastChild ? " session-item-child-last" : ""} session-item-border-assistant session-item-kind-assistant` : "session-item-border-user session-item-kind-user"} ${isActive() ? "session-item-active" : "session-item-inactive"}`}
        data-session-id={props.sessionId}
        onClick={() => props.selectSession(props.sessionId)}
        title={title()}
        role="button"
        aria-selected={isActive()}
        aria-expanded={props.hasChildren ? Boolean(props.expanded) : undefined}
      >
        <div class="session-item-row session-item-header">
          <div class="session-item-title-row">
            <Show when={props.enableFilterBar}>
              <input
                ref={(el) => {
                  rowCheckboxEl = el
                }}
                type="checkbox"
                checked={parentGroupState().checked}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation()
                  props.setSelectedMany(parentGroupState().ids, event.currentTarget.checked)
                }}
                aria-label={props.t("sessionList.selection.checkboxAriaLabel")}
              />
            </Show>

            {props.isChild ? <Bot class="w-4 h-4 flex-shrink-0" /> : <User class="w-4 h-4 flex-shrink-0" />}
            <span class="session-item-title session-item-title--clamp" dir="auto">{title()}</span>
          </div>
        </div>
        <div class="session-item-row session-item-meta">
          <div class="flex items-center gap-2 min-w-0">
            <Show
              when={props.hasChildren && !props.isChild}
              fallback={props.isChild ? null : <span class="session-item-expander session-item-expander--spacer" aria-hidden="true" />}
            >
              <span
                class={`session-item-expander opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onToggleExpand?.()
                }}
                role="button"
                tabIndex={0}
                aria-label={
                  props.expanded ? props.t("sessionList.expand.collapseAriaLabel") : props.t("sessionList.expand.expandAriaLabel")
                }
                title={props.expanded ? props.t("sessionList.expand.collapseTitle") : props.t("sessionList.expand.expandTitle")}
              >
                <ChevronDown class={`w-3.5 h-3.5 transition-transform ${props.expanded ? "" : "-rotate-90"}`} />
              </span>
            </Show>
            <Show when={showStatus()}>
              <span
                class={`status-indicator session-status session-status-list ${statusClassName()} notranslate`}
                title={statusTooltip()}
                translate="no"
              >
                {needsInput() ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
                {statusText()}
              </span>
            </Show>
            <Show when={showWorktreeBadge()}>
              <span class="status-indicator session-status-list worktree-indicator" title={`Worktree: ${worktreeSlug()}`}>
                <Split class="w-3.5 h-3.5" aria-hidden="true" />
                <span class="worktree-indicator-label">{worktreeSlug()}</span>
              </span>
            </Show>
          </div>
          <div class="session-item-actions">
            <span
              class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
              onClick={(event) => props.copySessionId(event, props.sessionId)}
              role="button"
              tabIndex={0}
              aria-label={props.t("sessionList.actions.copyId.ariaLabel")}
              title={props.t("sessionList.actions.copyId.title")}
            >
              <Copy class="w-3 h-3" />
            </span>
            <span
              class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
              onClick={(event) => props.handleReloadSession(event, props.sessionId)}
              role="button"
              tabIndex={0}
              aria-label={props.t("sessionList.actions.reload.ariaLabel")}
              title={props.t("sessionList.actions.reload.title")}
            >
              <Show
                when={!props.isSessionReloading(props.sessionId)}
                fallback={<RotateCw class="w-3 h-3 animate-spin" />}
              >
                <RotateCw class="w-3 h-3" />
              </Show>
            </span>
            <span
              class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
              onClick={(event) => {
                event.stopPropagation()
                props.openRenameDialog(props.sessionId)
              }}
              role="button"
              tabIndex={0}
              aria-label={props.t("sessionList.actions.rename.ariaLabel")}
              title={props.t("sessionList.actions.rename.title")}
            >
              <Pencil class="w-3 h-3" />
            </span>
            <span
              class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
              onClick={(event) => props.handleDeleteSession(event, props.sessionId)}
              role="button"
              tabIndex={0}
              aria-label={props.t("sessionList.actions.delete.ariaLabel")}
              title={props.t("sessionList.actions.delete.title")}
            >
              <Show
                when={!props.isSessionDeleting(props.sessionId)}
                fallback={
                  <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path
                      class="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                }
              >
                <Trash2 class="w-3 h-3" />
              </Show>
            </span>
          </div>
        </div>
      </button>
    </div>
  )
}

export default SessionRow
