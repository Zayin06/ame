import { useEffect, useRef, useState } from 'react'
import { formatRelativeTime, projectsByChatActivity, visibleProjectSessions } from '../project-order'
import type { GitState, Project, Session } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { Empty, errorText, IconButton } from './Primitives'

function SessionRow({ projectID, session, now, active, connected, onSelect, onRefresh, onRemoved }: { projectID: string; session: Session; now: number; active: boolean; connected: boolean; onSelect: () => void; onRefresh: () => Promise<void>; onRemoved: () => void }) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const timeLabel = formatRelativeTime(session.updatedAt, now)
  const run = async (action: 'rename' | 'archive' | 'delete') => {
    if (pending.current || !connected || (action === 'rename' && !title.trim())) return
    pending.current = true; setBusy(true); setError('')
    let removed = false
    try {
      if (action === 'rename') await window.ame.renameSession(projectID, session.id, title.trim())
      else if (action === 'archive') await window.ame.archiveSession(projectID, session.id, true)
      else await window.ame.deleteSession(projectID, session.id)
      removed = action !== 'rename'
      setRenaming(false)
      await onRefresh()
    } catch (error) { if (!/\bCANCELLED\b/.test(errorText(error))) setError(errorText(error)) }
    finally { if (removed) onRemoved(); pending.current = false; setBusy(false) }
  }
  return <div className="session-row" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setRenaming(false) } }}>
    <div className={`session-row__main ${active ? 'is-active' : ''}`}>
      {renaming ? <form className="session-rename" onSubmit={event => { event.preventDefault(); void run('rename') }}>
        <input autoFocus aria-label={`Đổi tên ${session.title || 'cuộc trò chuyện'}`} value={title} disabled={busy} onFocus={event => event.currentTarget.select()} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); if (event.key === 'Enter') event.preventDefault() } }} />
        <button type="submit" aria-label="Lưu" title="Lưu" disabled={busy || !connected || !title.trim()}><Icon name="check" /></button>
        <button type="button" aria-label="Hủy" title="Hủy" disabled={busy} onClick={() => setRenaming(false)}><Icon name="close" /></button>
      </form> : <>
        <button type="button" className={`nav-item ${active ? 'is-active' : ''}`} title={session.title} onClick={onSelect}>
          <span className="nav-item__left">{session.status === 'running' && <span className="status-dot status-dot--active" />}<span className="nav-item__title">{session.parentID ? '↳ ' : ''}{session.title || 'Cuộc trò chuyện'}</span></span>
          {timeLabel && <span className="session-time">{timeLabel}</span>}
        </button>
        <div className="session-hover-actions" role="group" aria-label={`Thao tác: ${session.title || 'Cuộc trò chuyện'}`}>
          <button type="button" className="session-hover-btn" title="Đổi tên" aria-label={`Đổi tên: ${session.title || 'Cuộc trò chuyện'}`} disabled={!connected || busy} onClick={() => { setTitle(session.title); setRenaming(true); setError('') }}><Icon name="pencil" /></button>
          <button type="button" className="session-hover-btn" title="Lưu trữ" aria-label={`Lưu trữ: ${session.title || 'Cuộc trò chuyện'}`} disabled={!connected || busy} onClick={() => void run('archive')}><Icon name="archive" /></button>
          <button type="button" className="session-hover-btn session-hover-btn--danger" title="Xóa" aria-label={`Xóa: ${session.title || 'Cuộc trò chuyện'}`} disabled={!connected || busy} onClick={() => void run('delete')}><Icon name="trash" /></button>
        </div>
      </>}
    </div>
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
  const [filterOpen, setFilterOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())
  const headerRef = useRef<HTMLDivElement>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [metadata, setMetadata] = useState<Record<string, { dirty: boolean }>>({})
  const onSessionsRef = useRef(onSessions); onSessionsRef.current = onSessions
  const sessionLoads = useRef(new Map<string, number>())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!filterOpen) return
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [filterOpen])
  useEffect(() => {
    if (projectMenu) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [projectMenu])
  useEffect(() => {
    if (!filterOpen && !projectMenu) return
    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (!headerRef.current?.contains(event.target)) setFilterOpen(false)
      if (!menuRef.current?.contains(event.target) && !menuButtonRef.current?.contains(event.target)) setProjectMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      if (filterOpen) { setFilterOpen(false); filterButtonRef.current?.focus() }
      if (projectMenu) { setProjectMenu(null); menuButtonRef.current?.focus() }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [filterOpen, projectMenu])
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
    <div className="projects-header" ref={headerRef}>
      <span className="projects-header__title">Projects</span>
      <div className="projects-header__actions">
        <button type="button" ref={filterButtonRef} className={`icon-btn proj-filter-trigger ${filterOpen ? 'is-active' : ''}`} aria-label="Lọc dự án & cuộc trò chuyện" title="Lọc dự án & cuộc trò chuyện" aria-expanded={filterOpen} aria-haspopup="true" onClick={() => { setFilterOpen(value => !value); setProjectMenu(null) }}>
          <Icon name="filter" />{(filter !== 'all' || !!normalized) && <span className="proj-filter-dot" />}
        </button>
        <IconButton label="Mở dự án" disabled={!window.ame} onClick={onPick}><Icon name="folderPlus" /></IconButton>
      </div>
      <div className={`proj-filter-popover ${filterOpen ? 'is-open' : ''}`} role={filterOpen ? 'dialog' : undefined} aria-hidden={!filterOpen} aria-label="Bộ lọc Projects">
        <div className="proj-search-box"><Icon name="search" /><input ref={searchInputRef} aria-label="Lọc projects / chats" placeholder="Lọc projects / chats..." value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" className="proj-search-clear" aria-label="Xóa tìm kiếm" onClick={() => { setQuery(''); searchInputRef.current?.focus() }}><Icon name="close" /></button>}</div>
        <div className="proj-filter-options" role="radiogroup" aria-label="Trạng thái dự án">
          {[[ 'all', 'Tất cả' ], [ 'chat', 'Đang chat' ], [ 'diff', 'Có Diff' ]].map(([id, label]) => <button type="button" key={id} role="radio" aria-checked={filter === id} className="proj-filter-option" onClick={() => setFilter(id)} onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const modes = ['all', 'chat', 'diff']
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (modes.indexOf(id) + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 2)) % 3
            setFilter(modes[index]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
          }}><span className="proj-filter-check">{filter === id && <Icon name="check" />}</span>{label}</button>)}
        </div>
      </div>
    </div>
    {(filter !== 'all' || normalized) && !filterOpen && <div className="proj-active-filters"><button type="button" aria-label="Xóa bộ lọc" title="Xóa bộ lọc" onClick={() => { setQuery(''); setFilter('all') }}><span>{[filter === 'chat' ? 'Đang chat' : filter === 'diff' ? 'Có Diff' : '', query.trim()].filter(Boolean).join(' · ')}</span><Icon name="close" /></button></div>}
    <div className="sidebar__scroll"><section className="sidebar-section">
      {loading ? <Empty>Đang đọc dự án…</Empty> : !projects.length ? <Empty>Chưa có dự án.<br /><button disabled={!window.ame} onClick={onPick}>Mở thư mục</button></Empty> : !visible.length ? <Empty>Không có kết quả.</Empty> : visible.map(project => {
        const active = project.id === projectID
        const items = sessionCache[project.id] || []
        const dirty = active ? !!git?.changes.length : metadata[project.id]?.dirty
        const shown = normalized && !project.name.toLocaleLowerCase().includes(normalized) ? items.filter(s => s.title.toLocaleLowerCase().includes(normalized)) : items
        const isFolded = !!folded[project.id] && !normalized
        const { items: visibleSessions, total, hiddenCount } = visibleProjectSessions(shown, { expanded: !!expandedProjects[project.id], activeSessionID: active ? sessionID : undefined, query: normalized, limit: 3 })
        return <section key={project.id} className={`proj-group ${active ? 'is-active-proj' : ''} ${isFolded ? 'is-folded' : ''}`}>
          <div className={`proj-row ${projectMenu === project.id ? 'is-menu-open' : ''}`}>
            <button type="button" className="proj-folder-btn" aria-label={isFolded ? `Mở rộng ${project.name}` : `Thu gọn ${project.name}`} title={isFolded ? 'Mở thư mục' : 'Đóng thư mục'} aria-expanded={!isFolded} onClick={() => setFolded(value => ({ ...value, [project.id]: !value[project.id] }))}><Icon name={isFolded ? 'folder' : 'folderOpen'} /></button>
            <button type="button" className="proj-row__left project-select" title={project.directory} onClick={() => { onSelect(project.id); if (active) setFolded(value => ({ ...value, [project.id]: !value[project.id] })) }}><span className="proj-name">{project.name}</span></button>
            {dirty && <span className="proj-dirty-indicator" title="Có thay đổi Git chưa commit" aria-hidden="true" />}
            <div className="proj-actions">
              <button type="button" className="proj-act-btn" aria-label={`Tùy chọn dự án: ${project.name}`} aria-haspopup="menu" aria-expanded={projectMenu === project.id} title="Thao tác dự án" onClick={event => { menuButtonRef.current = event.currentTarget; setProjectMenu(value => value === project.id ? null : project.id); setFilterOpen(false) }}><Icon name="more" /></button>
              <button type="button" className="proj-act-btn" aria-label={`New Chat: ${project.name}`} title="Cuộc trò chuyện mới" disabled={!connected || creating} onClick={() => onCreate(project.id)}><Icon name="plus" /></button>
            </div>
          </div>
          {projectMenu === project.id && <div className="proj-row-popover" role="menu" aria-label={`Thao tác dự án: ${project.name}`} ref={menuRef} onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
            buttons[index]?.focus()
          }}>
            <button type="button" role="menuitem" aria-label={`Explorer: ${project.name}`} onClick={() => { setProjectMenu(null); onTool(project.id, 'files') }}><Icon name="folder" />Explorer</button>
            <button type="button" role="menuitem" aria-label={`Search: ${project.name}`} onClick={() => { setProjectMenu(null); onTool(project.id, 'search') }}><Icon name="search" />Tìm trong dự án</button>
            <button type="button" role="menuitem" aria-label={`Git Diff: ${project.name}`} onClick={() => { setProjectMenu(null); onTool(project.id, 'git') }}><Icon name="git" />Git Diff{dirty && <span className="proj-menu-dirty" aria-hidden="true" />}</button>
            <div className="proj-menu-divider" role="separator" />
            <button type="button" role="menuitem" className="proj-menu-danger" aria-label={`Gỡ dự án: ${project.name}`} title={`Gỡ dự án ${project.name} khỏi danh sách (không xóa tệp)`} onClick={() => { setProjectMenu(null); onRemove(project.id) }}><Icon name="trash" />Gỡ dự án</button>
          </div>}
          <div className="proj-chats">{active && error ? <div className="inline-error">{error}<button onClick={onRetry}>Thử lại</button></div> : active && sessionsLoading && !items.length ? <p className="rail-note muted">Đang tải…</p> : <>
            {visibleSessions.map(session => <SessionRow key={session.id} projectID={project.id} session={session} now={now} active={active && sessionID === session.id} connected={connected} onSelect={() => onSession(project.id, session.id)} onRefresh={() => refreshSessions(project.id)} onRemoved={() => onSessionRemoved?.(project.id, session.id)} />)}
            {hiddenCount > 0 ? <button type="button" className="proj-see-all" onClick={() => setExpandedProjects(value => ({ ...value, [project.id]: true }))}>See all ({total})</button> : expandedProjects[project.id] && total > 3 && !normalized && <button type="button" className="proj-see-all" onClick={() => setExpandedProjects(value => ({ ...value, [project.id]: false }))}>Show less</button>}
          </>}</div>
        </section>
      })}
    </section></div>
  </aside>
}
