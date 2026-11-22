import { OpenCode, type OpenCodeClient, type OpenCodeEvent, type SessionMessageInfo } from '@opencode/client'
import { Service } from '@opencode/client/service'
import path from 'node:path'
import type { Agent, ChatItem, Connection, IdeEvent, Model, Session, SessionDiff } from '../../protocol/src/index'

export function localURL(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('LOCAL_SERVER_REQUIRED: Remote projects are not supported in this slice.')
  return url.origin
}
export function normalizeMessages(messages: SessionMessageInfo[]): ChatItem[] {
  let execution: { opener: string; files: Set<string> } | undefined
  return messages.flatMap<ChatItem>(message => {
    if (message.type === 'user') {
      execution ??= { opener: message.id, files: new Set() }
      return [{ id: message.id, role: 'user', text: message.text }]
    }
    if (message.type === 'idle') {
      const turn = execution
      execution = undefined
      return turn?.files.size ? [{ id: `${message.id}:changes`, role: 'assistant', kind: 'changes', text: '', turn: { from: turn.opener, files: [...turn.files].sort() } }] : []
    }
    if (message.type !== 'assistant') return []
    message.snapshot?.files?.forEach(file => execution?.files.add(file))
    return message.content.map((part, i) => ({ id: `${message.id}:${i}`, role: 'assistant', kind: part.type, text: part.type === 'tool' ? `${part.name} · ${part.state.status}` : part.text }))
  })
}
export class OpenCodeAdapter {
  private client?: OpenCodeClient
  private state: Connection = { connected: false, url: '', error: 'Chưa kết nối OpenCode local service.' }
  private credentials?: { url: string; headers: Record<string, string> }
  private stream?: AbortController
  private projects = new Map<string, string>()
  private live = new Map<string, Map<string, ChatItem>>()
  constructor(private notify: (event: IdeEvent) => void, private fetcher: typeof fetch = fetch) {}
  connection() { return { ...this.state } }
  disconnected(error: string) {
    this.dispose()
    this.state = { connected: false, url: '', error }
    this.notify({ type: 'connection', connection: this.connection() })
    return this.connection()
  }
  endpoint() { return this.state.connected ? this.credentials : undefined }
  async discover() {
    const endpoint = await Service.discover({ version: '2.3.2' })
    if (!endpoint) throw new Error('SERVICE_NOT_FOUND: Start upstream OpenCode 2.3.2 or enter its local URL.')
    return this.connect(endpoint.url, endpoint.auth?.username, endpoint.auth?.password)
  }
  async connect(value: string, username?: string, password?: string) {
    const url = localURL(value)
    const headers: Record<string, string> = password ? { authorization: `Basic ${Buffer.from(`${username || 'opencode'}:${password}`).toString('base64')}` } : {}
    const client = OpenCode.make({ baseUrl: url, headers, fetch: this.fetcher })
    const info = await client.server.info({ signal: AbortSignal.timeout(8000) })
    if (info.version !== '2.3.2') throw new Error('UNSUPPORTED_SERVER_VERSION: Requires OpenCode 2.3.2')
    this.stream?.abort(); this.live.clear()
    this.client = client; this.credentials = { url, headers }
    this.state = { connected: true, url, version: info.version }
    this.notify({ type: 'connection', connection: this.connection() })
    const controller = new AbortController(); this.stream = controller
    void this.events(client, controller.signal)
    return this.connection()
  }
  private api() { if (!this.client || !this.state.connected) throw new Error('OPENCODE_DISCONNECTED'); return this.client }
  attach(projectID: string, directory: string) { this.projects.set(projectID, directory) }
  private directory(projectID: string) { const value = this.projects.get(projectID); if (!value) throw new Error('UNKNOWN_PROJECT'); return value }
  private async owned(projectID: string, sessionID: string) {
    const session = await this.api().session.get({ sessionID })
    if (path.resolve(session.location.directory) !== path.resolve(this.directory(projectID))) throw new Error('SESSION_PROJECT_MISMATCH')
    return session
  }
  async sessions(projectID: string): Promise<Session[]> {
    const sessions = new Map<string, Session>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const list = await this.api().session.list({ directory: this.directory(projectID), archived: false, limit: 100, cursor })
      for (const s of list.data) sessions.set(s.id, {
        id: s.id, title: s.title || 'Untitled', updatedAt: s.time?.updated, parentID: s.parentID, agent: s.agent,
        status: s.time ? s.time.busy !== undefined && (s.time.idle === undefined || s.time.busy > s.time.idle) ? 'running' : 'idle' : undefined,
        outcome: s.outcome,
      })
      cursor = list.cursor.next ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error('SESSION_CURSOR_REPEATED')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return [...sessions.values()]
  }
  async createSession(projectID: string): Promise<Session> {
    const s = await this.api().session.create({ location: { directory: this.directory(projectID) } })
    return { id: s.id, title: s.title || 'New conversation', updatedAt: s.time.updated }
  }
  async messages(projectID: string, sessionID: string): Promise<ChatItem[]> {
    await this.owned(projectID, sessionID)
    const list = await this.api().message.list({ sessionID, limit: 200, order: 'desc' })
    const items = normalizeMessages([...list.data].reverse())
    const live = this.live.get(sessionID)
    if (live) for (const [key, item] of live) {
      const index = items.findIndex(i => i.id === key)
      if (index >= 0) { if (item.text.length >= items[index].text.length) items[index] = item } else items.push(item)
    }
    return items
  }
  async sessionDiff(projectID: string, sessionID: string, from?: string): Promise<SessionDiff[]> {
    await this.owned(projectID, sessionID)
    const options = { signal: AbortSignal.timeout(15000) }
    if (from) return this.api().session.diff({ sessionID, from }, options)
    // An unbounded session.diff means the latest turn, not the whole session.
    const [first, last] = await Promise.all([
      this.api().message.list({ sessionID, type: 'user', order: 'asc', limit: 1 }, options),
      this.api().message.list({ sessionID, type: 'user', order: 'desc', limit: 1 }, options),
    ])
    if (!first.data[0] || !last.data[0]) return []
    return this.api().session.diff({ sessionID, from: first.data[0].id, to: last.data[0].id }, options)
  }
  async models(projectID: string): Promise<Model[]> {
    const list = await this.api().model.list({ location: { directory: this.directory(projectID) }, types: ['chat'] })
    return list.data.map(m => ({ id: m.id, modelID: m.modelID, name: m.name, providerID: m.providerID }))
  }
  async agents(projectID: string): Promise<Agent[]> {
    const list = await this.api().agent.list({ location: { directory: this.directory(projectID) } })
    return list.data.filter(a => !a.hidden && a.mode !== 'subagent').map(a => ({ id: a.id, name: a.name }))
  }
  async prompt(projectID: string, sessionID: string, text: string, model?: Model, agent?: string) {
    await this.owned(projectID, sessionID)
    if (!text.trim() || text.length > 200000) throw new Error('INVALID_PROMPT')
    if (!model) throw new Error('SELECT_MODEL_REQUIRED')
    await this.api().session.switchModel({ sessionID, model: { id: model.id, providerID: model.providerID } })
    if (agent) await this.api().session.switchAgent({ sessionID, agent })
    await this.api().session.prompt({ sessionID, text })
  }
  async cancel(projectID: string, sessionID: string) { await this.owned(projectID, sessionID); await this.api().session.interrupt({ sessionID }) }
  async permissions(projectID: string, sessionID: string) {
    await this.owned(projectID, sessionID)
    return (await this.api().permission.list({ sessionID })).map(p => ({ id: p.id, sessionID: p.sessionID, title: `${p.action}: ${p.resources.join(', ')}${p.message ? '\n' + p.message : ''}` }))
  }
  async replyPermission(projectID: string, permissionID: string, decision: 'once' | 'always' | 'reject') {
    for (const session of await this.sessions(projectID)) {
      const permissions = await this.api().permission.list({ sessionID: session.id })
      if (permissions.some(p => p.id === permissionID)) { await this.api().permission.reply({ sessionID: session.id, requestID: permissionID, decision }); return }
    }
    throw new Error('PERMISSION_NOT_FOUND')
  }
  private async events(client: OpenCodeClient, signal: AbortSignal) {
    let attempt = 0
    while (!signal.aborted) {
      try {
        for await (const event of client.event.subscribe({ signal })) {
          if (signal.aborted) break
          if (event.type === 'server.connected') {
            // SSE has no replay. Drop deltas and force history reads on every reconnect.
            attempt = 0; this.live.clear()
            this.state = { ...this.state, connected: true, error: undefined }
            this.notify({ type: 'connection', connection: this.connection() })
            for (const projectID of this.projects.keys()) this.notify({ type: 'opencode', projectID })
            continue
          }
          this.accept(event)
        }
      } catch { /* A new live-only subscription below must resync API history. */ }
      if (signal.aborted) break
      this.state = { ...this.state, connected: false, error: 'Mất kết nối stream; đang kết nối lại…' }
      this.notify({ type: 'connection', connection: this.connection() })
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, Math.min(1000 * 2 ** attempt++, 15000))
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
  private accept(event: OpenCodeEvent) {
    if (event.type === 'session.text.delta' || event.type === 'session.reasoning.delta' || event.type === 'session.text.ended' || event.type === 'session.reasoning.ended') {
      const { sessionID, assistantMessageID, ordinal } = event.data
      let live = this.live.get(sessionID)
      if (!live) { live = new Map(); this.live.set(sessionID, live) }
      const key = `${assistantMessageID}:${ordinal}`
      const old = live.get(key)
      const text = 'delta' in event.data ? (old?.text ?? '') + event.data.delta : event.data.text
      live.set(key, { id: key, role: 'assistant', kind: event.type.includes('reasoning') ? 'reasoning' : 'text', text })
      if (live.size > 1000) live.delete(live.keys().next().value!)
    }
    const sessionID = 'data' in event && event.data && typeof event.data === 'object' && 'sessionID' in event.data ? String(event.data.sessionID) : undefined
    const directory = 'location' in event ? event.location?.directory : undefined
    for (const [projectID, root] of this.projects) {
      if (!directory || path.resolve(directory) === path.resolve(root)) this.notify({ type: 'opencode', projectID, sessionID })
    }
  }
  dispose() { this.stream?.abort(); this.client = undefined; this.credentials = undefined; this.live.clear() }
}
