import type { OpenCodeEvent } from '@opencode/client'
import type { Session } from '../../protocol/src/index'

type Activity = {
  busyAt?: number; idleAt?: number; status?: Session['status']; outcome?: Session['outcome']
  phase: 'thinking' | 'working'; tools: Set<string>; permissions: Set<string>; forms: Set<string>
}

/** Live activity is scoped to one connection; timestamps are always upstream timestamps. */
export class SessionActivity {
  private states = new Map<string, Activity>()
  clear() { this.states.clear() }
  delete(id: string) { this.states.delete(id) }
  has(id: string) { return this.states.has(id) }
  private get(id: string) {
    let state = this.states.get(id)
    if (!state) {
      state = { phase: 'thinking', tools: new Set(), permissions: new Set(), forms: new Set() }
      this.states.set(id, state)
    }
    return state
  }
  pending(id: string, kind: 'permissions' | 'forms', ids: string[]) { this.get(id)[kind] = new Set(ids) }
  snapshot(id: string, tools: string[], phase: Activity['phase']) {
    const state = this.get(id)
    state.tools = new Set(tools); state.phase = phase
  }
  map(session: Session): Session {
    const state = this.states.get(session.id)
    if (!state) return { ...session, ...(session.status === 'running' ? { activity: 'thinking' as const } : {}) }
    // A newer persisted execution supersedes state retained from the previous turn.
    if (state.busyAt !== undefined && (session.busyAt ?? -1) > Math.max(state.busyAt, state.idleAt ?? -1)) {
      state.tools.clear(); state.phase = 'thinking'; state.status = undefined; state.outcome = undefined
      state.permissions.clear(); state.forms.clear()
      state.busyAt = session.busyAt
    }
    state.busyAt ??= session.busyAt
    const liveNewer = Math.max(state.busyAt ?? -1, state.idleAt ?? -1) >= Math.max(session.busyAt ?? -1, session.idleAt ?? -1)
    if (!liveNewer && session.status === 'idle') {
      state.tools.clear(); state.permissions.clear(); state.forms.clear()
    }
    const result = { ...session, ...(liveNewer ? {
      status: state.status ?? session.status, outcome: state.status === 'running' ? undefined : state.outcome ?? session.outcome,
      busyAt: state.busyAt ?? session.busyAt, idleAt: state.idleAt ?? session.idleAt,
    } : {}) }
    return { ...result, activity: state.permissions.size || state.forms.size ? 'waiting' : result.status === 'running' ? state.tools.size ? 'working' : state.phase : undefined }
  }
  accept(event: OpenCodeEvent) {
    // permission.created is accepted for compatibility; 2.3.2 calls it permission.asked.
    const e = event as OpenCodeEvent | { type: 'permission.created'; created?: number; data: { sessionID: string; id: string } }
    const id = e.type === 'form.created' ? e.data.form.sessionID : 'data' in e && 'sessionID' in e.data ? String(e.data.sessionID) : undefined
    if (!id) return
    if (e.type === 'session.deleted') { this.delete(id); return }
    const state = this.get(id)
    if (e.type === 'session.execution.started') {
      state.busyAt = e.created; state.status = 'running'; state.outcome = undefined
      state.phase = 'thinking'; state.tools.clear(); state.permissions.clear(); state.forms.clear()
    } else if (e.type === 'session.execution.succeeded' || e.type === 'session.execution.failed' || e.type === 'session.execution.interrupted') {
      state.status = 'idle'; state.idleAt = e.created
      state.outcome = e.type === 'session.execution.succeeded' ? 'succeeded' : e.type === 'session.execution.failed' ? 'failed' : 'interrupted'
      state.tools.clear(); state.permissions.clear(); state.forms.clear()
    } else if (e.type === 'session.idle' || e.type === 'session.status' && e.data.status.type === 'idle') {
      state.status = 'idle'; state.idleAt = e.created; state.tools.clear(); state.permissions.clear(); state.forms.clear()
    } else if (e.type === 'session.status') {
      state.status = 'running'
    } else if (e.type === 'permission.asked' || e.type === 'permission.created') state.permissions.add(e.data.id)
    else if (e.type === 'permission.replied') state.permissions.delete(e.data.requestID)
    else if (e.type === 'form.created') state.forms.add(e.data.form.id)
    else if (e.type === 'form.replied' || e.type === 'form.cancelled') state.forms.delete(e.data.id)
    else if (e.type === 'session.tool.called' || e.type === 'session.tool.progress') state.tools.add(`${e.data.assistantMessageID}:${e.data.id}`)
    else if (e.type === 'session.tool.success' || e.type === 'session.tool.failed') {
      state.tools.delete(`${e.data.assistantMessageID}:${e.data.id}`); state.phase = 'thinking'
    } else if (e.type.startsWith('session.reasoning.') || e.type.startsWith('session.tool.input.') || e.type === 'session.step.started') state.phase = 'thinking'
    else if (e.type.startsWith('session.text.') || e.type === 'session.shell.started') state.phase = 'working'
    else if (e.type === 'session.shell.ended') state.phase = 'thinking'
  }
}
