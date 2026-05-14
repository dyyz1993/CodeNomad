interface PerfReport {
  fps: { avg: number; min: number; samples: number }
  longTasks: { count: number; totalMs: number; longestMs: number; entries: { duration: number; startTime: number }[] }
  inputDelay: { avg: number; max: number; samples: number }
  memory: { usedJS: string; totalJS: string; limit: string } | null
  layoutThrashing: { count: number }
  duration: string
  jsHeapGrowth: string
}

class PerfMonitor {
  private fpsSamples: number[] = []
  private rafId = 0
  private lastFrame = 0
  private running = false

  private longTaskEntries: { duration: number; startTime: number }[] = []
  private longTaskObs: PerformanceObserver | null = null

  private inputSamples: number[] = []
  private inputObs: PerformanceObserver | null = null

  private layoutCount = 0
  private layoutObs: PerformanceObserver | null = null

  private startTime = 0

  private initialHeap = 0

  start() {
    if (this.running) return
    this.running = true
    this.startTime = performance.now()

    this.fpsSamples = []
    this.longTaskEntries = []
    this.inputSamples = []
    this.layoutCount = 0

    const mem = (performance as any).memory
    this.initialHeap = mem?.usedJSHeapSize ?? 0

    this.lastFrame = performance.now()
    const tick = (now: number) => {
      if (!this.running) return
      const delta = now - this.lastFrame
      this.lastFrame = now
      if (delta > 0) {
        this.fpsSamples.push(1000 / delta)
      }
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)

    try {
      this.longTaskObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskEntries.push({
            duration: entry.duration,
            startTime: entry.startTime,
          })
        }
      })
      this.longTaskObs.observe({ type: "longtask", buffered: false })
    } catch { /* not supported */ }

    try {
      this.inputObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 0) {
            this.inputSamples.push(entry.duration)
          }
        }
      })
      this.inputObs.observe({ type: "first-input", buffered: false })
      this.inputObs.observe({ type: "event", buffered: false, durationThreshold: 0 } as any)
    } catch { /* not supported */ }

    try {
      this.layoutObs = new PerformanceObserver((list) => {
        this.layoutCount += list.getEntries().length
      })
      this.layoutObs.observe({ type: "layout-shift", buffered: false })
    } catch { /* not supported */ }

    console.log(
      "%c📊 PerfMonitor started. Call __perf.report() to get a performance report.",
      "font-weight:bold;color:#22c55e",
    )
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.longTaskObs?.disconnect()
    this.inputObs?.disconnect()
    this.layoutObs?.disconnect()
  }

  report(): PerfReport {
    this.stop()

    const avg = this.fpsSamples.length
      ? this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length
      : 0
    const min = this.fpsSamples.length
      ? Math.min(...this.fpsSamples)
      : 0
    const totalLong = this.longTaskEntries.reduce((s, e) => s + e.duration, 0)
    const longest = this.longTaskEntries.length
      ? Math.max(...this.longTaskEntries.map((e) => e.duration))
      : 0

    const avgInput = this.inputSamples.length
      ? this.inputSamples.reduce((a, b) => a + b, 0) / this.inputSamples.length
      : 0
    const maxInput = this.inputSamples.length
      ? Math.max(...this.inputSamples)
      : 0

    const mem = (performance as any).memory
    const memory = mem
      ? {
          usedJS: `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`,
          totalJS: `${(mem.totalJSHeapSize / 1048576).toFixed(1)} MB`,
          limit: `${(mem.jsHeapSizeLimit / 1048576).toFixed(1)} MB`,
        }
      : null

    const jsHeapGrowth = mem
      ? `${((mem.usedJSHeapSize - this.initialHeap) / 1048576).toFixed(1)} MB`
      : "N/A"

    return {
      fps: {
        avg: Math.round(avg * 10) / 10,
        min: Math.round(min * 10) / 10,
        samples: this.fpsSamples.length,
      },
      longTasks: {
        count: this.longTaskEntries.length,
        totalMs: Math.round(totalLong * 10) / 10,
        longestMs: Math.round(longest * 10) / 10,
        entries: this.longTaskEntries.slice(-10),
      },
      inputDelay: {
        avg: Math.round(avgInput * 10) / 10,
        max: Math.round(maxInput * 10) / 10,
        samples: this.inputSamples.length,
      },
      memory,
      layoutThrashing: { count: this.layoutCount },
      duration: `${((performance.now() - this.startTime) / 1000).toFixed(1)}s`,
      jsHeapGrowth,
    }
  }

  get isRunning() {
    return this.running
  }
}

const monitor = new PerfMonitor()

function copyReport(report: PerfReport) {
  const text = JSON.stringify(report, null, 2)
  navigator.clipboard.writeText(text).then(
    () => console.log("%c📋 Report copied to clipboard!", "font-weight:bold;color:#22c55e"),
    () => console.log("%c⚠️ Failed to copy. Select and copy manually.", "color:#f59e0b"),
  )
}

;(window as any).__perf = {
  start() {
    if (monitor.isRunning) {
      console.log("%c⚠️ PerfMonitor already running. Call __perf.stop() first or __perf.report() to get results.", "color:#f59e0b")
      return
    }
    monitor.start()
  },
  stop() {
    if (!monitor.isRunning) return
    const report = monitor.report()
    copyReport(report)
    console.log(`%c📊 Perf Report (${report.duration})`, "font-weight:bold;font-size:14px;color:#22c55e")
    console.table({
      "Avg FPS": report.fps.avg,
      "Min FPS": report.fps.min,
      "Long Tasks": `${report.longTasks.count} (total ${report.longTasks.totalMs}ms, longest ${report.longTasks.longestMs}ms)`,
      "Avg Input Delay": `${report.inputDelay.avg}ms`,
      "Max Input Delay": `${report.inputDelay.max}ms`,
      "JS Heap Growth": report.jsHeapGrowth,
      "Layout Shifts": report.layoutThrashing.count,
    })
  },
  report() {
    if (!monitor.isRunning) {
      console.log("%c⚠️ PerfMonitor not running. Call __perf.start() first.", "color:#f59e0b")
      return
    }
    const report = monitor.report()
    copyReport(report)
    console.log(`%c📊 Perf Report (${report.duration})`, "font-weight:bold;font-size:14px;color:#22c55e")
    console.table({
      "Avg FPS": report.fps.avg,
      "Min FPS": report.fps.min,
      "Long Tasks": `${report.longTasks.count} (total ${report.longTasks.totalMs}ms, longest ${report.longTasks.longestMs}ms)`,
      "Avg Input Delay": `${report.inputDelay.avg}ms`,
      "Max Input Delay": `${report.inputDelay.max}ms`,
      "JS Heap Growth": report.jsHeapGrowth,
      "Layout Shifts": report.layoutThrashing.count,
    })
  },
  status() {
    console.log(
      monitor.isRunning
        ? "%c🟢 PerfMonitor is running. Call __perf.report() to get results."
        : "%c🔴 PerfMonitor is stopped. Call __perf.start() to begin monitoring.",
      "font-weight:bold",
    )
  },
  get raw() {
    return monitor.isRunning ? monitor.report() : null
  },
}

console.log(
  "%c📊 PerfMonitor loaded. Use __perf.start() to begin, __perf.report() to get results.",
  "color:#6366f1;font-weight:bold",
)
