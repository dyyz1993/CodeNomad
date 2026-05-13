type BatchFn<T> = (items: T[]) => void

export function createBatchProcessor<T>(fn: BatchFn<T>, options?: { maxSize?: number; maxPending?: number }) {
  const maxSize = options?.maxSize ?? 100
  const maxPending = options?.maxPending ?? 500
  let pending: T[] = []
  let scheduled = false

  function flush() {
    scheduled = false
    if (pending.length === 0) return
    const batch = pending.splice(0, maxSize)
    fn(batch)
  }

  function push(item: T) {
    if (pending.length >= maxPending) {
      pending.splice(0, pending.length - maxPending + 1)
    }
    pending.push(item)
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }

  return { push, flush }
}
