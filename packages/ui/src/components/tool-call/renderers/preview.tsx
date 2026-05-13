import type { ToolRenderer, ToolRendererContext } from "../types"
import type { JSXElement } from "solid-js"
import { createSignal, createEffect, Show, Switch, Match, createMemo, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import {
  Globe,
  ExternalLink,
  Maximize2,
  Minimize2,
  X,
  FileText,
  AlertTriangle,
  ImageIcon,
  Music,
  Code,
  FileIcon,
} from "lucide-solid"
import { CODENOMAD_API_BASE, serverApi } from "../../../lib/api-client"
import { tGlobal } from "../../../lib/i18n"

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"])
const HTML_EXTENSIONS = new Set([".html", ".htm"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"])
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"])
const PDF_EXTENSION = ".pdf"

type TargetKind =
  | "image"
  | "url"
  | "port"
  | "html"
  | "pdf"
  | "video"
  | "audio"
  | "text"

interface SubdomainProxy {
  id: string
  subdomain: string
  targetPort: number
  targetHost: string
  name: string
  fullUrl: string
  createdAt: string
  updatedAt: string
}

function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/")
  const result: string[] = []
  for (const part of parts) {
    if (part === "." || part === "") continue
    if (part === "..") {
      result.pop()
      continue
    }
    result.push(part)
  }
  return result.join("/")
}

function resolvePreviewUrl(instanceId: string, filePath: string): string {
  const base = CODENOMAD_API_BASE ?? ""
  if (filePath.startsWith("/")) {
    const encoded = encodeURIComponent(filePath)
    return `${base}/api/workspaces/${encodeURIComponent(instanceId)}/preview/serve?path=${encoded}`
  }
  const normalized = normalizePath(filePath)
  const encoded = normalized
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")
  return `${base}/workspaces/${encodeURIComponent(instanceId)}/preview/${encoded}`
}

function getFileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}

function getExtension(path: string): string {
  const name = getFileName(path)
  const dotIdx = name.lastIndexOf(".")
  if (dotIdx === -1) return ""
  return name.substring(dotIdx).toLowerCase()
}

function classifyTarget(target: string): TargetKind {
  const trimmed = target.trim()
  const ext = getExtension(trimmed)

  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (HTML_EXTENSIONS.has(ext)) return "html"
  if (ext === PDF_EXTENSION) return "pdf"
  if (VIDEO_EXTENSIONS.has(ext)) return "video"
  if (AUDIO_EXTENSIONS.has(ext)) return "audio"
  if (/^\d+$/.test(trimmed)) return "port"
  if (/^https?:\/\//i.test(trimmed)) return "url"
  if (/^localhost/i.test(trimmed)) return "url"
  if (/^\d+\.\d+\.\d+\.\d+/.test(trimmed)) return "url"

  return "text"
}

function extractPortFromTarget(target: string): number | null {
  const trimmed = target.trim()
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10)
  }
  const portMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?::(\d+))?(?:\/|$)/i
  )
  if (portMatch?.[1]) {
    return parseInt(portMatch[1], 10)
  }
  return null
}

function ensureHttps(url: string): string {
  if (url.startsWith("http:") && typeof location !== "undefined" && location.protocol === "https:") {
    return url.replace(/^http:/, "https:")
  }
  return url
}

function isLocalAddress(url: string): boolean {
  try {
    const trimmed = url.trim()
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    const u = new URL(withProto)
    const hostname = u.hostname.toLowerCase()
    return hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
  } catch {
    return false
  }
}

async function fetchSubdomainMappings(): Promise<SubdomainProxy[]> {
  try {
    return await serverApi.listSubdomainProxies()
  } catch {
    return []
  }
}

function PreviewDialog(props: {
  url: string
  open: boolean
  onClose: () => void
}) {
  const [fullscreen, setFullscreen] = createSignal(false)

  const handleOpenNewTab = () => {
    window.open(props.url, "_blank", "noopener")
  }

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose()
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose()
    }
  }

  createEffect(() => {
    if (props.open) {
      window.addEventListener("keydown", handleKeyDown)
    } else {
      window.removeEventListener("keydown", handleKeyDown)
    }
  })

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown)
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div class="preview-dialog-overlay" onClick={handleBackdropClick}>
        <div
          class={`preview-dialog-content${fullscreen() ? " preview-dialog-fullscreen" : ""}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="preview-dialog-header">
            <span class="preview-dialog-url">{props.url}</span>
            <div class="preview-dialog-actions">
              <button
                class="preview-dialog-btn"
                title={tGlobal("toolCall.renderer.preview.dialog.fullscreen")}
                onClick={() => setFullscreen((v) => !v)}
              >
                <Show when={fullscreen()} fallback={<Maximize2 size={14} />}>
                  <Minimize2 size={14} />
                </Show>
              </button>
              <button
                class="preview-dialog-btn"
                title={tGlobal("toolCall.renderer.preview.dialog.openNewTab")}
                onClick={handleOpenNewTab}
              >
                <ExternalLink size={14} />
              </button>
              <button
                class="preview-dialog-btn"
                title={tGlobal("toolCall.renderer.preview.dialog.close")}
                onClick={props.onClose}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <iframe
            class="preview-dialog-iframe"
            src={props.url}
            sandbox="allow-scripts allow-forms allow-popups"
          />
        </div>
      </div>
      </Portal>
    </Show>
  )
}

function ImageLightbox(props: { src: string; alt: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <img
        class="preview-image-inline"
        src={props.src}
        alt={props.alt}
        onClick={() => setOpen(true)}
        loading="lazy"
      />
      <Show when={open()}>
        <Portal>
          <div class="preview-lightbox-overlay" onClick={() => setOpen(false)}>
          <div class="preview-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button
              class="preview-lightbox-close"
              onClick={() => setOpen(false)}
              title={tGlobal("toolCall.renderer.preview.dialog.close")}
            >
              <X size={20} />
            </button>
            <img class="preview-lightbox-img" src={props.src} alt={props.alt} />
          </div>
        </div>
        </Portal>
      </Show>
    </>
  )
}

function PreviewCard(props: {
  displayUrl: string
  resolvedUrl: string
  icon: "globe" | "file" | "image"
  label?: string
}) {
  const [dialogOpen, setDialogOpen] = createSignal(false)

  const IconComponent = () => {
    switch (props.icon) {
      case "globe":
        return <Globe size={18} class="preview-card-icon" />
      case "file":
        return <FileIcon size={18} class="preview-card-icon" />
      case "image":
        return <ImageIcon size={18} class="preview-card-icon" />
    }
  }

  return (
    <>
      <div class="preview-card" onClick={() => setDialogOpen(true)}>
        {IconComponent()}
        <div class="preview-card-body">
          <span class="preview-card-url">{props.label ?? props.displayUrl}</span>
          <span class="preview-card-status">
            {tGlobal("toolCall.renderer.preview.clickToOpen")}
          </span>
        </div>
        <ExternalLink size={16} class="preview-card-arrow" />
      </div>
      <PreviewDialog
        url={props.resolvedUrl}
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}

function NoMappingCard(props: { port: number }) {
  return (
    <div class="preview-nomapping-card">
      <AlertTriangle size={18} class="preview-nomapping-icon" />
      <div class="preview-nomapping-body">
        <span class="preview-nomapping-title">
          {tGlobal("toolCall.renderer.preview.noMapping.title")}
        </span>
        <span class="preview-nomapping-desc">
          {tGlobal("toolCall.renderer.preview.noMapping.desc").replace("{port}", String(props.port))}
        </span>
      </div>
    </div>
  )
}

function LocalAddressCard(props: { address: string; port?: number }) {
  return (
    <div class="preview-nomapping-card">
      <AlertTriangle size={18} class="preview-nomapping-icon" />
      <div class="preview-nomapping-body">
        <span class="preview-nomapping-title">
          {tGlobal("toolCall.renderer.preview.localAddress.title") || "无法预览本地地址"}
        </span>
        <span class="preview-nomapping-desc">
          {props.port
            ? (tGlobal("toolCall.renderer.preview.localAddress.portDesc") || `端口 ${props.port} 没有公网映射，请在设置中配置子域名代理`)
            : (tGlobal("toolCall.renderer.preview.localAddress.desc") || `本地地址 ${props.address} 无法在浏览器中预览，请配置公网映射`)}
        </span>
      </div>
    </div>
  )
}

function LoadingCard(props: { target: string }) {
  return (
    <div class="preview-card">
      <Globe size={18} class="preview-card-icon" />
      <div class="preview-card-body">
        <span class="preview-card-url">{props.target}</span>
        <span class="preview-card-status">
          {tGlobal("toolCall.renderer.preview.resolving")}
        </span>
      </div>
    </div>
  )
}

function VideoPlayer(props: { src: string }) {
  return (
    <div class="preview-video-wrapper">
      <video class="preview-video" controls preload="metadata">
        <source src={props.src} />
      </video>
    </div>
  )
}

function AudioPlayer(props: { src: string }) {
  return (
    <div class="preview-audio-wrapper">
      <Music size={16} class="preview-audio-icon" />
      <audio class="preview-audio" controls preload="metadata">
        <source src={props.src} />
      </audio>
    </div>
  )
}

function CodePreview(props: { instanceId: string; filePath: string }) {
  const url = createMemo(() => resolvePreviewUrl(props.instanceId, props.filePath))
  const [content, setContent] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [dialogOpen, setDialogOpen] = createSignal(false)

  createEffect(() => {
    const previewUrl = url()
    setLoading(true)
    setContent(null)
    fetch(previewUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((text) => {
        const trimmed = text.length > 2000 ? text.substring(0, 2000) + "\n..." : text
        setContent(trimmed)
      })
      .catch(() => setContent(null))
      .finally(() => setLoading(false))
  })

  return (
    <>
      <div class="preview-file-block" onClick={() => setDialogOpen(true)}>
        <Code size={14} class="preview-file-block-icon" />
        <span class="preview-file-name">{getFileName(props.filePath)}</span>
        <Show when={loading()}>
          <span class="preview-file-loading" />
        </Show>
      </div>
      <Show when={content()}>
        <pre class="preview-code-snippet">
          <code>{content()}</code>
        </pre>
      </Show>
      <PreviewDialog
        url={url()}
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}

function ResolvedUrlRenderer(props: { target: string }) {
  const [resolvedUrl, setResolvedUrl] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [localAddress, setLocalAddress] = createSignal<string | null>(null)
  const [localPort, setLocalPort] = createSignal<number | undefined>(undefined)

  createEffect(() => {
    const target = props.target
    const port = extractPortFromTarget(target)
    setLoading(true)
    setResolvedUrl(null)
    setLocalAddress(null)
    setLocalPort(undefined)

    if (port !== null) {
      fetchSubdomainMappings()
        .then((mappings) => {
          const match = mappings.find((m) => m.targetPort === port)
          if (match) {
            const base = ensureHttps(match.fullUrl)
            let pathSuffix = ""
            try {
              const withProto = /^https?:\/\//i.test(target) ? target : `http://${target}`
              const u = new URL(withProto)
              pathSuffix = u.pathname + u.search + u.hash
              if (pathSuffix === "/") pathSuffix = ""
            } catch {
              pathSuffix = ""
            }
            setResolvedUrl(base + pathSuffix)
          } else {
            setLocalAddress(target)
            setLocalPort(port)
          }
        })
        .catch(() => {
          setLocalAddress(target)
          setLocalPort(port)
        })
        .finally(() => setLoading(false))
    } else if (/^https?:\/\//i.test(target)) {
      if (isLocalAddress(target)) {
        setLocalAddress(target)
      } else {
        setResolvedUrl(target)
      }
      setLoading(false)
    } else {
      setResolvedUrl(null)
      setLoading(false)
    }
  })

  return (
    <Show when={!loading()} fallback={<LoadingCard target={props.target} />}>
      <Switch>
        <Match when={resolvedUrl() !== null}>
          <PreviewCard displayUrl={resolvedUrl()!} resolvedUrl={resolvedUrl()!} icon="globe" label={props.target} />
        </Match>
        <Match when={localAddress() !== null}>
          <LocalAddressCard address={localAddress()!} port={localPort()} />
        </Match>
        <Match when={resolvedUrl() === null && localAddress() === null}>
          <NoMappingCard port={0} />
        </Match>
      </Switch>
    </Show>
  )
}

function HtmlPreview(props: { instanceId: string; filePath: string }) {
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const url = createMemo(() => resolvePreviewUrl(props.instanceId, props.filePath))
  return (
    <>
      <div class="preview-html-card" onClick={() => setDialogOpen(true)}>
        <FileText size={18} class="preview-card-icon" />
        <div class="preview-card-body">
          <span class="preview-card-url">{getFileName(props.filePath)}</span>
          <span class="preview-card-status">
            {tGlobal("toolCall.renderer.preview.clickToOpen")}
          </span>
        </div>
        <ExternalLink size={16} class="preview-card-arrow" />
      </div>
      <PreviewDialog
        url={url()}
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}

function PdfPreview(props: { instanceId: string; filePath: string }) {
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const url = createMemo(() => resolvePreviewUrl(props.instanceId, props.filePath))
  return (
    <>
      <div class="preview-pdf-inline">
        <div class="preview-pdf-bar" onClick={() => setDialogOpen(true)}>
          <FileIcon size={16} class="preview-card-icon" />
          <span class="preview-pdf-name">{getFileName(props.filePath)}</span>
          <ExternalLink size={14} class="preview-card-arrow" />
        </div>
        <iframe
          class="preview-pdf-iframe"
          src={url()}
          title={getFileName(props.filePath)}
        />
      </div>
      <PreviewDialog
        url={url()}
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}

function PreviewBody(props: { instanceId: string; target: string }) {
  const kind = createMemo(() => classifyTarget(props.target))

  return (
    <Switch fallback={null}>
      <Match when={kind() === "image"}>
        <ImageLightbox
          src={resolvePreviewUrl(props.instanceId, props.target)}
          alt={getFileName(props.target)}
        />
      </Match>
      <Match when={kind() === "url"}>
        <ResolvedUrlRenderer target={props.target} />
      </Match>
      <Match when={kind() === "port"}>
        <ResolvedUrlRenderer target={props.target} />
      </Match>
      <Match when={kind() === "html"}>
        <HtmlPreview instanceId={props.instanceId} filePath={props.target} />
      </Match>
      <Match when={kind() === "pdf"}>
        <PdfPreview instanceId={props.instanceId} filePath={props.target} />
      </Match>
      <Match when={kind() === "video"}>
        <VideoPlayer src={resolvePreviewUrl(props.instanceId, props.target)} />
      </Match>
      <Match when={kind() === "audio"}>
        <AudioPlayer src={resolvePreviewUrl(props.instanceId, props.target)} />
      </Match>
      <Match when={kind() === "text"}>
        <CodePreview instanceId={props.instanceId} filePath={props.target} />
      </Match>
    </Switch>
  )
}

function extractTarget(state: any): string {
  if (state?.input && typeof state.input.target === "string" && state.input.target.trim()) {
    return state.input.target.trim()
  }

  if (typeof state?.output === "string") {
    const portMatch = state.output.match(/port\s+(\d+)/i)
    if (portMatch) return portMatch[1]
    const urlMatch = state.output.match(/(https?:\/\/[^\s]+)/i)
    if (urlMatch) return urlMatch[1]
  }

  if (typeof state?.raw === "string") {
    try {
      const parsed = JSON.parse(state.raw)
      if (typeof parsed.target === "string" && parsed.target.trim()) {
        return parsed.target.trim()
      }
    } catch { /* ignore */ }
  }

  return ""
}

export const previewRenderer: ToolRenderer = {
  tools: ["preview"],
  preferCustomBody: true,

  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined

    console.log("[previewRenderer] getTitle state:", JSON.stringify({ 
      status: state?.status, 
      input: state?.input, 
      raw: (state as any)?.raw?.substring(0, 200) 
    }))

    const target = extractTarget(state)
    if (!target) return "Preview"

    const kind = classifyTarget(target)

    switch (kind) {
      case "port":
        return `Preview :${target}`
      case "url": {
        try {
          const u = new URL(target)
          return `Preview ${u.host}`
        } catch {
          return `Preview ${target}`
        }
      }
      case "image":
      case "html":
      case "pdf":
      case "video":
      case "audio":
      case "text":
        return `Preview ${getFileName(target)}`
    }
  },

  getAction() {
    return tGlobal("toolCall.renderer.action.previewing")
  },

  renderBody(context: ToolRendererContext): JSXElement | null {
    const state = context.toolState()
    if (!state || state.status === "pending") return null

    console.log("[previewRenderer] renderBody state:", JSON.stringify({ 
      status: state?.status, 
      input: state?.input,
      output: typeof (state as any)?.output === "string" ? (state as any).output.substring(0, 100) : (state as any)?.output,
      raw: (state as any)?.raw?.substring(0, 200) 
    }))

    const target = extractTarget(state)
    if (!target) return null

    return <PreviewBody instanceId={context.instanceId} target={target} />
  },
}
