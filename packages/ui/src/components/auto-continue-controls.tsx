import { Dialog } from "@kobalte/core/dialog"
import { createSignal, createEffect, Show, onCleanup, type Component } from "solid-js"
import { RefreshCw, Timer } from "lucide-solid"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { isSessionBusy } from "../stores/session-status"
import { sessions } from "../stores/session-state"

const log = getLogger("session")

interface AutoContinueConfig {
  enabled: boolean
  prompt: string
  cooldownMs: number
  maxTriggers: number
  confirmSeconds: number
  triggerCount: number
  countdownRemaining: number
}

interface AutoContinueControlsProps {
  workspaceId: string
  sessionId: string
  isParentSession: boolean
}

const AutoContinueControls: Component<AutoContinueControlsProps> = (props) => {
  const { t } = useI18n()
  const [config, setConfig] = createSignal<AutoContinueConfig>({
    enabled: false,
    prompt: "",
    cooldownMs: 60_000,
    maxTriggers: 20,
    confirmSeconds: 5,
    triggerCount: 0,
    countdownRemaining: 0,
  })
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const closeDialog = () => { setDialogOpen(false) }
  const [draftEnabled, setDraftEnabled] = createSignal(false)
  const [draftPrompt, setDraftPrompt] = createSignal("")
  const [draftMaxTriggers, setDraftMaxTriggers] = createSignal(20)
  const [draftCooldownSec, setDraftCooldownSec] = createSignal(60)
  const [loading, setLoading] = createSignal(false)
  const [initialized, setInitialized] = createSignal(false)

  const sessionStatus = () => {
    const session = sessions().get(props.workspaceId)?.get(props.sessionId)
    return session?.status ?? "idle"
  }

  const sessionBusy = () => isSessionBusy(props.workspaceId, props.sessionId)

  const loadConfig = async () => {
    if (!props.isParentSession || !props.sessionId) return
    try {
      const data = await serverApi.fetchAutoContinue(props.workspaceId, props.sessionId)
      setConfig((prev) => ({ ...prev, ...data }))
      if (dialogOpen()) {
        setDraftEnabled(data.enabled)
      }
    } catch (err) {
      log.warn("Failed to fetch auto-continue config", err)
    }
  }

  if (!initialized()) {
    setInitialized(true)
    loadConfig()
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const startPolling = () => {
    stopPolling()
    pollTimer = setInterval(() => { void loadConfig() }, 1000)
  }

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  createEffect(() => {
    if (config().enabled && !sessionBusy() && sessionStatus() === "idle") {
      startPolling()
    } else {
      stopPolling()
    }
    onCleanup(stopPolling)
  })

  let prevBusy = true
  createEffect(() => {
    const busy = sessionBusy()
    if (prevBusy && !busy && sessionStatus() === "idle") {
      void loadConfig()
    }
    prevBusy = busy
  })

  const countdown = () => config().countdownRemaining ?? 0
  const showCountdown = () => config().enabled && countdown() > 0 && !sessionBusy()

  const openDialog = () => {
    const c = config()
    setDraftEnabled(c.enabled)
    setDraftPrompt(c.prompt)
    setDraftMaxTriggers(c.maxTriggers)
    setDraftCooldownSec(Math.round(c.cooldownMs / 1000))
    setDialogOpen(true)
  }

  const saveConfig = async () => {
    setLoading(true)
    try {
      const updates = {
        enabled: draftEnabled(),
        prompt: draftPrompt(),
        maxTriggers: draftMaxTriggers(),
        cooldownMs: draftCooldownSec() * 1000,
      }
      const result = await serverApi.updateAutoContinue(props.workspaceId, props.sessionId, updates)
      setConfig((prev) => ({ ...prev, ...result, triggerCount: prev.triggerCount }))
      setDialogOpen(false)
    } catch (err) {
      log.error("Failed to save auto-continue config", err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Show when={props.isParentSession}>
      <div class="auto-continue-trigger">
        <button
          type="button"
          class="auto-continue-btn"
          onClick={openDialog}
          title={t("autoContinue.label")}
          aria-label={t("autoContinue.label")}
        >
          <Timer class="w-3.5 h-3.5" />
          <Show when={config().enabled && !showCountdown()}>
            <span class="auto-continue-dot" />
          </Show>
          <Show when={showCountdown()}>
            <span class="auto-continue-countdown-badge">{countdown()}s</span>
          </Show>
        </button>

        <Dialog open={dialogOpen()} onOpenChange={(v) => setDialogOpen(!!v)} onClose={closeDialog}>
          <Dialog.Portal>
            <Dialog.Overlay class="modal-overlay" />
            <Dialog.Content class="modal-surface auto-continue-dialog">
              <Dialog.Title class="auto-continue-dialog-title">
                <Timer class="w-4 h-4" />
                {t("autoContinue.label")}
              </Dialog.Title>

              <div class="auto-continue-dialog-body">
                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.enabled")}
                  </label>
                  <input
                    type="checkbox"
                    checked={draftEnabled()}
                    onChange={(e) => setDraftEnabled(e.currentTarget.checked)}
                    class="auto-continue-checkbox"
                  />
                </div>

                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.maxTriggers")}
                  </label>
                  <input
                    type="number"
                    value={draftMaxTriggers()}
                    onInput={(e) => setDraftMaxTriggers(Number(e.currentTarget.value) || 1)}
                    min={1}
                    max={999}
                    class="auto-continue-number-input"
                  />
                </div>

                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.cooldown")}
                  </label>
                  <div class="auto-continue-field-row">
                    <input
                      type="number"
                      value={draftCooldownSec()}
                      onInput={(e) => setDraftCooldownSec(Number(e.currentTarget.value) || 10)}
                      min={5}
                      max={3600}
                      class="auto-continue-number-input"
                    />
                    <span class="auto-continue-unit">{t("autoContinue.seconds")}</span>
                  </div>
                </div>

                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.prompt")}
                  </label>
                  <textarea
                    value={draftPrompt()}
                    onInput={(e) => setDraftPrompt(e.currentTarget.value)}
                    placeholder={t("autoContinue.promptPlaceholder")}
                    rows={3}
                    class="auto-continue-textarea"
                  />
                </div>

                <Show when={config().enabled}>
                  <div class="auto-continue-status">
                    <RefreshCw class="w-3.5 h-3.5" />
                    {t("autoContinue.triggered", { count: String(config().triggerCount), max: String(config().maxTriggers) })}
                  </div>
                </Show>
              </div>

              <div class="auto-continue-dialog-actions">
                <button
                  type="button"
                  class="auto-continue-btn-secondary"
                  onClick={() => setDialogOpen(false)}
                >
                  {t("autoContinue.cancel")}
                </button>
                <button
                  type="button"
                  class="auto-continue-btn-primary"
                  onClick={saveConfig}
                  disabled={loading()}
                >
                  {loading() ? t("autoContinue.saving") : t("autoContinue.save")}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog>
      </div>
    </Show>
  )
}

export default AutoContinueControls
