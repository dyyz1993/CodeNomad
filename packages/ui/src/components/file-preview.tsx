import { Dialog } from "@kobalte/core/dialog"
import { createSignal, Show, For, type Component } from "solid-js"
import { FileText, Globe, X, Maximize2, Minimize2, ExternalLink } from "lucide-solid"
import { marked } from "marked"
import { useI18n } from "../lib/i18n"
import { CODENOMAD_API_BASE, serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("file-preview")

interface FilePreviewProps {
  instanceId: string
  workspacePath: string
}

type PreviewTab = "file" | "url"

function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/")
  const result: string[] = []
  for (const part of parts) {
    if (part === "." || part === "") continue
    if (part === "..") { result.pop(); continue }
    result.push(part)
  }
  return result.join("/")
}

function resolvePreviewUrl(instanceId: string, filePath: string): string {
  const base = CODENOMAD_API_BASE ?? ""
  const normalized = normalizePath(filePath)
  const encoded = normalized.split("/").map((s) => encodeURIComponent(s)).join("/")
  return `${base}/workspaces/${encodeURIComponent(instanceId)}/preview/${encoded}`
}

function isExternalUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")
}

const FilePreview: Component<FilePreviewProps> = (props) => {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(false)
  const [tab, setTab] = createSignal<PreviewTab>("file")
  const [filePath, setFilePath] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [content, setContent] = createSignal<string | null>(null)
  const [isImage, setIsImage] = createSignal(false)
  const [isMarkdown, setIsMarkdown] = createSignal(false)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [proxyMappings, setProxyMappings] = createSignal<Array<{ subdomain: string; targetPort: number; fullUrl: string; name: string }>>([])

  const loadProxyMappings = async () => {
    try {
      const data = await serverApi.listSubdomainProxies()
      setProxyMappings(data)
    } catch {
      log.warn("Failed to load subdomain proxy mappings")
    }
  }

  const openFile = async (filepath: string) => {
    setFilePath(filepath)
    setTab("file")
    setFullscreen(false)
    setError(null)
    setLoading(true)
    setOpen(true)

    const ext = filepath.toLowerCase().split(".").pop()
    const imageExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"]
    const isImageFile = imageExts.includes(ext ?? "")

    setIsImage(isImageFile)
    setIsMarkdown(ext === "md" || ext === "markdown")

    if (isImageFile) {
      setContent(null)
      setLoading(false)
      return
    }

    try {
      const previewUrl = resolvePreviewUrl(props.instanceId, filepath)
      const response = await fetch(previewUrl)
      if (!response.ok) {
        throw new Error(`Failed to load file: ${response.statusText}`)
      }
      const text = await response.text()
      setContent(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load file")
    } finally {
      setLoading(false)
    }
  }

  const openUrl = (targetUrl: string) => {
    setUrl(targetUrl)
    setTab("url")
    setFullscreen(false)
    setError(null)
    setOpen(true)
  }

  const renderMarkdown = (md: string): string => {
    const html = marked.parse(md, { async: false }) as string
    const tmp = document.createElement("div")
    tmp.innerHTML = html

    tmp.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src")
      if (!src) return
      if (isExternalUrl(src)) return
      img.src = resolvePreviewUrl(props.instanceId, src)
    })

    tmp.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href")
      if (!href) return
      if (isExternalUrl(href)) {
        a.target = "_blank"
        a.rel = "noopener noreferrer"
        return
      }
      a.href = resolvePreviewUrl(props.instanceId, href)
      a.target = "_blank"
      a.rel = "noopener noreferrer"
    })

    return tmp.innerHTML
  }

  const imageUrl = () => {
    const fp = filePath()
    if (!fp) return ""
    return resolvePreviewUrl(props.instanceId, fp)
  }

  const handleOpen = async (mode: "file" | "url") => {
    if (mode === "url") {
      void loadProxyMappings()
      const inputUrl = window.prompt(t("filePreview.enterUrl"), "http://")
      if (inputUrl && inputUrl.trim()) {
        openUrl(inputUrl.trim())
      }
    } else {
      const inputPath = window.prompt(t("filePreview.enterPath"), props.workspacePath + "/")
      if (inputPath && inputPath.trim()) {
        await openFile(inputPath.trim())
      }
    }
  }

  return (
    <div class="file-preview-trigger">
      <button
        type="button"
        class="file-preview-btn"
        onClick={() => handleOpen("file")}
        title={t("filePreview.label")}
        aria-label={t("filePreview.label")}
      >
        <FileText class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        class="file-preview-btn"
        onClick={() => handleOpen("url")}
        title={t("filePreview.urlLabel")}
        aria-label={t("filePreview.urlLabel")}
      >
        <Globe class="w-3.5 h-3.5" />
      </button>

      <Dialog open={open()} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <Dialog.Content class={`modal-surface file-preview-dialog ${fullscreen() ? "file-preview-fullscreen" : ""}`}>
            <div class="file-preview-header">
              <Dialog.Title class="file-preview-title">
                <Show when={tab() === "file"}>
                  <FileText class="w-4 h-4" />
                  <span class="file-preview-filename">{filePath().split("/").pop() || filePath()}</span>
                </Show>
                <Show when={tab() === "url"}>
                  <Globe class="w-4 h-4" />
                  <span class="file-preview-filename">{url()}</span>
                </Show>
              </Dialog.Title>
              <div class="file-preview-header-actions">
                <button
                  type="button"
                  class="file-preview-header-btn"
                  onClick={() => setFullscreen(!fullscreen())}
                  title={fullscreen() ? t("filePreview.exitFullscreen") : t("filePreview.fullscreen")}
                >
                  <Show when={fullscreen()} fallback={<Maximize2 class="w-3.5 h-3.5" />}>
                    <Minimize2 class="w-3.5 h-3.5" />
                  </Show>
                </button>
                <Show when={tab() === "url" && url()}>
                  <a
                    href={url()}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="file-preview-header-btn"
                    title={t("filePreview.openInNewTab")}
                  >
                    <ExternalLink class="w-3.5 h-3.5" />
                  </a>
                </Show>
                <Show when={tab() === "file" && isImage()}>
                  <a
                    href={imageUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="file-preview-header-btn"
                    title={t("filePreview.openInNewTab")}
                  >
                    <ExternalLink class="w-3.5 h-3.5" />
                  </a>
                </Show>
                <button
                  type="button"
                  class="file-preview-header-btn"
                  onClick={() => setOpen(false)}
                  aria-label={t("filePreview.close")}
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div class="file-preview-body">
              <Show when={tab() === "file"}>
                <Show when={loading()}>
                  <div class="file-preview-loading">{t("filePreview.loading")}</div>
                </Show>
                <Show when={error()}>
                  <div class="file-preview-error">{error()}</div>
                </Show>
                <Show when={!loading() && !error() && isImage()}>
                  <img src={imageUrl()} alt={filePath()} class="file-preview-image" />
                </Show>
                <Show when={!loading() && !error() && isMarkdown() && content()}>
                  <div
                    class="file-preview-markdown markdown-body"
                    innerHTML={renderMarkdown(content() ?? "")}
                  />
                </Show>
                <Show when={!loading() && !error() && !isImage() && !isMarkdown() && content() !== null}>
                  <pre class="file-preview-code"><code>{content()}</code></pre>
                </Show>
              </Show>

              <Show when={tab() === "url"}>
                <Show when={proxyMappings().length > 0}>
                  <div class="file-preview-proxy-list">
                    <div class="file-preview-proxy-title">{t("filePreview.proxyList")}</div>
                    <For each={proxyMappings()}>
                      {(mapping) => (
                        <button
                          type="button"
                          class="file-preview-proxy-item"
                          onClick={() => setUrl(mapping.fullUrl)}
                        >
                          <span class="file-preview-proxy-name">{mapping.name}</span>
                          <span class="file-preview-proxy-url">:{mapping.targetPort}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={url()}>
                  <iframe
                    src={url()}
                    class="file-preview-iframe"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    title={url()}
                  />
                </Show>
              </Show>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  )
}

export default FilePreview
