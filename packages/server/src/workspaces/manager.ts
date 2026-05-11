import os from "os"
import path from "path"
import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { WorkspaceRuntime, ProcessExitInfo } from "./runtime"
import type { AutoContinueManager } from "./auto-continue"
import { Logger } from "../logger"
import { getOpencodeConfigDir } from "../opencode-config.js"
import {
  OPENCODE_SERVER_BASE_URL_ENV,
  buildOpencodeBasicAuthHeader,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
  resolveOpencodeServerAuth,
} from "./opencode-auth"
import { resolveBinaryPath } from "./binary-resolver"
import { waitForWorkspaceReadiness } from "./workspace-readiness"

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
  autoContinueManager?: AutoContinueManager
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
      const tmpPath = this.stateFilePath + ".tmp"
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8")
      await rename(tmpPath, this.stateFilePath)
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
    const resolvedBinaryPath = await resolveBinaryPath(binary.path, this.options.logger)
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

    const { environment, logLevel } = this.buildEnvironment(id, proxyPath)

    try {
      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

      const runtimeVersion = await waitForWorkspaceReadiness({
        workspaceId: id,
        port,
        exitPromise,
        getLastOutput,
        authMap: this.opencodeAuth,
        logger: this.options.logger,
      })
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
    this.autoContinueManager?.removeWorkspaceSessions(id)
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

  private buildEnvironment(workspaceId: string, proxyPath: string): {
    environment: Record<string, string>
    logLevel: string | undefined
  } {
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
    this.opencodeAuth.set(workspaceId, { username: opencodeUsername, password: opencodePassword, authorization })

    const environment = {
      ...userEnvironment,
      OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
      CODENOMAD_INSTANCE_ID: workspaceId,
      CODENOMAD_BASE_URL: serverBaseUrl,
      ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
      [OPENCODE_SERVER_BASE_URL_ENV]: `${normalizedServerBaseUrl}${proxyPath}`,
      [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
      [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
    }

    const logLevel = (serverConfig as any)?.logLevel

    return { environment, logLevel }
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

  isWorkspaceBusy(workspaceId: string): boolean {
    return this.workspaceBusy.get(workspaceId) === true
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

  async waitForInstanceReady(id: string, timeoutMs = 30_000): Promise<WorkspaceDescriptor> {
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    if (workspace.status === "ready") {
      return workspace
    }
    if (workspace.status !== "starting") {
      throw new Error(`Workspace is ${workspace.status}, cannot wait for readiness`)
    }

    const pollIntervalMs = 200
    const deadline = Date.now() + timeoutMs

    return new Promise<WorkspaceDescriptor>((resolve, reject) => {
      let activeTimer: ReturnType<typeof setTimeout> | null = null
      const poll = () => {
        const current = this.workspaces.get(id)
        if (!current) {
          if (activeTimer) clearTimeout(activeTimer)
          reject(new Error("Workspace not found"))
          return
        }
        if (current.status === "ready") {
          if (activeTimer) clearTimeout(activeTimer)
          resolve(current)
          return
        }
        if (current.status === "error") {
          if (activeTimer) clearTimeout(activeTimer)
          reject(new Error(current.error ?? "Workspace entered error state"))
          return
        }
        if (Date.now() >= deadline) {
          if (activeTimer) clearTimeout(activeTimer)
          reject(new Error(`Workspace ${id} did not become ready within ${timeoutMs}ms`))
          return
        }
        activeTimer = setTimeout(poll, pollIntervalMs)
      }
      activeTimer = setTimeout(poll, pollIntervalMs)
    })
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
      const resolvedBinaryPath = await resolveBinaryPath(binary.path, this.options.logger)

      const { environment, logLevel } = this.buildEnvironment(id, workspace.proxyPath)

      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspace.path,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

      const runtimeVersion = await waitForWorkspaceReadiness({
        workspaceId: id,
        port,
        exitPromise,
        getLastOutput,
        authMap: this.opencodeAuth,
        logger: this.options.logger,
      })
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
