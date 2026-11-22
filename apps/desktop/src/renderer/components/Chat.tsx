import { useEffect, useRef, useState } from 'react'
import type { Agent, ChatItem, Model, Permission, Session } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'
import { type Preferences, type Tab } from '../state'
import { AgentList } from './AgentList'
import { Empty, errorText, IconButton } from './Primitives'
import { chatSubmit } from '../chat-submit'
import { TurnChanges } from './SessionChanges'
import { ToolCard } from './ToolCard'

export function Chat({ projectID, sessionID, title, connected, onCreate, report, onActivity, onOpenPanel, onOpenFile, sessions, tabs, changes, changesStatus, theme, projectName, branch, onSelectSession, onCreated, ready }: { ready: boolean; onCreated: (session: Session) => void; projectID?: string; sessionID?: string; title?: string; connected: boolean; onCreate: () => void; report: (e: unknown) => void; onActivity: () => void; onOpenPanel: (panel: Preferences['panel']) => void; onOpenFile: (path: string, line?: number) => void; sessions: Session[]; tabs: Tab[]; changes: number; changesStatus: 'loading' | 'ready' | 'error'; theme: 'dark' | 'light'; projectName?: string; branch?: string; onSelectSession: (id: string) => void }) {
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [model, setModel] = useState('')
  const [role, setRole] = useState<string>()
  const [agent, setAgent] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [replying, setReplying] = useState(false)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<'artifacts' | 'agents' | 'btw' | null>(null)
  const [menu, setMenu] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const currentSession = useRef(sessionID); currentSession.current = sessionID
  const createdSession = useRef<string | undefined>(undefined)
  const submit = useRef<ReturnType<typeof chatSubmit> | undefined>(undefined)
  if (!submit.current) submit.current = chatSubmit(window.ame, session => { createdSession.current = session.id; onCreated(session) })
  const drafts = useRef<Record<string, string>>({})
  const previousSession = useRef(sessionID)
  useEffect(() => {
    if (previousSession.current === sessionID) return
    drafts.current[previousSession.current || ''] = text
    if (previousSession.current || sessionID !== createdSession.current) setText(drafts.current[sessionID || ''] || '')
    previousSession.current = sessionID
    setMessages([]); setPermissions([]); setLoaded(false)
  }, [sessionID])
  useEffect(() => {
    const open = (event: Event) => setDrawer((event as CustomEvent).detail || 'artifacts')
    window.addEventListener('ame-chat-drawer', open)
    return () => window.removeEventListener('ame-chat-drawer', open)
  }, [])
  useEffect(() => {
    if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.max(46, Math.min(160, input.current.scrollHeight))}px` }
  }, [text])
  const [loaded, setLoaded] = useState(false)
  const timeline = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const refresh = useRef<() => void>(() => {})
  const running = sessions.some(session => session.id === sessionID && session.status === 'running')
  const runningRef = useRef(running); runningRef.current = running
  const permissionsCountRef = useRef(permissions.length); permissionsCountRef.current = permissions.length
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    let alive = true, generation = 0
    const load = async () => {
      const current = ++generation
      try {
        const status = await window.ame.account('status') as { account?: { role?: string } } | null
        if (alive && current === generation) setRole(status?.account?.role)
      } catch (e) { if (alive && current === generation) { setRole(undefined); setError(errorText(e)) } }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    return () => { alive = false; window.removeEventListener('ame-account-changed', load) }
  }, [connected])
  useEffect(() => {
    if (!projectID || !connected) return
    let alive = true, generation = 0
    const load = async () => {
      const current = ++generation
      try {
        const [m, a] = await Promise.all([window.ame.models(projectID), window.ame.agents(projectID)])
        if (alive && current === generation) {
          const allowed = m.filter(item => item.providerID === 'amecode')
          setModels(allowed)
          setModel(value => allowed.some(item => `${item.providerID}/${item.id}` === value) ? value : allowed[0] ? `${allowed[0].providerID}/${allowed[0].id}` : '')
          setAgents(a)
        }
      } catch (e) { if (alive && current === generation) setError(errorText(e)) }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    return () => { alive = false; window.removeEventListener('ame-account-changed', load) }
  }, [projectID, connected])
  useEffect(() => {
    if (role === 'user' && models[0]) setModel(`${models[0].providerID}/${models[0].id}`)
  }, [role, models])
  const activeModel = role === 'user' ? models[0] : models.find(item => `${item.providerID}/${item.id}` === model)
  useEffect(() => {
    if (!projectID || !sessionID || !connected) return
    let alive = true, loading = false, queued = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      if (!alive) return
      if (loading) { queued = true; return }
      loading = true
      clearTimeout(timer); clearTimeout(fallbackTimer.current)
      try {
        const [items, pending] = await Promise.all([window.ame.messages(projectID, sessionID), window.ame.permissions(projectID, sessionID)])
        if (alive) { permissionsCountRef.current = pending.length; setMessages(old => JSON.stringify(old) === JSON.stringify(items) ? old : items); setPermissions(pending); setLoaded(true); setError('') }
      } catch (e) { if (alive) setError(errorText(e)) }
      finally {
        loading = false
        if (alive) {
          if (queued) { queued = false; timer = setTimeout(() => void load(), 120) }
          else if (runningRef.current || permissionsCountRef.current > 0) {
            fallbackTimer.current = setTimeout(() => { if (runningRef.current || permissionsCountRef.current > 0) void load() }, 2000)
          }
        }
      }
    }
    const request = () => {
      if (loading) queued = true
      else { clearTimeout(timer); clearTimeout(fallbackTimer.current); timer = setTimeout(() => void load(), 120) }
    }
    refresh.current = request
    const unsubscribe = window.ame.onEvent(event => { if (event.type === 'opencode' && event.projectID === projectID && (!event.sessionID || event.sessionID === sessionID)) request() })
    void load()
    return () => { alive = false; clearTimeout(timer); clearTimeout(fallbackTimer.current); unsubscribe(); refresh.current = () => {} }
  }, [projectID, sessionID, connected])
  useEffect(() => {
    if (running && projectID && sessionID && connected) refresh.current()
    else if (permissionsCountRef.current === 0) clearTimeout(fallbackTimer.current)
  }, [running, projectID, sessionID, connected])
  useEffect(() => { if (follow.current) timeline.current?.scrollTo({ top: timeline.current.scrollHeight }) }, [messages, permissions])
  const send = async () => {
    const selectedModel = activeModel
    if (!projectID || !text.trim() || busy || !connected || !ready || !selectedModel) return
    const submitted = text, submittedSession = sessionID
    setBusy(true)
    try {
      if (!await submit.current!(projectID, sessionID, submitted, selectedModel, agent || undefined)) return
      if (currentSession.current === submittedSession || (!submittedSession && currentSession.current === createdSession.current)) setText(current => current === submitted ? '' : current)
      const draftKey = submittedSession || createdSession.current || ''
      if (drafts.current[draftKey] === submitted) drafts.current[draftKey] = ''
      if (!submittedSession && drafts.current[''] === submitted) drafts.current[''] = ''
      refresh.current(); onActivity()
    } catch (e) { report(e) } finally { setBusy(false) }
  }
  const reply = async (permission: Permission, response: 'once' | 'always' | 'reject') => {
    if (!projectID) return
    setReplying(true)
    try { await window.ame.replyPermission(projectID, permission.id, response); refresh.current() } catch (e) { report(e) } finally { setReplying(false) }
  }
  return <main data-testid="chat" className="chat-pane" data-region="Chat Canvas">
    <header className="chat-pane__header"><div className="chat-title-group"><span className="status-dot status-dot--active" /><span className="chat-title-text truncate">{title || 'Cuộc trò chuyện'}</span></div><div className="chat-header-actions">{(['artifacts', 'agents', 'btw'] as const).map(tab => <button key={tab} data-chat-drawer={tab} className={`pill-btn ${drawer === tab ? 'is-active' : ''}`} onClick={() => setDrawer(value => value === tab ? null : tab)}>{tab === 'artifacts' ? 'Artifacts' : tab === 'agents' ? 'Agents' : '/btw'}</button>)}<IconButton label="Tùy chọn hội thoại" active={menu} onClick={() => setMenu(value => !value)}><Icon name="more" /></IconButton></div></header>
    {!connected && <div className="warning">Đang kết nối OpenCode. Có thể thử lại trong Cài đặt.</div>}
    {error && <div className="inline-error" role="status">{error}</div>}
    <div className="chat-pane__body">{menu && <div className="chat-corner-drawer is-open" role="menu"><button className="chat-drawer__row" role="menuitem" onClick={() => { onCreate(); setMenu(false) }}>Cuộc trò chuyện mới</button><button className="chat-drawer__row" role="menuitem" onClick={() => { void navigator.clipboard.writeText(messages.map(item => `${item.role}: ${item.text}`).join('\n\n')).catch(report); setMenu(false) }}>Copy conversation</button></div>}
      <aside className={`chat-corner-drawer ${drawer ? 'is-open' : ''}`} data-testid="chat-drawer" data-drawer={drawer || ''}><div className="chat-drawer__head"><span>{drawer === 'agents' ? 'Subagents' : drawer === 'btw' ? '/btw' : 'Artifacts'}</span><IconButton label="Đóng công cụ Chat" onClick={() => setDrawer(null)}><Icon name="close" /></IconButton></div>{drawer === 'agents' ? <AgentList sessions={sessions} selected={sessionID} loading={false} error="" connected={connected} onRetry={onActivity} onSelect={onSelectSession} /> : drawer === 'btw' ? <Empty>Nhánh /btw chưa được backend cung cấp.</Empty> : <><button className="chat-drawer__row" onClick={() => onOpenPanel('artifact')}>Artifacts <span className="muted">Chưa có</span></button><button className="chat-drawer__row" onClick={() => onOpenPanel('changes')}>{changesStatus === 'loading' ? 'Đang tải thay đổi session…' : changesStatus === 'error' ? 'Không tải được thay đổi session' : `${changes} files modified · session`}</button>{[...new Set(tabs.map(tab => tab.path))].map(path => <button className="chat-drawer__row" key={path} onClick={() => onOpenFile(path)}><Icon name="file" /><span className="truncate">{path}</span></button>)}</>}</aside><div className="chat-column">
      <div ref={timeline} className="chat-stream" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}><div className="chat-stream__inner">
        {!projectID ? <Empty><span className="welcome-mark">A</span><h1>Không gian làm việc của bạn</h1><p>Mở một dự án để duyệt mã nguồn và trò chuyện với agent.</p></Empty> : !sessionID ? <Empty><h1>Bắt đầu từ dự án thật.</h1><p>Nhập yêu cầu bên dưới để bắt đầu. Cuộc trò chuyện sẽ được tạo khi gửi.</p></Empty> : (!loaded || previousSession.current !== sessionID) && connected ? <Empty>Đang tải lịch sử…</Empty> : !messages.length ? <Empty><h1>Bạn muốn làm gì tiếp theo?</h1><p>Gửi yêu cầu bên dưới. Phản hồi và công cụ sẽ hiển thị từ máy chủ.</p></Empty> : messages.map(item => <article key={item.id} className={item.role === 'user' ? 'msg-user' : 'msg-agent'}>
          {item.kind === 'tool' && item.tool ? <ToolCard call={item.tool} onOpenFile={onOpenFile} /> : item.turn && projectID && sessionID ? <TurnChanges key={`${sessionID}:${item.id}`} projectID={projectID} sessionID={sessionID} from={item.turn.from} files={item.turn.files} theme={theme} /> : item.kind === 'tool' ? <details className="tool-card"><summary><Icon name="terminal" /> Công cụ</summary><pre>{item.text || 'Đang cập nhật công cụ…'}</pre></details> : item.kind === 'reasoning' ? <details className="thought-block"><summary>Suy nghĩ</summary><div className="thought-block__content"><MessageContent text={item.text || '…'} onOpenFile={onOpenFile} /></div></details> : <MessageContent text={item.text || '…'} onOpenFile={onOpenFile} />}
        </article>)}
        {permissions.map(permission => <section className="permission" key={permission.id} role="alert"><h3>Yêu cầu quyền</h3><p>{permission.title}</p><div className="button-row"><button disabled={replying} onClick={() => void reply(permission, 'once')}>Cho phép một lần</button><button disabled={replying} onClick={() => void reply(permission, 'always')}>Luôn cho phép</button><button disabled={replying} onClick={() => void reply(permission, 'reject')}>Từ chối</button></div></section>)}
      </div></div>
      <div className="composer-dock"><div className="composer-dock__inner">{projectName && <div className="composer-context-strip">{sessionID ? <><span>Ngữ cảnh:</span><button className="ctx-strip-chip" onClick={() => onOpenPanel('changes')} title="Thay đổi của toàn bộ session, từ OpenCode snapshots">{changesStatus === 'loading' ? 'Đang tải thay đổi session…' : changesStatus === 'error' ? 'Không tải được thay đổi session' : `● ${changes} files changed · session (${projectName})`}</button></> : <span>Project: <strong>{projectName}</strong>{branch ? ` (${branch})` : ''}</span>}</div>}<form className="composer-card" onSubmit={e => { e.preventDefault(); void send() }}>
        <textarea ref={input} className="composer-input" aria-label="Yêu cầu cho agent" placeholder="Hỏi bất cứ điều gì — gõ yêu cầu cho agent…" value={text} disabled={!projectID || !connected} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} rows={1} />
        <div className="composer-toolbar"><div className="composer-toolbar__left"><button className="icon-btn" type="button" disabled title="Đính kèm ngữ cảnh: chưa triển khai"><Icon name="plus" /></button><button className="icon-btn" type="button" disabled title="Slash commands: chưa triển khai">/</button><button className="icon-btn" type="button" disabled title="File mentions: chưa triển khai">@</button>{models.length > 0 && role === 'user' ? <span className="select-pill select-pill--locked" role="status" aria-label="Mô hình cố định theo chính sách máy chủ" title={`Tài khoản user dùng model cố định từ máy chủ: ${activeModel?.name || model}`}>🔒 {activeModel?.name || model}</span> : <select className="select-pill" aria-label="Mô hình" value={model} onChange={e => setModel(e.target.value)} disabled={!connected || busy}><option value="">Chọn mô hình AmeKit</option>{models.map(m => <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>{m.name}</option>)}</select>}</div><div className="composer-toolbar__right"><label className="policy-inline" title="Agent và policy quyền do OpenCode quản lý"><Icon name="shield" /><select className="policy-inline__select" aria-label="Agent" value={agent} onChange={e => setAgent(e.target.value)} disabled={!connected || busy}><option value="">Default</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{running && <button className="icon-btn" type="button" disabled={!sessionID || !connected} title="Dừng phản hồi" onClick={() => { if (projectID && sessionID) void window.ame.cancel(projectID, sessionID).then(() => refresh.current()).catch(report) }}><Icon name="close" /></button>}<button className="send-btn" aria-label="Gửi yêu cầu" disabled={!projectID || !connected || !ready || busy || !text.trim() || !model}><Icon name="send" /></button></div></div>
      </form></div></div>
    </div>
    </div>
  </main>
}
