import { OpenCode, type ArtifactInfo, type OpenCodeClient, type OpenCodeEvent, type SessionInfo, type SessionMessageInfo } from '@opencode/client'
import { Service } from '@opencode/client/service'
import { permissionRules, permissionModeFromSession } from './permission-mode'
import { sessionFormAnswerSchema, sessionFormKeySchema, type SessionForm, type SessionFormAnswer } from '../../protocol/src/session-form'
import { permissionModeSchema, type PermissionMode } from '../../protocol/src/permission-mode'
import path from 'node:path'
import { summarizeUsage, usageFamily, type UsageNode } from '../../amekit/src/usage'
import type { UsagePrices } from '../../amekit/src/usage-pricing'
import type { Agent, AgentMapView, ArtifactDetail, ArtifactSummary, ChatItem, Connection, IdeEvent, Model, Session, SessionDiff, SkillSummary, SlashCommand, ToolCallInfo } from '../../protocol/src/index'
import { buildAgentMap, resolveAgentMapFamily } from './agent-map'
import { SessionActivity } from './session-activity'
import { MAX_PROMPT_FILES, type ChatAttachment, type PromptFileAttachment } from '../../ide-core/src/dropped-attachments'
import type { BuildNotesSummary } from '../../ide-core/src/git-ops'

export function localURL(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('LOCAL_SERVER_REQUIRED: Remote projects are not supported in this slice.')
  return url.origin
}
function normalizeToolDiffPath(rawPath: string, projectRoot: string): string {
  if (!rawPath) return rawPath
  let file = rawPath
  if (path.isAbsolute(rawPath)) {
    const relative = path.relative(projectRoot, rawPath)
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) file = relative
  }
  return file.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}
function extractToolDiffs(message: SessionMessageInfo, projectRoot: string): SessionDiff[] {
  if (message.type !== 'assistant') return []
  return message.content.flatMap<SessionDiff>(part => {
    if (part.type !== 'tool' || part.state.status !== 'completed' || !('metadata' in part.state)) return []
    const files = part.state.metadata?.files
    if (!Array.isArray(files)) return []
    return files.flatMap<SessionDiff>(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.file !== 'string' || !entry.file.trim() || typeof entry.patch !== 'string') return []
      return [{
        file: normalizeToolDiffPath(entry.file, projectRoot), patch: entry.patch,
        additions: typeof entry.additions === 'number' && Number.isFinite(entry.additions) && entry.additions >= 0 ? entry.additions : 0,
        deletions: typeof entry.deletions === 'number' && Number.isFinite(entry.deletions) && entry.deletions >= 0 ? entry.deletions : 0,
        status: entry.status === 'added' || entry.status === 'deleted' ? entry.status : 'modified',
      }]
    })
  })
}
export function normalizeMessages(messages: SessionMessageInfo[]): ChatItem[] {
  let execution: { opener: string; files: Set<string>; startedAt?: number; lastAssistant?: ChatItem } | undefined
  return messages.flatMap<ChatItem>(message => {
    if (message.type === 'user') {
      execution ??= { opener: message.id, files: new Set(), startedAt: message.time?.created }
      const attachments: ChatAttachment[] = 'files' in message && Array.isArray(message.files) && message.files.length
        ? message.files.map(file => {
          const mime = typeof file.mime === 'string' ? file.mime : 'application/octet-stream'
          const attachment: ChatAttachment = { name: file.name || 'attachment', mime }
          if (typeof file.data === 'string' && file.data.trim()) {
            const base64 = file.data.replace(/\s+/g, '')
            attachment.dataUrl = `data:${mime};base64,${base64}`
          } else if ('uri' in file && typeof file.uri === 'string') {
            attachment.uri = file.uri
            if ('bytes' in file && typeof file.bytes === 'number') attachment.size = file.bytes
          }
          return attachment
        }) : []
      return [{ id: message.id, role: 'user', text: message.text, ...(attachments.length ? { attachments } : {}), ...(message.time?.created !== undefined ? { createdAt: message.time.created } : {}) }]
    }
    if (message.type === 'idle') {
      if (execution?.lastAssistant && execution.startedAt !== undefined && message.time?.created !== undefined && message.time.created >= execution.startedAt) {
        execution.lastAssistant.workedMs = message.time.created - execution.startedAt
      }
      const turn = execution
      execution = undefined
      return turn?.files.size ? [{ id: `${message.id}:changes`, role: 'assistant', kind: 'changes', text: '', turn: { from: turn.opener, files: [...turn.files].sort() } }] : []
    }
    if (message.type !== 'assistant') return []
    message.snapshot?.files?.forEach(file => execution?.files.add(file))
    for (const part of message.content) {
      if (part.type !== 'tool' || part.state.status !== 'completed' || !('metadata' in part.state)) continue
      const files = part.state.metadata?.files
      if (!Array.isArray(files)) continue
      for (const entry of files) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.file === 'string' && entry.file.trim()) execution?.files.add(entry.file.replace(/\\/g, '/'))
      }
    }
    const items = message.content.map((part, i): ChatItem => {
      const id = `${message.id}:${i}`
      const time = {
        ...(message.time?.created !== undefined ? { createdAt: message.time.created } : {}),
        ...(message.time?.completed !== undefined ? { completedAt: message.time.completed } : {}),
      }
      if (part.type !== 'tool') return {
        id, role: 'assistant', kind: part.type, text: part.text, ...time,
        ...(part.type === 'text' && (part.native?.phase === 'commentary' || part.native?.phase === 'final_answer') ? { phase: part.native.phase } : {}),
      }
      let output: string | undefined
      if ('content' in part.state) for (const content of part.state.content ?? []) {
        const text = content.type === 'text' ? content.text : content.type === 'file' ? `[file: ${content.name || content.uri}]` : undefined
        if (text === undefined) continue
        output = (output === undefined ? '' : output + '\n') + text.slice(0, 65537 - (output === undefined ? 0 : output.length + 1))
        if (output.length > 65536) break
      }
      if (output && output.length > 65536) {
        const suffix = '\n…[truncated]'
        output = output.slice(0, 65536 - suffix.length)
        // Do not leave half of a UTF-16 surrogate pair at the truncation boundary.
        if (/[\uD800-\uDBFF]$/.test(output)) output = output.slice(0, -1)
        output += suffix
      }
      const error = part.state.status === 'error' ? part.state.error : undefined
      const tool: ToolCallInfo = {
        name: part.name, status: part.state.status, input: part.state.input, output: output || undefined,
        error: error === undefined ? undefined : typeof error === 'string' ? error : error.message || JSON.stringify(error),
        durationMs: part.time?.completed === undefined ? undefined : Math.max(0, part.time.completed - (part.time.ran ?? part.time.created)),
      }
      return { id, role: 'assistant', kind: 'tool', text: `${part.name} · ${part.state.status}`, tool, ...time }
    })
    if (execution && items.length) execution.lastAssistant = items[items.length - 1]
    return items
  })
}
function mapSession(s: SessionInfo): Session {
  return {
    id: s.id, title: s.title || 'Untitled', updatedAt: s.time?.updated, parentID: s.parentID, agent: s.agent,
    status: s.time ? s.time.busy !== undefined && (s.time.idle === undefined || s.time.busy > s.time.idle) ? 'running' : 'idle' : undefined,
    busyAt: s.time?.busy, idleAt: s.time?.idle,
    outcome: s.outcome, ...(s.permissions !== undefined ? { permissionMode: permissionModeFromSession(s) } : {}),
  }
}
function mapArtifact(info: ArtifactInfo): ArtifactSummary {
  return {
    id: info.id, provider: info.provider, sessionID: info.sessionID, title: info.title, entry: info.entry, url: info.url,
    createdAt: info.time.created, updatedAt: info.time.updated,
  }
}
function artifactID(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('INVALID_ARTIFACT_ID')
  return value.trim()
}
export class OpenCodeAdapter {
  private client?: OpenCodeClient
  private state: Connection = { connected: false, url: '', error: 'Chưa kết nối OpenCode local service.' }
  private credentials?: { url: string; headers: Record<string, string> }
  private stream?: AbortController
  private projects = new Map<string, string>()
  private live = new Map<string, Map<string, ChatItem>>()
  private activity = new SessionActivity()
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
    this.stream?.abort(); this.live.clear(); this.activity.clear()
    this.client = client; this.credentials = { url, headers }
    this.state = { connected: true, url, version: info.version }
    this.notify({ type: 'connection', connection: this.connection() })
    const controller = new AbortController(); this.stream = controller
    void this.events(client, controller.signal)
    return this.connection()
  }
  async reload(options?: { maxAttempts?: number; pollMs?: number }): Promise<void> {
    if (!this.client || !this.state.connected || !this.credentials) return
    const maxAttempts = options?.maxAttempts ?? 100
    const pollMs = options?.pollMs ?? 150
    const client = this.api(), { url, headers } = this.credentials
    await client.location.reload()
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.client !== client || !this.state.connected) return
      try {
        const plugins = await client.plugin.list(undefined, { signal: AbortSignal.timeout(5000) })
        if (!Array.isArray(plugins?.data)) throw new Error('INVALID_PLUGIN_INVENTORY')
        const plugin = plugins.data.find(plugin => plugin.id === 'amekit-models')
        if (plugins.data.length > 0 && !plugin) break
        if (plugin?.state?.status === 'active') {
          const response = await this.fetcher(new URL('/api/rpc/amekit-models/status', url), {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ input: null }), redirect: 'error', signal: AbortSignal.timeout(5000),
          })
          await response.body?.cancel()
          if (response.status === 200) break
        }
      } catch { /* Plugin setup and RPC registration can briefly be unavailable after reload. */ }
      if (attempt < maxAttempts - 1) await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    if (this.client === client && this.state.connected) this.notify({ type: 'catalog' })
  }
  private api() { if (!this.client || !this.state.connected) throw new Error('OPENCODE_DISCONNECTED'); return this.client }
  attach(projectID: string, directory: string) { this.projects.set(projectID, directory) }
  detach(projectID: string) { this.projects.delete(projectID) }
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
      for (const s of list.data) sessions.set(s.id, mapSession(s))
      cursor = list.cursor.next ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error('SESSION_CURSOR_REPEATED')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    // Recover pending prompts and active tools after attaching/reconnecting (SSE has no replay).
    const recover = [...sessions.values()].filter(s => s.status === 'running' && !this.activity.has(s.id))
    let next = 0
    await Promise.all(Array.from({ length: Math.min(6, recover.length) }, async () => {
      while (next < recover.length) {
        const s = recover[next++]
        const options = { signal: AbortSignal.timeout(8000) }
        const [permissions, forms, messages] = await Promise.allSettled([
          this.api().permission.list({ sessionID: s.id }, options), this.api().session.form.list({ sessionID: s.id }, options),
          this.api().message.list({ sessionID: s.id, limit: 1, order: 'desc', type: 'assistant' }, options),
        ])
        // Do not overwrite SSE that arrived while the snapshot requests were in flight.
        if (this.activity.has(s.id)) continue
        if (permissions.status === 'fulfilled') this.activity.pending(s.id, 'permissions', permissions.value.map(p => p.id))
        if (forms.status === 'fulfilled') this.activity.pending(s.id, 'forms', forms.value.filter(f => f.sessionID === s.id).map(f => f.id))
        if (messages.status === 'fulfilled') {
          const message = messages.value.data[0]
          const parts = message?.type === 'assistant' && message.time?.completed === undefined ? message.content : []
          this.activity.snapshot(s.id, parts.flatMap(p => p.type === 'tool' && p.state.status === 'running' ? [`${message.id}:${p.id}`] : []), parts.at(-1)?.type === 'text' ? 'working' : 'thinking')
        }
      }
    }))
    return [...sessions.values()].map(s => this.activity.map(s))
  }
  async createSession(projectID: string, mode: PermissionMode = 'default'): Promise<Session> {
    const permissions = permissionRules(mode)
    const s = await this.api().session.create({ location: { directory: this.directory(projectID) }, permissions })
    return mapSession(s)
  }
  async sessionPermissionMode(projectID: string, sessionID: string): Promise<PermissionMode> {
    return permissionModeFromSession(await this.owned(projectID, sessionID))
  }
  async updateSessionPermissionMode(projectID: string, sessionID: string, mode: PermissionMode): Promise<PermissionMode> {
    const parsed = permissionModeSchema.parse(mode)
    await this.owned(projectID, sessionID)
    await this.api().session.update({ sessionID, permissions: permissionRules(parsed) })
    const result = await this.sessionPermissionMode(projectID, sessionID)
    this.notify({ type: 'opencode', projectID, sessionID })
    return result
  }
  async forkSession(projectID: string, sessionID: string): Promise<Session> {
    await this.owned(projectID, sessionID)
    return mapSession(await this.api().session.fork({ sessionID }))
  }
  async btwAsk(projectID: string, sessionID: string, question: string, model?: Model): Promise<{ answer: string }> {
    await this.owned(projectID, sessionID)
    const trimmed = question.trim()
    if (!trimmed || trimmed.length > 20000) throw new Error('INVALID_PROMPT')
    if (model) await this.api().session.switchModel({ sessionID, model: { id: model.id, providerID: model.providerID } })
    const result = await this.api().session.generate({ sessionID, prompt: trimmed }, { signal: AbortSignal.timeout(45_000) })
    if (result.text.trim()) return { answer: result.text.trim() }
    const retry = await this.api().session.generate({ sessionID, prompt: `Answer directly in plain text using only the existing conversation context. Do not call any tools; if the information is not present in the conversation, briefly say so.\n\n${trimmed}` }, { signal: AbortSignal.timeout(45_000) })
    return { answer: retry.text.trim() }
  }
  async artifacts(projectID: string, sessionID?: string): Promise<ArtifactSummary[]> {
    const directory = this.directory(projectID)
    if (sessionID !== undefined) await this.owned(projectID, sessionID)
    const list = await this.api().experimental.artifacts.list({ location: { directory }, sessionID })
    return list.data.map(mapArtifact)
  }
  async artifact(projectID: string, id: string): Promise<ArtifactDetail> {
    const directory = this.directory(projectID)
    const result = await this.api().experimental.artifacts.get({ artifactID: artifactID(id), location: { directory } })
    return { info: mapArtifact(result.data.info), files: result.data.files }
  }
  async deleteArtifact(projectID: string, id: string): Promise<void> {
    const directory = this.directory(projectID)
    await this.api().experimental.artifacts.delete({ artifactID: artifactID(id), location: { directory } })
  }
  async renameSession(projectID: string, sessionID: string, title: string): Promise<void> {
    await this.owned(projectID, sessionID)
    const trimmed = title.trim()
    if (!trimmed || trimmed.length > 500) throw new Error('INVALID_SESSION_TITLE')
    await this.api().session.update({ sessionID, title: trimmed })
  }
  async archiveSession(projectID: string, sessionID: string, archived: boolean): Promise<void> {
    await this.owned(projectID, sessionID)
    await this.api().session.update({ sessionID, archived })
  }
  async deleteSession(projectID: string, sessionID: string): Promise<void> {
    await this.owned(projectID, sessionID)
    await this.api().session.remove({ sessionID })
    this.live.delete(sessionID)
    this.activity.delete(sessionID)
  }
  async commands(projectID: string): Promise<SlashCommand[]> {
    const list = await this.api().command.list({ location: { directory: this.directory(projectID) } })
    return list.data.map(({ name, description }) => ({ name, description }))
  }
  async skills(projectID: string): Promise<SkillSummary[]> {
    const list = await this.api().skill.list({ location: { directory: this.directory(projectID) } })
    return list.data.map(({ id, name, description, path }) => ({ id, name, description, path }))
  }
  async generateCommitMessage(summary: { diff: string; files: string[]; truncated: boolean }, model: Model, skill?: { name: string; instructions: string }): Promise<{ message: string; truncated: boolean }> {
    const prompt = skill?.instructions ? [
      'Write a commit message for the staged changes using the following skill.',
      `Skill: /${skill.name}\n\n${skill.instructions}`,
      `Files:\n${summary.files.join('\n')}`,
      `Diff:\n${summary.diff}`,
      'Return only the commit message text: no markdown fences, no tool calls or git commands, and no conversational preamble.',
    ].join('\n\n') : [
      'Write a concise Conventional Commits message for the staged changes below.',
      'Use a subject of at most 72 characters and at most 3 short bullets if there are multiple changes.',
      'Return only the commit message, without markdown fences or extra explanation.',
      `Files:\n${summary.files.join('\n')}`,
      `Diff:\n${summary.diff}`,
    ].join('\n\n')
    const result = await this.api().experimental.generate.text({ prompt, model: { id: model.id, providerID: model.providerID } }, { signal: AbortSignal.timeout(30_000) })
    const message = result.text.trim().replace(/^```[^\r\n]*\r?\n([\s\S]*?)```$/, '$1').trim()
    if (!message) throw new Error('EMPTY_COMMIT_MESSAGE')
    return { message, truncated: summary.truncated }
  }
  async generateBuildNotes(summary: BuildNotesSummary, model: Model, skill?: { name: string; instructions: string }, note?: string): Promise<{ notes: string; truncated: boolean }> {
    const prompt = [
      skill?.instructions
        ? `Write QC build notes / release notes using the following skill.\n\nSkill: /${skill.name}\n\n${skill.instructions}`
        : 'Viết ghi chú bản build bằng tiếng Việt cho QC dưới dạng Markdown rõ ràng với các mục: ## Tổng quan bản build, ## Tính năng mới / Cải tiến, ## Sửa lỗi, ## Khu vực QC cần kiểm tra kỹ & Lưu ý.',
      'Phản ánh chính xác cả thay đổi đã commit và thay đổi cục bộ chưa commit; phân biệt hai nguồn này. Chỉ mô tả những gì có bằng chứng trong ngữ cảnh, không bịa tính năng hoặc khẳng định đã kiểm thử khi chưa có bằng chứng. Diff có thể đã được lọc hoặc rút gọn.',
      `Branch: ${summary.branch}`,
      `Commits:\n${summary.commits.map(commit => `${commit.shortHash} ${commit.subject}${commit.body ? `\n${commit.body}` : ''}`).join('\n\n') || '(none)'}`,
      `Files (source status path +additions -deletions):\n${summary.files.map(file => `${file.source} ${file.status} ${file.path} +${file.additions} -${file.deletions}`).join('\n') || '(none)'}`,
      `Working files: ${summary.workingFileCount}; additions: ${summary.additions}; deletions: ${summary.deletions}; truncated: ${summary.truncated}`,
      `Diff:\n${summary.diff}`,
      ...(note?.trim() ? [`Developer note:\n${note.trim()}`] : []),
      'Return only the Markdown build notes without conversational preamble or outer triple-backtick wrapping.',
    ].join('\n\n')
    const result = await this.api().experimental.generate.text({ prompt, model: { id: model.id, providerID: model.providerID } }, { signal: AbortSignal.timeout(90_000) })
    const notes = result.text.trim().replace(/^```[^\r\n]*\r?\n([\s\S]*?)```$/, '$1').trim()
    if (!notes) throw new Error('EMPTY_BUILD_NOTES')
    return { notes, truncated: summary.truncated }
  }
  async messages(projectID: string, sessionID: string): Promise<ChatItem[]> {
    await this.owned(projectID, sessionID)
    const list = await this.api().message.list({ sessionID, limit: 200, order: 'desc' })
    const items = normalizeMessages([...list.data].reverse())
    const live = this.live.get(sessionID)
    if (live) for (const [key, item] of live) {
      const index = items.findIndex(i => i.id === key)
      if (index >= 0) {
        const history = items[index]
        // Completed history is authoritative, even if a stale delta is longer.
        if (history.completedAt !== undefined) live.delete(key)
        else if (!history.tool && item.text.length > history.text.length) items[index] = { ...history, text: item.text }
      } else items.push(item)
    }
    if (live?.size === 0) this.live.delete(sessionID)
    return items
  }
  async sessionUsage(projectID: string, sessionID: string, prices: UsagePrices, origin: string | null): Promise<{ origin: string | null; nodes: UsageNode[]; limited: boolean }> {
    await this.owned(projectID, sessionID)
    const sessions = new Map<string, SessionInfo>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const list = await this.api().session.list({ directory: this.directory(projectID), archived: false, limit: 100, cursor })
      for (const session of list.data) sessions.set(session.id, session)
      cursor = list.cursor.next ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error('SESSION_CURSOR_REPEATED')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const family = usageFamily([...sessions.values()], sessionID)
    const limited = family.length > 200
    const selected = family.slice(0, 200)
    const nodes: UsageNode[] = new Array(selected.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(6, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++, node = selected[index]
        const list = await this.api().message.list({ sessionID: node.id, limit: 200, order: 'desc' }, { signal: AbortSignal.timeout(15_000) })
        nodes[index] = summarizeUsage({ id: node.id, depth: node.depth, info: node.info, messages: [...list.data].reverse(), prices, historyComplete: !list.cursor.next })
      }
    }))
    return { origin, nodes, limited }
  }
  async agentMap(projectID: string, sessionID: string): Promise<AgentMapView> {
    await this.owned(projectID, sessionID)
    const sessions = new Map<string, SessionInfo>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const list = await this.api().session.list({ directory: this.directory(projectID), archived: false, limit: 100, cursor })
      for (const session of list.data) sessions.set(session.id, session)
      cursor = list.cursor.next ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error('SESSION_CURSOR_REPEATED')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const family = resolveAgentMapFamily([...sessions.values()], sessionID, 200)
    const messagesBySession = new Map<string, SessionMessageInfo[]>()
    const historyCompleteBySession = new Map<string, boolean>()
    let next = 0
    await Promise.all(Array.from({ length: Math.min(6, family.entries.length) }, async () => {
      while (next < family.entries.length) {
        const entry = family.entries[next++]
        const list = await this.api().message.list({ sessionID: entry.id, limit: 200, order: 'desc' }, { signal: AbortSignal.timeout(15_000) })
        messagesBySession.set(entry.id, [...list.data].reverse())
        historyCompleteBySession.set(entry.id, !list.cursor.next)
      }
    }))
    const liveTextBySession = new Map<string, string>()
    for (const entry of family.entries) {
      const live = this.live.get(entry.id)
      if (live) liveTextBySession.set(entry.id, [...live.values()].filter(item => item.kind === 'text').map(item => item.text).join('\n\n'))
    }
    return buildAgentMap({ family, activeSessionID: sessionID, messagesBySession, historyCompleteBySession, liveTextBySession, now: Date.now() })
  }
  async sessionDiff(projectID: string, sessionID: string, from?: string): Promise<SessionDiff[]> {
    await this.owned(projectID, sessionID)
    const options = { signal: AbortSignal.timeout(15000) }
    let diffs: SessionDiff[]
    if (from) diffs = await this.api().session.diff({ sessionID, from }, options)
    else {
      // An unbounded session.diff means the latest turn, not the whole session.
      const [first, last] = await Promise.all([
        this.api().message.list({ sessionID, type: 'user', order: 'asc', limit: 1 }, options),
        this.api().message.list({ sessionID, type: 'user', order: 'desc', limit: 1 }, options),
      ])
      if (!first.data[0] || !last.data[0]) return []
      diffs = await this.api().session.diff({ sessionID, from: first.data[0].id, to: last.data[0].id }, options)
    }
    if (diffs.length) return diffs
    try {
      const history = await this.api().message.list({ sessionID, order: 'asc', limit: 200 }, options)
      let messages = history.data
      if (from) {
        const start = messages.findIndex(message => message.id === from)
        if (start === -1) return []
        messages = messages.slice(start)
        const end = messages.findIndex(message => message.type === 'idle')
        if (end !== -1) messages = messages.slice(0, end)
      }
      const files = new Map<string, SessionDiff>()
      for (const message of messages) for (const diff of extractToolDiffs(message, this.directory(projectID))) {
        const previous = files.get(diff.file)
        files.set(diff.file, previous ? {
          file: diff.file,
          patch: [previous.patch, diff.patch].filter(Boolean).join('\n'),
          additions: previous.additions + diff.additions,
          deletions: previous.deletions + diff.deletions,
          status: previous.status === 'added' && diff.status === 'modified' ? 'added' : diff.status,
        } : diff)
      }
      return [...files.values()]
    } catch { return [] }
  }
  async models(projectID: string): Promise<Model[]> {
    const list = await this.api().model.list({ location: { directory: this.directory(projectID) }, types: ['chat'] })
    return list.data.map(m => ({ id: m.id, modelID: m.modelID, name: m.name, providerID: m.providerID }))
  }
  async agents(projectID: string): Promise<Agent[]> {
    const list = await this.api().agent.list({ location: { directory: this.directory(projectID) } })
    return list.data.filter(a => !a.hidden && a.mode !== 'subagent').map(a => ({ id: a.id, name: a.name }))
  }
  async prompt(projectID: string, sessionID: string, text: string, model?: Model, agent?: string, files?: PromptFileAttachment[]) {
    await this.owned(projectID, sessionID)
    if (!(text.trim().length > 0 || (Array.isArray(files) && files.length > 0)) || text.length > 200000) throw new Error('INVALID_PROMPT')
    if (!model) throw new Error('SELECT_MODEL_REQUIRED')
    const mappedFiles = (files ?? []).slice(0, MAX_PROMPT_FILES).map(file => ({ uri: file.uri, ...(file.name ? { name: file.name } : {}), ...(file.source ? { source: file.source } : {}) }))
    await this.api().session.switchModel({ sessionID, model: { id: model.id, providerID: model.providerID } })
    if (agent) await this.api().session.switchAgent({ sessionID, agent })
    await this.api().session.prompt({ sessionID, text: text.trim() ? text : '(Đính kèm tệp)', ...(mappedFiles.length ? { files: mappedFiles } : {}) })
  }
  async cancel(projectID: string, sessionID: string) { await this.owned(projectID, sessionID); await this.api().session.interrupt({ sessionID }) }
  async permissions(projectID: string, sessionID: string) {
    await this.owned(projectID, sessionID)
    const permissions = await this.api().permission.list({ sessionID })
    this.activity.pending(sessionID, 'permissions', permissions.map(p => p.id))
    return permissions.map(p => ({ id: p.id, sessionID: p.sessionID, title: `${p.action}: ${p.resources.join(', ')}${p.message ? '\n' + p.message : ''}` }))
  }
  async forms(projectID: string, sessionID: string): Promise<SessionForm[]> {
    await this.owned(projectID, sessionID)
    const forms = (await this.api().session.form.list({ sessionID })).filter(form => form.sessionID === sessionID)
    this.activity.pending(sessionID, 'forms', forms.map(f => f.id))
    return forms.map(form => ({
      id: form.id, sessionID: form.sessionID, title: form.title,
      fields: form.fields.map(field => {
        sessionFormKeySchema.parse(field.key)
        return structuredClone(field)
      }),
    }))
  }
  async replyForm(projectID: string, sessionID: string, formID: string, answer: SessionFormAnswer) {
    await this.owned(projectID, sessionID)
    await this.api().session.form.reply({ sessionID, formID, answer: sessionFormAnswerSchema.parse(answer) })
  }
  async cancelForm(projectID: string, sessionID: string, formID: string, message?: string) {
    await this.owned(projectID, sessionID)
    await this.api().session.form.cancel({ sessionID, formID, ...(message ? { message } : {}) })
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
            attempt = 0; this.live.clear(); this.activity.clear()
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
    this.activity.accept(event)
    if (event.type === 'session.idle' || event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted' || event.type === 'session.status' && event.data.status.type === 'idle') {
      this.live.delete(event.data.sessionID)
    }
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
    if (event.type === 'model.updated' || event.type === 'agent.updated' || event.type === 'command.updated' || event.type === 'skill.updated') {
      const target = 'location' in event ? event.location?.directory : undefined
      let matched = false
      if (target) {
        const resolvedTarget = path.resolve(target).toLowerCase()
        for (const [projectID, root] of this.projects) {
          if (path.resolve(root).toLowerCase() === resolvedTarget) {
            matched = true
            this.notify({ type: 'catalog', projectID })
          }
        }
      }
      if (!matched) this.notify({ type: 'catalog' })
      return
    }
    const sessionID = event.type === 'form.created' ? event.data.form.sessionID : 'data' in event && event.data && typeof event.data === 'object' && 'sessionID' in event.data ? String(event.data.sessionID) : undefined
    const directory = 'location' in event ? event.location?.directory : undefined
    for (const [projectID, root] of this.projects) {
      if (!directory || path.resolve(directory) === path.resolve(root)) this.notify(sessionID === undefined ? { type: 'opencode', projectID } : { type: 'opencode', projectID, sessionID })
    }
  }
  dispose() { this.stream?.abort(); this.client = undefined; this.credentials = undefined; this.live.clear(); this.activity.clear() }
}
