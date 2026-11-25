/** Fixed-deadline refreshes: events never postpone a scheduled read. */
export function createChatRefresh(load: () => Promise<void>, delay = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading = false, dirty = false, disposed = false
  const run = async () => {
    timer = undefined
    if (disposed || loading) return
    dirty = false
    loading = true
    try { await load() }
    finally {
      loading = false
      // Every event during a read is covered by one immediate follow-up read.
      if (!disposed && dirty) void run()
    }
  }
  return {
    request(immediate = false) {
      if (disposed) return
      dirty = true
      if (loading) return
      if (immediate) { clearTimeout(timer); void run() }
      else if (timer === undefined) timer = setTimeout(() => void run(), delay)
    },
    dispose() { disposed = true; dirty = false; clearTimeout(timer) },
  }
}
