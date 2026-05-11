import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { useGlobalPointerDrag } from "../useGlobalPointerDrag"
import {
  RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY,
  readStoredPanelWidth,
} from "../storage"

type SplitTab = "changes" | "git-changes" | "files"

interface UseSplitResizeConfig {
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
}

interface UseSplitResizeReturn {
  changesSplitWidth: Accessor<number>
  filesSplitWidth: Accessor<number>
  gitChangesSplitWidth: Accessor<number>
  handleSplitResizeMouseDown: (mode: SplitTab) => (event: MouseEvent) => void
  handleSplitResizeTouchStart: (mode: SplitTab) => (event: TouchEvent) => void
}

export function useSplitResize(config: UseSplitResizeConfig): UseSplitResizeReturn {
  const [changesSplitWidth, setChangesSplitWidth] = createSignal(320)
  const [filesSplitWidth, setFilesSplitWidth] = createSignal(320)
  const [gitChangesSplitWidth, setGitChangesSplitWidth] = createSignal(320)
  const [activeSplitResize, setActiveSplitResize] = createSignal<SplitTab | null>(null)
  const [splitResizeStartX, setSplitResizeStartX] = createSignal(0)
  const [splitResizeStartWidth, setSplitResizeStartWidth] = createSignal(0)

  const clampSplitWidth = (value: number) => {
    const min = 200
    const maxByDrawer = Math.max(min, Math.floor(config.rightDrawerWidth() * 0.65))
    const max = Math.min(560, maxByDrawer)
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  const [splitWidthsInitialized, setSplitWidthsInitialized] = createSignal(false)

  createEffect(() => {
    if (splitWidthsInitialized()) return
    if (!config.rightDrawerWidthInitialized()) return
    setSplitWidthsInitialized(true)
    setChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY, 320)))
    setFilesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY, 320)))
    setGitChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY, 320)))
  })

  const persistSplitWidth = (mode: SplitTab, width: number) => {
    if (typeof window === "undefined") return
    const key =
      mode === "changes"
        ? RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY
        : mode === "git-changes"
          ? RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY
          : RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY
    window.localStorage.setItem(key, String(width))
  }

  function stopSplitResize() {
    setActiveSplitResize(null)
    if (typeof document === "undefined") return
    splitPointerDrag.stop()
  }

  function splitMouseMove(event: MouseEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    event.preventDefault()
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (event.clientX - splitResizeStartX()) * (isRtl ? -1 : 1)
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "changes") setChangesSplitWidth(next)
    else if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitMouseUp() {
    const mode = activeSplitResize()
    if (mode) {
      const width =
        mode === "changes" ? changesSplitWidth() : mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  function splitTouchMove(event: TouchEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (touch.clientX - splitResizeStartX()) * (isRtl ? -1 : 1)
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "changes") setChangesSplitWidth(next)
    else if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitTouchEnd() {
    const mode = activeSplitResize()
    if (mode) {
      const width =
        mode === "changes" ? changesSplitWidth() : mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  const splitPointerDrag = useGlobalPointerDrag({
    onMouseMove: splitMouseMove,
    onMouseUp: splitMouseUp,
    onTouchMove: splitTouchMove,
    onTouchEnd: splitTouchEnd,
  })

  const startSplitResize = (mode: SplitTab, clientX: number) => {
    if (typeof document === "undefined") return
    setActiveSplitResize(mode)
    setSplitResizeStartX(clientX)
    setSplitResizeStartWidth(
      mode === "changes" ? changesSplitWidth() : mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth(),
    )
    splitPointerDrag.start()
  }

  const handleSplitResizeMouseDown = (mode: SplitTab) => (event: MouseEvent) => {
    event.preventDefault()
    startSplitResize(mode, event.clientX)
  }

  const handleSplitResizeTouchStart = (mode: SplitTab) => (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    startSplitResize(mode, touch.clientX)
  }

  onCleanup(() => {
    stopSplitResize()
  })

  return {
    changesSplitWidth,
    filesSplitWidth,
    gitChangesSplitWidth,
    handleSplitResizeMouseDown,
    handleSplitResizeTouchStart,
  }
}
