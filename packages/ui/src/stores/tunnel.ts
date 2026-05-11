import { createSignal } from "solid-js"

export interface TunnelInfo {
  id: string
  subdomain: string
  publicUrl: string
  relayUrl: string
  targetHost: string
  targetPort: number
  name: string
  status: "waiting" | "connected" | "disconnected"
  createdAt: number
  requests: number
  bytesIn: number
  bytesOut: number
}

const [viewerOpen, setViewerOpen] = createSignal(false)
const [viewerUrl, setViewerUrl] = createSignal("")
const [viewerTitle, setViewerTitle] = createSignal("")

const [tunnels, setTunnels] = createSignal<TunnelInfo[]>([])
const [tunnelEnabled, setTunnelEnabled] = createSignal(false)

function parseLocalUrl(url: string): { host: string; port: number; path: string } | null {
  try {
    const u = new URL(url)
    const port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80
    if (["localhost", "127.0.0.1"].includes(u.hostname) ||
        /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(u.hostname)) {
      return { host: u.hostname, port, path: u.pathname + u.search }
    }
  } catch { /* ignore */ }
  return null
}

export async function openTunnelViewer(url: string, title?: string) {
  setViewerUrl(url)
  setViewerTitle(title || url)
  setViewerOpen(true)
}

export async function ensureTunnelAndViewer(localUrl: string) {
  const parsed = parseLocalUrl(localUrl)
  if (!parsed) {
    openTunnelViewer(localUrl)
    return
  }

  const key = `${parsed.host}:${parsed.port}`
  const existing = tunnels().find(
    (t) => t.targetHost === parsed.host && t.targetPort === parsed.port && t.status === "connected"
  )

  let publicUrl = localUrl
  if (existing) {
    publicUrl = `${existing.publicUrl}${parsed.path}`
  } else {
    try {
      const tunnel = await createTunnel(parsed.host, parsed.port, key)
      if (tunnel?.publicUrl) {
        publicUrl = `${tunnel.publicUrl}${parsed.path}`
      }
    } catch { /* fall back to local URL */ }
  }

  openTunnelViewer(publicUrl, localUrl)
}

export function closeTunnelViewer() {
  setViewerOpen(false)
  setViewerUrl("")
  setViewerTitle("")
}

export async function fetchTunnels() {
  try {
    const response = await fetch("/api/tunnels")
    if (response.ok) {
      const data = await response.json()
      setTunnels(data.tunnels || [])
    }
  } catch {
    // Tunnel API not available
  }
}

export async function fetchTunnelStatus() {
  try {
    const response = await fetch("/api/tunnels/status")
    if (response.ok) {
      const data = await response.json()
      setTunnelEnabled(data.enabled ?? false)
    }
  } catch {
    setTunnelEnabled(false)
  }
}

export async function createTunnel(
  targetHost: string,
  targetPort: number,
  name?: string,
) {
  const response = await fetch("/api/tunnels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetHost, targetPort, name }),
  })
  if (response.ok) {
    const tunnel = await response.json()
    await fetchTunnels()
    return tunnel
  }
  throw new Error(`Failed to create tunnel: ${response.status}`)
}

export async function deleteTunnel(targetHost: string, targetPort: number) {
  await fetch("/api/tunnels", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetHost, targetPort }),
  })
  await fetchTunnels()
}

export {
  viewerOpen,
  viewerUrl,
  viewerTitle,
  tunnels,
  tunnelEnabled,
}
