import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  ModelPreferenceSchema,
  PreferencesSchema,
  RecentFolderSchema,
  OpenCodeBinarySchema,
  ConfigFileSchema,
  ConfigYamlSchema,
  StateFileSchema,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_YAML,
  DEFAULT_STATE,
} from "../schema.js"

describe("ModelPreferenceSchema", () => {
  it("parses valid input", () => {
    const result = ModelPreferenceSchema.parse({
      providerId: "openai",
      modelId: "gpt-4",
    })
    assert.deepEqual(result, { providerId: "openai", modelId: "gpt-4" })
  })

  it("rejects missing providerId", () => {
    assert.throws(
      () => ModelPreferenceSchema.parse({ modelId: "gpt-4" }),
      /providerId/,
    )
  })

  it("rejects missing modelId", () => {
    assert.throws(
      () => ModelPreferenceSchema.parse({ providerId: "openai" }),
      /modelId/,
    )
  })
})

describe("PreferencesSchema", () => {
  it("fills all defaults from empty object", () => {
    const result = PreferencesSchema.parse({})
    assert.equal(result.showThinkingBlocks, false)
    assert.equal(result.thinkingBlocksExpansion, "expanded")
    assert.equal(result.showTimelineTools, true)
    assert.equal(result.promptSubmitOnEnter, false)
    assert.equal(result.lastUsedBinary, undefined)
    assert.equal(result.locale, undefined)
    assert.deepEqual(result.environmentVariables, {})
    assert.deepEqual(result.modelRecents, [])
    assert.deepEqual(result.modelFavorites, [])
    assert.deepEqual(result.modelThinkingSelections, {})
    assert.equal(result.diffViewMode, "split")
    assert.equal(result.toolOutputExpansion, "expanded")
    assert.equal(result.diagnosticsExpansion, "expanded")
    assert.equal(result.showUsageMetrics, true)
    assert.equal(result.autoCleanupBlankSessions, true)
    assert.equal(result.listeningMode, "local")
    assert.equal(result.logLevel, "DEBUG")
    assert.equal(result.osNotificationsEnabled, false)
    assert.equal(result.osNotificationsAllowWhenVisible, false)
    assert.equal(result.notifyOnNeedsInput, true)
    assert.equal(result.notifyOnIdle, true)
  })

  it("overrides showThinkingBlocks default", () => {
    const result = PreferencesSchema.parse({ showThinkingBlocks: true })
    assert.equal(result.showThinkingBlocks, true)
  })

  it("sets locale", () => {
    const result = PreferencesSchema.parse({ locale: "zh" })
    assert.equal(result.locale, "zh")
  })

  it("preserves unknown keys via passthrough", () => {
    const result = PreferencesSchema.parse({ futureFeature: 42 })
    assert.equal((result as any).futureFeature, 42)
  })

  it("rejects invalid showThinkingBlocks type", () => {
    assert.throws(
      () => PreferencesSchema.parse({ showThinkingBlocks: "yes" }),
    )
  })
})

describe("RecentFolderSchema", () => {
  it("parses valid input", () => {
    const result = RecentFolderSchema.parse({
      path: "/home",
      lastAccessed: 12345,
    })
    assert.deepEqual(result, { path: "/home", lastAccessed: 12345 })
  })

  it("rejects negative lastAccessed", () => {
    assert.throws(
      () => RecentFolderSchema.parse({ path: "/home", lastAccessed: -1 }),
    )
  })
})

describe("OpenCodeBinarySchema", () => {
  it("parses valid input without optionals", () => {
    const result = OpenCodeBinarySchema.parse({
      path: "/usr/local/bin/opencode",
      lastUsed: 12345,
    })
    assert.equal(result.path, "/usr/local/bin/opencode")
    assert.equal(result.lastUsed, 12345)
    assert.equal(result.version, undefined)
    assert.equal(result.label, undefined)
  })

  it("parses valid input with optional version and label", () => {
    const result = OpenCodeBinarySchema.parse({
      path: "/usr/local/bin/opencode",
      lastUsed: 12345,
      version: "1.0.0",
      label: "stable",
    })
    assert.equal(result.version, "1.0.0")
    assert.equal(result.label, "stable")
  })

  it("rejects missing path", () => {
    assert.throws(
      () => OpenCodeBinarySchema.parse({ lastUsed: 12345 }),
      /path/,
    )
  })
})

describe("ConfigFileSchema", () => {
  it("fills all defaults from empty object", () => {
    const result = ConfigFileSchema.parse({})
    assert.deepEqual(result, DEFAULT_CONFIG)
    assert.deepEqual(result.preferences, PreferencesSchema.parse({}))
    assert.deepEqual(result.recentFolders, [])
    assert.deepEqual(result.opencodeBinaries, [])
    assert.equal(result.theme, undefined)
  })

  it("parses a full valid config", () => {
    const result = ConfigFileSchema.parse({
      preferences: { showThinkingBlocks: true, locale: "zh" },
      recentFolders: [{ path: "/home", lastAccessed: 12345 }],
      opencodeBinaries: [
        { path: "/usr/local/bin/opencode", lastUsed: 12345 },
      ],
      theme: "dark",
    })
    assert.equal(result.preferences.showThinkingBlocks, true)
    assert.equal(result.preferences.locale, "zh")
    assert.equal(result.recentFolders.length, 1)
    assert.equal(result.theme, "dark")
  })

  it("accepts theme: dark", () => {
    const result = ConfigFileSchema.parse({ theme: "dark" })
    assert.equal(result.theme, "dark")
  })

  it("rejects invalid theme value", () => {
    assert.throws(
      () => ConfigFileSchema.parse({ theme: "blue" }),
    )
  })

  it("preserves extra top-level keys via passthrough", () => {
    const result = ConfigFileSchema.parse({ experimentalFeature: true })
    assert.equal((result as any).experimentalFeature, true)
  })
})

describe("ConfigYamlSchema", () => {
  it("fills all defaults from empty object", () => {
    const result = ConfigYamlSchema.parse({})
    assert.deepEqual(result, DEFAULT_CONFIG_YAML)
  })

  it("parses config with preferences", () => {
    const result = ConfigYamlSchema.parse({
      preferences: { locale: "zh" },
    })
    assert.equal(result.preferences.locale, "zh")
  })

  it("does not have recentFolders field", () => {
    const result = ConfigYamlSchema.parse({})
    assert.equal((result as any).recentFolders, undefined)
  })
})

describe("StateFileSchema", () => {
  it("fills all defaults from empty object", () => {
    const result = StateFileSchema.parse({})
    assert.deepEqual(result, DEFAULT_STATE)
    assert.deepEqual(result.recentFolders, [])
  })

  it("parses with recentFolders", () => {
    const result = StateFileSchema.parse({
      recentFolders: [{ path: "/home", lastAccessed: 12345 }],
    })
    assert.equal(result.recentFolders.length, 1)
    assert.equal(result.recentFolders[0].path, "/home")
  })
})

describe("DEFAULT values", () => {
  it("DEFAULT_CONFIG has expected structure", () => {
    assert.ok(DEFAULT_CONFIG.preferences)
    assert.ok(Array.isArray(DEFAULT_CONFIG.recentFolders))
    assert.ok(Array.isArray(DEFAULT_CONFIG.opencodeBinaries))
    assert.equal(DEFAULT_CONFIG.theme, undefined)
  })

  it("DEFAULT_CONFIG_YAML has no recentFolders", () => {
    assert.equal((DEFAULT_CONFIG_YAML as any).recentFolders, undefined)
  })

  it("DEFAULT_STATE has empty recentFolders", () => {
    assert.ok(Array.isArray(DEFAULT_STATE.recentFolders))
    assert.equal(DEFAULT_STATE.recentFolders.length, 0)
  })
})
