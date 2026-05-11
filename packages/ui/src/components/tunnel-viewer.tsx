import { createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { useI18n } from "../lib/i18n"

interface TunnelViewerProps {
  open: boolean
  onClose: () => void
  url: string
  title?: string
}

export function TunnelViewer(props: TunnelViewerProps) {
  const { t } = useI18n()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <Dialog.Content
          class="modal-surface tunnel-viewer-dialog"
        >
          <div class="tunnel-viewer-header">
            <div class="tunnel-viewer-title-row">
              <span class="tunnel-viewer-icon">🌐</span>
              <Dialog.Title class="tunnel-viewer-title-text">
                {props.title || t("tunnel.viewer.title")}
              </Dialog.Title>
            </div>
            <div class="tunnel-viewer-actions">
              <a
                href={props.url}
                target="_blank"
                rel="noopener noreferrer"
                class="tunnel-viewer-external-link"
              >
                {t("tunnel.viewer.openExternal")} ↗
              </a>
              <button
                onClick={props.onClose}
                class="tunnel-viewer-close-btn"
              >
                ✕
              </button>
            </div>
          </div>

          <div class="tunnel-viewer-url-bar">
            <input
              type="text"
              value={props.url}
              readOnly
              class="tunnel-viewer-url-input"
            />
          </div>

          <div class="tunnel-viewer-content">
            {loading() && (
              <div class="tunnel-viewer-loading">
                {t("tunnel.viewer.loading")}
              </div>
            )}
            {error() && (
              <div class="tunnel-viewer-error">
                {t("tunnel.viewer.error", { error: error() })}
              </div>
            )}
            <iframe
              src={props.url}
              class="tunnel-viewer-iframe"
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false)
                setError(t("tunnel.viewer.connectionFailed"))
              }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              referrerpolicy="no-referrer"
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
