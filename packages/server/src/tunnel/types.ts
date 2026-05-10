export interface TunnelConfig {
  hubUrl: string
  enabled: boolean
}

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

export interface RelayRequest {
  type: "request"
  id: string
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
}

export interface RelayResponse {
  type: "response"
  id: string
  status: number
  headers: Record<string, string>
  body?: string
  bodyBase64?: string
}

export interface LocalUrlMatch {
  fullUrl: string
  host: string
  port: number
  path: string
}
