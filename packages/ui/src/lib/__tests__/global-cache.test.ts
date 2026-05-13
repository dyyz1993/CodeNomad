import { beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  clearCacheForInstance,
  clearCacheForSession,
  clearCacheScope,
  configureGlobalCache,
  getCacheEntry,
  setCacheEntry,
} from "../global-cache.ts"

describe("global-cache", () => {
  beforeEach(() => {
    configureGlobalCache({ maxEntriesPerScope: 50, scopeBudgetBytes: 5 * 1024 * 1024 })
    clearCacheForInstance()
  })

  it("setCacheEntry + getCacheEntry roundtrip", () => {
    setCacheEntry({ scope: "s1", cacheId: "k1", version: "v1" }, "hello")
    const result = getCacheEntry<string>({ scope: "s1", cacheId: "k1", version: "v1" })
    assert.equal(result, "hello")
  })

  it("getCacheEntry returns undefined for unknown key", () => {
    const result = getCacheEntry({ scope: "s1", cacheId: "noexist", version: "v1" })
    assert.equal(result, undefined)
  })

  it("getCacheEntry returns undefined on version mismatch", () => {
    setCacheEntry({ scope: "s1", cacheId: "k1", version: "v1" }, "hello")
    const result = getCacheEntry<string>({ scope: "s1", cacheId: "k1", version: "v2" })
    assert.equal(result, undefined)
  })

  it("setCacheEntry with undefined value deletes the entry", () => {
    setCacheEntry({ scope: "s1", cacheId: "k1", version: "v1" }, "hello")
    setCacheEntry<string>({ scope: "s1", cacheId: "k1", version: "v1" }, undefined)
    const result = getCacheEntry<string>({ scope: "s1", cacheId: "k1", version: "v1" })
    assert.equal(result, undefined)
  })

  it("clearCacheScope removes all entries for a scope", () => {
    setCacheEntry({ scope: "sc1", cacheId: "a", version: "v1" }, 1)
    setCacheEntry({ scope: "sc1", cacheId: "b", version: "v1" }, 2)
    setCacheEntry({ scope: "sc2", cacheId: "c", version: "v1" }, 3)

    clearCacheScope({ scope: "sc1" })

    assert.equal(getCacheEntry({ scope: "sc1", cacheId: "a", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "sc1", cacheId: "b", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "sc2", cacheId: "c", version: "v1" }), 3)
  })

  it("clearCacheForSession removes all entries for a session", () => {
    setCacheEntry({ scope: "s1", cacheId: "a", version: "v1" }, 1)
    setCacheEntry({ scope: "s2", cacheId: "b", version: "v1" }, 2)

    clearCacheForSession()

    assert.equal(getCacheEntry({ scope: "s1", cacheId: "a", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "s2", cacheId: "b", version: "v1" }), undefined)
  })

  it("clearCacheForInstance removes all entries and cleans up scopeMetaStore", () => {
    setCacheEntry({ instanceId: "inst1", scope: "s1", cacheId: "a", version: "v1" }, "x", 100)

    clearCacheForInstance("inst1")

    assert.equal(getCacheEntry({ instanceId: "inst1", scope: "s1", cacheId: "a", version: "v1" }), undefined)

    configureGlobalCache({ scopeBudgetBytes: 150 })
    setCacheEntry({ instanceId: "inst1", scope: "s1", cacheId: "b", version: "v1" }, "y", 60)
    setCacheEntry({ instanceId: "inst1", scope: "s1", cacheId: "c", version: "v1" }, "z", 60)

    assert.equal(getCacheEntry({ instanceId: "inst1", scope: "s1", cacheId: "b", version: "v1" }), "y")
    assert.equal(getCacheEntry({ instanceId: "inst1", scope: "s1", cacheId: "c", version: "v1" }), "z")
  })

  it("LRU eviction: oldest entry evicted when maxEntriesPerScope exceeded", () => {
    configureGlobalCache({ maxEntriesPerScope: 3 })

    setCacheEntry({ scope: "lru", cacheId: "a", version: "v1" }, 1)
    setCacheEntry({ scope: "lru", cacheId: "b", version: "v1" }, 2)
    setCacheEntry({ scope: "lru", cacheId: "c", version: "v1" }, 3)
    setCacheEntry({ scope: "lru", cacheId: "d", version: "v1" }, 4)

    assert.equal(getCacheEntry({ scope: "lru", cacheId: "a", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "lru", cacheId: "b", version: "v1" }), 2)
    assert.equal(getCacheEntry({ scope: "lru", cacheId: "d", version: "v1" }), 4)
  })

  it("size budget eviction removes entries exceeding scopeBudgetBytes", () => {
    configureGlobalCache({ scopeBudgetBytes: 100 })

    setCacheEntry({ scope: "budget", cacheId: "a", version: "v1" }, "x", 60)
    setCacheEntry({ scope: "budget", cacheId: "b", version: "v1" }, "y", 60)

    assert.equal(getCacheEntry({ scope: "budget", cacheId: "a", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "budget", cacheId: "b", version: "v1" }), "y")
  })

  it("configureGlobalCache updates limits", () => {
    configureGlobalCache({ maxEntriesPerScope: 2 })

    setCacheEntry({ scope: "conf", cacheId: "a", version: "v1" }, 1)
    setCacheEntry({ scope: "conf", cacheId: "b", version: "v1" }, 2)
    setCacheEntry({ scope: "conf", cacheId: "c", version: "v1" }, 3)

    assert.equal(getCacheEntry({ scope: "conf", cacheId: "a", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "conf", cacheId: "c", version: "v1" }), 3)

    configureGlobalCache({ maxEntriesPerScope: 5 })
    setCacheEntry({ scope: "conf", cacheId: "d", version: "v1" }, 4)
    setCacheEntry({ scope: "conf", cacheId: "e", version: "v1" }, 5)

    assert.equal(getCacheEntry({ scope: "conf", cacheId: "b", version: "v1" }), 2)
    assert.equal(getCacheEntry({ scope: "conf", cacheId: "d", version: "v1" }), 4)
    assert.equal(getCacheEntry({ scope: "conf", cacheId: "e", version: "v1" }), 5)
  })

  it("setCacheEntry bumps entry to front preserving LRU order on read", () => {
    configureGlobalCache({ maxEntriesPerScope: 3 })

    setCacheEntry({ scope: "bump", cacheId: "a", version: "v1" }, 1)
    setCacheEntry({ scope: "bump", cacheId: "b", version: "v1" }, 2)
    setCacheEntry({ scope: "bump", cacheId: "c", version: "v1" }, 3)

    getCacheEntry({ scope: "bump", cacheId: "a", version: "v1" })

    setCacheEntry({ scope: "bump", cacheId: "d", version: "v1" }, 4)
    setCacheEntry({ scope: "bump", cacheId: "e", version: "v1" }, 5)

    assert.equal(getCacheEntry({ scope: "bump", cacheId: "a", version: "v1" }), 1)
    assert.equal(getCacheEntry({ scope: "bump", cacheId: "b", version: "v1" }), undefined)
  })

  it("scope isolation: different scopes do not interfere", () => {
    configureGlobalCache({ maxEntriesPerScope: 2 })

    setCacheEntry({ scope: "iso1", cacheId: "a", version: "v1" }, 1)
    setCacheEntry({ scope: "iso1", cacheId: "b", version: "v1" }, 2)
    setCacheEntry({ scope: "iso2", cacheId: "c", version: "v1" }, 3)
    setCacheEntry({ scope: "iso2", cacheId: "d", version: "v1" }, 4)

    setCacheEntry({ scope: "iso1", cacheId: "e", version: "v1" }, 5)

    assert.equal(getCacheEntry({ scope: "iso1", cacheId: "a", version: "v1" }), undefined)
    assert.equal(getCacheEntry({ scope: "iso1", cacheId: "b", version: "v1" }), 2)
    assert.equal(getCacheEntry({ scope: "iso2", cacheId: "c", version: "v1" }), 3)
    assert.equal(getCacheEntry({ scope: "iso2", cacheId: "d", version: "v1" }), 4)
  })
})
