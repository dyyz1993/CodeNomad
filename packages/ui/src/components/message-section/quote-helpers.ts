import { copyToClipboard } from "../../lib/clipboard"
import { showToastNotification } from "../../lib/notifications"
type TranslateFn = (key: string, params?: Record<string, unknown>) => string

const QUOTE_SELECTION_MAX_LENGTH = 2000

export interface QuoteSelectionState {
  quoteSelection: () => { text: string; top: number; left: number } | null
  setQuoteSelection: (value: { text: string; top: number; left: number } | null) => void
  streamElement: () => HTMLDivElement | undefined
  streamShellElement: () => HTMLDivElement | undefined
  onQuoteSelection?: (text: string, mode: "quote" | "code") => void
  t: TranslateFn
}

export function makeClearQuoteSelection(state: QuoteSelectionState) {
  return () => {
    state.setQuoteSelection(null)
  }
}

export function isSelectionWithinStream(
  range: Range | null,
  streamElement: () => HTMLDivElement | undefined,
): boolean {
  const container = streamElement()
  if (!range || !container) return false
  const node = range.commonAncestorContainer
  if (!node) return false
  return container.contains(node)
}

export function makeUpdateQuoteSelectionFromSelection(state: QuoteSelectionState, clearQuoteSelection: () => void) {
  return () => {
    if (!state.onQuoteSelection || typeof window === "undefined") {
      clearQuoteSelection()
      return
    }
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      clearQuoteSelection()
      return
    }
    const range = selection.getRangeAt(0)
    if (!isSelectionWithinStream(range, state.streamElement)) {
      clearQuoteSelection()
      return
    }
    const shell = state.streamShellElement()
    if (!shell) {
      clearQuoteSelection()
      return
    }
    const rawText = selection.toString().trim()
    if (!rawText) {
      clearQuoteSelection()
      return
    }
    const limited =
      rawText.length > QUOTE_SELECTION_MAX_LENGTH ? rawText.slice(0, QUOTE_SELECTION_MAX_LENGTH).trimEnd() : rawText
    if (!limited) {
      clearQuoteSelection()
      return
    }
    const rects = range.getClientRects()
    const anchorRect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    const relativeTop = Math.max(anchorRect.top - shellRect.top - 40, 8)
    const maxLeft = Math.max(shell.clientWidth - 260, 8)
    const relativeLeft = Math.min(Math.max(anchorRect.left - shellRect.left, 8), maxLeft)
    state.setQuoteSelection({ text: limited, top: relativeTop, left: relativeLeft })
  }
}

export function makeHandleQuoteSelectionRequest(state: QuoteSelectionState, clearQuoteSelection: () => void) {
  return (mode: "quote" | "code") => {
    const info = state.quoteSelection()
    if (!info || !state.onQuoteSelection) return
    state.onQuoteSelection(info.text, mode)
    clearQuoteSelection()
    if (typeof window !== "undefined") {
      const selection = window.getSelection()
      selection?.removeAllRanges()
    }
  }
}

export function makeHandleCopySelectionRequest(state: QuoteSelectionState, clearQuoteSelection: () => void) {
  return async () => {
    const info = state.quoteSelection()
    if (!info) return

    const success = await copyToClipboard(info.text)
    showToastNotification({
      message: success ? state.t("messageSection.quote.copied") : state.t("messageSection.quote.copyFailed"),
      variant: success ? "success" : "error",
      duration: success ? 2000 : 6000,
    })

    clearQuoteSelection()
    if (typeof window !== "undefined") {
      const selection = window.getSelection()
      selection?.removeAllRanges()
    }
  }
}
