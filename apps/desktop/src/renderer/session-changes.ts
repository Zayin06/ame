import type { DesktopApi, SessionDiff } from '../../../../packages/protocol/src/index'

export type SessionChangesState = { status: 'loading' | 'ready' | 'error'; files: SessionDiff[]; error?: string }

export function watchSessionChanges(api: Pick<DesktopApi, 'sessionDiff' | 'onEvent'>, projectID: string, sessionID: string, publish: (state: SessionChangesState) => void) {
  let disposed = false, running = false, queued = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const load = async () => {
    if (disposed) return
    timer = undefined
    if (running) { queued = true; return }
    running = true
    try {
      const files = await api.sessionDiff(projectID, sessionID)
      if (!disposed) publish({ status: 'ready', files })
    } catch (error) {
      if (!disposed) publish({ status: 'error', files: [], error: error instanceof Error ? error.message : String(error) })
    } finally {
      running = false
      if (queued && !disposed) { queued = false; timer = setTimeout(() => void load(), 180) }
    }
  }
  const unsubscribe = api.onEvent(event => {
    if (event.type !== 'opencode' || event.projectID !== projectID || (event.sessionID && event.sessionID !== sessionID)) return
    if (running) { queued = true; return }
    if (!timer) timer = setTimeout(() => { timer = undefined; void load() }, 180)
  })
  publish({ status: 'loading', files: [] })
  void load()
  return () => { disposed = true; clearTimeout(timer); unsubscribe() }
}
