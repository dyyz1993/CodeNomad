import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import type { TextPart, RenderCache } from "../types/message"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { useI18n } from "../lib/i18n"
import { CODENOMAD_API_BASE } from "../lib/api-client"

const log = getLogger("session")

function normalizeFilePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/")
  const result: string[] = []
  for (const part of parts) {
    if (part === "." || part === "") continue
    if (part === "..") { result.pop(); continue }
    result.push(part)
  }
  return result.join("/")
}

function buildPreviewUrl(instanceId: string, filePath: string): string {
  const base = CODENOMAD_API_BASE ?? ""
  const normalized = normalizeFilePath(filePath)
  const encoded = normalized.split("/").map((s) => encodeURIComponent(s)).join("/")
  return `${base}/workspaces/${encodeURIComponent(instanceId)}/preview/${encoded}`
}

function isLocalPath(href: string): boolean {
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("#") || href.startsWith("data:") || href.startsWith("/workspaces/")) {
    return false
  }
  return true
}

function getFileIconSvg(ext: string): string {
  const iconMap: Record<string, string> = {
    ts: `<svg viewBox="0 0 24 24" fill="none" stroke="#3178C6" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#3178C6" font-size="10" font-weight="bold">TS</text></svg>`,
    tsx: `<svg viewBox="0 0 24 24" fill="none" stroke="#3178C6" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#3178C6" font-size="8" font-weight="bold">TSX</text></svg>`,
    js: `<svg viewBox="0 0 24 24" fill="none" stroke="#F7DF1E" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#F7DF1E" font-size="10" font-weight="bold">JS</text></svg>`,
    jsx: `<svg viewBox="0 0 24 24" fill="none" stroke="#F7DF1E" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#F7DF1E" font-size="8" font-weight="bold">JSX</text></svg>`,
    py: `<svg viewBox="0 0 24 24" fill="none" stroke="#3776AB" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#3776AB" font-size="10" font-weight="bold">Py</text></svg>`,
    go: `<svg viewBox="0 0 24 24" fill="none" stroke="#00ADD8" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#00ADD8" font-size="10" font-weight="bold">Go</text></svg>`,
    rs: `<svg viewBox="0 0 24 24" fill="none" stroke="#DEA584" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#DEA584" font-size="10" font-weight="bold">Rs</text></svg>`,
    json: `<svg viewBox="0 0 24 24" fill="none" stroke="#8BC34A" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#8BC34A" font-size="8" font-weight="bold">{ }</text></svg>`,
    yaml: `<svg viewBox="0 0 24 24" fill="none" stroke="#6B5B95" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#6B5B95" font-size="8" font-weight="bold">YML</text></svg>`,
    md: `<svg viewBox="0 0 24 24" fill="none" stroke="#42A5F5" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#42A5F5" font-size="10" font-weight="bold">MD</text></svg>`,
    css: `<svg viewBox="0 0 24 24" fill="none" stroke="#1572B6" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#1572B6" font-size="10" font-weight="bold">CSS</text></svg>`,
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="#E44D26" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#E44D26" font-size="8" font-weight="bold">HTML</text></svg>`,
    sh: `<svg viewBox="0 0 24 24" fill="none" stroke="#4EAA25" stroke-width="1.5"><path d="M3 3h18v18H3z"/><text x="12" y="16" text-anchor="middle" fill="#4EAA25" font-size="10" font-weight="bold">sh</text></svg>`,
  }
  return iconMap[ext] ?? `<svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #888)" stroke-width="1.5"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 10h6M9 14h4" stroke-width="1.5"/></svg>`
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function rewriteLocalPaths(html: string, instanceId: string | undefined): string {
  if (!instanceId || !html) return html

  let result = html.replace(/(<img\s[^>]*src=["'])([^"']*)(["'][^>]*>)/gi, (match, prefix, src, suffix) => {
    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") || src.startsWith("/workspaces/")) {
      return match
    }
    const previewUrl = buildPreviewUrl(instanceId, src)
    return `${prefix}${previewUrl}${suffix}`
  })

  result = result.replace(/<a\s([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi, (match, before, href, after, text) => {
    if (!isLocalPath(href)) return match

    const fileName = href.split("/").pop() || text.replace(/<[^>]*>/g, "").trim() || "file"
    const ext = fileName.split(".").pop()?.toLowerCase() || ""
    const previewUrl = buildPreviewUrl(instanceId, href)
    const iconSvg = getFileIconSvg(ext)

    return `<a href="${escapeAttr(previewUrl)}" target="_blank" rel="noopener noreferrer" class="path-card" data-file-type="${escapeAttr(ext)}" data-preview-url="${escapeAttr(previewUrl)}" data-file-path="${escapeAttr(href)}">
      <span class="path-card-main">
        <span class="path-card-icon">${iconSvg}</span>
        <span class="path-card-body">
          <span class="path-card-name">${escapeAttr(fileName)}</span>
          <span class="path-card-path">${escapeAttr(href)}</span>
        </span>
      </span>
      <span class="path-card-snapshot"></span>
    </a>`
  })

  return result
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"])

async function loadPathCardPreviews(container: HTMLElement, instanceId: string): Promise<void> {
  const cards = container.querySelectorAll<HTMLAnchorElement>(".path-card[data-preview-url]")
  if (cards.length === 0) return

  for (const card of cards) {
    const fileType = card.getAttribute("data-file-type") || ""
    const previewUrl = card.getAttribute("data-preview-url")
    const snapshotEl = card.querySelector<HTMLElement>(".path-card-snapshot")
    if (!previewUrl || !snapshotEl) continue

    try {
      if (IMAGE_EXTS.has(fileType)) {
        const img = document.createElement("img")
        img.className = "path-card-thumbnail"
        img.src = previewUrl
        img.alt = card.getAttribute("data-file-path") || ""
        img.loading = "lazy"
        snapshotEl.appendChild(img)
      } else {
        const response = await fetch(previewUrl)
        if (!response.ok) continue
        const text = await response.text()
        const lines = text.split("\n").slice(0, 4).join("\n").trim()
        if (!lines) continue
        const code = document.createElement("pre")
        code.className = "path-card-snippet"
        code.textContent = lines
        snapshotEl.appendChild(code)
      }
    } catch {
      // silently ignore — card still shows metadata
    }
  }
}

type MarkdownModule = typeof import("../lib/markdown")

let markdownModulePromise: Promise<MarkdownModule> | null = null

function loadMarkdownModule(): Promise<MarkdownModule> {
  if (!markdownModulePromise) {
    markdownModulePromise = import("../lib/markdown").catch((error) => {
      markdownModulePromise = null
      throw error
    })
  }
  return markdownModulePromise
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function resolvePartVersion(part: TextPart, text: string): string {
  if (typeof part.version === "number") {
    return String(part.version)
  }
  return `text-${hashText(text)}`
}

function resolvePartCacheId(part: TextPart, text: string): string {
  const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : ""
  if (partId) {
    return partId
  }

  return `anonymous:${hashText(text)}`
}

function decodeHtmlEntitiesLocally(content: string): string {
  if (!content.includes("&") || typeof document === "undefined") {
    return content
  }

  const textarea = document.createElement("textarea")
  textarea.innerHTML = content
  return textarea.value
}

function escapeHtml(content: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }

  return content.replace(/[&<>"']/g, (match) => map[match] ?? match)
}

function renderFallbackHtml(content: string): string {
  if (!content) {
    return ""
  }

  return escapeHtml(content).replace(/\n/g, "<br />")
}

interface MarkdownProps {
  part: TextPart
  instanceId?: string
  sessionId?: string
  isDark?: boolean
  size?: "base" | "sm" | "tight"
  disableHighlight?: boolean
  escapeRawHtml?: boolean
  onRendered?: () => void
}

export function Markdown(props: MarkdownProps) {
  const { t } = useI18n()
  const [html, setHtml] = createSignal("")
  let containerRef: HTMLDivElement | undefined
  let latestRequestKey = ""
  let cleanupLanguageListener: (() => void) | undefined

  const notifyRendered = () => {
    Promise.resolve().then(() => props.onRendered?.())
  }

  const resolved = createMemo(() => {
    const part = props.part
    const rawText = typeof part.text === "string" ? part.text : ""
    const text = decodeHtmlEntitiesLocally(rawText)
    const themeKey = Boolean(props.isDark) ? "dark" : "light"
    const highlightEnabled = !props.disableHighlight
    const escapeRawHtml = Boolean(props.escapeRawHtml)
    const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined
    const cacheId = resolvePartCacheId(part, text)
    const version = resolvePartVersion(part, text)
    const requestKey = `${cacheId}:${themeKey}:${highlightEnabled ? 1 : 0}:${escapeRawHtml ? 1 : 0}:${version}`
    return { part, text, themeKey, highlightEnabled, escapeRawHtml, partId, cacheId, version, requestKey }
  })

  const cacheHandle = useGlobalCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: "markdown",
    cacheId: () => {
      const { cacheId, themeKey, highlightEnabled } = resolved()
      return `${cacheId}:${themeKey}:${highlightEnabled ? 1 : 0}:${resolved().escapeRawHtml ? 1 : 0}`
    },
    version: () => resolved().version,
  })

  const commitCacheEntry = (
    snapshot: ReturnType<typeof resolved>,
    renderedHtml: string,
    options?: { cache?: boolean },
  ) => {
    const cacheEntry: RenderCache = {
      text: snapshot.text,
      html: renderedHtml,
      theme: snapshot.themeKey,
      mode: `${snapshot.version}:${snapshot.escapeRawHtml ? "escaped" : "raw"}`,
    }
    setHtml(renderedHtml)
    if (options?.cache ?? true) {
      cacheHandle.set(cacheEntry)
    }
    notifyRendered()
    if (containerRef && props.instanceId) {
      requestAnimationFrame(() => {
        void loadPathCardPreviews(containerRef!, props.instanceId!)
      })
    }
  }

  const renderSnapshot = async (snapshot: ReturnType<typeof resolved>) => {
    const markdown = await loadMarkdownModule()
    markdown.setMarkdownTheme(snapshot.themeKey === "dark")
    const rendered = await markdown.renderMarkdown(snapshot.text, {
      suppressHighlight: !snapshot.highlightEnabled,
      escapeRawHtml: snapshot.escapeRawHtml,
    })
    const rewritten = rewriteLocalPaths(rendered, props.instanceId)
    const shouldCache = !snapshot.highlightEnabled || !markdown.hasPendingCodeHighlight(snapshot.text)

    if (latestRequestKey === snapshot.requestKey) {
      commitCacheEntry(snapshot, rewritten, { cache: shouldCache })
    }
  }

  createEffect(() => {
    const snapshot = resolved()
    latestRequestKey = snapshot.requestKey
    const cacheMode = `${snapshot.version}:${snapshot.escapeRawHtml ? "escaped" : "raw"}`

    const cacheMatches = (cache: RenderCache | undefined) => {
      if (!cache) return false
      return cache.theme === snapshot.themeKey && cache.mode === cacheMode
    }

    const localCache = snapshot.part.renderCache
    if (localCache && cacheMatches(localCache)) {
      setHtml(rewriteLocalPaths(localCache.html, props.instanceId))
      notifyRendered()
      if (containerRef && props.instanceId) {
        requestAnimationFrame(() => void loadPathCardPreviews(containerRef!, props.instanceId!))
      }
      return
    }

    const globalCache = cacheHandle.get<RenderCache>()
    if (globalCache && cacheMatches(globalCache)) {
      setHtml(rewriteLocalPaths(globalCache.html, props.instanceId))
      notifyRendered()
      if (containerRef && props.instanceId) {
        requestAnimationFrame(() => void loadPathCardPreviews(containerRef!, props.instanceId!))
      }
      return
    }

    setHtml(renderFallbackHtml(snapshot.text))
    notifyRendered()

    void renderSnapshot(snapshot).catch((error) => {
      log.error("Failed to render markdown:", error)
      if (latestRequestKey === snapshot.requestKey) {
        commitCacheEntry(snapshot, renderFallbackHtml(snapshot.text))
      }
    })
  })

  onMount(() => {
    const handleClick = async (event: Event) => {
      const target = event.target as HTMLElement
      const copyButton = target.closest(".code-block-copy") as HTMLButtonElement

      if (copyButton) {
        event.preventDefault()
        const code = copyButton.getAttribute("data-code")
        if (!code) {
          return
        }

        const decodedCode = decodeURIComponent(code)
        const success = await copyToClipboard(decodedCode)
        const copyText = copyButton.querySelector(".copy-text")
        if (!copyText) {
          return
        }

        copyText.textContent = success ? t("markdown.codeBlock.copy.copied") : t("markdown.codeBlock.copy.failed")
        setTimeout(() => {
          copyText.textContent = t("markdown.codeBlock.copy.label")
        }, 2000)
        return
      }
    }

    containerRef?.addEventListener("click", handleClick)

    let disposed = false
    void loadMarkdownModule()
      .then((markdown) => {
        if (disposed) {
          return
        }

        cleanupLanguageListener = markdown.onLanguagesLoaded(() => {
          const snapshot = resolved()
          if (!snapshot.highlightEnabled) {
            return
          }

          latestRequestKey = snapshot.requestKey
          void renderSnapshot(snapshot).catch((error) => {
            log.error("Failed to re-render markdown after language load:", error)
          })
        })
      })
      .catch((error) => {
        log.error("Failed to load markdown module:", error)
      })

    onCleanup(() => {
      disposed = true
      containerRef?.removeEventListener("click", handleClick)
      cleanupLanguageListener?.()
      cleanupLanguageListener = undefined
    })
  })

  return (
    <div
      ref={containerRef}
      class="markdown-body"
      dir="auto"
      data-view="markdown"
      data-part-id={resolved().partId}
      data-markdown-theme={resolved().themeKey}
      data-markdown-highlight={resolved().highlightEnabled ? "true" : "false"}
      innerHTML={html()}
    />
  )
}
