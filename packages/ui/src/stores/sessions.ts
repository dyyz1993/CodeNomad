import type { SessionInfo } from "./session-state"

import { sseManager } from "../lib/sse-manager"
import { serverEvents } from "../lib/server-events"
import { instances } from "./instances"

import {
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  ensureSessionParentExpanded,
  getActiveParentSession,
  getActiveSession,
  getChildSessions,
  getParentSessions,
  getSessionDraftPrompt,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  getSessions,
  getVisibleSessionIds,
  isSessionKnown,
  isSessionMessagesLoading,
  isSessionParentExpanded,
  loading,
  providers,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  setSessionDraftPrompt,
  setSessionParentExpanded,
  setSessionStatus,
  toggleSessionParentExpanded,
} from "./session-state"

import { getDefaultModel } from "./session-models"
import {
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  forkSession,
  loadMessages,
} from "./session-api"
import {
  abortSession,
  executeCustomCommand,
  renameSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
} from "./session-actions"
import {
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessagePartDelta,
  handleMessageUpdate,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleQuestionAnswered,
  handleQuestionAsked,
  handleSessionCompacted,
  handleSessionDiff,
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionUpdate,
  handleTuiToast,
} from "./session-events"

import { getLogger } from "../lib/logger"

const log = getLogger("session")

sseManager.onMessageUpdate = handleMessageUpdate
sseManager.onMessagePartUpdated = handleMessageUpdate
sseManager.onMessagePartDelta = handleMessagePartDelta
sseManager.onMessageRemoved = handleMessageRemoved
sseManager.onMessagePartRemoved = handleMessagePartRemoved
sseManager.onSessionUpdate = handleSessionUpdate
sseManager.onSessionCompacted = handleSessionCompacted
sseManager.onSessionDiff = handleSessionDiff
sseManager.onSessionError = handleSessionError
sseManager.onSessionIdle = handleSessionIdle
sseManager.onSessionStatus = handleSessionStatus
sseManager.onTuiToast = handleTuiToast
sseManager.onPermissionUpdated = handlePermissionUpdated
sseManager.onPermissionReplied = handlePermissionReplied
sseManager.onQuestionAsked = handleQuestionAsked
sseManager.onQuestionAnswered = handleQuestionAnswered

serverEvents.onOpen(() => {
  const known = sessions()
  if (known.size === 0) return
  for (const [instanceId] of known) {
    const inst = instances().get(instanceId)
    if (!inst?.client) continue
    fetchSessions(instanceId).catch((err) => {
      log.warn("Reconnect status refresh failed", { instanceId, err })
    })
  }
})

export {
  abortSession,
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  createSession,
  deleteSession,
  ensureSessionParentExpanded,
  executeCustomCommand,
  renameSession,
  runShellCommand,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  forkSession,
  getActiveParentSession,
  getActiveSession,
  getChildSessions,
  getDefaultModel,
  getParentSessions,
  getSessionDraftPrompt,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  getSessions,
  getVisibleSessionIds,
  isSessionKnown,
  isSessionMessagesLoading,
  isSessionParentExpanded,
  loadMessages,
  loading,
  providers,
  sendMessage,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  setSessionDraftPrompt,
  setSessionParentExpanded,
  setSessionStatus,
  toggleSessionParentExpanded,
  updateSessionAgent,
  updateSessionModel,
}
export type { SessionInfo }
