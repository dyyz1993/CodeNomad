import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { Logger } from '../../logger'
import { WorkspaceManager } from '../../workspaces/manager'
import { isValidWorktreeSlug } from '../../workspaces/git-worktrees'
import { resolveWorktreeDirectory } from '../../workspaces/worktree-directory'

interface InstanceProxyDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

export function registerInstanceProxyRoutes(app: FastifyInstance, deps: InstanceProxyDeps) {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser('*', (req, body, done) => done(null, body))

    const proxyBaseHandler = async (
      request: FastifyRequest<{ Params: { id: string; slug: string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeSlug: request.params.slug,
        pathSuffix: '',
        logger: deps.logger,
      })
    }

    const proxyWildcardHandler = async (
      request: FastifyRequest<{ Params: { id: string; slug: string; '*': string } }>,
      reply: FastifyReply,
    ) => {
      await proxyWorkspaceRequest({
        request,
        reply,
        workspaceManager: deps.workspaceManager,
        worktreeSlug: request.params.slug,
        pathSuffix: request.params['*'] ?? '',
        logger: deps.logger,
      })
    }

    instance.all('/workspaces/:id/worktrees/:slug/instance', proxyBaseHandler)
    instance.all('/workspaces/:id/worktrees/:slug/instance/*', proxyWildcardHandler)
  })
}

const INSTANCE_PROXY_HOST = '127.0.0.1'
const OPENCODE_DIR_OVERRIDE_PREFIX = '__dir/'
const OPENCODE_DIR_OVERRIDE_MAX_LEN = 4096

async function proxyWorkspaceRequest(args: {
  request: FastifyRequest
  reply: FastifyReply
  workspaceManager: WorkspaceManager
  logger: Logger
  worktreeSlug: string
  pathSuffix?: string
}) {
  const { request, reply, workspaceManager, logger, worktreeSlug } = args
  const workspaceId = (request.params as { id: string }).id
  const workspace = workspaceManager.get(workspaceId)

  const bodyToJson = (body: unknown): unknown => {
    if (body == null) return null

    const anyBody = body as any
    if (anyBody && typeof anyBody.pipe === 'function') {
      try {
        const buffered = anyBody?._readableState?.buffer
        if (Array.isArray(buffered) && buffered.length > 0) {
          const chunks: Buffer[] = []
          for (const entry of buffered) {
            if (!entry) continue
            if (Buffer.isBuffer(entry)) {
              chunks.push(entry)
              continue
            }
            const data = (entry as any).data
            if (Buffer.isBuffer(data)) {
              chunks.push(data)
            }
          }

          if (chunks.length > 0) {
            const text = Buffer.concat(chunks).toString('utf-8')
            try {
              return JSON.parse(text)
            } catch {
              return { __raw: text }
            }
          }
        }
      } catch {
        // fall through
      }

      return { __stream: true }
    }

    const maybeParse = (input: string): unknown => {
      try {
        return JSON.parse(input)
      } catch {
        return { __raw: input }
      }
    }

    if (Buffer.isBuffer(body)) {
      return maybeParse(body.toString('utf-8'))
    }

    if (typeof body === 'string') {
      return maybeParse(body)
    }

    if (typeof body === 'object') {
      return body
    }

    return body
  }

  if (!workspace) {
    reply.code(404).send({ error: 'Workspace not found' })
    return
  }

  let port = workspaceManager.getInstancePort(workspaceId)
  if (!port) {
    if (workspace.status === 'suspended') {
      try {
        await workspaceManager.resumeWorkspace(workspaceId)
        port = workspaceManager.getInstancePort(workspaceId)
      } catch (err) {
        reply.code(502).send({ error: 'Failed to resume workspace', details: String(err) })
        return
      }
    } else if (workspace.status === 'starting') {
      try {
        logger.debug({ workspaceId, status: workspace.status }, 'Workspace is starting, waiting for readiness')
        await workspaceManager.waitForInstanceReady(workspaceId, 30_000)
        port = workspaceManager.getInstancePort(workspaceId)
      } catch (err) {
        reply
          .header('Retry-After', '5')
          .code(503)
          .send({ error: 'Workspace instance is starting', details: String(err) })
        return
      }
    }
    if (!port) {
      reply
        .header('Retry-After', '5')
        .code(503)
        .send({ error: 'Workspace instance is not ready' })
      return
    }
  }

  if (!isValidWorktreeSlug(worktreeSlug)) {
    reply.code(400).send({ error: 'Invalid worktree slug' })
    return
  }

  let extracted: { overrideDirectory: string | null; forwardedSuffix: string | undefined }
  try {
    extracted = extractOpencodeDirectoryOverride(args.pathSuffix)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid directory override'
    reply.code(400).send({ error: message })
    return
  }
  let directory: string | null = null
  let forwardedSuffix = extracted.forwardedSuffix

  if (extracted.overrideDirectory) {
    try {
      directory = await validateAndNormalizeOverrideDirectory({
        overrideDirectory: extracted.overrideDirectory,
        workspaceRoot: workspace.path,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid directory override'
      reply.code(400).send({ error: message })
      return
    }
  } else {
    directory = await resolveWorktreeDirectory({
      workspaceId,
      workspacePath: workspace.path,
      worktreeSlug,
      logger,
    })

    if (!directory) {
      reply.code(404).send({ error: 'Worktree not found' })
      return
    }
  }

  const normalizedSuffix = normalizeInstanceSuffix(forwardedSuffix)
  const queryIndex = (request.raw.url ?? '').indexOf('?')
  const search = queryIndex >= 0 ? (request.raw.url ?? '').slice(queryIndex) : ''
  const targetUrl = `http://${INSTANCE_PROXY_HOST}:${port}${normalizedSuffix}${search}`
  const instanceAuthHeader = workspaceManager.getInstanceAuthorizationHeader(workspaceId)

  logger.debug({ workspaceId, method: request.method, targetUrl }, 'Proxying request to instance')
  workspaceManager.recordActivity(workspaceId)
  if (logger.isLevelEnabled('trace')) {
    logger.trace({ workspaceId, targetUrl, body: request.body }, 'Instance proxy payload')
  }

  return reply.from(targetUrl, {
    rewriteRequestHeaders: (_originalRequest, headers) => {
      if (instanceAuthHeader) {
        headers.authorization = instanceAuthHeader
      }

      const isNonASCII = /[^\x00-\x7F]/.test(directory)
      const encodedDirectory = isNonASCII ? encodeURIComponent(directory) : directory

      ;(headers as Record<string, unknown>)['x-opencode-directory'] = encodedDirectory

      if (logger.isLevelEnabled('trace')) {
        const outgoing: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
          outgoing[key] = value
        }

        for (const key of Object.keys(outgoing)) {
          const lower = key.toLowerCase()
          if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie') {
            outgoing[key] = '<redacted>'
          }
        }

        logger.trace(
          {
            workspaceId,
            method: request.method,
            targetUrl,
            worktreeSlug,
            directory,
            contentType: request.headers['content-type'],
            body: bodyToJson(request.body),
            headers: outgoing,
          },
          'Proxy -> OpenCode request',
        )
      }

      return headers
    },
    onError: (proxyReply, { error }) => {
      const errorCode = (error as NodeJS.ErrnoException)?.code
      const errorName = error?.name || ''
      const errorMsg = error instanceof Error ? error.message : String(error)
      const isConnectionError =
        errorCode === 'ECONNREFUSED' ||
        errorCode === 'ECONNRESET' ||
        errorCode === 'ETIMEDOUT' ||
        errorCode === 'EPIPE' ||
        errorName.includes('SocketError') ||
        errorMsg.includes('Socket Error') ||
        errorMsg.includes('UndiciSocketError')

      if (isConnectionError) {
        logger.warn({ workspaceId, targetUrl, errorCode, errorName, err: errorMsg }, 'Instance connection error, triggering recovery')
        if (!workspaceManager.isWorkspaceBusy(workspaceId)) {
          workspaceManager
            .suspendWorkspace(workspaceId)
            .then(() => workspaceManager.resumeWorkspace(workspaceId))
            .then(() => logger.info({ workspaceId }, 'Workspace recovered after connection error'))
            .catch((e) => logger.warn({ workspaceId, err: e }, 'Failed to recover workspace'))
        }
        if (!proxyReply.sent) {
          proxyReply
            .header('Retry-After', '3')
            .code(503)
            .send({ error: 'Workspace instance is starting, please retry' })
        }
        return
      }
      logger.error({ err: error, workspaceId, targetUrl }, 'Failed to proxy workspace request')
      if (!proxyReply.sent) {
        proxyReply.code(502).send({ error: 'Workspace instance proxy failed' })
      }
    },
  })
}

function extractOpencodeDirectoryOverride(pathSuffix: string | undefined): {
  overrideDirectory: string | null
  forwardedSuffix: string | undefined
} {
  if (!pathSuffix) {
    return { overrideDirectory: null, forwardedSuffix: pathSuffix }
  }

  const trimmed = pathSuffix.replace(/^\/+/, '')
  if (!trimmed.startsWith(OPENCODE_DIR_OVERRIDE_PREFIX)) {
    return { overrideDirectory: null, forwardedSuffix: pathSuffix }
  }

  const rest = trimmed.slice(OPENCODE_DIR_OVERRIDE_PREFIX.length)
  const slashIndex = rest.indexOf('/')
  const encoded = (slashIndex >= 0 ? rest.slice(0, slashIndex) : rest).trim()
  const remaining = slashIndex >= 0 ? rest.slice(slashIndex + 1) : ''

  if (!encoded) {
    throw new Error('Missing directory override')
  }

  if (encoded.length > OPENCODE_DIR_OVERRIDE_MAX_LEN) {
    throw new Error('Directory override too large')
  }

  let overrideDirectory = ''
  try {
    overrideDirectory = decodeBase64Url(encoded)
  } catch {
    throw new Error('Invalid directory override')
  }
  const forwardedSuffix = remaining
  return { overrideDirectory, forwardedSuffix }
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  const base64 = `${normalized}${padding}`
  return Buffer.from(base64, 'base64').toString('utf-8')
}

async function validateAndNormalizeOverrideDirectory(params: { overrideDirectory: string; workspaceRoot: string }): Promise<string> {
  const raw = params.overrideDirectory.trim()
  if (!raw) {
    throw new Error('Override directory is empty')
  }

  if (!path.isAbsolute(raw)) {
    throw new Error('Override directory must be an absolute path')
  }

  try {
    await fs.promises.access(raw)
  } catch {
    throw new Error(`Override directory does not exist: ${raw}`)
  }

  const stats = await fs.promises.stat(raw)
  if (!stats.isDirectory()) {
    throw new Error(`Override path is not a directory: ${raw}`)
  }

  const normalizedOverride = await fs.promises.realpath(raw)
  const normalizedRoot = await fs.promises.realpath(params.workspaceRoot)

  if (!isSubpath(normalizedOverride, normalizedRoot)) {
    throw new Error('Override directory must be within the workspace root')
  }

  return normalizedOverride
}

function isSubpath(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  if (rel === '') return true
  if (rel === '..') return false
  if (rel.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(rel)) return false
  return true
}

function normalizeInstanceSuffix(pathSuffix: string | undefined) {
  if (!pathSuffix || pathSuffix === '/') {
    return '/'
  }
  const trimmed = pathSuffix.replace(/^\/+/, '')
  return trimmed.length === 0 ? '/' : `/${trimmed}`
}
