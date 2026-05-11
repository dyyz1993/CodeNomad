import { createEffect, onCleanup } from "solid-js"

const OPEN_SESSION_SEARCH_EVENT = "codenomad:open-session-search"

interface EventEffectsDeps {
  isActive: () => boolean
  isSearchOpen: () => boolean
  isDeleteMenuOpen: () => boolean
  selectedTimelineIds: () => Set<string>
  selectedForDeletion: () => Set<string>
  streamShellElement: () => HTMLDivElement | undefined
  updateQuoteSelectionFromSelection: () => void
  clearQuoteSelection: () => void
  openSearch: () => void
  closeSearch: () => void
  clearDeleteMode: () => void
  setIsDeleteMenuOpen: (setter: boolean | ((prev: boolean) => boolean)) => void
  deleteMenuRef: () => HTMLDivElement | undefined
  deleteMenuButtonRef: () => HTMLButtonElement | undefined
  cleanupTimelineEffects: () => void
}

export function installEventEffects(deps: EventEffectsDeps) {
  createEffect(() => {
    if (typeof document === "undefined") return
    const handleSelectionChange = () => deps.updateQuoteSelectionFromSelection()
    const handlePointerDown = (event: PointerEvent) => {
      const shell = deps.streamShellElement()
      if (!shell) return
      if (!shell.contains(event.target as Node)) {
        deps.clearQuoteSelection()
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("pointerdown", handlePointerDown)
    onCleanup(() => {
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("pointerdown", handlePointerDown)
    })
  })

  createEffect(() => {
    if (typeof document === "undefined") return
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const isModSearch = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && key === "f"
      if (isModSearch && deps.isActive()) {
        const modalOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
        if (!modalOpen) {
          event.preventDefault()
          event.stopPropagation()
          deps.openSearch()
          return
        }
      }

      if (event.key === "Escape" && deps.isSearchOpen()) {
        event.preventDefault()
        event.stopPropagation()
        deps.closeSearch()
        return
      }

      if (event.key === "Escape" && (deps.selectedTimelineIds().size > 0 || deps.selectedForDeletion().size > 0)) {
        deps.clearDeleteMode()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const handleOpenSearch = () => {
      if (!deps.isActive()) return
      deps.openSearch()
    }
    window.addEventListener(OPEN_SESSION_SEARCH_EVENT, handleOpenSearch)
    onCleanup(() => window.removeEventListener(OPEN_SESSION_SEARCH_EVENT, handleOpenSearch))
  })

  createEffect(() => {
    if (!deps.isDeleteMenuOpen()) return
    if (typeof document === "undefined") return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (deps.deleteMenuRef()?.contains(target)) return
      if (deps.deleteMenuButtonRef()?.contains(target)) return
      deps.setIsDeleteMenuOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    onCleanup(() => document.removeEventListener("mousedown", handleClick))
  })

  onCleanup(() => {
    deps.cleanupTimelineEffects()
    deps.clearQuoteSelection()
  })
}
