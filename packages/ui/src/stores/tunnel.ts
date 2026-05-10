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

export function openTunnelViewer(url: string, title?: string) {
  setViewerUrl(url)
  setViewerTitle(title || url)
  setViewerOpen(true)
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
