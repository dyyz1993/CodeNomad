import type { ClientPart } from "../../types/message"

export function ensurePartId(messageId: string, part: ClientPart, index: number): string {
  if (typeof part.id === "string" && part.id.length > 0) {
    return part.id
  }

  if (part.type === "tool") {
    part.id = `tool-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return part.id
  }

  const fallbackId = `${messageId}-part-${index}`
  part.id = fallbackId
  return fallbackId
}

export function clonePart(part: ClientPart): ClientPart {
  return part
}

export function cloneStructuredValue<T>(value: T): T {
  return value
}
