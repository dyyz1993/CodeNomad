import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { RefreshCw } from "lucide-solid"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

interface AutoContinueConfig {
  enabled: boolean
  prompt: string
  cooldownMs: number
  maxTriggers: number
  confirmSeconds: number
  triggerCount: number
  lastTriggerAt: number
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
    lastTriggerAt: 0,
  })
  const [loading, setLoading] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [initialized, setInitialized] = createSignal(false)

  createEffect(() => {
    if (!props.isParentSession || initialized()) return
    setInitialized(true)
    serverApi
      .fetchAutoContinue(props.workspaceId, props.sessionId)
      .then((data) => {
        setConfig((prev) => ({ ...prev, ...data }))
      })
      .catch((err) => {
        log.warn("Failed to fetch auto-continue config", err)
      })
  })

  onCleanup(() => {
    setInitialized(false)
  })

  const toggleEnabled = async () => {
    const next = !config().enabled
    setLoading(true)
    try {
      await serverApi.updateAutoContinue(props.workspaceId, props.sessionId, { enabled: next })
      setConfig((prev) => ({ ...prev, enabled: next }))
    } catch (err) {
      log.error("Failed to toggle auto-continue", err)
    } finally {
      setLoading(false)
    }
  }

  const updatePrompt = async (newPrompt: string) => {
    setConfig((prev) => ({ ...prev, prompt: newPrompt }))
    try {
      await serverApi.updateAutoContinue(props.workspaceId, props.sessionId, { prompt: newPrompt })
    } catch (err) {
      log.error("Failed to update auto-continue prompt", err)
    }
  }

  return (
    <Show when={props.isParentSession}>
      <div class="auto-continue-controls">
        <div class="auto-continue-row">
          <label class="auto-continue-label">
            <input
              type="checkbox"
              checked={config().enabled}
              onChange={toggleEnabled}
              disabled={loading()}
            />
            <span class="auto-continue-label-text">{t("autoContinue.label")}</span>
          </label>
          <Show when={config().enabled}>
            <span class="auto-continue-count" title={t("autoContinue.countTitle", { max: String(config().maxTriggers) })}>
              {config().triggerCount}/{config().maxTriggers}
            </span>
            <button
              type="button"
              class="auto-continue-expand-btn"
              onClick={() => setExpanded(!expanded())}
              aria-label={expanded() ? t("autoContinue.collapse") : t("autoContinue.expand")}
              title={expanded() ? t("autoContinue.collapse") : t("autoContinue.expand")}
            >
              <RefreshCw class={`w-3 h-3 ${expanded() ? "rotate-180" : ""}`} style={{ "transition": "transform 0.2s" }} />
            </button>
          </Show>
        </div>
        <Show when={config().enabled && expanded()}>
          <div class="auto-continue-prompt-row">
            <textarea
              class="auto-continue-prompt-input"
              value={config().prompt}
              onInput={(e) => updatePrompt(e.currentTarget.value)}
              placeholder={t("autoContinue.promptPlaceholder")}
              rows={2}
            />
          </div>
        </Show>
      </div>
    </Show>
  )
}

export default AutoContinueControls
