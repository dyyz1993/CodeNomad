import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import fs from 'fs'
import path from 'path'
import { fetch } from 'undici'
import type { AuthManager } from '../auth/manager'
import { wantsHtml } from '../auth/http-auth'

let cachedIndexHtml: string | null = null

export function getIndexHtml(indexPath: string): string {
  if (cachedIndexHtml === null) {
    cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8')
  }
  return cachedIndexHtml
}

export function setupStaticUi(app: FastifyInstance, uiDir: string, authManager: AuthManager) {
  if (!uiDir) {
    app.log.warn('UI static directory not provided; API endpoints only')
    return
  }

  if (!fs.existsSync(uiDir)) {
    app.log.warn({ uiDir }, 'UI static directory missing; API endpoints only')
    return
  }

  app.register(fastifyStatic, {
    root: uiDir,
    prefix: '/',
    decorateReply: false,
  })

  const indexPath = path.join(uiDir, 'index.html')

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ''
    if (isApiRequest(url)) {
      reply.code(404).send({ message: 'Not Found' })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (!session && wantsHtml(request)) {
      reply.redirect('/login')
      return
    }

    if (fs.existsSync(indexPath)) {
      reply.type('text/html').send(getIndexHtml(indexPath))
    } else {
      reply.code(404).send({ message: 'UI bundle missing' })
    }
  })
}

export function setupDevProxy(app: FastifyInstance, upstreamBase: string, authManager: AuthManager) {
  app.log.info({ upstreamBase }, 'Proxying UI requests to development server')
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? ''
    if (isApiRequest(url)) {
      reply.code(404).send({ message: 'Not Found' })
      return
    }

    const session = authManager.getSessionFromRequest(request)
    if (!session && wantsHtml(request)) {
      reply.redirect('/login')
      return
    }

    void proxyToDevServer(request, reply, upstreamBase)
  })
}

export async function proxyToDevServer(request: FastifyRequest, reply: FastifyReply, upstreamBase: string) {
  try {
    const targetUrl = new URL(request.raw.url ?? '/', upstreamBase)
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: buildProxyHeaders(request.headers),
    })

    response.headers.forEach((value, key) => {
      reply.header(key, value)
    })

    reply.code(response.status)

    if (!response.body || request.method === 'HEAD') {
      reply.send()
      return
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    reply.send(buffer)
  } catch (error) {
    request.log.error({ err: error }, 'Failed to proxy UI request to dev server')
    if (!reply.sent) {
      reply.code(502).send('UI dev server is unavailable')
    }
  }
}

export function isApiRequest(rawUrl: string | null | undefined) {
  if (!rawUrl) return false
  const pathname = rawUrl.split('?')[0] ?? ''
  return pathname === '/api' || pathname.startsWith('/api/')
}

export function buildProxyHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!value || key.toLowerCase() === 'host') continue
    result[key] = Array.isArray(value) ? value.join(',') : value
  }
  return result
}
