import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizeMessagePart } from "../../../../ui/src/stores/message-v2/normalizers"

describe("normalizeMessagePart", () => {
  describe("tool part fallback ID", () => {
    it("generates a fallback ID for tool part without id", () => {
      const part = { type: "tool", name: "read-file" }
      const result = normalizeMessagePart(part)

      assert.equal(typeof result.id, "string")
      assert.ok(result.id.startsWith("tool-fallback-"), `expected id to start with "tool-fallback-", got: ${result.id}`)
      assert.ok(result.id.length > "tool-fallback-".length)
    })

    it("generates a fallback ID for tool part with empty id", () => {
      const part = { type: "tool", id: "", name: "read-file" }
      const result = normalizeMessagePart(part)

      assert.equal(typeof result.id, "string")
      assert.ok(result.id.startsWith("tool-fallback-"))
    })

    it("preserves existing ID for tool part with valid id", () => {
      const part = { type: "tool", id: "existing-123", name: "read-file" }
      const result = normalizeMessagePart(part)

      assert.equal(result.id, "existing-123")
    })

    it("does not add id to non-tool parts", () => {
      const part = { type: "text", text: "hello" }
      const result = normalizeMessagePart(part)

      assert.equal(result.id, undefined)
    })
  })

  describe("text part HTML entity decoding", () => {
    it("decodes HTML entities in string text", () => {
      const part = { type: "text", text: "a &lt; b &amp; c" }
      const result = normalizeMessagePart(part)

      assert.equal(result.text, "a < b & c")
    })

    it("decodes HTML entities in text object with value", () => {
      const part = { type: "text", text: { value: "&quot;hello&quot;" } }
      const result = normalizeMessagePart(part)

      assert.equal(result.text.value, '"hello"')
    })

    it("decodes HTML entities in text object with content array", () => {
      const part = {
        type: "text",
        text: {
          content: [
            { text: "a &amp; b" },
            "plain &lt; string",
          ],
        },
      }
      const result = normalizeMessagePart(part)

      assert.equal(result.text.content[0].text, "a & b")
      assert.equal(result.text.content[1], "plain < string")
    })

    it("decodes HTML entities in content array at part level", () => {
      const part = {
        type: "text",
        content: [
          { text: "&lt;div&gt;" },
          { value: "&apos;hi&apos;" },
        ],
      }
      const result = normalizeMessagePart(part)

      assert.equal(result.content[0].text, "<div>")
      assert.equal(result.content[1].value, "'hi'")
    })

    it("decodes HTML entities in thinking content", () => {
      const part = {
        type: "text",
        thinking: {
          content: [{ text: "1 &lt; 2" }],
        },
      }
      const result = normalizeMessagePart(part)

      assert.equal(result.thinking.content[0].text, "1 < 2")
    })

    it("strips renderCache from text parts", () => {
      const part = { type: "text", text: "hi", renderCache: "some cache" }
      const result = normalizeMessagePart(part)

      assert.equal(result.renderCache, undefined)
    })
  })

  describe("passthrough behavior", () => {
    it("returns null/undefined unchanged", () => {
      assert.equal(normalizeMessagePart(null), null)
      assert.equal(normalizeMessagePart(undefined), undefined)
    })

    it("returns non-text, non-tool parts unchanged", () => {
      const part = { type: "image", url: "http://example.com/img.png" }
      const result = normalizeMessagePart(part)

      assert.deepEqual(result, part)
    })
  })
})
