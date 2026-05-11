import { Show, createMemo, type Accessor } from "solid-js"
import { ShieldAlert } from "lucide-solid"
import { useI18n } from "../../../lib/i18n"
import { getSessionStatus, getSessionRetry, shouldShowSessionStatus, getRetrySeconds } from "../../../stores/session-status"
import { isPermissionAutoAcceptEnabled } from "../../../stores/permission-auto-accept"
import PermissionNotificationBanner from "../../permission-notification-banner"
import type { Session } from "../../../types/session"

interface SessionHeaderIndicatorsProps {
  instanceId: string
  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  hasPendingRequests: Accessor<boolean>
  now: Accessor<number>
  onPermissionModalOpen: () => void
}

export default function SessionHeaderIndicators(props: SessionHeaderIndicatorsProps) {
  const { t } = useI18n()

  const yoloModeEnabled = createMemo(() => {
    const session = props.activeSession()
    if (!session) return false
    return isPermissionAutoAcceptEnabled(props.instanceId, session.id)
  })

  const activeSessionStatusPill = createMemo(() => {
    const activeSessionId = props.activeSessionId()
    if (!activeSessionId || activeSessionId === "info") return null

    const activeSession = props.activeSession()
    const needsPermission = Boolean(activeSession?.pendingPermission)
    const needsQuestion = Boolean(activeSession?.pendingQuestion)
    const needsInput = needsPermission || needsQuestion

    if (needsInput) {
      return {
        className: "session-permission",
        text: needsPermission
          ? t("sessionList.status.needsPermission")
          : t("sessionList.status.needsInput"),
        showAlertIcon: true,
      }
    }

    const status = getSessionStatus(props.instanceId, activeSessionId)
    const retry = getSessionRetry(props.instanceId, activeSessionId)
    const showStatus = shouldShowSessionStatus(props.instanceId, activeSessionId)
    if (!showStatus) {
      return null
    }
    const text = retry
      ? (() => {
          const seconds = getRetrySeconds(retry.next, props.now())
          return seconds > 0 ? t("sessionList.status.retryingIn", { seconds: String(seconds) }) : t("sessionList.status.retrying")
        })()
      : status === "working"
        ? t("sessionList.status.working")
        : status === "compacting"
          ? t("sessionList.status.compacting")
          : t("sessionList.status.idle")

    return {
      className: `session-${retry ? "retrying" : status}`,
      text,
      showAlertIcon: false,
      title: retry
        ? t("sessionList.status.retryTooltip", {
            message: retry.message,
            attempt: String(retry.attempt),
          })
        : undefined,
    }
  })

  const renderActiveSessionStatusPill = () => {
    const pill = activeSessionStatusPill()
    if (!pill) return null
    return (
      <span
        class={`status-indicator session-status session-status-list ${pill.className} notranslate`}
        title={pill.title}
        translate="no"
      >
        {pill.showAlertIcon ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
        {pill.text}
      </span>
    )
  }

  const renderYoloModePill = () => {
    if (!yoloModeEnabled()) return null
    return (
      <span
        class="status-indicator session-status session-status-list session-yolo-mode"
        aria-label={t("instanceShell.yoloMode.badgeAriaLabel")}
        title={t("instanceShell.yoloMode.badgeAriaLabel")}
      >
        <span class="status-dot" />
        {t("instanceShell.yoloMode.badge")}
      </span>
    )
  }

  return (
    <div class="flex items-center flex-wrap justify-center gap-2">
      {renderYoloModePill()}
      <Show when={props.hasPendingRequests()} fallback={renderActiveSessionStatusPill()}>
        <PermissionNotificationBanner
          instanceId={props.instanceId}
          onClick={props.onPermissionModalOpen}
        />
      </Show>
    </div>
  )
}
