import os from "os"
import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { connect } from "net"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

const execFileAsync = promisify(execFile)
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { WorkspaceRuntime, ProcessExitInfo } from "./runtime"
import { Logger } from "../logger"
import { getOpencodeConfigDir } from "../opencode-config.js"
import {
  OPENCODE_SERVER_BASE_URL_ENV,
  buildOpencodeBasicAuthHeader,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
  resolveOpencodeServerAuth,
} from "./opencode-auth"

const STARTUP_STABILITY_DELAY_MS = 300
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 60 * 1000
const MAX_ACTIVE_WORKSPACES = 3

interface WorkspaceManagerOptions {
  rootDir: string
  settings: SettingsService
  binaryResolver: BinaryResolver
  eventBus: EventBus
  logger: Logger
  getServerBaseUrl: () => string
  /** Optional CA bundle path to trust CodeNomad HTTPS certs. */
  nodeExtraCaCertsPath?: string
  /** Base config directory for persisting state files. */
  configDir?: string
}

interface WorkspaceRecord extends WorkspaceDescriptor {}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly runtime: WorkspaceRuntime
  private readonly opencodeConfigDir: string
  private readonly opencodeAuth = new Map<string, { username: string; password: string; authorization: string }>()
  private readonly stateFilePath: string

  private readonly MAX_CONCURRENT_STARTUPS = 3
  private activeStartups = 0
  private startupQueue: Array<() => void> = []
  private readonly lastActivityTime = new Map<string, number>()
  private readonly workspaceBusy = new Map<string, boolean>()
  private idleCheckTimer?: ReturnType<typeof setInterval>

  private async acquireStartupSlot(): Promise<void> {
    if (this.activeStartups < this.MAX_CONCURRENT_STARTUPS) {
      this.activeStartups++
      return
    }
    return new Promise<void>((resolve) => {
      this.startupQueue.push(resolve)
    })
  }

  private releaseStartupSlot(): void {
    this.activeStartups--
    const next = this.startupQueue.shift()
    if (next) {
      this.activeStartups++
      next()
    }
  }

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.runtime = new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.opencodeConfigDir = getOpencodeConfigDir()
    this.stateFilePath = path.join(
      this.options.configDir ?? path.join(os.homedir(), ".config", "codenomad"),
      "workspaces-state.json",
    )
    void this.loadState()
    this.startIdleCheck()
  }

  private async saveState(): Promise<void> {
    const data = Array.from(this.workspaces.entries()).map(([id, w]) => ({
      id,
      path: w.path,
      name: w.name,
      proxyPath: w.proxyPath,
    }))
    try {
      await mkdir(path.dirname(this.stateFilePath), { recursive: true })
      await writeFile(this.stateFilePath, JSON.stringify(data, null, 2), "utf-8")
    } catch (err) {
      this.options.logger.warn({ err }, "Failed to save workspaces state")
    }
  }

  private async loadState(): Promise<void> {
    try {
      if (!existsSync(this.stateFilePath)) return
      const content = await readFile(this.stateFilePath, "utf-8")
      const entries = JSON.parse(content) as Array<{
        id: string
        path: string
        name?: string
        proxyPath?: string
      }>
      for (const entry of entries) {
        this.workspaces.set(entry.id, {
          id: entry.id,
          path: entry.path,
          name: entry.name,
          status: "suspended",
          proxyPath: entry.proxyPath ?? `/workspaces/${entry.id}/worktrees/root/instance`,
          binaryId: "",
          binaryLabel: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      }
      if (entries.length > 0) {
        this.options.logger.info({ count: entries.length }, "Restored workspaces from disk")
      }
    } catch (err) {
      this.options.logger.warn({ err }, "Failed to load workspaces state")
    }
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
  }

  get(id: string): WorkspaceDescriptor | undefined {
    return this.workspaces.get(id)
  }

  getInstancePort(id: string): number | undefined {
    return this.workspaces.get(id)?.port
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.opencodeAuth.get(id)?.authorization
  }

  listFiles(workspaceId: string, relativePath = "."): FileSystemEntry[] {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    return browser.list(relativePath)
  }

  async searchFiles(workspaceId: string, query: string, options?: WorkspaceFileSearchOptions): Promise<FileSystemEntry[]> {
    const workspace = this.requireWorkspace(workspaceId)
    return searchWorkspaceFiles(workspace.path, query, options)
  }

  readFile(workspaceId: string, relativePath: string): WorkspaceFileResponse {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    const contents = browser.readFile(relativePath)
    return {
      workspaceId,
      relativePath,
      contents,
    }
  }

  writeFile(workspaceId: string, relativePath: string, contents: string): void {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    browser.writeFile(relativePath, contents)
  }

  async create(folder: string, name?: string): Promise<WorkspaceDescriptor> {
    await this.acquireStartupSlot()
    const id = `${Date.now().toString(36)}`
    const binary = await this.options.binaryResolver.resolveDefault()
    const resolvedBinaryPath = await this.resolveBinaryPath(binary.path)
    const workspacePath = path.isAbsolute(folder) ? folder : path.resolve(this.options.rootDir, folder)
    clearWorkspaceSearchCache(workspacePath)

    this.options.logger.info({ workspaceId: id, folder: workspacePath, binary: resolvedBinaryPath }, "Creating workspace")

    const proxyPath = `/workspaces/${id}/worktrees/root/instance`


    const descriptor: WorkspaceRecord = {
      id,
      path: workspacePath,
      name,
      status: "starting",
      proxyPath,
      binaryId: resolvedBinaryPath,
      binaryLabel: binary.label,
      binaryVersion: binary.version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.workspaces.set(id, descriptor)


    this.options.eventBus.publish({ type: "workspace.created", workspace: descriptor })

    const serverConfig = this.options.settings.getOwnerSync("config", "server") ?? {}
    const envVars = (serverConfig as any)?.environmentVariables
    const userEnvironment = envVars && typeof envVars === "object" && !Array.isArray(envVars) ? (envVars as any) : {}
    const serverBaseUrl = this.options.getServerBaseUrl()
    const normalizedServerBaseUrl = serverBaseUrl.replace(/\/+$/, "")

    const { username: opencodeUsername, password: opencodePassword } = resolveOpencodeServerAuth({
      userEnvironment,
      processEnv: process.env,
    })
    const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })
    if (!authorization) {
      throw new Error("Failed to build OpenCode auth header")
    }
    this.opencodeAuth.set(id, { username: opencodeUsername, password: opencodePassword, authorization })

    const environment = {
      ...userEnvironment,
      OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
      CODENOMAD_INSTANCE_ID: id,
      CODENOMAD_BASE_URL: serverBaseUrl,
      ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
      [OPENCODE_SERVER_BASE_URL_ENV]: `${normalizedServerBaseUrl}${proxyPath}`,
      [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
      [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
    }

    const logLevel = (serverConfig as any)?.logLevel

    try {
      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

      const runtimeVersion = await this.waitForWorkspaceReadiness({ workspaceId: id, port, exitPromise, getLastOutput })
      if (runtimeVersion) {
        descriptor.binaryVersion = runtimeVersion
      }

      descriptor.pid = pid
      descriptor.port = port
      descriptor.status = "ready"
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
      this.recordActivity(id)
      this.options.logger.info({ workspaceId: id, port }, "Workspace ready")
      void this.saveState()
      return descriptor
    } catch (error) {
      descriptor.status = "error"
      descriptor.error = error instanceof Error ? error.message : String(error)
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.error", workspace: descriptor })
      this.options.logger.error({ workspaceId: id, err: error }, "Workspace failed to start")
      throw error
    } finally {
      this.releaseStartupSlot()
    }
  }

  async delete(id: string): Promise<WorkspaceDescriptor | undefined> {
    const workspace = this.workspaces.get(id)
    if (!workspace) return undefined

    this.options.logger.info({ workspaceId: id }, "Stopping workspace")
    const wasRunning = Boolean(workspace.pid)
    if (wasRunning) {
      await this.runtime.stop(id).catch((error) => {
        this.options.logger.warn({ workspaceId: id, err: error }, "Failed to stop workspace process cleanly")
      })
    }

    this.workspaces.delete(id)
    this.opencodeAuth.delete(id)
    this.lastActivityTime.delete(id)
    this.workspaceBusy.delete(id)
    clearWorkspaceSearchCache(workspace.path)
    if (!wasRunning) {
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: id })
    }
    void this.saveState()
    return workspace
  }

  async shutdown() {
    this.options.logger.info("Shutting down all workspaces")

    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer)
      this.idleCheckTimer = undefined
    }
    this.lastActivityTime.clear()
    this.workspaceBusy.clear()

    const stopTasks: Array<Promise<void>> = []

    for (const [id, workspace] of this.workspaces) {
      if (!workspace.pid) {
        this.options.logger.debug({ workspaceId: id }, "Workspace already stopped")
        continue
      }

      this.options.logger.info({ workspaceId: id }, "Stopping workspace during shutdown")
      stopTasks.push(
        this.runtime.stop(id).catch((error) => {
          this.options.logger.error({ workspaceId: id, err: error }, "Failed to stop workspace during shutdown")
        }),
      )
    }

    if (stopTasks.length > 0) {
      await Promise.allSettled(stopTasks)
    }

    this.workspaces.clear()
    this.opencodeAuth.clear()
    this.options.logger.info("All workspaces cleared")
  }

  private requireWorkspace(id: string): WorkspaceRecord {
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    return workspace
  }

  private async resolveBinaryPath(identifier: string): Promise<string> {
    if (!identifier) {
      return identifier
    }

    const looksLikePath = identifier.includes("/") || identifier.includes("\\") || identifier.startsWith(".")
    if (path.isAbsolute(identifier) || looksLikePath) {
      return identifier
    }

    const locator = process.platform === "win32" ? "where" : "which"

    try {
      let stdout: string
      let stderr: string
      try {
        const result = await execFileAsync(locator, [identifier], { encoding: "utf8" })
        stdout = result.stdout
        stderr = result.stderr
      } catch (err: any) {
        stdout = err?.stdout ?? ""
        stderr = err?.stderr ?? ""
        if (!stdout && err?.code === "ENOENT") {
          this.options.logger.warn({ identifier, err }, "Failed to resolve binary path via locator command")
          return identifier
        }
      }

      if (stdout) {
        const candidates = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .filter((line) => !/^INFO:/i.test(line))

        if (candidates.length > 0) {
          const resolved = this.pickBinaryCandidate(candidates)
          this.options.logger.debug({ identifier, resolved, candidates }, "Resolved binary path from system PATH")
          return resolved
        }
      }

      if (stderr) {
        this.options.logger.warn({ identifier, stderr }, "Locator command reported errors")
      }
    } catch (error) {
      this.options.logger.warn({ identifier, err: error }, "Failed to resolve binary path from system PATH")
    }

    return identifier
  }

  private pickBinaryCandidate(candidates: string[]): string {
    if (process.platform !== "win32") {
      return candidates[0] ?? ""
    }

    const extensionPreference = [".exe", ".cmd", ".bat", ".ps1"]

    for (const ext of extensionPreference) {
      const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(ext))
      if (match) {
        return match
      }
    }

    return candidates[0] ?? ""
  }

  private async waitForWorkspaceReadiness(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
  }): Promise<string | undefined> {

    await Promise.race([
      this.waitForPortAvailability(params.port),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited before becoming ready",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    const version = await this.waitForInstanceHealth(params)

    await Promise.race([
      this.delay(STARTUP_STABILITY_DELAY_MS),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited shortly after start",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    return version
  }

  private async waitForInstanceHealth(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
  }): Promise<string | undefined> {
    const probeResult = await Promise.race([
      this.probeInstance(params.workspaceId, params.port),
      params.exitPromise.then((info) => {
        throw this.buildStartupError(
          params.workspaceId,
          "exited during health checks",
          info,
          params.getLastOutput(),
        )
      }),
    ])

    if (probeResult.ok) {
      return probeResult.version
    }

    const latestOutput = params.getLastOutput().trim()
    if (latestOutput) {
      throw new Error(latestOutput)
    }
    const reason = probeResult.reason ?? "Health check failed"
    throw new Error(`Workspace ${params.workspaceId} failed health check: ${reason}.`)
  }

  private async probeInstance(
    workspaceId: string,
    port: number,
  ): Promise<{ ok: boolean; reason?: string; version?: string }> {
    const url = `http://127.0.0.1:${port}/global/health`

    try {
      const headers: Record<string, string> = {}
      const authHeader = this.opencodeAuth.get(workspaceId)?.authorization
      if (authHeader) {
        headers["Authorization"] = authHeader
      }

      const response = await fetch(url, { headers })
      if (!response.ok) {
        const reason = `/global/health returned HTTP ${response.status}`
        this.options.logger.debug({ workspaceId, status: response.status }, "Health probe returned server error")
        return { ok: false, reason }
      }

      const payload = (await response.json().catch(() => null)) as null | { healthy?: unknown; version?: unknown }
      const healthy = payload?.healthy === true
      const version = typeof payload?.version === "string" ? payload.version.trim() : undefined

      if (!healthy) {
        const reason = "Instance reported unhealthy"
        this.options.logger.debug({ workspaceId, payload }, "Health probe returned unhealthy response")
        return { ok: false, reason }
      }

      return { ok: true, version: version || undefined }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.options.logger.debug({ workspaceId, err: error }, "Health probe failed")
      return { ok: false, reason }
    }
  }

  private buildStartupError(
    workspaceId: string,
    phase: string,
    exitInfo: ProcessExitInfo,
    lastOutput: string,
  ): Error {
    const exitDetails = this.describeExit(exitInfo)
    const trimmedOutput = lastOutput.trim()
    const outputDetails = trimmedOutput ? ` Last output: ${trimmedOutput}` : ""
    return new Error(`Workspace ${workspaceId} ${phase} (${exitDetails}).${outputDetails}`)
  }

  private waitForPortAvailability(port: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      let settled = false
      let retryTimer: NodeJS.Timeout | null = null

      const cleanup = () => {
        settled = true
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
      }

      const tryConnect = () => {
        if (settled) {
          return
        }
        const socket = connect({ port, host: "127.0.0.1" }, () => {
          cleanup()
          socket.end()
          resolve()
        })
        socket.once("error", () => {
          socket.destroy()
          if (settled) {
            return
          }
          if (Date.now() >= deadline) {
            cleanup()
            reject(new Error(`Workspace port ${port} did not become ready within ${timeoutMs}ms`))
          } else {
            retryTimer = setTimeout(() => {
              retryTimer = null
              tryConnect()
            }, 100)
          }
        })
      }

      tryConnect()
    })
  }

  private delay(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => setTimeout(resolve, durationMs))
  }

  private describeExit(info: ProcessExitInfo): string {
    if (info.signal) {
      return `signal ${info.signal}`
    }
    if (info.code !== null) {
      return `code ${info.code}`
    }
    return "unknown reason"
  }

  private handleProcessExit(workspaceId: string, info: { code: number | null; requested: boolean }) {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return

    this.opencodeAuth.delete(workspaceId)

    this.options.logger.info({ workspaceId, ...info }, "Workspace process exited")

    workspace.pid = undefined
    workspace.port = undefined
    workspace.updatedAt = new Date().toISOString()

    if (info.requested || info.code === 0) {
      workspace.status = "stopped"
      workspace.error = undefined
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId })
    } else {
      workspace.status = "error"
      workspace.error = `Process exited with code ${info.code}`
      this.options.eventBus.publish({ type: "workspace.error", workspace })
    }
  }

  recordActivity(workspaceId: string): void {
    this.lastActivityTime.set(workspaceId, Date.now())
  }

  markBusy(workspaceId: string): void {
    this.workspaceBusy.set(workspaceId, true)
    this.recordActivity(workspaceId)
  }

  markIdle(workspaceId: string): void {
    this.workspaceBusy.set(workspaceId, false)
    this.recordActivity(workspaceId)
  }

  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleWorkspaces().catch((err) => {
        this.options.logger.error({ err }, "Idle check failed")
      })
    }, IDLE_CHECK_INTERVAL_MS)
  }

  private async checkIdleWorkspaces(): Promise<void> {
    const now = Date.now()
    for (const [id, lastTime] of this.lastActivityTime) {
      const workspace = this.workspaces.get(id)
      if (!workspace || workspace.status !== "ready") continue

      if (this.workspaceBusy.get(id) === true) continue

      if (now - lastTime > IDLE_TIMEOUT_MS) {
        this.options.logger.info(
          { workspaceId: id, idleMinutes: Math.round((now - lastTime) / 60000) },
          "Suspending idle workspace",
        )
        await this.suspendWorkspace(id)
      }
    }
  }

  async suspendWorkspace(id: string): Promise<void> {
    const workspace = this.workspaces.get(id)
    if (!workspace || workspace.status !== "ready") return

    await this.runtime.stop(id)
    workspace.status = "suspended"
    workspace.pid = undefined
    workspace.port = undefined
    workspace.updatedAt = new Date().toISOString()
    this.options.eventBus.publish({ type: "workspace.suspended", workspace: { ...workspace } })
    this.lastActivityTime.delete(id)
    this.workspaceBusy.delete(id)
    void this.saveState()
  }

  async resumeWorkspace(id: string): Promise<WorkspaceDescriptor> {
    const workspace = this.workspaces.get(id)
    if (!workspace || workspace.status !== "suspended") {
      throw new Error("Workspace not found or not suspended")
    }

    const activeCount = Array.from(this.workspaces.values()).filter(
      (w) => w.status === "ready" || w.status === "starting",
    ).length
    if (activeCount >= MAX_ACTIVE_WORKSPACES) {
      await this.evictLeastRecentlyUsed(id)
    }

    await this.acquireStartupSlot()
    try {
      workspace.status = "starting"
      workspace.updatedAt = new Date().toISOString()

      const binary = await this.options.binaryResolver.resolveDefault()
      const resolvedBinaryPath = await this.resolveBinaryPath(binary.path)

      const serverConfig = this.options.settings.getOwnerSync("config", "server") ?? {}
      const envVars = (serverConfig as any)?.environmentVariables
      const userEnvironment = envVars && typeof envVars === "object" && !Array.isArray(envVars) ? (envVars as any) : {}
      const serverBaseUrl = this.options.getServerBaseUrl()
      const normalizedServerBaseUrl = serverBaseUrl.replace(/\/+$/, "")

      const { username: opencodeUsername, password: opencodePassword } = resolveOpencodeServerAuth({
        userEnvironment,
        processEnv: process.env,
      })
      const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })
      if (!authorization) {
        throw new Error("Failed to build OpenCode auth header")
      }
      this.opencodeAuth.set(id, { username: opencodeUsername, password: opencodePassword, authorization })

      const environment = {
        ...userEnvironment,
        OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
        CODENOMAD_INSTANCE_ID: id,
        CODENOMAD_BASE_URL: serverBaseUrl,
        ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
        [OPENCODE_SERVER_BASE_URL_ENV]: `${normalizedServerBaseUrl}${workspace.proxyPath}`,
        [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
        [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
      }

      const logLevel = (serverConfig as any)?.logLevel

      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspace.path,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

      const runtimeVersion = await this.waitForWorkspaceReadiness({ workspaceId: id, port, exitPromise, getLastOutput })
      if (runtimeVersion) {
        workspace.binaryVersion = runtimeVersion
      }

      workspace.pid = pid
      workspace.port = port
      workspace.status = "ready"
      workspace.updatedAt = new Date().toISOString()
      this.recordActivity(id)
      this.options.eventBus.publish({ type: "workspace.resumed", workspace: { ...workspace } })
      this.options.logger.info({ workspaceId: id, port }, "Workspace resumed")
      void this.saveState()
      return workspace
    } catch (error) {
      workspace.status = "error"
      workspace.error = error instanceof Error ? error.message : String(error)
      workspace.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.error", workspace })
      this.options.logger.error({ workspaceId: id, err: error }, "Workspace failed to resume")
      throw error
    } finally {
      this.releaseStartupSlot()
    }
  }

  private async evictLeastRecentlyUsed(excludeId: string): Promise<void> {
    let lruId: string | undefined
    let lruTime = Infinity

    for (const [id, lastTime] of this.lastActivityTime) {
      if (id === excludeId) continue
      const workspace = this.workspaces.get(id)
      if (!workspace || workspace.status !== "ready") continue
      if (lastTime < lruTime) {
        lruTime = lastTime
        lruId = id
      }
    }

    if (lruId) {
      this.options.logger.info({ workspaceId: lruId }, "Evicting least recently used workspace")
      await this.suspendWorkspace(lruId)
    }
  }
}
