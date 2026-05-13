export interface CacheEntryBaseParams {
  instanceId?: string
  sessionId?: string
  scope: string
}

export interface CacheEntryParams extends CacheEntryBaseParams {
  cacheId: string
  version: string
}

type VersionedCacheEntry = {
  version: string
  value: unknown
}

interface LRUCacheEntry extends VersionedCacheEntry {
  sizeBytes?: number
}

interface ScopeMetadata {
  totalBytes: number
}

type CacheValueMap = Map<string, LRUCacheEntry>
type CacheScopeMap = Map<string, CacheValueMap>
type CacheSessionMap = Map<string, CacheScopeMap>

const GLOBAL_KEY = "GLOBAL"
const cacheStore = new Map<string, CacheSessionMap>()
const scopeMetaStore = new Map<string, ScopeMetadata>()

let maxEntriesPerScope = 50
let scopeBudgetBytes = 5 * 1024 * 1024

export function configureGlobalCache(options?: { maxEntriesPerScope?: number; scopeBudgetBytes?: number }): void {
  if (options?.maxEntriesPerScope !== undefined) maxEntriesPerScope = options.maxEntriesPerScope
  if (options?.scopeBudgetBytes !== undefined) scopeBudgetBytes = options.scopeBudgetBytes
}

function resolveKey(value?: string) {
  return value && value.length > 0 ? value : GLOBAL_KEY
}

function scopeMetaKey(params: CacheEntryParams): string {
  return `${resolveKey(params.instanceId)}::${resolveKey(params.sessionId)}::${params.scope}`
}

function getOrCreateMeta(key: string): ScopeMetadata {
  let meta = scopeMetaStore.get(key)
  if (!meta) {
    meta = { totalBytes: 0 }
    scopeMetaStore.set(key, meta)
  }
  return meta
}

function getScopeValueMap(params: CacheEntryParams, create: boolean): CacheValueMap | undefined {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)

  let sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) {
    if (!create) return undefined
    sessionMap = new Map()
    cacheStore.set(instanceKey, sessionMap)
  }

  let scopeMap = sessionMap.get(sessionKey)
  if (!scopeMap) {
    if (!create) return undefined
    scopeMap = new Map()
    sessionMap.set(sessionKey, scopeMap)
  }

  let valueMap = scopeMap.get(params.scope)
  if (!valueMap) {
    if (!create) return undefined
    valueMap = new Map()
    scopeMap.set(params.scope, valueMap)
  }

  return valueMap
}

function evictLRU(valueMap: CacheValueMap, meta: ScopeMetadata): void {
  while (valueMap.size > maxEntriesPerScope || meta.totalBytes > scopeBudgetBytes) {
    const firstKey = valueMap.keys().next().value
    if (firstKey === undefined) break
    const evicted = valueMap.get(firstKey)
    if (evicted?.sizeBytes) meta.totalBytes -= evicted.sizeBytes
    valueMap.delete(firstKey)
  }
}

function cleanupHierarchy(instanceKey: string, sessionKey: string, scopeKey?: string) {
  const sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) return

  const scopeMap = sessionMap.get(sessionKey)
  if (!scopeMap) {
    if (sessionMap.size === 0) cacheStore.delete(instanceKey)
    return
  }

  if (scopeKey) {
    const valueMap = scopeMap.get(scopeKey)
    if (valueMap && valueMap.size === 0) {
      scopeMap.delete(scopeKey)
      scopeMetaStore.delete(`${instanceKey}::${sessionKey}::${scopeKey}`)
    }
  }

  if (scopeMap.size === 0) sessionMap.delete(sessionKey)
  if (sessionMap.size === 0) cacheStore.delete(instanceKey)
}

export function setCacheEntry<T>(params: CacheEntryParams, value: T | undefined, sizeBytes?: number): void {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)

  if (value === undefined) {
    const existingMap = getScopeValueMap(params, false)
    if (existingMap) {
      const existing = existingMap.get(params.cacheId)
      if (existing?.sizeBytes) {
        const meta = getOrCreateMeta(scopeMetaKey(params))
        meta.totalBytes -= existing.sizeBytes
      }
      existingMap.delete(params.cacheId)
    }
    cleanupHierarchy(instanceKey, sessionKey, params.scope)
    return
  }

  const scopeEntries = getScopeValueMap(params, true)!
  const meta = getOrCreateMeta(scopeMetaKey(params))

  const existing = scopeEntries.get(params.cacheId)
  if (existing?.sizeBytes) meta.totalBytes -= existing.sizeBytes

  scopeEntries.delete(params.cacheId)
  scopeEntries.set(params.cacheId, { version: params.version, value, sizeBytes })
  if (sizeBytes) meta.totalBytes += sizeBytes

  evictLRU(scopeEntries, meta)
}

export function getCacheEntry<T>(params: CacheEntryParams): T | undefined {
  const scopeEntries = getScopeValueMap(params, false)
  const entry = scopeEntries?.get(params.cacheId)
  if (!entry || entry.version !== params.version) return undefined

  scopeEntries!.delete(params.cacheId)
  scopeEntries!.set(params.cacheId, entry)
  return entry.value as T
}

export function clearCacheScope(params: CacheEntryBaseParams): void {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)
  const sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) return
  const scopeMap = sessionMap.get(sessionKey)
  if (!scopeMap) return
  scopeMap.delete(params.scope)
  scopeMetaStore.delete(`${instanceKey}::${sessionKey}::${params.scope}`)
  cleanupHierarchy(instanceKey, sessionKey)
}

export function clearCacheForSession(instanceId?: string, sessionId?: string): void {
  const instanceKey = resolveKey(instanceId)
  const sessionKey = resolveKey(sessionId)
  const sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) return
  sessionMap.delete(sessionKey)
  if (sessionMap.size === 0) cacheStore.delete(instanceKey)
}

export function clearCacheForInstance(instanceId?: string): void {
  const instanceKey = resolveKey(instanceId)
  cacheStore.delete(instanceKey)
  for (const key of scopeMetaStore.keys()) {
    if (key.startsWith(`${instanceKey}::`)) scopeMetaStore.delete(key)
  }
}
