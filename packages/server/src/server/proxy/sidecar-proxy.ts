import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { connect as connectTcp, type Socket } from 'net'
import { connect as connectTls, type TLSSocket } from 'tls'
import type { Logger } from '../../logger'
import type { AuthManager } from '../../auth/manager'
import type { SideCarManager } from '../../sidecars/manager'

interface SideCarProxyDeps {
  sidecarManager: SideCarManager
  logger: Logger
}

interface SideCarWebSocketProxyDeps extends SideCarProxyDeps {
  authManager: AuthManager
}

export function registerSideCarProxyRoutes(app: FastifyInstance, deps: SideCarProxyDeps) {
  const proxyBaseHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    await proxySideCarRequest({
      request,
      reply,
      sidecarManager: deps.sidecarManager,
      logger: deps.logger,
      pathSuffix: '',
    })
  }

  const proxyWildcardHandler = async (
    request: FastifyRequest<{ Params: { id: string; '*': string } }>,
    reply: FastifyReply,
  ) => {
    await proxySideCarRequest({
      request,
      reply,
      sidecarManager: deps.sidecarManager,
      logger: deps.logger,
      pathSuffix: request.params['*'] ?? '',
    })
  }

  app.all('/sidecars/:id', proxyBaseHandler)
  app.all('/sidecars/:id/*', proxyWildcardHandler)
}

export function setupSideCarWebSocketProxy(app: FastifyInstance, deps: SideCarWebSocketProxyDeps) {
  app.server.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url ?? '/'
    const parsed = parseSideCarUpgradePath(rawUrl)
    if (!parsed) {
      return
    }

    void proxySideCarWebSocketUpgrade({
      request,
      socket: socket as Socket,
      head,
      sidecarId: parsed.sidecarId,
      incomingPath: parsed.pathname,
      search: parsed.search,
      sidecarManager: deps.sidecarManager,
      authManager: deps.authManager,
      logger: deps.logger,
    })
  })
}

async function proxySideCarRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  sidecarManager: SideCarManager
  logger: Logger
  pathSuffix?: string
}) {
  const sidecarId = (args.request.params as { id?: string }).id ?? ''
  const sidecar = await args.sidecarManager.get(sidecarId)
  if (!sidecar) {
    args.reply.code(404).send({ error: 'SideCar not found' })
    return
  }

  const pathname = (args.request.raw.url ?? args.request.url ?? '').split('?')[0] ?? ''
  const queryIndex = (args.request.raw.url ?? args.request.url ?? '').indexOf('?')
  const search = queryIndex >= 0 ? (args.request.raw.url ?? args.request.url ?? '').slice(queryIndex) : ''
  const pathSuffix = args.pathSuffix ?? ''
  const requestPath = pathSuffix ? `${args.sidecarManager.buildProxyBasePath(sidecarId)}/${pathSuffix.replace(/^\/+/, '')}` : args.sidecarManager.buildProxyBasePath(sidecarId)
  const targetPath = args.sidecarManager.buildTargetPath(sidecarId, requestPath, search)
  const targetOrigin = args.sidecarManager.buildTargetOrigin(sidecar)
  const targetUrl = `${targetOrigin}${targetPath}`
  args.logger.debug({ sidecarId: sidecar.id, targetUrl, pathname, prefixMode: sidecar.prefixMode }, 'Proxying request to SideCar')

  await args.reply.from(targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) =>
      sanitizeSideCarProxyRequestHeaders(headers as Record<string, string | string[] | undefined>, targetOrigin),
    rewriteHeaders: (headers) => rewriteSideCarResponseHeaders(headers, sidecarId, targetOrigin, sidecar.prefixMode),
    onError: (reply, { error }) => {
      args.logger.error({ sidecarId: sidecar.id, err: error, targetUrl }, 'Failed to proxy SideCar request')
      if (!reply.sent) {
        reply.code(502).send({ error: 'SideCar proxy failed' })
      }
    },
  })
}

function parseSideCarUpgradePath(rawUrl: string): { sidecarId: string; pathname: string; search: string } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, 'http://localhost')
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/sidecars\/([^/]+)(?:\/.*)?$/)
  if (!match) {
    return null
  }

  try {
    return {
      sidecarId: decodeURIComponent(match[1] ?? ''),
      pathname: parsed.pathname,
      search: parsed.search,
    }
  } catch {
    return null
  }
}

async function proxySideCarWebSocketUpgrade(args: {
  request: import('http').IncomingMessage
  socket: Socket
  head: Buffer
  sidecarId: string
  incomingPath: string
  search: string
  sidecarManager: SideCarManager
  authManager: AuthManager
  logger: Logger
}) {
  const { request, socket, head, sidecarId, incomingPath, search, sidecarManager, authManager, logger } = args

  if (!isWebSocketUpgradeRequest(request)) {
    rejectUpgrade(socket, 400, 'Bad Request')
    return
  }

  const session = authManager.getSessionFromHeaders(request.headers)
  if (!session) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    return
  }

  const sidecar = await sidecarManager.get(sidecarId)
  if (!sidecar) {
    rejectUpgrade(socket, 404, 'Not Found')
    return
  }

  const targetOrigin = sidecarManager.buildTargetOrigin(sidecar)
  const targetPath = sidecarManager.buildTargetPath(sidecarId, incomingPath, search)
  const targetUrl = new URL(`${targetOrigin}${targetPath}`)
  logger.debug({ sidecarId, targetUrl: targetUrl.toString(), prefixMode: sidecar.prefixMode }, 'Proxying websocket to SideCar')

  const { socket: upstream, readyEvent } = createSideCarUpstreamSocket(targetUrl)

  const closeBoth = () => {
    if (!socket.destroyed) {
      socket.destroy()
    }
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  }

  upstream.once('error', (error) => {
    logger.error({ sidecarId, err: error, targetUrl: targetUrl.toString() }, 'Failed to proxy SideCar websocket')
    rejectUpgrade(socket, 502, 'Bad Gateway')
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  socket.once('error', (error) => {
    logger.debug({ sidecarId, err: error }, 'SideCar websocket client socket errored')
    if (!upstream.destroyed) {
      upstream.destroy()
    }
  })

  upstream.once(readyEvent, () => {
    try {
      upstream.write(buildSideCarWebSocketRequest(request, targetUrl))
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    } catch (error) {
      logger.error({ sidecarId, err: error, targetUrl: targetUrl.toString() }, 'Failed to forward SideCar websocket upgrade')
      closeBoth()
    }
  })

  upstream.once('close', () => {
    if (!socket.destroyed) {
      socket.end()
    }
  })

  socket.once('close', () => {
    if (!upstream.destroyed) {
      upstream.end()
    }
  })
}

function createSideCarUpstreamSocket(targetUrl: URL): { socket: Socket | TLSSocket; readyEvent: 'connect' | 'secureConnect' } {
  const port = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80))
  if (targetUrl.protocol === 'https:') {
    return {
      socket: connectTls({
        host: targetUrl.hostname,
        port,
        servername: targetUrl.hostname,
      }),
      readyEvent: 'secureConnect',
    }
  }
  return {
    socket: connectTcp(port, targetUrl.hostname),
    readyEvent: 'connect',
  }
}

function buildSideCarWebSocketRequest(request: import('http').IncomingMessage, targetUrl: URL): string {
  const pathWithQuery = `${targetUrl.pathname}${targetUrl.search}`
  const requestLine = `${request.method ?? 'GET'} ${pathWithQuery} HTTP/${request.httpVersion}\r\n`
  const headerLines: string[] = []
  const rawHeaders = request.rawHeaders ?? []
  const blockedHeaders = getBlockedSideCarRequestHeaders()

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (!key || value === undefined) continue
    const lower = key.toLowerCase()
    if (blockedHeaders.has(lower)) continue
    if (lower === 'origin') {
      headerLines.push(`Origin: ${targetUrl.origin}\r\n`)
      continue
    }
    headerLines.push(`${key}: ${value}\r\n`)
  }

  const hostValue = targetUrl.port ? `${targetUrl.hostname}:${targetUrl.port}` : targetUrl.hostname
  headerLines.push(`Host: ${hostValue}\r\n`)
  headerLines.push('\r\n')

  return requestLine + headerLines.join('')
}

function isWebSocketUpgradeRequest(request: import('http').IncomingMessage): boolean {
  const upgrade = request.headers.upgrade
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
    return false
  }
  const connection = request.headers.connection
  const connectionValue = Array.isArray(connection) ? connection.join(',') : connection ?? ''
  return connectionValue.toLowerCase().split(',').map((part) => part.trim()).includes('upgrade')
}

function rejectUpgrade(socket: Socket, statusCode: number, statusText: string) {
  if (socket.destroyed) {
    return
  }
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function rewriteSideCarResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  sidecarId: string,
  targetOrigin: string,
  prefixMode: 'strip' | 'preserve',
) {
  if (prefixMode === 'preserve') {
    return headers
  }

  const next = { ...headers }
  const locationHeader = next.location
  const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader
  if (!location) {
    return next
  }

  const publicBase = `/sidecars/${encodeURIComponent(sidecarId)}`

  if (location.startsWith('/')) {
    next.location = `${publicBase}${location}`
    return next
  }

  try {
    const parsed = new URL(location)
    if (parsed.origin === targetOrigin) {
      next.location = `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Relative redirects should continue to resolve against the public sidecar path.
  }

  return next
}

function sanitizeSideCarProxyRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  targetOrigin: string,
): Record<string, string | string[] | undefined> {
  const blockedHeaders = getBlockedSideCarRequestHeaders()
  const next: Record<string, string | string[] | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (blockedHeaders.has(key.toLowerCase())) continue
    next[key] = value
  }

  next.origin = targetOrigin
  return next
}

const BLOCKED_SIDECAR_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
])

function getBlockedSideCarRequestHeaders(): Set<string> {
  return BLOCKED_SIDECAR_REQUEST_HEADERS
}
