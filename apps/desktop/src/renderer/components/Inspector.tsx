import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DiffTarget, FileEntry, GitBranches, GitState } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { Empty, errorText, IconButton } from './Primitives'
import { canCommit, commitShortcut } from '../scm-commit'
import { gitStatusMeta, splitFilePath } from '../scm-display'
import { formatGitError, syncBadgeSummary } from '../git-ui'
import { FileTypeIcon } from '../components/FileTypeIcon'
import { WORKSPACE_DRAG_MIME } from '../composer-mentions'
import { ProjectSearch } from './ProjectSearch'
import { loadInstalledAccount } from '../buffer-recovery'

type Mutate = <T>(action: () => Promise<T>, success?: (result: T) => void, refreshAfter?: boolean, onError?: (error: unknown) => void) => Promise<void>
type Naming = { kind: 'file' | 'directory' | 'rename'; parent: string; entry?: FileEntry }
type ExplorerClipboard = { mode: 'copy' | 'cut'; projectID: string; path: string; directory: boolean } | null
let explorerClipboard: ExplorerClipboard = null
const clipboardSubscribers = new Set<() => void>()
function setExplorerClipboard(value: ExplorerClipboard) {
  explorerClipboard = value
  clipboardSubscribers.forEach(notify => notify())
}
const pasteDirectory = (entry: FileEntry | null) => entry ? entry.directory ? entry.path : parentPath(entry.path) : ''
type ExplorerMenu = { kind: 'file' | 'directory'; entry: FileEntry; x: number; y: number } | { kind: 'root'; x: number; y: number }
const emptyOSClipboard = { hasFiles: false, count: 0, names: [] as string[] }
type InspectorProps = {
  dirtyPaths?: ReadonlySet<string>
  projectID?: string; name?: string; connected?: boolean; tab: 'files' | 'search' | 'git'; setTab: (tab: 'files' | 'search' | 'git') => void; generation: number;
  git?: GitState; gitError: string; refresh: () => void; onOpen: (path: string, line?: number, column?: number) => void;
  onRename: (from: string, to: string) => void; onDelete: (path: string, targetProjectID?: string) => void;
  onDiff: (path: string, target?: DiffTarget) => void; onHide: () => void; report: (error: unknown) => void
  commitMessage?: string
  onCommitMessageChange?: (value: string) => void
  gitWorkspaceOpen?: boolean
  onOpenGitWorkspace?: (tab?: 'commit' | 'history' | 'stash' | 'build-notes') => void
  onOpenCommitAgent?: () => void
  onCommitEnhanceSkillChange?: (skill: string) => void
}

const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name
const cancelled = (error: unknown) => /\bCANCELLED\b/.test(errorText(error))
const withinPath = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`)
function rebaseEntry<T extends { path: string }>(entry: T, from: string, to: string): T {
  return withinPath(entry.path, from) ? { ...entry, path: to + entry.path.slice(from.length) } : entry
}

function InlineName({ label, prefix = '', initial = '', busy, submit, cancel }: {
  label: string; prefix?: string; initial?: string; busy: boolean; submit: (name: string) => void; cancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return <form className="insp-inline-name" onSubmit={event => { event.preventDefault(); if (!busy && value.trim()) submit(value.trim()) }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancel() } }}>
    {prefix && <span className="insp-inline-name__prefix truncate" title={prefix}>{prefix}/</span>}
    <div><input autoFocus aria-label={label} placeholder={label} value={value} disabled={busy} onChange={event => setValue(event.target.value)} onFocus={event => event.currentTarget.select()} />
      <button type="submit" title="Xác nhận (Enter)" aria-label="Xác nhận tên" disabled={busy || !value.trim()}><Icon name="check" /></button>
      <button type="button" title="Hủy (Escape)" aria-label="Hủy nhập tên" disabled={busy} onClick={cancel}><Icon name="close" /></button></div>
  </form>
}

type DirectoryProps = {
  projectID: string; path: string; generation: number; onOpen: InspectorProps['onOpen']; busy: boolean;
  naming: Naming | null; startNaming: (naming: Naming | null) => void; submitName: (name: string) => void;
  menu: ExplorerMenu | null; openMenu: (entry: FileEntry | null, x: number, y: number) => void; closeMenu: () => void;
  expanded: Record<string, boolean>; setExpanded: (update: (value: Record<string, boolean>) => Record<string, boolean>) => void;
  selected: FileEntry | null; select: (entry: FileEntry) => void; clipboard: ExplorerClipboard
}

function Directory(props: DirectoryProps) {
  const { projectID, path, generation, onOpen, busy, naming, startNaming, submitName, menu, openMenu, closeMenu, expanded = {}, setExpanded, selected, select, clipboard } = props
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void window.ame.entries(projectID, path).then(items => { if (alive) setEntries(items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))) }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectID, path, generation])
  return <ul className="file-tree" aria-label={path || 'Thư mục dự án'}>{error ? <li className="inline-error">{error}</li> : loading && !entries.length ? <li className="muted">Đang đọc…</li> : !entries.length ? <li className="muted">Thư mục trống</li> : entries.map(entry => {
    const editing = naming && (naming.kind === 'rename' ? naming.entry?.path === entry.path : naming.parent === entry.path)
    return <li key={entry.path}>
      <div className={`insp-tree-entry${selected?.path === entry.path ? ' is-selected' : ''}${clipboard?.mode === 'cut' && clipboard.projectID === projectID && clipboard.path === entry.path ? ' is-cut' : ''}`} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(entry, event.clientX, event.clientY) }}>
        <button className="tree-row insp-row" title={entry.path} onFocus={() => select(entry)} aria-expanded={entry.directory ? !!expanded[entry.path] : undefined} draggable={!entry.directory && !busy} onDragStart={event => {
          if (entry.directory || busy) { event.preventDefault(); return }
          event.dataTransfer.setData(WORKSPACE_DRAG_MIME, entry.path)
          event.dataTransfer.setData('text/plain', `@${entry.path}`)
          event.dataTransfer.effectAllowed = 'copy'
        }} onClick={() => { select(entry); entry.directory ? setExpanded(value => ({ ...value, [entry.path]: !value[entry.path] })) : onOpen(entry.path) }}><span className="file-symbol">{entry.directory ? <Icon name={expanded[entry.path] ? 'down' : 'chevron'} /> : <FileTypeIcon path={entry.path} />}</span><span className="truncate">{entry.name}</span></button>
        <button className="insp-tree-more" title={`Thao tác ${entry.path}`} aria-label={`Thao tác ${entry.path}`} onFocus={() => select(entry)} aria-haspopup="menu" aria-expanded={!!menu && menu.kind !== 'root' && menu.entry.path === entry.path} disabled={busy} onClick={event => { if (menu && menu.kind !== 'root' && menu.entry.path === entry.path) { closeMenu(); return } const rect = event.currentTarget.getBoundingClientRect(); openMenu(entry, rect.left, rect.bottom) }}><Icon name="more" /></button>
      </div>
      {editing && <InlineName key={`${naming.kind}:${entry.path}`} label={naming.kind === 'rename' ? 'Tên mới' : naming.kind === 'file' ? 'Tên tệp mới' : 'Tên thư mục mới'} prefix={naming.parent} initial={naming.kind === 'rename' ? entry.name : ''} busy={busy} submit={submitName} cancel={() => startNaming(null)} />}
      {entry.directory && expanded[entry.path] && <Directory {...props} path={entry.path} />}
    </li>
  })}</ul>
}

function Explorer({ projectID, name, generation, onOpen, onRename, onDelete, busy, mutate, dirtyPaths }: {
  dirtyPaths?: ReadonlySet<string>;
  projectID: string; name?: string; generation: number; onOpen: InspectorProps['onOpen']; onRename: InspectorProps['onRename']; onDelete: InspectorProps['onDelete']; busy: boolean; mutate: Mutate
}) {
  const [naming, setNaming] = useState<Naming | null>(null)
  const [menu, setMenu] = useState<ExplorerMenu | null>(null)
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [clipboard, setClipboard] = useState(explorerClipboard)
  const [osFiles, setOSFiles] = useState(emptyOSClipboard)
  const root = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const menuRequest = useRef(0)
  const closeMenu = () => { ++menuRequest.current; setMenu(null); root.current?.focus() }
  useEffect(() => {
    const update = () => setClipboard(explorerClipboard)
    clipboardSubscribers.add(update); update()
    return () => { clipboardSubscribers.delete(update) }
  }, [])
  const openMenu = (entry: FileEntry | null, x: number, y: number) => {
    if (busy) return
    setSelected(entry); setMenu(entry ? { kind: entry.directory ? 'directory' : 'file', entry, x, y } : { kind: 'root', x, y }); setOSFiles(emptyOSClipboard)
    const request = ++menuRequest.current
    void Promise.resolve().then(() => window.ame.clipboardFiles?.()).then(result => {
      if (alive.current && request === menuRequest.current) setOSFiles(result ?? emptyOSClipboard)
    }).catch(() => { /* Older hosts may not expose the OS clipboard API. */ })
  }
  useEffect(() => {
    const element = popover.current
    if (!menu || !element) return
    const rect = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`
  }, [menu, osFiles, clipboard])
  useEffect(() => {
    if (menu) popover.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])
  useEffect(() => {
    if (menu === null) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation()
      closeMenu()
    }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && (popover.current?.contains(target) || (root.current?.contains(target) && target.closest('.insp-tree-more')))) return
      setMenu(null)
    }
    window.addEventListener('keydown', escape)
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside) }
  }, [menu])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const finish = () => { if (alive.current) setNaming(null) }
  const renamed = (from: string, to: string) => {
    setSelected(value => {
      if (!value) return null
      const next = rebaseEntry(value, from, to)
      return next === value ? value : { ...next, name: splitFilePath(next.path).name }
    })
    if (explorerClipboard?.projectID === projectID && withinPath(explorerClipboard.path, from)) setExplorerClipboard(rebaseEntry(explorerClipboard, from, to))
    onRename(from, to)
  }
  const deleted = (path: string, targetProjectID = projectID) => {
    if (targetProjectID === projectID) setSelected(value => value && withinPath(value.path, path) ? null : value)
    if (explorerClipboard?.projectID === targetProjectID && withinPath(explorerClipboard.path, path)) setExplorerClipboard(null)
    onDelete(path, targetProjectID)
  }
  const expand = (path: string) => setExpanded(value => {
    const next = { ...value }
    for (let part = path; part; part = parentPath(part)) next[part] = true
    return next
  })
  const edit = (value: Naming) => { setMenu(null); expand(value.parent); setNaming(value) }
  const copy = (entry: FileEntry, mode: 'copy' | 'cut') => {
    setExplorerClipboard({ mode, projectID, path: entry.path, directory: entry.directory }); closeMenu()
  }
  const paste = (entry: FileEntry | null, os = false) => {
    if (busy) return
    const target = pasteDirectory(entry), source = os ? null : explorerClipboard
    closeMenu()
    void mutate(async () => {
      if (source?.mode === 'cut') {
        const result = await window.ame.movePath(projectID, source.projectID, source.path, target)
        if (result.moved) {
          if (explorerClipboard === source) setExplorerClipboard(null)
        }
        return result
      } else if (source) await window.ame.copyPath(projectID, source.projectID, source.path, target)
      else await window.ame.pasteClipboardFiles(projectID, target)
    }, result => {
      if (!alive.current) return
      if (result?.moved) {
        if (result.sameProject) renamed(result.from, result.to)
        else if (source) deleted(result.from, source.projectID)
      }
      expand(target)
    })
  }
  const submitName = (value: string) => {
    if (!naming) return
    const target = joinPath(naming.parent, value)
    if (naming.kind === 'rename' && naming.entry) {
      void mutate(() => window.ame.renamePath(projectID, naming.entry!.path, target), result => { renamed(result.from, result.to); finish() })
    } else if (naming.kind === 'directory') {
      void mutate(() => window.ame.createDirectory(projectID, target), () => { expand(naming.parent); finish() })
    } else {
      void mutate(() => window.ame.createFile(projectID, target), () => { expand(naming.parent); finish() })
    }
  }
  const entry = menu && menu.kind !== 'root' ? menu.entry : null
  const target = pasteDirectory(entry)
  const menuContent = menu && !busy && <div ref={popover} className="insp-tree-popover insp-context-menu" role="menu" aria-label={`Thao tác ${entry?.path || 'thư mục gốc'}`} style={{ position: 'fixed', left: Math.max(8, menu.x), top: Math.max(8, menu.y), right: 'auto', bottom: 'auto', maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }} onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}>
    {(!entry || entry.directory) && <><button role="menuitem" aria-label={`New File trong ${target}`} onClick={() => edit({ kind: 'file', parent: target })}><Icon name="filePlus" /><span>Tệp mới</span></button><button role="menuitem" aria-label={`New Folder trong ${target}`} onClick={() => edit({ kind: 'directory', parent: target })}><Icon name="folderPlus" /><span>Thư mục mới</span></button></>}
    {(!entry || entry.directory) && <div className="insp-tree-popover__sep" role="separator" />}
    {entry && <><button role="menuitem" aria-label={`Cut ${entry.path}`} onClick={() => copy(entry, 'cut')}><Icon name="scissors" /><span>Cắt</span><kbd className="insp-context-menu__kbd">Ctrl/Cmd+X</kbd></button><button role="menuitem" aria-label={`Copy ${entry.path}`} onClick={() => copy(entry, 'copy')}><Icon name="copy" /><span>Sao chép</span><kbd className="insp-context-menu__kbd">Ctrl/Cmd+C</kbd></button></>}
    <button role="menuitem" aria-label={clipboard ? `Paste ${splitFilePath(clipboard.path).name}` : 'Paste'} disabled={!clipboard && !osFiles.hasFiles} onClick={() => paste(entry)}><Icon name="clipboard" /><span>Dán</span><kbd className="insp-context-menu__kbd">Ctrl/Cmd+V</kbd></button>
    {clipboard && osFiles.hasFiles && <button role="menuitem" aria-label={`Paste OS trong ${target}`} onClick={() => paste(entry, true)}><Icon name="clipboard" /><span>Dán từ máy ({osFiles.count})</span></button>}
    <div className="insp-tree-popover__sep" role="separator" />
    {entry && <><button role="menuitem" aria-label={`Duplicate ${entry.path}`} onClick={() => { closeMenu(); void mutate(() => window.ame.copyPath(projectID, projectID, entry.path, parentPath(entry.path))) }}><Icon name="copy" /><span>Nhân bản</span></button><button role="menuitem" aria-label={`Rename ${entry.path}`} onClick={() => edit({ kind: 'rename', parent: parentPath(entry.path), entry })}><Icon name="pencil" /><span>Đổi tên</span></button></>}
    {entry && <button role="menuitem" aria-label={`Copy Path ${entry.path}`} onClick={() => { closeMenu(); void mutate(async () => { if (!navigator.clipboard) throw new Error('Clipboard không khả dụng.'); await navigator.clipboard.writeText(entry.path) }, undefined, false) }}><Icon name="copy" /><span>Sao chép đường dẫn</span></button>}
    <button role="menuitem" aria-label={`Reveal in OS ${entry?.path || ''}`} onClick={() => { closeMenu(); void mutate(() => window.ame.revealPath(projectID, entry?.path || ''), undefined, false) }}><Icon name="externalLink" /><span>Mở trong thư mục</span></button>
    {entry && <><div className="insp-tree-popover__sep" role="separator" /><button role="menuitem" className="insp-tree-popover__danger" aria-label={`Delete ${entry.path}`} onClick={() => { closeMenu(); const unsaved = [...(dirtyPaths ?? [])].filter(path => withinPath(path, entry.path)); if (unsaved.length && !window.confirm(`Các tệp có thay đổi chưa lưu: ${unsaved.join(', ')}. Vẫn xóa?`)) return; void mutate(() => window.ame.deletePath(projectID, entry.path), result => { setNaming(null); deleted(result.path) }) }}><Icon name="trash" /><span>Xóa</span></button></>}
  </div>
  return <div ref={root} data-testid="explorer" tabIndex={0} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(null, event.clientX, event.clientY) }} onKeyDown={event => {
    if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]') || busy) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (menu) closeMenu(); else if (explorerClipboard?.mode === 'cut') setExplorerClipboard(null); return }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    const key = event.key.toLowerCase()
    if ((key === 'c' || key === 'x') && selected) { event.preventDefault(); event.stopPropagation(); copy(selected, key === 'x' ? 'cut' : 'copy') }
    if (key === 'v') { event.preventDefault(); event.stopPropagation(); paste(selected) }
  }}>
    <div className="insp-folder-label" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(null, event.clientX, event.clientY) }}><Icon name="down" /><span className="truncate" title={name}>{name}</span>
      <div className="insp-explorer-toolbar" role="group" aria-label="Explorer actions"><button title="New File ở thư mục gốc" aria-label="New File" disabled={busy} onClick={() => { setMenu(null); setNaming({ kind: 'file', parent: '' }) }}><Icon name="filePlus" /></button><button title="New Folder ở thư mục gốc" aria-label="New Folder" disabled={busy} onClick={() => { setMenu(null); setNaming({ kind: 'directory', parent: '' }) }}><Icon name="folderPlus" /></button></div>
    </div>
    {naming && naming.kind !== 'rename' && !naming.parent && <InlineName key={naming.kind} label={naming.kind === 'file' ? 'Tên tệp mới' : 'Tên thư mục mới'} busy={busy} submit={submitName} cancel={() => setNaming(null)} />}
    <Directory projectID={projectID} path="" generation={generation} onOpen={onOpen} busy={busy} naming={naming} startNaming={setNaming} submitName={submitName} menu={menu} openMenu={openMenu} closeMenu={closeMenu} expanded={expanded} setExpanded={setExpanded} selected={selected} select={setSelected} clipboard={clipboard} />
    {menuContent && (typeof document === 'undefined' ? menuContent : createPortal(menuContent, document.body))}
  </div>
}

// A project switch unmounts pending UI work, including an A → B → A switch.
export function Inspector(props: InspectorProps) {
  return <ProjectInspector key={props.projectID || ''} {...props} />
}

function ProjectInspector({ projectID, name, connected = false, tab, setTab, generation, git, gitError, refresh, onOpen, onRename, onDelete, onDiff, onHide, report, commitMessage, onCommitMessageChange, gitWorkspaceOpen, onOpenGitWorkspace, onOpenCommitAgent, onCommitEnhanceSkillChange, dirtyPaths }: InspectorProps) {
  const [localMessage, setLocalMessage] = useState('')
  const message = commitMessage ?? localMessage
  const setMessage = (next: string) => {
    if (onCommitMessageChange) onCommitMessageChange(next)
    else setLocalMessage(next)
  }
  const [enhancing, setEnhancing] = useState(false)
  const [commitError, setCommitError] = useState('')
  useEffect(() => { setCommitError('') }, [projectID, tab])
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  const [branches, setBranches] = useState<GitBranches>()
  const [branchError, setBranchError] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchRevision, setBranchRevision] = useState(0)
  const [newBranch, setNewBranch] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [targetBranch, setTargetBranch] = useState('')
  const [commitEnhanceSkill, setCommitEnhanceSkill] = useState('')
  const skillChange = useRef(onCommitEnhanceSkillChange)
  skillChange.current = onCommitEnhanceSkillChange
  const [foldedSections, setFoldedSections] = useState({ staged: false, working: false })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!projectID || tab !== 'git') return
    let current = true, revision = 0
    const updateSkill = (skill: string) => {
      setCommitEnhanceSkill(skill)
      skillChange.current?.(skill)
    }
    const load = async (event: Event | boolean = true) => {
      const request = ++revision
      updateSkill('')
      try {
        const value = await loadInstalledAccount(() => window.ame?.account?.('installed', {}), !!event)
        if (current && request === revision) updateSkill((value as { features?: { commitEnhanceSkill?: string } } | null)?.features?.commitEnhanceSkill || '')
      } catch { if (current && request === revision) updateSkill('') }
    }
    void load(false)
    window.addEventListener('ame-account-changed', load)
    window.addEventListener('ame-bundle-updated', load)
    return () => { current = false; window.removeEventListener('ame-account-changed', load); window.removeEventListener('ame-bundle-updated', load) }
  }, [projectID, tab])
  useEffect(() => {
    if (!projectID || tab !== 'git') return
    let current = true
    setBranchLoading(true)
    setBranchError('')
    void window.ame.gitBranches(projectID).then(result => { if (current) setBranches(result) }).catch(error => { if (current) { setBranches(undefined); if (!cancelled(error)) setBranchError(errorText(error)) } }).finally(() => { if (current) setBranchLoading(false) })
    return () => { current = false }
  }, [projectID, generation, tab, branchRevision])
  const mutate: Mutate = async (action, success, refreshAfter = true, onError = report) => {
    if (pending.current || !alive.current) return
    pending.current = true
    setBusy(true)
    try {
      const result = await action()
      if (alive.current) {
        setCommitError('')
        success?.(result)
        if (refreshAfter) { setBranchRevision(value => value + 1); refresh() }
      }
    } catch (error) { if (alive.current && !cancelled(error)) onError(error) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const changes = git?.changes || []
  const stagedChanges = changes.filter(change => !!change.index.trim() && !['?', '!'].includes(change.index))
  const enhanceTitle = !connected ? 'Chưa kết nối OpenCode' : !stagedChanges.length ? 'Stage ít nhất một tệp để tạo thông điệp commit' : busy ? 'Đang xử lý…' : commitEnhanceSkill ? `Tạo thông điệp commit bằng AI (Skill /${commitEnhanceSkill})` : 'Tạo thông điệp commit bằng AI từ thay đổi đã stage'
  const commitState = { busy, message, changes }
  const showGitError = (error: unknown) => {
    const { title, detail } = formatGitError(error)
    setCommitError(detail ? `${title}: ${detail}` : title)
  }
  const sync = syncBadgeSummary(git)
  const syncRemote = (action: 'fetch' | 'pull' | 'push') => {
    if (!projectID || !sync.canSync) return
    void mutate(() => {
      setCommitError('')
      return action === 'fetch' ? window.ame.gitFetch(projectID) : action === 'pull' ? window.ame.gitPull(projectID) : window.ame.gitPush(projectID, sync.needsPublish ? { setUpstream: true } : undefined)
    }, undefined, true, showGitError)
  }
  const submitCommit = () => {
    if (!projectID || !canCommit(commitState)) return
    void mutate(() => {
      setCommitError('')
      return window.ame.commit(projectID, message.trim())
    }, () => setMessage(''), true, showGitError)
  }
  const enhanceCommit = () => {
    if (!projectID || !connected || !stagedChanges.length) return
    void mutate(async () => {
      setEnhancing(true)
      setCommitError('')
      try { return await window.ame.generateCommitMessage(projectID) }
      finally { if (alive.current) setEnhancing(false) }
    }, result => setMessage(result.message), false, error => setCommitError(errorText(error)))
  }
  const branch = branches?.current ?? git?.branch ?? ''
  const deletableBranches = branches?.branches.filter(item => item.name !== branch && !item.current) ?? []
  const canDeleteBranch = deletableBranches.some(item => item.name === targetBranch)
  return <aside data-testid="inspector" className="inspector-pane" data-region="Project Inspector">
    <header className="inspector-pane__header"><span className="inspector-pane__title" title={name}><Icon name="folder" /><span className="truncate">{name || 'Project Inspector'}</span>{git?.branch && <span className="branch-tag">{git.branch}</span>}</span><IconButton label="Đóng Inspector (ẩn cố định)" onClick={onHide}><Icon name="left" /></IconButton></header>
    <nav className="inspector-mode-bar" aria-label="Inspector">{(['files', 'search', 'git'] as const).map(mode => <button key={mode} className={`inspector-mode-btn ${tab === mode ? 'is-active' : ''}`} title={mode === 'git' ? 'Git Diff' : mode === 'files' ? 'Explorer' : 'Search'} aria-label={mode === 'git' ? 'Git Diff' : mode === 'files' ? 'Explorer' : 'Search'} aria-pressed={tab === mode} onClick={() => setTab(mode)}><Icon name={mode === 'files' ? 'folder' : mode === 'search' ? 'search' : 'git'} />{mode === 'git' && changes.length > 0 && <span className="diff-dot" />}</button>)}</nav>
    <div className="inspector-pane__body">{!projectID ? <Empty>Mở một thư mục để bắt đầu.</Empty> : tab === 'files' ? <Explorer dirtyPaths={dirtyPaths} projectID={projectID} name={name} generation={generation} onOpen={onOpen} onRename={onRename} onDelete={onDelete} busy={busy} mutate={mutate} /> : tab === 'search' ? <ProjectSearch key={projectID} projectID={projectID} generation={generation} refresh={refresh} onOpen={onOpen} /> : <>
      <div className="scm-branch-controls"><label htmlFor="inspector-branch">Branch</label><select id="inspector-branch" aria-label="Git branch" title={branch || 'Chọn nhánh'} value={branch} disabled={busy || branchLoading || !branches} onChange={event => { const next = event.target.value; if (next !== branch) void mutate(() => window.ame.checkoutBranch(projectID, next)) }}>
        {!branches?.branches.some(item => item.name === branch) && <option value={branch}>{branch || (branchLoading ? 'Đang đọc…' : 'Chưa có nhánh')}</option>}
        <optgroup label="Nhánh cục bộ">{branches?.branches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</optgroup>
        {!!branches?.remoteBranches?.length && <optgroup label="Nhánh từ xa (Remote)">{branches.remoteBranches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</optgroup>}
      </select><IconButton label="New Branch" disabled={busy} onClick={() => setNewBranch(value => !value)}><Icon name="plus" /></IconButton><IconButton label="Xóa nhánh" disabled={busy || (branches?.branches.length ?? 0) <= 1} onClick={() => { setDeleteBranch(value => !value); setTargetBranch('') }}><Icon name="trash" /></IconButton></div>
      <div className="scm-sync-bar" data-testid="scm-sync-bar" role="group" aria-label="Đồng bộ remote">
        <button type="button" data-testid="scm-fetch-btn" disabled={!sync.canSync || busy} title="Fetch từ remote" onClick={() => syncRemote('fetch')}>Fetch</button>
        <button type="button" data-testid="scm-pull-btn" disabled={!sync.canSync || busy} onClick={() => syncRemote('pull')}>{sync.pullLabel}</button>
        <button type="button" data-testid="scm-push-btn" disabled={!sync.canSync || busy} onClick={() => syncRemote('push')}>{sync.pushLabel}</button>
        <IconButton label="Lịch sử commit" disabled={!projectID} onClick={() => onOpenGitWorkspace?.('history')}><Icon name="history" /></IconButton>
        <span data-testid="scm-commit-agent-btn"><IconButton label="Trợ lý Commit AI (phân tích & tách commit)" disabled={!projectID || !onOpenCommitAgent} onClick={() => onOpenCommitAgent?.()}><Icon name="wand" /></IconButton></span>
        <IconButton label="Quản lý Stash" disabled={!projectID} onClick={() => onOpenGitWorkspace?.('stash')}><Icon name="stash" /></IconButton>
        <IconButton label="Mô tả bản build (QC)" disabled={!projectID} onClick={() => onOpenGitWorkspace?.('build-notes')}><Icon name="notes" /></IconButton>
      </div>
      {deleteBranch && <form className="insp-inline-name" aria-label="Xóa nhánh cục bộ" onSubmit={event => {
        event.preventDefault()
        if (!canDeleteBranch) return
        void mutate(() => window.ame.gitDeleteBranch(projectID, targetBranch), () => { setDeleteBranch(false); setTargetBranch('') }, true, showGitError)
      }}><div><select aria-label="Nhánh cần xóa" value={canDeleteBranch ? targetBranch : ''} disabled={busy} onChange={event => setTargetBranch(event.target.value)}>
        <option value="">Chọn nhánh cần xóa</option>{deletableBranches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select><button type="submit" title="Xác nhận xóa nhánh" aria-label="Xác nhận xóa nhánh" disabled={busy || !canDeleteBranch}><Icon name="check" /></button><button type="button" title="Hủy xóa nhánh" aria-label="Hủy xóa nhánh" disabled={busy} onClick={() => setDeleteBranch(false)}><Icon name="close" /></button></div></form>}
      {newBranch && <InlineName label="Tên nhánh mới" busy={busy} submit={value => void mutate(() => window.ame.createBranch(projectID, value, true), () => setNewBranch(false))} cancel={() => setNewBranch(false)} />}
      {branchError && <div className="inline-error" role="alert">{branchError}</div>}
      {gitError ? <div className="inline-error">{gitError}</div> : !git ? <Empty>Đang đọc trạng thái Git…</Empty> : !changes.length ? <Empty>Không có thay đổi. Cây làm việc sạch.</Empty> : (['staged', 'working'] as const).map(group => {
        const groupChanges = changes.filter(change => group === 'staged' ? !!change.index.trim() && !['?', '!'].includes(change.index) : !!change.working.trim() || change.index === '?')
        const folded = foldedSections[group]
        return groupChanges.length ? <section className={`scm-section${folded ? ' is-folded' : ''}`} key={group}>
          <div className="scm-section__head">
            <button type="button" className="scm-section__toggle" aria-expanded={!folded} onClick={() => setFoldedSections(value => ({ ...value, [group]: !value[group] }))}>
              <span className="scm-section__left"><span className="scm-chevron"><Icon name="down" /></span><span className="truncate">{group === 'staged' ? 'Staged Changes' : 'Changes'}</span></span>
            </button>
            <span className="scm-section__right">
              <span className="scm-section__actions"><IconButton label={group === 'staged' ? 'Unstage All' : 'Stage All'} disabled={busy} onClick={() => void mutate(() => group === 'staged' ? window.ame.unstageAll(projectID) : window.ame.stageAll(projectID))}><Icon name={group === 'staged' ? 'minus' : 'plus'} /></IconButton></span>
              <span className="scm-count-pill">{groupChanges.length}</span>
            </span>
          </div>
          <div className="scm-list">{groupChanges.map(change => {
            const rawStatus = group === 'staged' ? change.index.trim() : change.working.trim() || change.index.trim()
            const meta = gitStatusMeta(rawStatus)
            const { name, dir } = splitFilePath(change.path)
            return <div className="scm-file-row" data-status={meta.dataStatus} key={change.path}>
              <button type="button" className="scm-file-row__main" data-git-group={group} data-git-path={change.path} title={`${group === 'staged' ? 'Staged' : 'Changes'}: ${change.from ? `${change.from} → ` : ''}${change.path}`} onClick={() => onDiff(change.path, { kind: group, ...(group === 'staged' && change.from ? { from: change.from } : {}) })}>
                <FileTypeIcon path={change.path} /><span className="scm-file-name">{name}</span>{dir && <span className="scm-file-dir">{dir}</span>}
              </button>
              <div className="scm-file-row__right">
                <span className="scm-row-actions">
                  <IconButton label={group === 'staged' ? `Bỏ stage ${change.path}` : `Stage ${change.path}`} disabled={busy} onClick={() => void mutate(() => window.ame.stage(projectID, change.path, group !== 'staged', group === 'staged' ? change.from : undefined))}><Icon name={group === 'staged' ? 'minus' : 'plus'} /></IconButton>
                  {group === 'working' && <IconButton label={`Discard ${change.path}`} disabled={busy} onClick={() => void mutate(() => window.ame.discardFile(projectID, change.path))}><Icon name="undo" /></IconButton>}
                </span>
                <span className={`git-badge git-badge--${meta.dataStatus}`} title={meta.label}>{meta.code}</span>
              </div>
            </div>
          })}</div>
        </section> : null
      })}
    </>}</div>
    {tab === 'git' && projectID && <form className="scm-commit-dock is-visible" onSubmit={e => { e.preventDefault(); submitCommit() }}><div className="scm-commit-input-wrap"><textarea aria-label="Thông điệp commit" className="scm-commit-textarea" rows={3} value={message} onChange={e => { setMessage(e.target.value); setCommitError('') }} onKeyDown={e => commitShortcut(e, commitState, submitCommit)} placeholder="Message (Ctrl/Cmd+Enter to commit)" /><div className="scm-commit-input-bar"><button type="button" className={`scm-enhance-icon-btn${enhancing ? ' is-loading' : ''}`} aria-busy={enhancing || undefined} disabled={!connected || busy || !stagedChanges.length} title={enhancing ? 'Đang tạo thông điệp commit…' : enhanceTitle} aria-label={enhancing ? 'Đang tạo thông điệp commit…' : enhanceTitle} data-testid="scm-enhance-btn" onClick={enhanceCommit}>{enhancing ? <span className="amekit-spinner" aria-hidden="true" /> : <Icon name="wand" />}</button><button type="button" className="scm-expand-icon-btn" data-testid="scm-expand-commit-btn" aria-pressed={gitWorkspaceOpen || undefined} title={gitWorkspaceOpen ? 'Thu gọn về thanh bên' : 'Mở rộng khu soạn commit ra vùng giữa'} aria-label={gitWorkspaceOpen ? 'Thu gọn khu soạn commit' : 'Mở rộng khu soạn commit'} onClick={() => onOpenGitWorkspace?.('commit')}><Icon name="expand" /></button></div></div>{commitError && <div className="inline-error scm-commit-error" data-testid="scm-commit-error" role="alert">{commitError}</div>}<button className="scm-commit-btn" disabled={!canCommit(commitState)}>{busy ? 'Đang xử lý…' : <><Icon name="check" /> Commit</>}</button></form>}
    <footer className="inspector-pane__footer"><span>{tab === 'git' ? `${changes.length} changes` : tab === 'search' ? 'Project Search' : 'Explorer'}</span><IconButton label="Làm mới dự án" onClick={refresh}><Icon name="refresh" /></IconButton></footer>
  </aside>
}
