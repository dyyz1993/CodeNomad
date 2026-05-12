import { FastifyInstance } from "fastify"
import fs from "fs"
import path from "path"
import type { WorkspaceManager } from "../../workspaces/manager"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

function isSubpath(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  if (rel === "" || rel === ".") return true
  if (rel === "..") return false
  if (rel.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(rel)) return false
  return true
}

export function registerFilePreviewRoutes(app: FastifyInstance, deps: { workspaceManager: WorkspaceManager }) {
  app.get<{
    Params: { id: string }
    Querystring: { path?: string }
  }>("/workspaces/:id/preview/*", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const wildcard = (request.params as any)["*"] as string | undefined
    if (!wildcard) {
      reply.code(400).send({ error: "File path required" })
      return
    }

    const decodedPath = decodeURIComponent(wildcard)
    const resolved = path.resolve(workspace.path, decodedPath)

    if (!isSubpath(resolved, workspace.path)) {
      reply.code(403).send({ error: "Path outside workspace" })
      return
    }

    if (!fs.existsSync(resolved)) {
      reply.code(404).send({ error: "File not found" })
      return
    }

    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved)
      const listing = entries.map((name) => {
        const fullPath = path.join(resolved, name)
        const isDir = fs.statSync(fullPath).isDirectory()
        return {
          name,
          path: decodedPath.replace(/\/$/, "") + "/" + name,
          type: isDir ? "directory" : "file" as const,
          size: isDir ? undefined : fs.statSync(fullPath).size,
        }
      })
      reply.send(listing)
      return
    }

    const mime = getMimeType(resolved)

    if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) {
      reply.header("Content-Type", mime)
      reply.header("Cache-Control", "private, max-age=3600")
      reply.send(fs.readFileSync(resolved))
      return
    }

    const content = fs.readFileSync(resolved, "utf-8")
    reply.header("Content-Type", mime)
    reply.send(content)
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string }
  }>("/api/workspaces/:id/preview/serve", async (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const filePath = request.query.path
    if (!filePath) {
      reply.code(400).send({ error: "path query parameter required" })
      return
    }

    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspace.path, filePath)
    if (!isSubpath(absolutePath, workspace.path)) {
      reply.code(403).send({ error: "Path outside workspace" })
      return
    }

    if (!fs.existsSync(absolutePath)) {
      reply.code(404).send({ error: "File not found" })
      return
    }

    const stat = fs.statSync(absolutePath)
    if (stat.isDirectory()) {
      reply.code(400).send({ error: "Path is a directory, use /workspaces/:id/preview/* for directory listing" })
      return
    }

    const mime = getMimeType(absolutePath)

    if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) {
      reply.header("Content-Type", mime)
      reply.header("Cache-Control", "private, max-age=3600")
      reply.send(fs.readFileSync(absolutePath))
      return
    }

    const content = fs.readFileSync(absolutePath, "utf-8")
    reply.header("Content-Type", mime)
    reply.send(content)
  })
}
