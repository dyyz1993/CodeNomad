import { createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"

interface TunnelViewerProps {
  open: boolean
  onClose: () => void
  url: string
  title?: string
}

export function TunnelViewer(props: TunnelViewerProps) {
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <Dialog.Content
          class="modal-surface"
          style={{
            "max-width": "90vw",
            "max-height": "90vh",
            width: "90vw",
            height: "90vh",
            padding: "0",
            display: "flex",
            "flex-direction": "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              padding: "8px 16px",
              "border-bottom": "1px solid var(--color-border)",
              "flex-shrink": "0",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <span style={{ "font-size": "14px" }}>🌐</span>
              <Dialog.Title
                style={{ "font-size": "14px", "font-weight": "600", margin: "0" }}
              >
                {props.title || "Tunnel Viewer"}
              </Dialog.Title>
            </div>
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <a
                href={props.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  "font-size": "12px",
                  color: "var(--color-primary)",
                  "text-decoration": "none",
                }}
              >
                Open in new tab ↗
              </a>
              <button
                onClick={props.onClose}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  "font-size": "18px",
                  color: "var(--color-text-secondary)",
                  padding: "4px 8px",
                }}
              >
                ✕
              </button>
            </div>
          </div>

          <div
            style={{
              padding: "4px 16px",
              "border-bottom": "1px solid var(--color-border)",
              "flex-shrink": "0",
            }}
          >
            <input
              type="text"
              value={props.url}
              readOnly
              style={{
                width: "100%",
                "font-size": "12px",
                padding: "4px 8px",
                border: "1px solid var(--color-border)",
                "border-radius": "4px",
                background: "var(--color-bg-secondary)",
                color: "var(--color-text-secondary)",
              }}
            />
          </div>

          <div style={{ flex: "1", position: "relative", overflow: "hidden" }}>
            {loading() && (
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  color: "var(--color-text-secondary)",
                  "font-size": "14px",
                }}
              >
                Loading...
              </div>
            )}
            {error() && (
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  color: "var(--color-error, red)",
                  "font-size": "14px",
                  "text-align": "center",
                }}
              >
                Failed to load: {error()}
              </div>
            )}
            <iframe
              src={props.url}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                "background-color": "white",
              }}
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false)
                setError("Connection failed")
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
