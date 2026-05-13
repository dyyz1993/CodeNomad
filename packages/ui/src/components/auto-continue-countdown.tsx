import { createSignal, createEffect, onCleanup, Show, type Component } from "solid-js"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { isSessionBusy } from "../stores/session-status"
import { sessions } from "../stores/session-state"

const log = getLogger("session")

interface AutoContinueCountdownProps {
  instanceId: string
  sessionId: string
}

const AutoContinueCountdown: Component<AutoContinueCountdownProps> = (props) => {
  const { t } = useI18n()
  const [countdown, setCountdown] = createSignal(0)
  const [enabled, setEnabled] = createSignal(false)
  const [cancelling, setCancelling] = createSignal(false)
  const [dismissed, setDismissed] = createSignal(false)

  const sessionStatus = () => {
    const session = sessions().get(props.instanceId)?.get(props.sessionId)
    return session?.status ?? "idle"
  }

  const sessionBusy = () => isSessionBusy(props.instanceId, props.sessionId)

  const visible = () =>
    !dismissed() &&
    !sessionBusy() &&
    sessionStatus() === "idle" &&
    enabled() &&
    countdown() > 0

  createEffect(() => {
    // Reset dismissed when session becomes busy or changes away from idle
    if (sessionBusy() || sessionStatus() !== "idle") {
      setDismissed(false)
    }
  })

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const startPolling = () => {
    stopPolling()
    if (!props.sessionId) return
    pollTimer = setInterval(async () => {
      try {
        const data = await serverApi.fetchAutoContinue(props.instanceId, props.sessionId)
        setEnabled(data.enabled)
        setCountdown(data.countdownRemaining)
      } catch (err) {
        log.warn("Failed to poll auto-continue state", err)
      }
    }, 1000)
  }

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  createEffect(() => {
    // Only poll when idle and not dismissed
    if (sessionStatus() === "idle" && !sessionBusy() && !dismissed()) {
      startPolling()
    } else {
      stopPolling()
    }
    onCleanup(stopPolling)
  })

  async function handleCancel() {
    setCancelling(true)
    try {
      await serverApi.cancelAutoContinue(props.instanceId, props.sessionId)
      setDismissed(true)
      setCountdown(0)
    } catch (err) {
      log.warn("Failed to cancel auto-continue countdown", err)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <Show when={visible()}>
      <div class="auto-continue-bar" role="status" aria-live="polite">
        <span>⏱️</span>
        <span class="auto-continue-bar-countdown">{countdown()}s</span>
        <span>{t("autoContinueCountdown.message")}</span>
        <button
          type="button"
          class="auto-continue-bar-cancel"
          onClick={handleCancel}
          disabled={cancelling()}
          aria-label={t("autoContinueCountdown.cancelBtn")}
        >
          {t("autoContinueCountdown.cancelBtn")}
        </button>
      </div>
    </Show>
  )
}

export default AutoContinueCountdown
