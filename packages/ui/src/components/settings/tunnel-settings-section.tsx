import { Show, createSignal, onMount, type Component } from "solid-js"
import { Link2, Loader2 } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"

interface TunnelStatus {
  enabled: boolean
  tunnelCount: number
}

interface TunnelTestResult {
  connected: boolean
  hubUrl: string
  error?: string
}

export const TunnelSettingsSection: Component = () => {
  const { t } = useI18n()
  const [tunnelHubUrl, setTunnelHubUrl] = createSignal("")
  const [testingTunnel, setTestingTunnel] = createSignal(false)
  const [tunnelTestResult, setTunnelTestResult] = createSignal<TunnelTestResult | null>(null)
  const [tunnelStatus, setTunnelStatus] = createSignal<TunnelStatus | null>(null)
  const [saving, setSaving] = createSignal(false)

  onMount(async () => {
    try {
      const serverConfig = await serverApi.fetchConfigOwner("server")
      if (serverConfig.tunnelHubUrl) {
        setTunnelHubUrl(serverConfig.tunnelHubUrl as string)
      }
    } catch {}

    try {
      const status = await serverApi.fetchTunnelStatus()
      setTunnelStatus(status)
    } catch {}
  })

  const testTunnelConnection = async () => {
    const url = tunnelHubUrl()
    if (!url) return

    setTestingTunnel(true)
    setTunnelTestResult(null)
    try {
      const result = await serverApi.testTunnelConnection(url)
      setTunnelTestResult(result)

      if (result.connected) {
        setSaving(true)
        try {
          await serverApi.patchConfigOwner("server", { tunnelHubUrl: url })
        } catch {} finally {
          setSaving(false)
        }
      }
    } catch (err) {
      setTunnelTestResult({ connected: false, hubUrl: url, error: (err as Error).message })
    } finally {
      setTestingTunnel(false)
    }
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Link2 class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.tunnel.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.tunnel.subtitle")}</p>
            </div>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <div class="settings-card-content">
          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.tunnel.hubUrl.title")}</div>
              <div class="settings-toggle-caption">{t("settings.tunnel.hubUrl.subtitle")}</div>
            </div>
            <div class="tunnel-url-row">
              <input
                class="selector-input tunnel-url-input"
                type="text"
                placeholder="https://tunnel.yourdomain.com"
                value={tunnelHubUrl()}
                onInput={(e) => {
                  setTunnelHubUrl(e.currentTarget.value)
                  setTunnelTestResult(null)
                }}
              />
              <button
                type="button"
                class="selector-button selector-button-secondary"
                disabled={testingTunnel() || !tunnelHubUrl().trim()}
                onClick={() => void testTunnelConnection()}
              >
                <Show when={testingTunnel()} fallback={<Link2 class="w-4 h-4" />}>
                  <Loader2 class="w-4 h-4 animate-spin" />
                </Show>
                <span>{testingTunnel() ? t("settings.tunnel.test.testing") : t("settings.tunnel.test.label")}</span>
              </button>
            </div>
          </div>

          <Show when={tunnelTestResult()}>
            {(result) => (
              <div class={`tunnel-status-indicator ${result().connected ? "tunnel-status-connected" : "tunnel-status-disconnected"}`}>
                {result().connected
                  ? t("settings.tunnel.status.connected", { hubUrl: result().hubUrl })
                  : t("settings.tunnel.status.disconnected", { error: result().error || t("settings.tunnel.status.failed") })}
              </div>
            )}
          </Show>

          <Show when={saving()}>
            <div class="settings-toggle-caption">{t("settings.tunnel.saving")}</div>
          </Show>
        </div>
      </div>

      <Show when={tunnelStatus()?.enabled}>
        <div class="settings-card">
          <div class="settings-card-header">
            <div>
              <h3 class="settings-card-title">{t("settings.tunnel.activeTunnels.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.tunnel.activeTunnels.subtitle")}</p>
            </div>
          </div>
          <div class="settings-card-content">
            <div class="tunnel-active-badge">
              {t("settings.tunnel.activeTunnels.count", { count: String(tunnelStatus()?.tunnelCount ?? 0) })}
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
