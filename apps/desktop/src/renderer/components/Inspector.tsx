import { useEffect, useState } from 'react'
import type { FileEntry, GitState } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { Empty, errorText, IconButton } from './Primitives'
import { ProjectSearch } from './ProjectSearch'
import { canCommit, commitShortcut } from '../scm-commit'

function Directory({ projectID, path, generation, onOpen }: { projectID: string; path: string; generation: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.ame.entries(projectID, path).then(items => { if (alive) { setEntries(items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))); setError('') } }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectID, path, generation])
  return <ul className="file-tree" aria-label={path || 'Thư mục dự án'}>{error ? <li className="inline-error">{error}</li> : loading && !entries.length ? <li className="muted">Đang đọc…</li> : !entries.length ? <li className="muted">Thư mục trống</li> : entries.map(entry => <li key={entry.path}><button className="tree-row insp-row" title={entry.path} aria-expanded={entry.directory ? !!expanded[entry.path] : undefined} onClick={() => entry.directory ? setExpanded(value => ({ ...value, [entry.path]: !value[entry.path] })) : onOpen(entry.path)}><span className="file-symbol"><Icon name={entry.directory ? expanded[entry.path] ? 'down' : 'chevron' : 'file'} /></span><span className="truncate">{entry.name}</span></button>{entry.directory && expanded[entry.path] && <Directory projectID={projectID} path={entry.path} generation={generation} onOpen={onOpen} />}</li>)}</ul>
}
export function Inspector({ projectID, name, tab, setTab, generation, git, gitError, refresh, onOpen, onDiff, onHide, report }: {
  projectID?: string; name?: string; tab: 'files' | 'search' | 'git'; setTab: (tab: 'files' | 'search' | 'git') => void; generation: number;
  git?: GitState; gitError: string; refresh: () => void; onOpen: (path: string) => void; onDiff: (path: string) => void; onHide: () => void; report: (error: unknown) => void
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setMessage('') }, [projectID])
  const mutate = async (action: () => Promise<void>) => { setBusy(true); try { await action(); refresh() } catch (e) { report(e) } finally { setBusy(false) } }
  const changes = git?.changes || []
  const commitState = { busy, message, changes }
  const submitCommit = () => {
    if (!projectID || !canCommit(commitState)) return
    const text = message.trim()
    void mutate(async () => { await window.ame.commit(projectID, text); setMessage('') })
  }
  return <aside data-testid="inspector" className="inspector-pane" data-region="Project Inspector">
    <header className="inspector-pane__header"><span className="inspector-pane__title" title={name}><Icon name="folder" /><span className="truncate">{name || 'Project Inspector'}</span>{git?.branch && <span className="branch-tag">{git.branch}</span>}</span><IconButton label="Đóng Inspector (ẩn cố định)" onClick={onHide}><Icon name="left" /></IconButton></header>
    <nav className="inspector-mode-bar" aria-label="Inspector">{(['files', 'search', 'git'] as const).map(mode => <button key={mode} className={`inspector-mode-btn ${mode === 'git' ? 'inspector-mode-btn--icon' : ''} ${tab === mode ? 'is-active' : ''}`} title={mode === 'git' ? 'Git Diff' : mode === 'files' ? 'Explorer' : 'Search'} aria-pressed={tab === mode} onClick={() => setTab(mode)}>{mode === 'git' && <Icon name="git" />}{mode === 'files' ? 'Explorer' : mode === 'search' ? 'Search' : changes.length > 0 && <span className="diff-dot" />}</button>)}</nav>
    <div className="inspector-pane__body">{!projectID ? <Empty>Mở một thư mục để bắt đầu.</Empty> : tab === 'files' ? <div data-testid="explorer"><div className="insp-folder-label"><Icon name="down" />{name}</div><Directory key={projectID} projectID={projectID} path="" generation={generation} onOpen={onOpen} /></div> : tab === 'search' ? <ProjectSearch key={projectID} projectID={projectID} onOpen={onOpen} /> : gitError ? <div className="inline-error">{gitError}</div> : !git ? <Empty>Đang đọc trạng thái Git…</Empty> : !changes.length ? <Empty>Không có thay đổi. Cây làm việc sạch.</Empty> : (['staged', 'working'] as const).map(group => {
      const groupChanges = changes.filter(change => group === 'staged' ? !!change.index.trim() && !['?', '!'].includes(change.index) : !!change.working.trim() || change.index === '?')
      return groupChanges.length ? <section className="scm-section" key={group}><div className="scm-section__head"><span>{group === 'staged' ? 'Staged Changes' : 'Changes'}</span><span className="badge">{groupChanges.length}</span></div>{groupChanges.map(change => <div className="scm-file-row" key={change.path}><button className="scm-file-row__main" title={`Diff với HEAD: ${change.path}`} onClick={() => onDiff(change.path)}><Icon name="file" /><span className="scm-file-name truncate">{change.path}</span></button><span className="git-badge">{group === 'staged' ? change.index : change.working || change.index}</span><IconButton label={group === 'staged' ? `Bỏ stage ${change.path}` : `Stage ${change.path}`} disabled={busy} onClick={() => void mutate(() => window.ame.stage(projectID, change.path, group !== 'staged'))}>{group === 'staged' ? '−' : '+'}</IconButton></div>)}</section> : null
    })}</div>
    {tab === 'git' && projectID && <form className="scm-commit-dock is-visible" onSubmit={e => { e.preventDefault(); submitCommit() }}><div className="scm-commit-input-wrap"><textarea aria-label="Thông điệp commit" className="scm-commit-textarea" rows={3} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => commitShortcut(e, commitState, submitCommit)} placeholder="Message (Ctrl/Cmd+Enter to commit)" /><div className="scm-commit-input-bar"><span className="muted">Skill /git-commit</span><button type="button" disabled title="AI commit enhancement chưa được kết nối">✦ Enhance</button></div></div><button className="scm-commit-btn" disabled={!canCommit(commitState)}>{busy ? 'Đang xử lý…' : '✓ Commit'}</button></form>}
    <footer className="inspector-pane__footer"><span>{tab === 'git' ? `${changes.length} changes` : tab === 'search' ? 'Project Search' : 'Explorer'}</span><IconButton label="Làm mới dự án" onClick={refresh}><Icon name="refresh" /></IconButton></footer>
  </aside>
}
