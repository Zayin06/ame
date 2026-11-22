import { useEffect, useRef, useState } from 'react'
import type { FileEntry, GitBranches, GitState } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { Empty, errorText, IconButton } from './Primitives'
import { ProjectSearch } from './ProjectSearch'
import { canCommit, commitShortcut } from '../scm-commit'

type Mutate = <T>(action: () => Promise<T>, success?: (result: T) => void, refreshAfter?: boolean) => Promise<void>
type Naming = { kind: 'file' | 'directory' | 'rename'; parent: string; entry?: FileEntry }
type InspectorProps = {
  projectID?: string; name?: string; tab: 'files' | 'search' | 'git'; setTab: (tab: 'files' | 'search' | 'git') => void; generation: number;
  git?: GitState; gitError: string; refresh: () => void; onOpen: (path: string, line?: number, column?: number) => void;
  onRename: (from: string, to: string) => void; onDelete: (path: string) => void;
  onDiff: (path: string) => void; onHide: () => void; report: (error: unknown) => void
}

const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name
const cancelled = (error: unknown) => /\bCANCELLED\b/.test(errorText(error))

function InlineName({ label, prefix = '', initial = '', busy, submit, cancel }: {
  label: string; prefix?: string; initial?: string; busy: boolean; submit: (name: string) => void; cancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return <form className="insp-inline-name" onSubmit={event => { event.preventDefault(); if (!busy && value.trim()) submit(value.trim()) }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancel() } }}>
    {prefix && <span className="insp-inline-name__prefix truncate" title={prefix}>{prefix}/</span>}
    <div><input autoFocus aria-label={label} placeholder={label} value={value} disabled={busy} onChange={event => setValue(event.target.value)} onFocus={event => event.currentTarget.select()} />
      <button type="submit" title="Xác nhận (Enter)" aria-label="Xác nhận tên" disabled={busy || !value.trim()}>✓</button>
      <button type="button" title="Hủy (Escape)" aria-label="Hủy nhập tên" disabled={busy} onClick={cancel}>×</button></div>
  </form>
}

type DirectoryProps = {
  projectID: string; path: string; generation: number; onOpen: InspectorProps['onOpen']; busy: boolean;
  naming: Naming | null; startNaming: (naming: Naming | null) => void; submitName: (name: string) => void;
  menu: string | null; setMenu: (path: string | null) => void; mutate: Mutate; onDelete: InspectorProps['onDelete']
}

function Directory(props: DirectoryProps) {
  const { projectID, path, generation, onOpen, busy, naming, startNaming, submitName, menu, setMenu, mutate, onDelete } = props
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void window.ame.entries(projectID, path).then(items => { if (alive) setEntries(items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))) }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectID, path, generation])
  const edit = (value: Naming) => { setMenu(null); startNaming(value) }
  return <ul className="file-tree" aria-label={path || 'Thư mục dự án'}>{error ? <li className="inline-error">{error}</li> : loading && !entries.length ? <li className="muted">Đang đọc…</li> : !entries.length ? <li className="muted">Thư mục trống</li> : entries.map(entry => {
    const editing = naming && (naming.kind === 'rename' ? naming.entry?.path === entry.path : naming.parent === entry.path)
    return <li key={entry.path}>
      <div className="insp-tree-entry">
        <button className="tree-row insp-row" title={entry.path} aria-expanded={entry.directory ? !!expanded[entry.path] : undefined} onClick={() => entry.directory ? setExpanded(value => ({ ...value, [entry.path]: !value[entry.path] })) : onOpen(entry.path)}><span className="file-symbol"><Icon name={entry.directory ? expanded[entry.path] ? 'down' : 'chevron' : 'file'} /></span><span className="truncate">{entry.name}</span></button>
        <button className="insp-tree-more" title={`Thao tác ${entry.path}`} aria-label={`Thao tác ${entry.path}`} aria-expanded={menu === entry.path} disabled={busy} onClick={() => setMenu(menu === entry.path ? null : entry.path)}>⋯</button>
      </div>
      {menu === entry.path && !busy && <div className="insp-tree-actions" role="group" aria-label={`Thao tác ${entry.path}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null) } }}>
        {entry.directory && <><button title={`New File trong ${entry.path}`} aria-label={`New File trong ${entry.path}`} onClick={() => edit({ kind: 'file', parent: entry.path })}>+ File</button><button title={`New Folder trong ${entry.path}`} aria-label={`New Folder trong ${entry.path}`} onClick={() => edit({ kind: 'directory', parent: entry.path })}>+ Folder</button></>}
        <button title={`Rename ${entry.path}`} aria-label={`Rename ${entry.path}`} onClick={() => edit({ kind: 'rename', parent: parentPath(entry.path), entry })}>Rename</button>
        <button title={`Delete ${entry.path}`} aria-label={`Delete ${entry.path}`} onClick={() => { setMenu(null); void mutate(() => window.ame.deletePath(projectID, entry.path), result => { startNaming(null); onDelete(result.path) }) }}>Delete</button>
        <button title={`Copy Path ${entry.path}`} aria-label={`Copy Path ${entry.path}`} onClick={() => { setMenu(null); void mutate(async () => { if (!navigator.clipboard) throw new Error('Clipboard không khả dụng.'); await navigator.clipboard.writeText(entry.path) }, undefined, false) }}>Copy Path</button>
        <button title={`Reveal in OS ${entry.path}`} aria-label={`Reveal in OS ${entry.path}`} onClick={() => { setMenu(null); void mutate(() => window.ame.revealPath(projectID, entry.path), undefined, false) }}>Reveal in OS</button>
      </div>}
      {editing && <InlineName key={`${naming.kind}:${entry.path}`} label={naming.kind === 'rename' ? 'Tên mới' : naming.kind === 'file' ? 'Tên tệp mới' : 'Tên thư mục mới'} prefix={naming.parent} initial={naming.kind === 'rename' ? entry.name : ''} busy={busy} submit={submitName} cancel={() => startNaming(null)} />}
      {entry.directory && expanded[entry.path] && <Directory {...props} path={entry.path} />}
    </li>
  })}</ul>
}

function Explorer({ projectID, name, generation, onOpen, onRename, onDelete, busy, mutate }: {
  projectID: string; name?: string; generation: number; onOpen: InspectorProps['onOpen']; onRename: InspectorProps['onRename']; onDelete: InspectorProps['onDelete']; busy: boolean; mutate: Mutate
}) {
  const [naming, setNaming] = useState<Naming | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const finish = () => { if (alive.current) setNaming(null) }
  const submitName = (value: string) => {
    if (!naming) return
    const target = joinPath(naming.parent, value)
    if (naming.kind === 'rename' && naming.entry) {
      void mutate(() => window.ame.renamePath(projectID, naming.entry!.path, target), result => { onRename(result.from, result.to); finish() })
    } else if (naming.kind === 'directory') {
      void mutate(() => window.ame.createDirectory(projectID, target), finish)
    } else {
      void mutate(() => window.ame.createFile(projectID, target), finish)
    }
  }
  return <div data-testid="explorer">
    <div className="insp-folder-label"><Icon name="down" /><span className="truncate">{name}</span></div>
    <div className="insp-explorer-toolbar" role="group" aria-label="Explorer actions"><button title="New File ở thư mục gốc" aria-label="New File" disabled={busy} onClick={() => { setMenu(null); setNaming({ kind: 'file', parent: '' }) }}>+ File</button><button title="New Folder ở thư mục gốc" aria-label="New Folder" disabled={busy} onClick={() => { setMenu(null); setNaming({ kind: 'directory', parent: '' }) }}>+ Folder</button></div>
    {naming && naming.kind !== 'rename' && !naming.parent && <InlineName key={naming.kind} label={naming.kind === 'file' ? 'Tên tệp mới' : 'Tên thư mục mới'} busy={busy} submit={submitName} cancel={() => setNaming(null)} />}
    <Directory projectID={projectID} path="" generation={generation} onOpen={onOpen} busy={busy} naming={naming} startNaming={setNaming} submitName={submitName} menu={menu} setMenu={setMenu} mutate={mutate} onDelete={onDelete} />
  </div>
}

// A project switch unmounts pending UI work, including an A → B → A switch.
export function Inspector(props: InspectorProps) {
  return <ProjectInspector key={props.projectID || ''} {...props} />
}

function ProjectInspector({ projectID, name, tab, setTab, generation, git, gitError, refresh, onOpen, onRename, onDelete, onDiff, onHide, report }: InspectorProps) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  const [branches, setBranches] = useState<GitBranches>()
  const [branchError, setBranchError] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchRevision, setBranchRevision] = useState(0)
  const [newBranch, setNewBranch] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!projectID || tab !== 'git') return
    let current = true
    setBranchLoading(true)
    setBranchError('')
    void window.ame.gitBranches(projectID).then(result => { if (current) setBranches(result) }).catch(error => { if (current) { setBranches(undefined); if (!cancelled(error)) setBranchError(errorText(error)) } }).finally(() => { if (current) setBranchLoading(false) })
    return () => { current = false }
  }, [projectID, generation, tab, branchRevision])
  const mutate: Mutate = async (action, success, refreshAfter = true) => {
    if (pending.current || !alive.current) return
    pending.current = true
    setBusy(true)
    try {
      const result = await action()
      if (alive.current) {
        success?.(result)
        if (refreshAfter) { setBranchRevision(value => value + 1); refresh() }
      }
    } catch (error) { if (alive.current && !cancelled(error)) report(error) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const changes = git?.changes || []
  const commitState = { busy, message, changes }
  const submitCommit = () => {
    if (!projectID || !canCommit(commitState)) return
    void mutate(() => window.ame.commit(projectID, message.trim()), () => setMessage(''))
  }
  const branch = branches?.current ?? git?.branch ?? ''
  return <aside data-testid="inspector" className="inspector-pane" data-region="Project Inspector">
    <header className="inspector-pane__header"><span className="inspector-pane__title" title={name}><Icon name="folder" /><span className="truncate">{name || 'Project Inspector'}</span>{git?.branch && <span className="branch-tag">{git.branch}</span>}</span><IconButton label="Đóng Inspector (ẩn cố định)" onClick={onHide}><Icon name="left" /></IconButton></header>
    <nav className="inspector-mode-bar" aria-label="Inspector">{(['files', 'search', 'git'] as const).map(mode => <button key={mode} className={`inspector-mode-btn ${mode === 'git' ? 'inspector-mode-btn--icon' : ''} ${tab === mode ? 'is-active' : ''}`} title={mode === 'git' ? 'Git Diff' : mode === 'files' ? 'Explorer' : 'Search'} aria-pressed={tab === mode} onClick={() => setTab(mode)}>{mode === 'git' && <Icon name="git" />}{mode === 'files' ? 'Explorer' : mode === 'search' ? 'Search' : changes.length > 0 && <span className="diff-dot" />}</button>)}</nav>
    <div className="inspector-pane__body">{!projectID ? <Empty>Mở một thư mục để bắt đầu.</Empty> : tab === 'files' ? <Explorer projectID={projectID} name={name} generation={generation} onOpen={onOpen} onRename={onRename} onDelete={onDelete} busy={busy} mutate={mutate} /> : tab === 'search' ? <ProjectSearch key={projectID} projectID={projectID} generation={generation} refresh={refresh} onOpen={onOpen} /> : <>
      <div className="scm-branch-controls"><label htmlFor="inspector-branch">Branch</label><select id="inspector-branch" aria-label="Git branch" title={branch || 'Chọn nhánh'} value={branch} disabled={busy || branchLoading || !branches} onChange={event => { const next = event.target.value; if (next !== branch) void mutate(() => window.ame.checkoutBranch(projectID, next)) }}>
        {!branches?.branches.some(item => item.name === branch) && <option value={branch}>{branch || (branchLoading ? 'Đang đọc…' : 'Chưa có nhánh')}</option>}
        {branches?.branches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select><IconButton label="New Branch" disabled={busy} onClick={() => setNewBranch(value => !value)}>+</IconButton></div>
      {newBranch && <InlineName label="Tên nhánh mới" busy={busy} submit={value => void mutate(() => window.ame.createBranch(projectID, value, true), () => setNewBranch(false))} cancel={() => setNewBranch(false)} />}
      {branchError && <div className="inline-error" role="alert">{branchError}</div>}
      {gitError ? <div className="inline-error">{gitError}</div> : !git ? <Empty>Đang đọc trạng thái Git…</Empty> : !changes.length ? <Empty>Không có thay đổi. Cây làm việc sạch.</Empty> : (['staged', 'working'] as const).map(group => {
        const groupChanges = changes.filter(change => group === 'staged' ? !!change.index.trim() && !['?', '!'].includes(change.index) : !!change.working.trim() || change.index === '?')
        return groupChanges.length ? <section className="scm-section" key={group}><div className="scm-section__head"><span className="truncate">{group === 'staged' ? 'Staged Changes' : 'Changes'}</span><span className="scm-section__right"><span className="badge">{groupChanges.length}</span><IconButton label={group === 'staged' ? 'Unstage All' : 'Stage All'} disabled={busy} onClick={() => void mutate(() => group === 'staged' ? window.ame.unstageAll(projectID) : window.ame.stageAll(projectID))}>{group === 'staged' ? '−' : '+'}</IconButton></span></div>{groupChanges.map(change => <div className="scm-file-row" key={change.path}><button className="scm-file-row__main" title={`Diff với HEAD: ${change.path}`} onClick={() => onDiff(change.path)}><Icon name="file" /><span className="scm-file-name truncate">{change.path}</span></button><span className="git-badge">{group === 'staged' ? change.index : change.working.trim() || change.index}</span><IconButton label={group === 'staged' ? `Bỏ stage ${change.path}` : `Stage ${change.path}`} disabled={busy} onClick={() => void mutate(() => window.ame.stage(projectID, change.path, group !== 'staged'))}>{group === 'staged' ? '−' : '+'}</IconButton>{group === 'working' && <IconButton label={`Discard ${change.path}`} disabled={busy} onClick={() => void mutate(() => window.ame.discardFile(projectID, change.path))}>↩</IconButton>}</div>)}</section> : null
      })}
    </>}</div>
    {tab === 'git' && projectID && <form className="scm-commit-dock is-visible" onSubmit={e => { e.preventDefault(); submitCommit() }}><div className="scm-commit-input-wrap"><textarea aria-label="Thông điệp commit" className="scm-commit-textarea" rows={3} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => commitShortcut(e, commitState, submitCommit)} placeholder="Message (Ctrl/Cmd+Enter to commit)" /><div className="scm-commit-input-bar"><span className="muted">Skill /git-commit</span><button type="button" disabled title="AI commit enhancement chưa được kết nối">✦ Enhance</button></div></div><button className="scm-commit-btn" disabled={!canCommit(commitState)}>{busy ? 'Đang xử lý…' : '✓ Commit'}</button></form>}
    <footer className="inspector-pane__footer"><span>{tab === 'git' ? `${changes.length} changes` : tab === 'search' ? 'Project Search' : 'Explorer'}</span><IconButton label="Làm mới dự án" onClick={refresh}><Icon name="refresh" /></IconButton></footer>
  </aside>
}
