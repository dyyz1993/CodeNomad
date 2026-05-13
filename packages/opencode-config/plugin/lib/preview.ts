import { tool } from "@opencode-ai/plugin/tool"
import type { CodeNomadConfig } from "./request"

/**
 * Preview tool: lets the AI show a resource to the user as an inline card
 * in the chat stream. The frontend previewRenderer picks up the tool call
 * and renders an appropriate card (image / URL / port / HTML / PDF / video / audio / text).
 *
 * The tool itself is intentionally lightweight — it validates the target,
 * optionally resolves localhost ports to public subdomain URLs, and returns
 * a short summary. All visual rendering happens client-side.
 */
export function createPreviewTool(config: CodeNomadConfig) {
  return {
    preview: tool({
      description: [
        "Preview a resource inline in the chat. Use this to show the user a URL, a local port (e.g. a dev server), an image file, an HTML page, a PDF, a video/audio file, or any file.",
        "Examples: preview({ target: '8080' }) for a dev server, preview({ target: 'https://example.com' }) for a URL, preview({ target: './screenshot.png' }) for an image.",
        "The preview renders as an interactive card in the chat. URLs and ports show as clickable cards that open an iframe preview. Images display inline.",
      ].join(" "),
      args: {
        target: tool.schema.string().describe(
          "The resource to preview: a URL (https://...), a port number ('3000' or ':3000'), or a file path (./image.png, ./report.html)"
        ),
      },
      async execute(args) {
        const target = args.target.trim()
        if (!target) {
          return "Error: empty target. Provide a URL, port number, or file path."
        }

        const kind = classifyTarget(target)

        // For port targets, always create a new dynamic subdomain
        if (kind === "port") {
          const port = extractPort(target)
          if (port) {
            const mapping = await createSubdomainMapping(config, port)
            if (mapping) {
              return `Preview: port ${port} → ${mapping}\nTarget: ${target}`
            }
            return `Preview: port ${port} (failed to create subdomain mapping)\nTarget: ${target}`
          }
        }

        // For URL targets, validate the URL
        if (kind === "url") {
          try {
            const url = new URL(target.startsWith("http") ? target : `https://${target}`)
            return `Preview: ${url.href}\nTarget: ${target}`
          } catch {
            return `Preview: ${target}\nTarget: ${target}`
          }
        }

        // For file targets, just return the path — the frontend handles fetching
        return `Preview: ${target}\nTarget: ${target}`
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TargetKind = "url" | "port" | "image" | "html" | "pdf" | "video" | "audio" | "text" | "unknown"

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"])
const HTML_EXTENSIONS = new Set([".html", ".htm"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi"])
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac"])
const PDF_EXTENSION = ".pdf"

function classifyTarget(target: string): TargetKind {
  // Bare port number: "3000", ":3000"
  if (/^\d{1,5}$/.test(target) || /^:\d{1,5}$/.test(target)) {
    return "port"
  }

  // URL with protocol
  if (/^https?:\/\//i.test(target)) {
    return "url"
  }

  // Domain-like without protocol: "example.com", "localhost:3000"
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?/i.test(target)) {
    return "url"
  }

  // File extension based classification
  const lower = target.toLowerCase()
  const ext = lower.includes(".") ? "." + lower.split(".").pop()! : ""

  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (HTML_EXTENSIONS.has(ext)) return "html"
  if (ext === PDF_EXTENSION) return "pdf"
  if (VIDEO_EXTENSIONS.has(ext)) return "video"
  if (AUDIO_EXTENSIONS.has(ext)) return "audio"

  // File path (relative or absolute) without recognized extension
  if (target.startsWith("./") || target.startsWith("/") || target.startsWith("~/")) {
    return "text"
  }

  return "unknown"
}

function extractPort(target: string): number | null {
  const match = target.match(/^:?(\d{1,5})$/)
  if (match) {
    const port = parseInt(match[1], 10)
    return port > 0 && port <= 65535 ? port : null
  }
  return null
}

interface SubdomainProxy {
  id: string
  subdomain: string
  targetPort: number
  targetHost: string
  name: string
  fullUrl: string
}

/**
 * Query the CodeNomad server's subdomain-proxy API to find the public URL
 * for a given localhost port.
 *
 * NOTE: We call the server's direct /api/subdomain-proxies endpoint instead
 * of using the plugin requester (which prefixes paths with /workspaces/:id/plugin/).
 * The server registers subdomain-proxy routes under /api/, not under the plugin prefix.
 */
async function resolveSubdomainUrl(
  config: CodeNomadConfig,
  port: number,
): Promise<string | null> {
  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, "")
    const response = await fetch(`${baseUrl}/api/subdomain-proxies`, {
      headers: { Accept: "application/json" },
    })
    if (!response.ok) return null
    const data = (await response.json()) as { proxies?: SubdomainProxy[] }
    const proxies = Array.isArray(data) ? (data as SubdomainProxy[]) : (data.proxies ?? [])
    const match = proxies.find((p) => p.targetPort === port)
    return match?.fullUrl ?? null
  } catch {
    // API not available or error — return null, frontend will show warning
    return null
  }
}

function randomSuffix(length = 4): string {
  return Math.random().toString(36).substring(2, 2 + length)
}

/**
 * Dynamically create a new subdomain proxy mapping for the given port.
 * Uses a unique subdomain name (`p-{port}-{random}`) to avoid collisions.
 */
async function createSubdomainMapping(
  config: CodeNomadConfig,
  port: number,
): Promise<string | null> {
  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, "")
    const subdomain = `p-${port}-${randomSuffix()}`

    const response = await fetch(`${baseUrl}/api/subdomain-proxies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain,
        targetPort: port,
        name: `Port ${port} Preview`,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      console.error(`[preview-plugin] Failed to create subdomain mapping (${response.status}): ${text}`)
      return null
    }

    const data = (await response.json()) as Record<string, unknown>
    return typeof data.fullUrl === "string" ? data.fullUrl : null
  } catch (err) {
    console.error("[preview-plugin] Error creating subdomain mapping:", err)
    return null
  }
}
