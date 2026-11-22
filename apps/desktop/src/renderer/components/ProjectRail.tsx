import { useEffect, useRef, useState } from 'react'
import { projectsByChatActivity } from '../project-order'
import type { GitState, Project, Session } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { Empty, IconButton } from './Primitives'

export function ProjectRail({ projects, projectID, sessions, sessionID, loading, sessionsLoading, error, connected, creating, git, generation, onSelect, onSession, onTool, onCreate, onPick, onRetry, onRemove, sessionCache, onSessions }: {
  sessionCache: Record<string, Session[]>; onSessions: (id: string, sessions: Session[]) => void;
  projects: Project[]; projectID?: string; sessions: Session[]; sessionID?: string; loading: boolean; sessionsLoading: boolean; error: string; connected: boolean; creating: boolean; git?: GitState; generation: number;
  onRemove: (id: string) => void; onSelect: (id: string) => void; onSession: (project: string, session: string) => void; onTool: (id: string, tab: 'files' | 'search' | 'git') => void; onCreate: (id: string) => void; onPick: () => void; onRetry: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [metadata, setMetadata] = useState<Record<string, { dirty: boolean }>>({})
  const onSessionsRef = useRef(onSessions); onSessionsRef.current = onSessions
  useEffect(() => {
    if (!window.ame) return
    let alive = true
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const load = (id: string) => {
      if (connected) void window.ame.sessions(id).then(items => { if (alive) onSessionsRef.current(id, items) }).catch(() => {})
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
          <div className="proj-chats">{active && error ? <div className="inline-error">{error}<button onClick={onRetry}>Thử lại</button></div> : active && sessionsLoading && !items.length ? <p className="rail-note muted">Đang tải…</p> : shown.map(session => <button key={session.id} className={`nav-item ${active && sessionID === session.id ? 'is-active' : ''}`} title={session.title} onClick={() => onSession(project.id, session.id)}><span className="nav-item__left"><span className={`status-dot ${session.status === 'running' ? 'status-dot--active' : 'status-dot--done'}`} /><span className="nav-item__title">{session.parentID ? '↳ ' : ''}{session.title || 'Cuộc trò chuyện'}</span></span></button>)}</div>
        </section>
      })}
    </section></div>
  </aside>
}
