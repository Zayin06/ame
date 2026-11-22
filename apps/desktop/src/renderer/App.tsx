import { useCallback, useEffect, useRef, useState } from 'react'
import type { Connection, GitState, Project, Session, TerminalInfo } from '../../../../packages/protocol/src/index'
import { activateTab, defaults, dirty, documentID, languageFor, parsePreferences, projectDirtyPaths, reconcileDocument, removeTab, savedDocument, selectedTab, tabID, withoutKey, withoutProject, withoutProjectDocuments, type Buffer, type Pane, type Preferences, type ProjectView, type Tab } from './state'
import { Icon } from './components/Icon'
import { ProjectRail } from './components/ProjectRail'
import type { CSSProperties } from 'react'
import { Chat } from './components/Chat'
import { EditorStage, type EditorStatus } from './components/EditorStage'
import { QuickOpen } from './components/QuickOpen'
import { UsagePanel } from './components/UsagePanel'
import type { SessionUsageView } from '../../../../packages/protocol/src/index'
import { closeTabInGroup, createSplitState, deleteInSplitState, focusGroup, openTabInGroup, renameInSplitState, selectTabInGroup, splitRight, unsplit, type EditorGroupID, type EditorSplitState } from './editor-split'
import { Inspector } from './components/Inspector'
import { Empty, errorText, IconButton, Modal, Resizer } from './components/Primitives'
import { Settings } from './components/Settings'
import { SessionChanges } from './components/SessionChanges'
import { watchSessionChanges, type SessionChangesState } from './session-changes'
import { TerminalPanel } from './components/TerminalPanel'
import { createProjectTerminal, isTerminalKey, newTerminalShortcut } from './terminal-controls'
import { changePathDocuments, deleteFromView, renameBuffers, renamedPath, renameView, type NavigationTarget } from './workspace-paths'

const storageKey = 'ame.ide.layout.v1'
const readPreferences = () => { try { return parsePreferences(localStorage.getItem(storageKey)) } catch { return defaults() } }
const emptyView: ProjectView = { tabs: [] }
export function App() {
  const [preferences, setPreferences] = useState<Preferences>(readPreferences)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessionCache, setSessionCache] = useState<Record<string, Session[]>>({})
  const sessionCacheRef = useRef(sessionCache); sessionCacheRef.current = sessionCache
  const [sessionError, setSessionError] = useState('')
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [connection, setConnection] = useState<Connection>({ connected: false, url: '' })
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const [diffs, setDiffs] = useState<Record<string, { original: string; modified: string }>>({})
  const [git, setGit] = useState<GitState>()
  const [gitError, setGitError] = useState('')
  const [generation, setGeneration] = useState(0)
  const [sessionGeneration, setSessionGeneration] = useState(0)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'settings' | 'account' | 'palette' | null>(null)
  const [query, setQuery] = useState('')
  const [xray, setXray] = useState(false)
  const [creating, setCreating] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [createdTerminal, setCreatedTerminal] = useState<TerminalInfo>()
  const [navigation, setNavigation] = useState<NavigationTarget>()
  const [splits, setSplits] = useState<Record<string, EditorSplitState>>({})
  const splitsRef = useRef(splits); splitsRef.current = splits
  const [editorStatuses, setEditorStatuses] = useState<Record<string, EditorStatus>>({})
  const [quickOpen, setQuickOpen] = useState<'files' | 'line'>()
  const [filesRequested, setFilesRequested] = useState(false)
  const [fileIndex, setFileIndex] = useState<{ key: string; files: string[]; loading: boolean; error?: string }>()
  const [usage, setUsage] = useState<{ key: string; value?: SessionUsageView; loading: boolean; error?: string }>()
  const [usageAttempt, setUsageAttempt] = useState(0)
  const navigationNonce = useRef(0)
  const pathsEpoch = useRef(0)
  const removedProjects = useRef(new Set<string>())
  const projectsRef = useRef(projects); projectsRef.current = projects
  const buffersRef = useRef(buffers); buffersRef.current = buffers
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences
  const saving = useRef(new Set<string>())
  const pendingReads = useRef(new Set<string>())
  const projectID = preferences.project
  const sessions = projectID ? sessionCache[projectID] || [] : []
  const project = projects.find(p => p.id === projectID)
  const view = projectID ? preferences.projects[projectID] || emptyView : emptyView
  const splitState = projectID && splits[projectID] || createSplitState(view.tabs.filter(tab => tab.mode === 'file'), selectedTab(view, 'file'))
  const focusedGroup = splitState[splitState.focused] || splitState.primary
  const activeTab = preferences.panel === 'diff' ? selectedTab(view, 'diff') : focusedGroup.active
  const editorStatus = projectID && activeTab ? editorStatuses[JSON.stringify([projectID, splitState.focused, activeTab.path])] : undefined
  const fileIndexKey = JSON.stringify([projectID, generation])
  const files = fileIndex?.key === fileIndexKey ? fileIndex.files : []
  const usageKey = JSON.stringify([projectID, view.session, connection.url])
  const activeBuffer = projectID && activeTab ? buffers[documentID(projectID, activeTab.path)] : undefined
  const activeSession = sessions.find(s => s.id === view.session)
  const [sessionChanges, setSessionChanges] = useState<{ key: string; state: SessionChangesState }>()
  const [changesAttempt, setChangesAttempt] = useState(0)
  const changesKey = JSON.stringify([projectID, view.session, connection.url])
  const changesState: SessionChangesState = !projectID || !view.session ? { status: 'ready', files: [] } : !connection.connected ? { status: 'error', files: [], error: connection.error || 'Chưa kết nối OpenCode.' } : sessionChanges?.key === changesKey ? sessionChanges.state : { status: 'loading', files: [] }
  useEffect(() => {
    if (!projectID || !view.session || !connection.connected || !window.ame) return
    return watchSessionChanges(window.ame, projectID, view.session, state => setSessionChanges({ key: changesKey, state }))
  }, [projectID, view.session, connection.connected, changesKey, changesAttempt])
  const report = useCallback((e: unknown) => setError(errorText(e)), [])
  const refresh = useCallback(() => setGeneration(g => g + 1), [])
  const refreshSessions = useCallback(() => setSessionGeneration(g => g + 1), [])
  const updateView = useCallback((id: string, update: (view: ProjectView) => ProjectView) => setPreferences(p => removedProjects.current.has(id) ? p : ({ ...p, projects: { ...p.projects, [id]: update(p.projects[id] || { tabs: [] }) } })), [])
  const toggle = (pane: Pane) => setPreferences(p => ({ ...p, [pane]: !p[pane] }))
  const setWidth = (pane: Pane, width: number) => setPreferences(p => ({ ...p, widths: { ...p.widths, [pane]: width } }))

  const requestFiles = () => setFilesRequested(true)
  const showQuickOpen = (mode: 'files' | 'line') => { requestFiles(); setQuickOpen(mode) }
  useEffect(() => {
    if (!projectID || !filesRequested || !window.ame) return
    let alive = true
    setFileIndex({ key: fileIndexKey, files: [], loading: true })
    void window.ame.listFiles(projectID).then(files => { if (alive) setFileIndex({ key: fileIndexKey, files, loading: false }) }).catch(e => { if (alive) setFileIndex({ key: fileIndexKey, files: [], loading: false, error: errorText(e) }) })
    return () => { alive = false }
  }, [projectID, fileIndexKey, filesRequested])
  useEffect(() => {
    if (preferences.panel !== 'usage' || !projectID || !view.session || !window.ame) return
    let alive = true
    setUsage({ key: usageKey, loading: true })
    void window.ame.sessionUsage(projectID, view.session).then(value => { if (alive) setUsage({ key: usageKey, value, loading: false }) }).catch(e => { if (alive) setUsage({ key: usageKey, loading: false, error: errorText(e) }) })
    return () => { alive = false }
  }, [preferences.panel, projectID, view.session, usageKey, usageAttempt])

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.dataset.workspaceTint = preferences.tint
    document.documentElement.dataset.layoutMode = preferences.layoutMode
    document.documentElement.style.setProperty('--chat-max-w', `${preferences.chatWidth}px`)
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)) } catch { /* Storage may be disabled; editing remains available. */ }
  }, [preferences])
  useEffect(() => {
    if (!window.ame) { setError('Không tìm thấy cầu nối desktop. Hãy mở Ame bằng ứng dụng Electron.'); setProjectsLoading(false); return }
    let alive = true
    void window.ame.projects().then(items => { if (alive) { setProjects(items); setPreferences(p => ({ ...p, project: items.some(item => item.id === p.project) ? p.project : items[0]?.id })) } }).catch(report).finally(() => { if (alive) setProjectsLoading(false) })
    void window.ame.connection().then(value => { if (alive) setConnection(value) }).catch(report)
    const fileTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let chatTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.ame.onEvent(event => {
      if (event.type === 'connection') { setConnection(event.connection); refreshSessions(); window.dispatchEvent(new Event('ame-account-changed')); return }
      if (event.type === 'terminal') return
      if (event.type === 'opencode') {
        if (event.projectID === preferencesRef.current.project && !chatTimer) chatTimer = setTimeout(() => { chatTimer = undefined; refreshSessions() }, 300)
        return
      }
      clearTimeout(fileTimers.get(event.projectID))
      fileTimers.set(event.projectID, setTimeout(() => {
        fileTimers.delete(event.projectID)
        if (event.projectID === preferencesRef.current.project) refresh()
        for (const [id, buffer] of Object.entries(buffersRef.current)) {
          if (buffer.projectID !== event.projectID) continue
          void window.ame.read(buffer.projectID, buffer.path).then(incoming => { if (alive) setBuffers(current => current[id] ? { ...current, [id]: reconcileDocument(current[id], incoming) } : current) }).catch(() => {
            if (alive) setBuffers(current => current[id] ? { ...current, [id]: { ...current[id], conflict: true } } : current)
          })
        }
      }, 180))
    })
    return () => { alive = false; unsubscribe(); for (const timer of fileTimers.values()) clearTimeout(timer); clearTimeout(chatTimer) }
  }, [report, refresh, refreshSessions])
  useEffect(() => {
    if (!window.ame) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!Object.values(buffersRef.current).some(dirty)) return
      // Electron main handles the prevented close with a native discard confirmation.
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
  useEffect(() => {
    setSessionError('')
  }, [projectID, connection.connected])
  useEffect(() => {
    if (!projectID || !connection.connected || !window.ame) { setSessionsLoading(false); return }
    let alive = true
    setSessionsLoading(true)
    void window.ame.sessions(projectID).then(items => {
      if (!alive || removedProjects.current.has(projectID)) return
      setSessionCache(current => ({ ...current, [projectID]: items })); setSessionError('')
      updateView(projectID, current => ({ ...current, session: items.some(s => s.id === current.session) ? current.session : items[0]?.id }))
    }).catch(e => { if (alive) setSessionError(errorText(e)) }).finally(() => { if (alive) setSessionsLoading(false) })
    return () => { alive = false }
  }, [projectID, connection.connected, sessionGeneration, updateView])
  useEffect(() => { setGit(undefined); setGitError('') }, [projectID])
  useEffect(() => {
    if (!projectID || !window.ame) return
    let alive = true
    void window.ame.git(projectID).then(value => { if (alive) { setGit(value); setGitError('') } }).catch(e => { if (alive) { setGit(undefined); setGitError(errorText(e)) } })
    return () => { alive = false }
  }, [projectID, generation])
  const loadFile = useCallback(async (id: string, path: string) => {
    const key = documentID(id, path)
    if (buffersRef.current[key] || pendingReads.current.has(key)) return
    pendingReads.current.add(key)
    const epoch = pathsEpoch.current
    try {
      const doc = await window.ame.read(id, path)
      if (removedProjects.current.has(id) || epoch !== pathsEpoch.current) return
      setBuffers(current => current[key] ? current : { ...current, [key]: { ...doc, projectID: id, text: doc.content, conflict: false } })
    } catch (e) { if (epoch === pathsEpoch.current) report(e) } finally { pendingReads.current.delete(key); if (epoch !== pathsEpoch.current) refresh() }
  }, [report, refresh])
  const visibleFiles = JSON.stringify([splitState.primary.active?.path, splitState.secondary?.active?.path])
  useEffect(() => {
    if (!projectID || !window.ame) return
    for (const path of JSON.parse(visibleFiles) as (string | null)[]) if (path) void loadFile(projectID, path)
  }, [projectID, visibleFiles, loadFile, generation])
  useEffect(() => {
    if (!projectID || !activeTab || activeTab.mode !== 'diff' || !window.ame) return
    let alive = true
    const key = documentID(projectID, activeTab.path)
    void window.ame.diff(projectID, activeTab.path).then(value => { if (alive && !removedProjects.current.has(projectID)) setDiffs(current => ({ ...current, [key]: value })) }).catch(e => { if (alive) report(e) })
    return () => { alive = false }
  }, [projectID, activeTab?.path, activeTab?.mode, generation, report])

  const pickProject = async () => {
    try { const selected = await window.ame.pickProject(); if (selected) { removedProjects.current.delete(selected.id); setProjects(current => current.some(p => p.id === selected.id) ? current : [...current, selected]); setPreferences(p => ({ ...p, project: selected.id })); refresh() } } catch (e) { report(e) }
  }
  const removeProject = async (id: string) => {
    try {
      await window.ame.removeProject(id)
      removedProjects.current.add(id)
      const remaining = projectsRef.current.filter(project => project.id !== id)
      projectsRef.current = remaining
      setProjects(remaining)
      setSessionCache(current => withoutKey(current, id))
      setSplits(current => withoutKey(current, id))
      setBuffers(current => withoutProjectDocuments(current, id))
      setDiffs(current => withoutProjectDocuments(current, id))
      setPreferences(current => withoutProject(current, id, remaining))
      setCreatedTerminal(current => current?.projectID === id ? undefined : current)
    } catch (e) { if (!errorText(e).includes('CANCELLED')) report(e) }
  }
  const newTerminal = async () => {
    setPreferences(p => ({ ...p, stage: true, terminalOpen: true, layoutMode: 'swe' }))
    try {
      const item = await createProjectTerminal(window.ame, projectID)
      if (item && !removedProjects.current.has(item.projectID)) setCreatedTerminal(item)
    } catch (e) { report(e) }
  }
  const createSession = async (id = projectID) => {
    if (!id || !connection.connected || creating) return
    setCreating(true)
    try {
      const session = await window.ame.createSession(id)
      if (removedProjects.current.has(id)) return
      updateView(id, current => ({ ...current, session: session.id }))
      setPreferences(current => ({ ...current, project: id }))
      setSessionCache(current => ({ ...current, [id]: [session, ...(current[id] || []).filter(s => s.id !== session.id)] }))
      refreshSessions()
    } catch (e) { report(e) } finally { setCreating(false) }
  }
  const updateSplit = (id: string, update: (state: EditorSplitState) => EditorSplitState) => {
    setSplits(current => {
      const saved = preferencesRef.current.projects[id] || emptyView
      return { ...current, [id]: update(current[id] || createSplitState(saved.tabs.filter(tab => tab.mode === 'file'), selectedTab(saved, 'file'))) }
    })
  }
  const toggleSplit = () => {
    if (!projectID) return
    setPreferences(current => ({ ...current, panel: 'files', stage: true }))
    updateSplit(projectID, current => current.secondary ? unsplit(current) : splitRight(current))
  }
  const openTab = (path: string, mode: Tab['mode'], line?: number, column?: number) => {
    if (!projectID) return
    setNavigation(mode === 'file' && line !== undefined ? { projectID, path, line, column, nonce: ++navigationNonce.current } : undefined)
    const tab = { path, mode }
    if (mode === 'file') updateSplit(projectID, current => openTabInGroup(current, tab))
    updateView(projectID, current => activateTab({ ...current, tabs: current.tabs.some(t => tabID(t) === tabID(tab)) ? current.tabs : [...current.tabs, tab] }, tab))
    setPreferences(p => ({ ...p, stage: true, panel: mode === 'diff' ? 'diff' : 'files', layoutMode: mode === 'diff' ? 'swe' : p.layoutMode }))
  }
  const renameOpenPath = (id: string, from: string, to: string) => {
    pathsEpoch.current++
    updateView(id, current => renameView(current, from, to))
    updateSplit(id, current => renameInSplitState(current, from, to))
    setBuffers(current => renameBuffers(current, id, from, to))
    setDiffs(current => changePathDocuments(current, id, from, to))
    setNavigation(current => current?.projectID === id ? { ...current, path: renamedPath(current.path, from, to) } : current)
  }
  const deleteOpenPath = (id: string, path: string) => {
    pathsEpoch.current++
    updateView(id, current => deleteFromView(current, path))
    updateSplit(id, current => deleteInSplitState(current, path))
    setBuffers(current => changePathDocuments(current, id, path))
    setDiffs(current => changePathDocuments(current, id, path))
    setNavigation(current => current?.projectID === id ? undefined : current)
  }
  const save = async (requestedTab?: Tab) => {
    const p = preferencesRef.current
    if (!p.project || !p.stage || p.panel !== 'files') return
    const v = p.projects[p.project]
    const state = splitsRef.current[p.project]
    const tab = requestedTab || (state ? (state[state.focused] || state.primary).active : v && selectedTab(v, 'file'))
    if (!tab || tab.mode !== 'file') return
    const key = documentID(p.project, tab.path), buffer = buffersRef.current[key]
    if (!buffer || !dirty(buffer) || saving.current.has(key)) return
    if (buffer.conflict) { report('Xung đột phiên bản. Nạp lại tệp sau khi giữ lại các chỉnh sửa cần thiết.'); return }
    saving.current.add(key)
    try {
      const saved = await window.ame.save(p.project, tab.path, buffer.text, buffer.revision)
      setBuffers(current => current[key] ? { ...current, [key]: savedDocument(current[key], saved, buffer.text) } : current)
      refresh()
    } catch (e) {
      report(e)
      try { const incoming = await window.ame.read(p.project, tab.path); setBuffers(current => current[key] ? { ...current, [key]: reconcileDocument(current[key], incoming) } : current) } catch { /* The save error remains visible. */ }
    } finally { saving.current.delete(key) }
  }
  const reload = async (tab = activeTab) => {
    if (!projectID || !tab) return
    const key = documentID(projectID, tab.path)
    if (buffersRef.current[key] && dirty(buffersRef.current[key]) && !window.confirm('Bỏ các thay đổi chưa lưu và nạp lại tệp từ đĩa?')) return
    try { const incoming = await window.ame.read(projectID, tab.path); setBuffers(current => ({ ...current, [key]: { ...incoming, projectID, text: incoming.content, conflict: false } })) } catch (e) { report(e) }
  }
  const closeTab = (tab: Tab, group: EditorGroupID = splitState.focused) => {
    if (!projectID) return
    const other = splitState[group === 'primary' ? 'secondary' : 'primary']
    const retained = tab.mode === 'file' && !!other?.tabs.some(item => tabID(item) === tabID(tab))
    const key = documentID(projectID, tab.path), buffer = buffersRef.current[key]
    if (!retained && tab.mode === 'file' && buffer && dirty(buffer) && !window.confirm(`Bỏ các thay đổi chưa lưu trong ${tab.path}?`)) return
    if (tab.mode === 'file') updateSplit(projectID, current => closeTabInGroup(current, tab, group))
    if (!retained) updateView(projectID, current => removeTab(current, tab))
    if (!retained && tab.mode === 'file') setBuffers(current => { const next = { ...current }; delete next[key]; return next })
  }
  const selectPanel = (panel: Preferences['panel']) => {
    if (panel === 'subagents' || panel === 'btw') { window.dispatchEvent(new CustomEvent('ame-chat-drawer', { detail: panel === 'subagents' ? 'agents' : 'btw' })); return }
    if (panel === 'terminal') { setPreferences(p => ({ ...p, terminalOpen: true, stage: true })); return }
    setPreferences(p => ({ ...p, panel, stage: true, layoutMode: ['diff', 'terminal', 'subagents'].includes(panel) ? 'swe' : p.layoutMode }))
    if (projectID && (panel === 'files' || panel === 'diff')) {
      const mode = panel === 'files' ? 'file' : 'diff'
      updateView(projectID, current => { const tab = selectedTab(current, mode); return tab ? activateTab(current, tab) : current })
    }
  }
  const actions = [
    { title: 'Mở thư mục dự án', shortcut: '', run: () => void pickProject() },
    { title: 'Cuộc trò chuyện mới', shortcut: 'Ctrl+N', run: () => void createSession() },
    { title: 'Lưu tệp', shortcut: 'Ctrl+S', run: () => void save() },
    { title: 'Mở tệp nhanh', shortcut: 'Ctrl+P', run: () => showQuickOpen('files') },
    { title: 'Đi đến dòng', shortcut: 'Ctrl+G', run: () => showQuickOpen('line') },
    { title: splitState.secondary ? 'Gộp trình soạn thảo' : 'Chia đôi trình soạn thảo', shortcut: '', run: toggleSplit },
    { title: 'Phân tích Usage & Chi phí', shortcut: '', run: () => selectPanel('usage') },
    { title: 'Tìm trong dự án', shortcut: 'Ctrl+Shift+F', run: () => setPreferences(p => ({ ...p, inspector: true, inspectorTab: 'search' })) },
    { title: 'Mở Git Source Control', shortcut: '', run: () => setPreferences(p => ({ ...p, inspector: true, inspectorTab: 'git' })) },
    { title: 'Terminal mới', shortcut: 'Ctrl / Cmd+Shift+`', run: () => void newTerminal() },
    { title: 'Ẩn / hiện Terminal', shortcut: 'Ctrl / Cmd+`', run: () => setPreferences(p => ({ ...p, terminalOpen: !p.terminalOpen, stage: true })) },
    { title: 'Ẩn / hiện Projects & Chats', shortcut: 'Ctrl+B', run: () => toggle('rail') },
    { title: 'Ẩn / hiện Side Panel', shortcut: 'Ctrl+Alt+B', run: () => toggle('stage') },
    { title: 'Ẩn / hiện Project Inspector', shortcut: 'Ctrl+Shift+E', run: () => toggle('inspector') },
    { title: 'Chuyển chủ đề sáng / tối', shortcut: '', run: () => setPreferences(p => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' })) },
    { title: 'Cài đặt & kết nối', shortcut: 'Ctrl+,', run: () => setModal('settings') },
    { title: 'Tài khoản & AmeKit', shortcut: '', run: () => setModal('account') },
    ...(import.meta.env.DEV ? [{ title: 'Layout X-Ray', shortcut: 'Ctrl+Shift+X', run: () => setXray(x => !x) }] : [])
  ]
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandler.current = event => {
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (newTerminalShortcut(event)) { event.preventDefault(); event.stopPropagation(); void newTerminal(); return }
    if ((event.target as HTMLElement | null)?.closest?.('.terminal-surface') && !isTerminalKey(event)) return
    if ((key === 'p' || key === 'g') && !event.altKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); showQuickOpen(key === 'p' ? 'files' : 'line') }
    else if (key === 's' && !event.altKey) { event.preventDefault(); void save() }
    else if (key === 'b') { event.preventDefault(); toggle(event.altKey ? 'stage' : 'rail') }
    else if (key === 'e' && event.shiftKey) { event.preventDefault(); toggle('inspector') }
    else if (key === 'f' && event.shiftKey) { event.preventDefault(); setPreferences(p => ({ ...p, inspector: true, inspectorTab: 'search' })) }
    else if (key === 'j' || isTerminalKey(event)) { event.preventDefault(); setPreferences(p => ({ ...p, terminalOpen: !p.terminalOpen, stage: true })) }
    else if (key === 'k') { event.preventDefault(); setQuery(''); setModal('palette') }
    else if (key === ',') { event.preventDefault(); setModal('settings') }
    else if (key === 'n' && !modal) { event.preventDefault(); void createSession() }
    else if (key === 'x' && event.shiftKey) { event.preventDefault(); setXray(x => !x) }
  }
  useEffect(() => { const handler = (event: KeyboardEvent) => keyHandler.current(event); window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true) }, [])
  const dirtyCount = Object.values(buffers).filter(dirty).length
  const renderEditor = (group: EditorGroupID) => {
    const diffMode = preferences.panel === 'diff'
    const editorGroup = splitState[group]
    const tab = diffMode ? selectedTab(view, 'diff') : editorGroup?.active
    const buffer = projectID && tab ? buffers[documentID(projectID, tab.path)] : undefined
    return <div key={group} className={`editor-group ${splitState.focused === group ? 'is-focused' : ''}`} onFocusCapture={() => { if (projectID && !diffMode) updateSplit(projectID, current => focusGroup(current, group)) }} onPointerDownCapture={() => { if (projectID && !diffMode) updateSplit(projectID, current => focusGroup(current, group)) }}>
      <EditorStage projectID={projectID || ''} target={group === splitState.focused || diffMode ? navigation : undefined} dirtyPaths={projectDirtyPaths(buffers, projectID)} tabs={diffMode ? view.tabs.filter(tab => tab.mode === 'diff') : editorGroup?.tabs || []} active={tab} buffer={buffer} diff={projectID && tab ? diffs[documentID(projectID, tab.path)] : undefined} theme={preferences.theme}
        onSelect={selected => { if (projectID) { if (!diffMode) updateSplit(projectID, current => selectTabInGroup(current, selected, group)); updateView(projectID, current => activateTab(current, selected)) } }}
        onClose={tab => closeTab(tab, group)} onChange={text => { if (projectID && tab) { const key = documentID(projectID, tab.path); setBuffers(current => current[key] ? { ...current, [key]: { ...current[key], text } } : current) } }}
        onSave={() => void save(tab)} onReload={() => void reload(tab)} onToggleSplit={toggleSplit} isSplit={!!splitState.secondary}
        onStatus={status => { if (projectID && tab) setEditorStatuses(current => ({ ...current, [JSON.stringify([projectID, group, tab.path])]: status })) }} />
    </div>
  }
  return <div data-testid="shell" className={`app-shell ${xray ? 'xray' : ''}`}>
    <header className="titlebar" data-region="Titlebar"><div className="titlebar__left"><span className="brand-mark brand-mark--icon-only" title="Ame"><span className="brand-mark__icon"><Icon name="brand" /></span></span><IconButton label="Tài khoản & AmeKit" onClick={() => setModal('account')}><Icon name="account" /></IconButton><IconButton label="Settings" onClick={() => setModal('settings')}><Icon name="settings" /></IconButton><IconButton label="Projects & Chats (Ctrl+B)" active={preferences.rail} onClick={() => toggle('rail')}><Icon name="sidebar" /></IconButton></div><div className="titlebar__center"><button className="cmd-trigger" onClick={() => { setQuery(''); setModal('palette') }}><span className="cmd-trigger__label"><Icon name="search" /><span className="truncate">{activeSession?.title || 'Lệnh & điều hướng'}</span></span><span className="kbd">Ctrl+K</span></button></div><div className="titlebar__right"><button className={`pill-btn ${xray ? 'is-active' : ''}`} onClick={() => setXray(value => !value)}><Icon name="grid" />Layout X-Ray</button><IconButton label="Project Inspector (Ctrl+Shift+E)" active={preferences.inspector} onClick={() => toggle('inspector')}><Icon name="folder" /></IconButton><IconButton label="Bottom Panel (Ctrl+J)" active={preferences.terminalOpen && preferences.stage} onClick={() => setPreferences(p => ({ ...p, terminalOpen: !p.terminalOpen, stage: true }))}><Icon name="bottom" /></IconButton><IconButton label="File Stage (Ctrl+Alt+B)" active={preferences.stage} onClick={() => toggle('stage')}><Icon name="panel" /></IconButton><span className="titlebar__divider" /><div className="win-controls">{(['minimize', 'maximize', 'close'] as const).map((action, index) => <button key={action} className={`win-btn ${action === 'close' ? 'win-btn--close' : ''}`} aria-label={['Thu nhỏ', 'Phóng to / khôi phục', 'Đóng cửa sổ'][index]} onClick={() => void window.ame?.window(action).catch(report)}><Icon name={action} /></button>)}</div></div></header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><IconButton label="Đóng thông báo" onClick={() => setError('')}><Icon name="close" /></IconButton></div>}
    <div className={`workspace-body ${!preferences.rail ? 'is-sidebar-collapsed' : ''} ${!preferences.inspector ? 'is-inspector-collapsed' : ''} ${!preferences.stage ? 'is-sidepanel-collapsed' : ''} ${maximized && preferences.stage ? 'is-sidepanel-maximized' : ''}`} style={{ '--sidebar-w': `${preferences.widths.rail}px`, '--inspector-w': `${preferences.widths.inspector}px`, '--sidepanel-w': `${preferences.widths.stage}px` } as CSSProperties}>
      {preferences.rail && <><ProjectRail projects={projects} projectID={projectID} sessions={sessions} sessionCache={sessionCache} onRemove={id => void removeProject(id)} onSessionRemoved={(id, removed) => { const remaining = (sessionCacheRef.current[id] || []).filter(session => session.id !== removed); setSessionCache(current => ({ ...current, [id]: (current[id] || []).filter(session => session.id !== removed) })); updateView(id, current => current.session === removed ? { ...current, session: remaining[0]?.id } : current); refreshSessions() }} onSessions={(id, items) => { setSessionCache(current => removedProjects.current.has(id) ? current : ({ ...current, [id]: items })); updateView(id, current => ({ ...current, session: items.some(item => item.id === current.session) ? current.session : items[0]?.id })) }} sessionID={view.session} loading={projectsLoading} sessionsLoading={sessionsLoading} error={sessionError} connected={connection.connected} creating={creating} git={git} generation={generation} onSelect={id => setPreferences(p => ({ ...p, project: id }))} onSession={(id, session) => { setPreferences(p => ({ ...p, project: id })); updateView(id, current => ({ ...current, session })) }} onTool={(id, tab) => setPreferences(p => ({ ...p, project: id, inspector: true, inspectorTab: tab }))} onCreate={id => void createSession(id)} onPick={() => void pickProject()} onRetry={refreshSessions} /><Resizer pane="rail" width={preferences.widths.rail} onChange={w => setWidth('rail', w)} /></>}
      {preferences.inspector && <><Inspector projectID={projectID} name={project?.name} connected={connection.connected} tab={preferences.inspectorTab} setTab={tab => setPreferences(p => ({ ...p, inspectorTab: tab }))} generation={generation} git={git} gitError={gitError} refresh={refresh} onOpen={(path, line, column) => openTab(path, 'file', line, column)} onRename={(from, to) => { if (projectID) renameOpenPath(projectID, from, to) }} onDelete={path => { if (projectID) deleteOpenPath(projectID, path) }} onDiff={path => openTab(path, 'diff')} onHide={() => toggle('inspector')} report={report} /><Resizer pane="inspector" width={preferences.widths.inspector} onChange={w => setWidth('inspector', w)} /></>}
      <Chat key={projectID || ''} files={files} activeFile={activeTab?.mode === 'file' ? activeTab.path : undefined} onRequestFiles={requestFiles} ready={!!projectID && sessionCache[projectID] !== undefined && !sessionsLoading && (!sessions.length || !!activeSession) && !sessionError} onCreated={session => { if (projectID) { updateView(projectID, current => ({ ...current, session: session.id })); setSessionCache(current => ({ ...current, [projectID]: [session, ...(current[projectID] || []).filter(s => s.id !== session.id)] })) } }} projectID={projectID} sessionID={view.session} title={activeSession?.title} connected={connection.connected} onCreate={() => void createSession()} report={report} onActivity={refreshSessions} onOpenPanel={selectPanel} onOpenFile={(path, line) => openTab(path, 'file', line)} sessions={sessions} tabs={view.tabs} changes={changesState.status === 'ready' ? changesState.files.length : 0} changesStatus={changesState.status} theme={preferences.theme} projectName={project?.name} branch={git?.branch} onSelectSession={id => { if (projectID) updateView(projectID, current => ({ ...current, session: id })) }} />
      {preferences.stage && <><Resizer pane="stage" width={preferences.widths.stage} onChange={w => setWidth('stage', w)} /><section className="side-panel" data-testid="side-panel" data-region="Auxiliary Side Panel">
        <div className="side-panel__tabs"><div className="side-panel__tab-list" role="tablist" aria-label="Workspace panel">{(['files', 'changes', 'diff', 'artifact', 'usage'] as const).filter(tab => preferences.layoutMode !== 'knowledge' || tab !== 'diff').map(tab => <button key={tab} role="tab" aria-selected={preferences.panel === tab} className={`panel-tab ${preferences.panel === tab ? 'is-active' : ''}`} onClick={() => selectPanel(tab)}>{({ files: 'Code', changes: 'Session Changes', diff: 'Git Diff', artifact: 'Artifact', usage: 'Usage' })[tab]}</button>)}</div><div className="stage-actions"><IconButton label="Toggle Terminal" active={preferences.terminalOpen} onClick={() => setPreferences(p => ({ ...p, terminalOpen: !p.terminalOpen }))}><Icon name="terminal" /></IconButton><IconButton label="Phóng to Side Panel" active={maximized} onClick={() => setMaximized(v => !v)}><Icon name="maximize" /></IconButton><IconButton label="Close Side Panel" onClick={() => toggle('stage')}><Icon name="close" /></IconButton></div></div>
        <div className="editor-breadcrumb"><span className="truncate"><strong>{project?.name || 'Local Workspace'}</strong> &rsaquo; {preferences.panel === 'changes' ? activeSession?.title || 'Session Changes' : activeTab?.path || (preferences.panel === 'diff' ? 'VS Code Diff' : 'Code')}</span><span>{preferences.panel === 'changes' ? 'OpenCode snapshots' : preferences.panel === 'diff' ? 'Git Engine' : 'UTF-8'}</span></div>
        <div className="side-panel__content"><div className={`workspace-tools ${preferences.panel === 'files' && splitState.secondary ? 'is-split' : ''}`} hidden={!['files', 'diff'].includes(preferences.panel)}>{renderEditor('primary')}{preferences.panel === 'files' && splitState.secondary && renderEditor('secondary')}</div>{preferences.panel === 'changes' && <SessionChanges key={changesKey} state={changesState} theme={preferences.theme} onRetry={() => setChangesAttempt(value => value + 1)} />}{preferences.panel === 'usage' && <><UsagePanel nodes={usage?.key === usageKey ? usage.value?.nodes || [] : []} loading={!!projectID && !!view.session && (usage?.key !== usageKey || usage.loading)} error={usage?.key === usageKey ? usage.error : undefined} origin={usage?.key === usageKey ? usage.value?.origin : null} selectedSessionID={view.session} onSelectSession={id => { if (projectID) updateView(projectID, current => ({ ...current, session: id })) }} onRefresh={() => setUsageAttempt(value => value + 1)} />{usage?.key === usageKey && usage.value?.limited && <p role="status">Giới hạn hiển thị 200 phiên.</p>}</>}{!['files', 'diff', 'changes', 'usage'].includes(preferences.panel) && <Empty><Icon name="file" /><h3>Artifacts</h3><p>Artifacts API is not available yet.</p></Empty>}</div>
        <TerminalPanel projectID={projectID} createdTerminal={createdTerminal} theme={preferences.theme} visible={preferences.terminalOpen && preferences.layoutMode !== 'knowledge'} close={() => setPreferences(p => ({ ...p, terminalOpen: false }))} />
        <footer className="side-panel__status statusbar"><span className="truncate">{project?.name || 'Local Workspace'}{git?.branch ? ` · ${git.branch}` : ''}</span>{preferences.panel === 'files' && activeTab && <span className="statusbar__editor">Ln {editorStatus?.line || 1}, Col {editorStatus?.column || 1} · {editorStatus?.language || languageFor(activeTab.path)} · UTF-8 · {editorStatus?.indent || 'Spaces: 2'}</span>}<span>{dirtyCount ? `${dirtyCount} tệp chưa lưu` : 'Đã lưu'}</span></footer>
      </section></>}
    </div>
    {(modal === 'settings' || modal === 'account') && <Settings initialSection={modal === 'account' ? 'amekit' : 'appearance'} preferences={preferences} setLayout={patch => setPreferences(p => ({ ...p, ...patch, panel: patch.layoutMode === 'knowledge' && ['diff', 'terminal', 'subagents'].includes(p.panel) ? 'files' : p.panel }))} theme={preferences.theme} setTheme={theme => setPreferences(p => ({ ...p, theme }))} connection={connection} setConnection={setConnection} close={() => setModal(null)} />}
    <QuickOpen open={!!quickOpen} mode={quickOpen || 'files'} files={files} recentPaths={view.tabs.filter(tab => tab.mode === 'file').map(tab => tab.path)} activeFile={activeTab?.mode === 'file' ? activeTab.path : undefined} activeLineCount={editorStatus?.lineCount || activeBuffer?.text.split('\n').length} loading={fileIndex?.key !== fileIndexKey || fileIndex.loading} onSelectFile={(path, line, column) => openTab(path, 'file', line, column)} onGoToLine={(line, column) => { if (activeTab?.mode === 'file') openTab(activeTab.path, 'file', line, column) }} onClose={() => setQuickOpen(undefined)} />
    {quickOpen && fileIndex?.key === fileIndexKey && fileIndex.error && <div className="error-banner" role="alert">{fileIndex.error}</div>}
    {modal === 'palette' && <Modal title="Bảng lệnh" close={() => setModal(null)}><input className="palette-input" aria-label="Tìm lệnh" placeholder="Nhập tên lệnh…" value={query} onChange={e => setQuery(e.target.value)} autoFocus /><div className="palette-actions">{actions.filter(action => action.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(action => <button key={action.title} onClick={() => { setModal(null); action.run() }}>{action.title}<kbd>{action.shortcut}</kbd></button>)}</div></Modal>}
  </div>
}
