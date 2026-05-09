import { decodeHtmlEntities } from "../../lib/text-render-utils";
function decodeTextSegment(segment) {
    if (typeof segment === "string") {
        return decodeHtmlEntities(segment);
    }
    if (segment && typeof segment === "object") {
        const updated = { ...segment };
        if (typeof updated.text === "string") {
            updated.text = decodeHtmlEntities(updated.text);
        }
        if (typeof updated.value === "string") {
            updated.value = decodeHtmlEntities(updated.value);
        }
        if (Array.isArray(updated.content)) {
            updated.content = updated.content.map((item) => decodeTextSegment(item));
        }
        return updated;
    }
    return segment;
}
export function normalizeMessagePart(part) {
    if (!part || typeof part !== "object") {
        return part;
    }
    if (part.type === "tool" && (typeof part.id !== "string" || part.id.length === 0)) {
        part.id = `tool-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    if (part.type !== "text") {
        return part;
    }
    const normalized = { ...part, renderCache: undefined };
    if (typeof normalized.text === "string") {
        normalized.text = decodeHtmlEntities(normalized.text);
    }
    else if (normalized.text && typeof normalized.text === "object") {
        const textObject = { ...normalized.text };
        if (typeof textObject.value === "string") {
            textObject.value = decodeHtmlEntities(textObject.value);
        }
        if (Array.isArray(textObject.content)) {
            textObject.content = textObject.content.map((item) => decodeTextSegment(item));
        }
        if (typeof textObject.text === "string") {
            textObject.text = decodeHtmlEntities(textObject.text);
        }
        normalized.text = textObject;
    }
    if (Array.isArray(normalized.content)) {
        normalized.content = normalized.content.map((item) => decodeTextSegment(item));
    }
    if (normalized.thinking && typeof normalized.thinking === "object") {
        const thinking = { ...normalized.thinking };
        if (Array.isArray(thinking.content)) {
            thinking.content = thinking.content.map((item) => decodeTextSegment(item));
        }
        normalized.thinking = thinking;
    }
    return normalized;
}
