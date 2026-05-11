import { Component, For, Show, createSignal, createMemo, createEffect, JSX, onCleanup } from "solid-js"
import type { SessionThread } from "../stores/session-state"
import { Search, Square, CheckSquare, MinusSquare } from "lucide-solid"
import SessionRow from "./session-list/SessionRow"
import KeyboardHint from "./keyboard-hint"
import SessionRenameDialog from "./session-rename-dialog"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { showToastNotification } from "../lib/notifications"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import {
  deleteSession,
  ensureSessionParentExpanded,
  getVisibleSessionIds,
  isSessionParentExpanded,
  loadMessages,
  loading,
  renameSession,
  sessions as sessionStateSessions,
  setActiveSessionFromList,
  toggleSessionParentExpanded,
} from "../stores/sessions"
import { getGitRepoStatus, getWorktreeSlugForParentSession } from "../stores/worktrees"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
const log = getLogger("session")



interface SessionListProps {
  instanceId: string
  threads: SessionThread[]
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onNew: () => void
  showHeader?: boolean
  showFooter?: boolean
  headerContent?: JSX.Element
  footerContent?: JSX.Element
  enableFilterBar?: boolean
}

const SessionList: Component<SessionListProps> = (props) => {
  const { t } = useI18n()
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string; label: string } | null>(null)
  const [isRenaming, setIsRenaming] = createSignal(false)

  const [filterQuery, setFilterQuery] = createSignal("")
  const normalizedQuery = createMemo(() => (props.enableFilterBar ? filterQuery().trim().toLowerCase() : ""))

  const [selectedSessionIds, setSelectedSessionIds] = createSignal<Set<string>>(new Set())
  const [reloadingSessionIds, setReloadingSessionIds] = createSignal<Set<string>>(new Set())
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (typeof window === "undefined") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  const normalizeSessionLabel = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    const title = (session?.title ?? "").trim()
    return title || t("sessionList.session.untitled")
  }

  const sessionMatchesQuery = (sessionId: string, query: string) => {
    if (!query) return true
    const label = normalizeSessionLabel(sessionId).toLowerCase()
    if (label.includes(query)) return true
    return sessionId.toLowerCase().includes(query)
  }

  const filteredThreads = createMemo<SessionThread[]>(() => {
    const query = normalizedQuery()
    if (!query) return props.threads

    const next: SessionThread[] = []
    for (const thread of props.threads) {
      const parentMatches = sessionMatchesQuery(thread.parent.id, query)
      const matchingChildren = thread.children.filter((child) => sessionMatchesQuery(child.id, query))

      if (!parentMatches && matchingChildren.length === 0) continue

      next.push({
        parent: thread.parent,
        children: matchingChildren,
        latestUpdated: thread.latestUpdated,
      })
    }

    return next
  })

  const allMatchingSessionIds = createMemo<string[]>(() => {
    const ids: string[] = []
    for (const thread of filteredThreads()) {
      ids.push(thread.parent.id)
      for (const child of thread.children) ids.push(child.id)
    }
    return ids
  })

  const selectedCount = createMemo(() => selectedSessionIds().size)

  const isAllSelected = createMemo(() => {
    const ids = allMatchingSessionIds()
    if (ids.length === 0) return false
    const selected = selectedSessionIds()
    return ids.every((id) => selected.has(id))
  })
  const isSelectAllIndeterminate = createMemo(() => {
    const ids = allMatchingSessionIds()
    const total = ids.length
    if (total === 0) return false
    const count = selectedCount()
    return count > 0 && count < total
  })

  const isSessionDeleting = (sessionId: string) => {
    const deleting = loading().deletingSession.get(props.instanceId)
    return deleting ? deleting.has(sessionId) : false
  }
 

  const selectSession = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    // If the user selects a child session, make sure its parent thread is expanded.
    // For parent sessions we don't force expansion; user can collapse/expand freely.
    if (session?.parentId) {
      ensureSessionParentExpanded(props.instanceId, session.parentId)
    }

    props.onSelect(sessionId)
  }
 
  const copySessionId = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()

    try {
      const success = await copyToClipboard(sessionId)
      if (success) {
        showToastNotification({ message: t("sessionList.copyId.success"), variant: "success" })
      } else {
        showToastNotification({ message: t("sessionList.copyId.error"), variant: "error" })
      }
    } catch (error) {
      log.error(`Failed to copy session ID ${sessionId}:`, error)
      showToastNotification({ message: t("sessionList.copyId.error"), variant: "error" })
    }
  }
 
  const handleDeleteSession = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()
    if (isSessionDeleting(sessionId)) return

    const confirmed = await showConfirmDialog(
      t("sessionList.delete.confirmMessage", { label: normalizeSessionLabel(sessionId) }),
      {
        title: t("sessionList.delete.title"),
        variant: "warning",
        confirmLabel: t("sessionList.delete.confirmLabel"),
        cancelLabel: t("sessionList.delete.cancelLabel"),
        dismissible: false,
      },
    )
    if (!confirmed) return

    const shouldSelectFallback = props.activeSessionId === sessionId
    let fallbackSessionId: string | undefined

    if (shouldSelectFallback) {
      const visible = getVisibleSessionIds(props.instanceId)
      const currentIndex = visible.indexOf(sessionId)
      const remaining = visible.filter((id) => id !== sessionId)

      if (remaining.length > 0) {
        if (currentIndex !== -1) {
          for (let i = currentIndex; i < visible.length; i++) {
            const candidate = visible[i]
            if (candidate && candidate !== sessionId) {
              fallbackSessionId = candidate
              break
            }
          }

          if (!fallbackSessionId) {
            for (let i = currentIndex - 1; i >= 0; i--) {
              const candidate = visible[i]
              if (candidate && candidate !== sessionId) {
                fallbackSessionId = candidate
                break
              }
            }
          }
        }

        fallbackSessionId ??= remaining[0]
      }
    }

    try {
      await deleteSession(props.instanceId, sessionId)
      if (fallbackSessionId) {
        setActiveSessionFromList(props.instanceId, fallbackSessionId)
      }
    } catch (error) {
      log.error(`Failed to delete session ${sessionId}:`, error)
      showToastNotification({ message: t("sessionList.delete.error"), variant: "error" })
    }
  }

  const openRenameDialog = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    if (!session) return
    const label = session.title && session.title.trim() ? session.title : sessionId
    setRenameTarget({ id: sessionId, title: session.title ?? "", label })
  }

  const isSessionReloading = (sessionId: string) => reloadingSessionIds().has(sessionId)

  const handleReloadSession = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()
    if (isSessionReloading(sessionId)) return

    setReloadingSessionIds((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })

    try {
      await loadMessages(props.instanceId, sessionId, true)
    } catch (error) {
      log.error(`Failed to reload session ${sessionId}:`, error)
      showToastNotification({ message: t("sessionList.reload.error"), variant: "error" })
    } finally {
      setReloadingSessionIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }

  const closeRenameDialog = () => {
    setRenameTarget(null)
  }

  const handleRenameSubmit = async (nextTitle: string) => {
    const target = renameTarget()
    if (!target) return
 
    setIsRenaming(true)
    try {
      await renameSession(props.instanceId, target.id, nextTitle)
      setRenameTarget(null)
    } catch (error) {
      log.error(`Failed to rename session ${target.id}:`, error)
      showToastNotification({ message: t("sessionList.rename.error"), variant: "error" })
    } finally {
      setIsRenaming(false)
    }
  }

  const setSelectedMany = (sessionIds: string[], checked: boolean) => {
    if (sessionIds.length === 0) return
    setSelectedSessionIds((prev) => {
      const next = new Set(prev)
      sessionIds.forEach((id) => {
        if (checked) next.add(id)
        else next.delete(id)
      })
      return next
    })
  }

  const getSelectableThreadIds = (parentId: string): string[] => {
    const query = normalizedQuery()
    const source = query ? filteredThreads() : props.threads
    const thread = source.find((t) => t.parent.id === parentId)
    if (!thread) return [parentId]
    return [thread.parent.id, ...thread.children.map((c) => c.id)]
  }

  const getAllSessionIdsInOrder = (threads: SessionThread[]): string[] => {
    const ids: string[] = []
    threads.forEach((thread) => {
      ids.push(thread.parent.id)
      thread.children.forEach((child) => ids.push(child.id))
    })
    return ids
  }

  const handleToggleSelectAll = (checked: boolean) => {
    const ids = allMatchingSessionIds()
    setSelectedMany(ids, checked)
  }

  const toggleSelectAll = () => {
    if (isAllSelected()) {
      handleToggleSelectAll(false)
      return
    }
    handleToggleSelectAll(true)
  }

  const handleBulkDelete = async () => {
    const selected = Array.from(selectedSessionIds())
    if (selected.length === 0) return

    const confirmed = await showConfirmDialog(
      t("sessionList.bulkDelete.confirmMessage", { count: selected.length }),
      {
        title: t("sessionList.bulkDelete.title"),
        variant: "warning",
        confirmLabel: t("sessionList.bulkDelete.confirmLabel"),
        cancelLabel: t("sessionList.bulkDelete.cancelLabel"),
        dismissible: false,
      },
    )

    if (!confirmed) return

    const deletedSet = new Set(selected)
    const currentActiveId = props.activeSessionId

    let fallbackSessionId: string | undefined
    if (currentActiveId && deletedSet.has(currentActiveId)) {
      const ordered = getAllSessionIdsInOrder(props.threads)
      const currentIndex = ordered.indexOf(currentActiveId)

      for (let i = Math.max(0, currentIndex); i < ordered.length; i++) {
        const candidate = ordered[i]
        if (candidate && !deletedSet.has(candidate)) {
          fallbackSessionId = candidate
          break
        }
      }
      if (!fallbackSessionId) {
        for (let i = currentIndex - 1; i >= 0; i--) {
          const candidate = ordered[i]
          if (candidate && !deletedSet.has(candidate)) {
            fallbackSessionId = candidate
            break
          }
        }
      }
    }

    let failed = 0
    for (const sessionId of selected) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteSession(props.instanceId, sessionId)
      } catch (error) {
        failed += 1
        log.error(`Failed to delete session ${sessionId}:`, error)
      }
    }

    setSelectedSessionIds(new Set<string>())

    if (fallbackSessionId) {
      setActiveSessionFromList(props.instanceId, fallbackSessionId)
    }

    if (failed > 0) {
      showToastNotification({
        message: t("sessionList.bulkDelete.error", { count: failed }),
        variant: "error",
      })
    }
  }
 

  const getInstanceSession = (instanceId: string, sessionId: string) =>
    sessionStateSessions().get(instanceId)?.get(sessionId)

  const activeParentId = createMemo(() => {
    const activeId = props.activeSessionId
    if (!activeId || activeId === "info") return null

    const activeSession = sessionStateSessions().get(props.instanceId)?.get(activeId)
    if (!activeSession) return null

    return activeSession.parentId ?? activeSession.id
  })

  createEffect(() => {
    // Keep the active child session visible by ensuring its parent is expanded.
    // Don't force-expanding when the active session itself is a parent lets users collapse it.
    const activeId = props.activeSessionId
    if (!activeId || activeId === "info") return
    const activeSession = sessionStateSessions().get(props.instanceId)?.get(activeId)
    if (!activeSession) return
    if (!activeSession.parentId) return
    const parentId = activeParentId()
    if (!parentId) return
    ensureSessionParentExpanded(props.instanceId, parentId)
  })
 
  const listEl = createSignal<HTMLElement | null>(null)

  const escapeCss = (value: string) => {
    if (typeof CSS !== "undefined" && typeof (CSS as any).escape === "function") {
      return (CSS as any).escape(value)
    }
    return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"")
  }

  const scrollActiveIntoView = (sessionId: string) => {
    const root = listEl[0]()
    if (!root) return

    const selector = `[data-session-id="${escapeCss(sessionId)}"]`

    const scrollNow = () => {
      const target = root.querySelector(selector) as HTMLElement | null
      if (!target) return
      target.scrollIntoView({ block: "nearest", inline: "nearest" })
    }

    if (typeof requestAnimationFrame === "undefined") {
      scrollNow()
      return
    }

    // Wait a couple frames so expand/collapse DOM settles.
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        scrollNow()
      })
    })

    onCleanup(() => {
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    })
  }

  createEffect(() => {
    const activeId = props.activeSessionId
    if (!activeId || activeId === "info") return
    scrollActiveIntoView(activeId)
  })

  return (
    <div
      class="session-list-container bg-surface-secondary border-r border-base flex flex-col w-full"
    >
      <Show when={props.enableFilterBar}>
        <div class="p-3 border-b border-base">
          <div class="flex items-center gap-2">
            <div class="relative flex-1 min-w-0">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true">
                <Search class="w-4 h-4" />
              </span>
              <input
                type="text"
                class="form-input pl-9"
                value={filterQuery()}
                onInput={(e) => setFilterQuery(e.currentTarget.value)}
                placeholder={t("sessionList.filter.placeholder")}
                aria-label={t("sessionList.filter.ariaLabel")}
              />
            </div>

            <button
              type="button"
              class="button-tertiary p-2 inline-flex items-center justify-center"
              onClick={toggleSelectAll}
              disabled={allMatchingSessionIds().length === 0}
              aria-label={t("sessionList.selection.selectAllAriaLabel")}
              title={t("sessionList.selection.selectAllLabel")}
            >
              <Show
                when={isSelectAllIndeterminate()}
                fallback={isAllSelected() ? <CheckSquare class="w-4 h-4" /> : <Square class="w-4 h-4" />}
              >
                <MinusSquare class="w-4 h-4" />
              </Show>
            </button>
          </div>

          <Show when={selectedCount() > 0}>
            <div class="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                class="button-tertiary"
                onClick={handleBulkDelete}
                aria-label={t("sessionList.bulkDelete.ariaLabel", { count: selectedCount() })}
              >
                {t("sessionList.bulkDelete.button", { count: selectedCount() })}
              </button>
              <button
                type="button"
                class="button-tertiary"
                onClick={() => setSelectedSessionIds(new Set<string>())}
                aria-label={t("sessionList.selection.clearAriaLabel")}
              >
                {t("sessionList.selection.clearLabel")}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.showHeader !== false}>
        <div class="session-list-header p-3 border-b border-base">
          {props.headerContent ?? (
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-semibold text-primary notranslate" translate="no">
                {t("sessionList.header.title")}
              </h3>
              <KeyboardHint
                shortcuts={[keyboardRegistry.get("session-prev")!, keyboardRegistry.get("session-next")!].filter(Boolean)}
              />
            </div>
          )}
        </div>
      </Show>

       <div class="session-list flex-1 overflow-y-auto" ref={(el) => listEl[1](el)}>

          <Show when={filteredThreads().length > 0}>
            <div class="session-section">
              <For each={filteredThreads()}>

               {(thread) => {
                 const expanded = () => (normalizedQuery() ? true : isSessionParentExpanded(props.instanceId, thread.parent.id))
                 return (
                   <>
                        <SessionRow
                          sessionId={thread.parent.id}
                          hasChildren={thread.children.length > 0}
                          expanded={expanded()}
                          onToggleExpand={() => toggleSessionParentExpanded(props.instanceId, thread.parent.id)}
                          instanceId={props.instanceId}
                          activeSessionId={props.activeSessionId}
                          enableFilterBar={props.enableFilterBar}
                          t={t}
                          now={now}
                          selectedSessionIds={selectedSessionIds}
                          isSessionDeleting={isSessionDeleting}
                          isSessionReloading={isSessionReloading}
                          selectSession={selectSession}
                          copySessionId={copySessionId}
                          handleDeleteSession={handleDeleteSession}
                          handleReloadSession={handleReloadSession}
                          openRenameDialog={openRenameDialog}
                          setSelectedMany={setSelectedMany}
                          getSelectableThreadIds={getSelectableThreadIds}
                          getInstanceSession={getInstanceSession}
                          getWorktreeSlugForParentSession={getWorktreeSlugForParentSession}
                          getGitRepoStatus={getGitRepoStatus}
                        />

                     <Show when={expanded() && thread.children.length > 0}>
                       <For each={thread.children}>
                         {(child, index) => (
                            <SessionRow
                              sessionId={child.id}
                              isChild
                              isLastChild={index() === thread.children.length - 1}
                              instanceId={props.instanceId}
                              activeSessionId={props.activeSessionId}
                              enableFilterBar={props.enableFilterBar}
                              t={t}
                              now={now}
                              selectedSessionIds={selectedSessionIds}
                              isSessionDeleting={isSessionDeleting}
                              isSessionReloading={isSessionReloading}
                              selectSession={selectSession}
                              copySessionId={copySessionId}
                              handleDeleteSession={handleDeleteSession}
                              handleReloadSession={handleReloadSession}
                              openRenameDialog={openRenameDialog}
                              setSelectedMany={setSelectedMany}
                              getSelectableThreadIds={getSelectableThreadIds}
                              getInstanceSession={getInstanceSession}
                              getWorktreeSlugForParentSession={getWorktreeSlugForParentSession}
                              getGitRepoStatus={getGitRepoStatus}
                            />
                         )}
                       </For>
                     </Show>
                   </>
                 )
               }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.showFooter !== false}>
        <div class="session-list-footer p-3 border-t border-base">
          {props.footerContent ?? null}
        </div>
      </Show>

      <SessionRenameDialog
        open={Boolean(renameTarget())}
        currentTitle={renameTarget()?.title ?? ""}
        sessionLabel={renameTarget()?.label}
        isSubmitting={isRenaming()}
        onRename={handleRenameSubmit}
        onClose={closeRenameDialog}
      />
    </div>
  )
}

export default SessionList
