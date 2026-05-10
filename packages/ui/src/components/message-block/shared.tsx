import { ListStart } from "lucide-solid"
import type { ClientPart } from "../../types/message"

export function DeleteUpToIcon() {
  return (
    <span class="relative inline-block w-3.5 h-3.5" aria-hidden="true">
      <ListStart class="absolute inset-0 w-3.5 h-3.5" aria-hidden="true" />
    </span>
  )
}

export const TOOL_ICON = "🔧"
export const USER_BORDER_COLOR = "var(--message-user-border)"
export const ASSISTANT_BORDER_COLOR = "var(--message-assistant-border)"
export const TOOL_BORDER_COLOR = "var(--message-tool-border)"
export const REASONING_SCROLL_SENTINEL_MARGIN_PX = 48

export function reasoningHasRenderableContent(part: ClientPart): boolean {
  if (!part || part.type !== "reasoning") {
    return false
  }
  const checkSegment = (segment: unknown): boolean => {
    if (typeof segment === "string") {
      return segment.trim().length > 0
    }
    if (segment && typeof segment === "object") {
      const candidate = segment as { text?: unknown; value?: unknown; content?: unknown[] }
      if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
        return true
      }
      if (typeof candidate.value === "string" && candidate.value.trim().length > 0) {
        return true
      }
      if (Array.isArray(candidate.content)) {
        return candidate.content.some((entry) => checkSegment(entry))
      }
    }
    return false
  }

  if (checkSegment((part as any).text)) {
    return true
  }
  if (Array.isArray((part as any).content)) {
    return (part as any).content.some((entry: unknown) => checkSegment(entry))
  }
  return false
}
