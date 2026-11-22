import { useEffect, useRef, useState } from 'react'
import { projectsByChatActivity } from '../project-order'
import type { GitState, Project, Session } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { Empty, errorText, IconButton } from './Primitives'

function SessionRow({ projectID, session, active, connected, onSelect, onRefresh, onRemoved }: { projectID: string; session: Session; active: boolean; connected: boolean; onSelect: () => void; onRefresh: () => Promise<void>; onRemoved: () => void }) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const run = async (action: 'rename' | 'archive' | 'delete') => {
    if (pending.current || !connected || (action === 'rename' && !title.trim())) return
    pending.current = true; setBusy(true); setError('')
    let removed = false
    try {
      if (action === 'rename') await window.ame.renameSession(projectID, session.id, title.trim())
      else if (action === 'archive') await window.ame.archiveSession(projectID, session.id, true)
      else await window.ame.deleteSession(projectID, session.id)
      removed = action !== 'rename'
      setRenaming(false); setMenu(false)
      await onRefresh()
    } catch (error) { if (!/\bCANCELLED\b/.test(errorText(error))) setError(errorText(error)) }
    finally { if (removed) onRemoved(); pending.current = false; setBusy(false) }
  }
  return <div className="session-row" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(false) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(false); if (!busy) setRenaming(false) } }}>
    <div className="session-row__main">
      {renaming ? <form className="session-rename" onSubmit={event => { event.preventDefault(); void run('rename') }}><input autoFocus aria-label={`Đổi tên ${session.title || 'cuộc trò chuyện'}`} value={title} disabled={busy} onFocus={event => event.currentTarget.select()} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); if (event.key === 'Enter') event.preventDefault() } }} /><button type="submit" disabled={busy || !connected || !title.trim()}>Lưu</button><button type="button" disabled={busy} onClick={() => setRenaming(false)}>Hủy</button></form> : <><button className={`nav-item ${active ? 'is-active' : ''}`} title={session.title} onClick={onSelect}><span className="nav-item__left"><span className={`status-dot ${session.status === 'running' ? 'status-dot--active' : 'status-dot--done'}`} /><span className="nav-item__title">{session.parentID ? '↳ ' : ''}{session.title || 'Cuộc trò chuyện'}</span></span></button><button type="button" className="session-more" aria-label={`Tùy chọn: ${session.title || 'Cuộc trò chuyện'}`} aria-haspopup="menu" aria-expanded={menu} disabled={!connected || busy} onClick={() => setMenu(value => !value)}>⋯</button></>}
    </div>
    {menu && !renaming && <div className="session-actions" role="menu" aria-label={`Thao tác: ${session.title || 'Cuộc trò chuyện'}`}><button type="button" role="menuitem" disabled={busy} onClick={() => { setTitle(session.title); setRenaming(true); setMenu(false); setError('') }}>Đổi tên</button><button type="button" role="menuitem" disabled={busy} onClick={() => void run('archive')}>Lưu trữ</button><button type="button" role="menuitem" className="session-actions__delete" disabled={busy} onClick={() => void run('delete')}>Xóa</button></div>}
    {busy && <div className="session-operation-status muted" role="status">Đang cập nhật…</div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
  </div>
}

export function ProjectRail({ projects, projectID, sessions, sessionID, loading, sessionsLoading, error, connected, creating, git, generation, onSelect, onSession, onTool, onCreate, onPick, onRetry, onRemove, sessionCache, onSessions, onSessionRemoved }: {
  sessionCache: Record<string, Session[]>; onSessions: (id: string, sessions: Session[]) => void; onSessionRemoved?: (projectID: string, sessionID: string) => void;
  projects: Project[]; projectID?: string; sessions: Session[]; sessionID?: string; loading: boolean; sessionsLoading: boolean; error: string; connected: boolean; creating: boolean; git?: GitState; generation: number;
  onRemove: (id: string) => void; onSelect: (id: string) => void; onSession: (project: string, session: string) => void; onTool: (id: string, tab: 'files' | 'search' | 'git') => void; onCreate: (id: string) => void; onPick: () => void; onRetry: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [metadata, setMetadata] = useState<Record<string, { dirty: boolean }>>({})
  const onSessionsRef = useRef(onSessions); onSessionsRef.current = onSessions
  const sessionLoads = useRef(new Map<string, number>())
  const refreshSessions = async (id: string) => {
    const request = (sessionLoads.current.get(id) || 0) + 1
    sessionLoads.current.set(id, request)
    const items = await window.ame.sessions(id)
    if (sessionLoads.current.get(id) === request) onSessionsRef.current(id, items)
  }
  useEffect(() => {
    if (!window.ame) return
    let alive = true
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const load = (id: string) => {
      if (connected) {
        const request = (sessionLoads.current.get(id) || 0) + 1
        sessionLoads.current.set(id, request)
        void window.ame.sessions(id).then(items => { if (alive && sessionLoads.current.get(id) === request) onSessionsRef.current(id, items) }).catch(() => {})
      }
      void window.ame.git(id).then(state => { if (alive) setMetadata(current => ({ ...current, [id]: { dirty: !!state.changes.length } })) }).catch(() => {})
    }
    for (const project of projects) load(project.id)
    const unsubscribe = window.ame.onEvent(event => {
      if ((event.type !== 'opencode' && event.type !== 'files') || timers.has(event.projectID)) return
      const id = event.projectID
      timers.set(id, setTimeout(() => { timers.delete(id); load(id) }, 300))
    })
    return () => { alive = false; unsubscribe(); for (const timer of timers.values()) clearTimeout(timer) }
  }, [projects, connected, generation])
  const normalized = query.trim().toLocaleLowerCase()
  const visible = projectsByChatActivity(projects, sessionCache).filter(project => {
    const items = sessionCache[project.id] || []
    const dirty = project.id === projectID ? !!git?.changes.length : metadata[project.id]?.dirty
    return (!normalized || project.name.toLocaleLowerCase().includes(normalized) || items.some(s => s.title.toLocaleLowerCase().includes(normalized))) && (filter !== 'chat' || items.length > 0) && (filter !== 'diff' || dirty)
  })
  return <aside className="sidebar" data-region="Projects & Chats" data-testid="projects">
    <div className="sidebar__top"><div className="proj-search-box"><Icon name="search" /><input aria-label="Lọc projects / chats" placeholder="Lọc projects / chats..." value={query} onChange={e => setQuery(e.target.value)} /></div><div className="proj-filter-bar">{[['all', 'Tất cả'], ['chat', 'Đang chat'], ['diff', 'Có Diff']].map(([id, label]) => <button key={id} className={`proj-filter-btn ${filter === id ? 'is-active' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    <div className="sidebar__scroll"><section className="sidebar-section"><div className="sidebar-section__label"><span>Projects &amp; Chats</span><IconButton label="Mở dự án" disabled={!window.ame} onClick={onPick}><Icon name="plus" /></IconButton></div>
      {loading ? <Empty>Đang đọc dự án…</Empty> : !projects.length ? <Empty>Chưa có dự án.<br /><button disabled={!window.ame} onClick={onPick}>Mở thư mục</button></Empty> : !visible.length ? <Empty>Không có kết quả.</Empty> : visible.map(project => {
        const active = project.id === projectID
        const items = sessionCache[project.id] || []
        const dirty = active ? !!git?.changes.length : metadata[project.id]?.dirty
        const shown = normalized && !project.name.toLocaleLowerCase().includes(normalized) ? items.filter(s => s.title.toLocaleLowerCase().includes(normalized)) : items
        return <section key={project.id} className={`proj-group ${active ? 'is-active-proj' : ''} ${folded[project.id] && !normalized ? 'is-folded' : ''}`}>
          <div className="proj-row"><button className="proj-row__left project-select" title={project.directory} onClick={() => { onSelect(project.id); if (active) setFolded(value => ({ ...value, [project.id]: !value[project.id] })) }}><span className="proj-chevron"><Icon name="down" /></span><span className={`status-dot status-dot--${items.some(session => session.status === 'running') ? 'active' : 'idle'}`} /><span className="proj-name">{project.name}</span></button><div className="proj-actions">{(['files', 'search', 'git'] as const).map(tab => <button key={tab} className="proj-act-btn" aria-label={`${tab === 'files' ? 'Explorer' : tab === 'search' ? 'Search' : 'Git Diff'}: ${project.name}`} onClick={() => onTool(project.id, tab)}><Icon name={tab === 'files' ? 'folder' : tab === 'search' ? 'search' : 'git'} />{tab === 'git' && dirty && <span className="diff-dot" />}</button>)}<button className="proj-act-btn" aria-label={`New Chat: ${project.name}`} disabled={!connected || creating} onClick={() => onCreate(project.id)}>          <Icon name="plus" /></button><button className="proj-act-btn proj-remove-btn" aria-label={`Gỡ dự án: ${project.name}`} title={`Gỡ dự án ${project.name} khỏi danh sách (không xóa tệp)`} onClick={() => onRemove(project.id)}><Icon name="close" /></button></div></div>
          <div className="proj-chats">{active && error ? <div className="inline-error">{error}<button onClick={onRetry}>Thử lại</button></div> : active && sessionsLoading && !items.length ? <p className="rail-note muted">Đang tải…</p> : shown.map(session => <SessionRow key={session.id} projectID={project.id} session={session} active={active && sessionID === session.id} connected={connected} onSelect={() => onSession(project.id, session.id)} onRefresh={() => refreshSessions(project.id)} onRemoved={() => onSessionRemoved?.(project.id, session.id)} />)}</div>
        </section>
      })}
    </section></div>
  </aside>
}
