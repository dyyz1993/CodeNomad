import { Dialog } from "@kobalte/core/dialog"
import { createSignal, createEffect, Show, For, onCleanup, type Component } from "solid-js"
import { RefreshCw, Timer } from "lucide-solid"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { isSessionBusy } from "../stores/session-status"
import { sessions } from "../stores/session-state"

const log = getLogger("session")

const MAX_TRIGGER_PRESETS = [10, 20, 50, 99] as const
const COOLDOWN_PRESETS = [30, 60, 120, 300, 600] as const
const CONFIRM_PRESETS = [5, 10, 15, 30] as const

interface AutoContinueConfig {
  enabled: boolean
  prompt: string
  cooldownMs: number
  maxTriggers: number
  confirmSeconds: number
  triggerCount: number
  countdownRemaining: number
  checklistRelativePath?: string
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
  const [draftConfirmSec, setDraftConfirmSec] = createSignal(5)
  const [draftChecklistPath, setDraftChecklistPath] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [initialized, setInitialized] = createSignal(false)
  const [cancelling, setCancelling] = createSignal(false)

  const [localCountdown, setLocalCountdown] = createSignal(0)
  const [serverCountdown, setServerCountdown] = createSignal(0)

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
      setServerCountdown(data.countdownRemaining ?? 0)
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
  let pollInFlight = false

  const startPolling = () => {
    stopPolling()
    pollTimer = setInterval(() => {
      if (pollInFlight) return
      pollInFlight = true
      loadConfig().finally(() => { pollInFlight = false })
    }, 5000)
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
  let prevSessionId = props.sessionId
  createEffect(() => {
    const currentSessionId = props.sessionId
    if (currentSessionId !== prevSessionId) {
      prevBusy = true
      prevSessionId = currentSessionId
    }
    const busy = sessionBusy()
    if (prevBusy && !busy && sessionStatus() === "idle") {
      void loadConfig()
    }
    prevBusy = busy
  })

  let countdownTimer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (countdownTimer !== undefined) {
      clearInterval(countdownTimer)
      countdownTimer = undefined
    }

    const srv = serverCountdown()

    if (!config().enabled || sessionBusy() || srv <= 0) {
      setLocalCountdown(0)
      return
    }

    setLocalCountdown(srv)

    countdownTimer = setInterval(() => {
      setLocalCountdown((prev) => {
        if (prev <= 1) {
          if (countdownTimer !== undefined) {
            clearInterval(countdownTimer)
            countdownTimer = undefined
          }
          void loadConfig()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    onCleanup(() => {
      if (countdownTimer !== undefined) {
        clearInterval(countdownTimer)
        countdownTimer = undefined
      }
    })
  })

  const countdown = () => localCountdown()
  const showCountdown = () => config().enabled && countdown() > 0 && !sessionBusy()

  const openDialog = () => {
    const c = config()
    setDraftEnabled(c.enabled)
    setDraftPrompt(c.prompt)
    setDraftMaxTriggers(c.maxTriggers)
    setDraftCooldownSec(Math.round(c.cooldownMs / 1000))
    setDraftConfirmSec(c.confirmSeconds)
    setDraftChecklistPath(c.checklistRelativePath ?? "")
    setDialogOpen(true)
  }

  const saveConfig = async () => {
    setLoading(true)
    try {
      const updates: Record<string, unknown> = {
        enabled: draftEnabled(),
        prompt: draftPrompt(),
        maxTriggers: draftMaxTriggers(),
        cooldownMs: draftCooldownSec() * 1000,
        confirmSeconds: draftConfirmSec(),
      }
      const checklistPath = draftChecklistPath()
      if (checklistPath) {
        updates.checklistRelativePath = checklistPath
      }
      const result = await serverApi.updateAutoContinue(props.workspaceId, props.sessionId, updates as any)
      setConfig((prev) => ({
        ...prev,
        ...result,
        triggerCount: result.triggerCount ?? prev.triggerCount,
        countdownRemaining: result.countdownRemaining ?? prev.countdownRemaining,
      }))
      setServerCountdown(result.countdownRemaining ?? 0)
      setDialogOpen(false)
    } catch (err) {
      log.error("Failed to save auto-continue config", err)
    } finally {
      setLoading(false)
    }
  }

  const handleCancelCountdown = async () => {
    setCancelling(true)
    try {
      await serverApi.cancelAutoContinue(props.workspaceId, props.sessionId)
      setLocalCountdown(0)
      setServerCountdown(0)
      setConfig((prev) => ({ ...prev, countdownRemaining: 0 }))
    } catch (err) {
      log.warn("Failed to cancel auto-continue countdown", err)
    } finally {
      setCancelling(false)
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
            <span class="auto-continue-guarding">{t("autoContinue.guarding")}</span>
          </Show>
          <Show when={config().enabled && showCountdown()}>
            <span class="auto-continue-dot auto-continue-dot-countdown" />
            <span class="auto-continue-guarding">
              {t("autoContinue.guarding")}
              <span class="auto-continue-guarding-countdown">{countdown()}s</span>
            </span>
          </Show>
        </button>

        <Show when={showCountdown()}>
          <div class="auto-continue-bar" role="status" aria-live="polite">
            <span class="auto-continue-bar-countdown">{countdown()}s</span>
            <span>{t("autoContinueCountdown.message")}</span>
            <button
              type="button"
              class="auto-continue-bar-cancel"
              onClick={handleCancelCountdown}
              disabled={cancelling()}
              aria-label={t("autoContinueCountdown.cancelBtn")}
            >
              {t("autoContinueCountdown.cancelBtn")}
            </button>
          </div>
        </Show>

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
                  <select
                    class="auto-continue-select"
                    value={MAX_TRIGGER_PRESETS.includes(draftMaxTriggers() as never) ? String(draftMaxTriggers()) : "custom"}
                    onChange={(e) => {
                      const val = e.currentTarget.value
                      if (val !== "custom") setDraftMaxTriggers(Number(val))
                    }}
                  >
                    <For each={MAX_TRIGGER_PRESETS}>
                      {(opt) => <option value={String(opt)}>{String(opt)}</option>}
                    </For>
                    <option value="custom">{t("autoContinue.customOption")}</option>
                  </select>
                  <Show when={!MAX_TRIGGER_PRESETS.includes(draftMaxTriggers() as never)}>
                    <div class="auto-continue-custom-row">
                      <input
                        type="number"
                        value={draftMaxTriggers()}
                        onInput={(e) => setDraftMaxTriggers(Number(e.currentTarget.value) || 1)}
                        min={1}
                        max={999}
                        class="auto-continue-number-input"
                      />
                    </div>
                  </Show>
                </div>

                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.cooldown")}
                  </label>
                  <select
                    class="auto-continue-select"
                    value={COOLDOWN_PRESETS.includes(draftCooldownSec() as never) ? String(draftCooldownSec()) : "custom"}
                    onChange={(e) => {
                      const val = e.currentTarget.value
                      if (val !== "custom") setDraftCooldownSec(Number(val))
                    }}
                  >
                    <For each={COOLDOWN_PRESETS}>
                      {(opt) => <option value={String(opt)}>{opt}s</option>}
                    </For>
                    <option value="custom">{t("autoContinue.customOption")}</option>
                  </select>
                  <Show when={!COOLDOWN_PRESETS.includes(draftCooldownSec() as never)}>
                    <div class="auto-continue-custom-row">
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
                  </Show>
                </div>

                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.confirmSeconds")}
                  </label>
                  <select
                    class="auto-continue-select"
                    value={CONFIRM_PRESETS.includes(draftConfirmSec() as never) ? String(draftConfirmSec()) : "custom"}
                    onChange={(e) => {
                      const val = e.currentTarget.value
                      if (val !== "custom") setDraftConfirmSec(Number(val))
                    }}
                  >
                    <For each={CONFIRM_PRESETS}>
                      {(opt) => <option value={String(opt)}>{opt}s</option>}
                    </For>
                    <option value="custom">{t("autoContinue.customOption")}</option>
                  </select>
                  <Show when={!CONFIRM_PRESETS.includes(draftConfirmSec() as never)}>
                    <div class="auto-continue-custom-row">
                      <input
                        type="number"
                        value={draftConfirmSec()}
                        onInput={(e) => setDraftConfirmSec(Number(e.currentTarget.value) || 1)}
                        min={1}
                        max={60}
                        class="auto-continue-number-input"
                      />
                      <span class="auto-continue-unit">{t("autoContinue.seconds")}</span>
                    </div>
                  </Show>
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

                <div class="auto-continue-field">
                  <label class="auto-continue-field-label">
                    {t("autoContinue.checklistPath")}
                  </label>
                  <input
                    type="text"
                    value={draftChecklistPath()}
                    onInput={(e) => setDraftChecklistPath(e.currentTarget.value)}
                    placeholder={t("autoContinue.checklistPathPlaceholder")}
                    class="auto-continue-checklist-path"
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
