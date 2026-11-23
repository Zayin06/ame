import { useCallback, useEffect, useRef, useState } from 'react'
import { ArtifactViewer } from './components/ArtifactViewer'
import { formatShortcut, isMacPlatform } from './platform'
import type { Connection, DebugSessionSnapshot, LspDiagnostic, GitState, Model, PetHostState, PetSession, Project, Session, TerminalInfo } from '../../../../packages/protocol/src/index'
import { activateTab, defaults, dirty, documentID, languageFor, parsePreferences, projectDirtyPaths, reconcileDocument, removeTab, savedDocument, selectedTab, tabID, withoutKey, withoutProject, withoutProjectDocuments, type Buffer, type Pane, type Preferences, type ProjectView, type Tab } from './state'
import { Icon } from './components/Icon'
import { ProjectRail } from './components/ProjectRail'
import type { CSSProperties } from 'react'
import { Chat } from './components/Chat'
import { AndroidTranslationModal } from './components/AndroidTranslationModal'
import type { ModelLevels } from './model-selection'
import { EditorStage, type EditorStatus } from './components/EditorStage'
import { QuickOpen } from './components/QuickOpen'
import { UsagePanel } from './components/UsagePanel'
import type { SessionUsageView } from '../../../../packages/protocol/src/index'
import { closeTabInGroup, createSplitState, deleteInSplitState, focusGroup, openTabInGroup, renameInSplitState, selectTabInGroup, splitRight, unsplit, type EditorGroupID, type EditorSplitState } from './editor-split'
import { Inspector } from './components/Inspector'
import { Empty, errorText, humanizeIdeError, IconButton, Modal, Resizer } from './components/Primitives'
import { Settings } from './components/Settings'
import { SessionChanges } from './components/SessionChanges'
import { watchSessionChanges, type SessionChangesState } from './session-changes'
import { TerminalPanel, type BottomPanelTab } from './components/TerminalPanel'
import { createProjectTerminal, isTerminalKey, newTerminalShortcut } from './terminal-controls'
import { changePathDocuments, deleteFromView, renameBuffers, renamedPath, renameView, resolveWorkspaceFilePath, sanitizeProjectView, type NavigationTarget } from './workspace-paths'

const storageKey = 'ame.ide.layout.v1'
const readPreferences = () => { try { return parsePreferences(localStorage.getItem(storageKey)) } catch { return defaults() } }
const emptyView: ProjectView = { tabs: [] }
const isSourceFile = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path)
const idleDebug: DebugSessionSnapshot = { status: 'idle', frames: [], variables: [], breakpoints: [] }
type DebugOutput = { stream: 'stdout' | 'stderr' | 'console'; text: string }
export function App() {
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault() }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    return () => { window.removeEventListener('dragover', preventFileNavigation); window.removeEventListener('drop', preventFileNavigation) }
  }, [])
  const [preferences, setPreferences] = useState<Preferences>(readPreferences)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessionCache, setSessionCache] = useState<Record<string, Session[]>>({})
  const sessionCacheRef = useRef(sessionCache); sessionCacheRef.current = sessionCache
  const [sessionError, setSessionError] = useState('')
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [connection, setConnection] = useState<Connection>({ connected: false, url: '' })
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const [readErrors, setReadErrors] = useState<Record<string, string>>({})
  const readErrorsRef = useRef(readErrors)
  const updateReadErrors = useCallback((update: (current: Record<string, string>) => Record<string, string>) => {
    readErrorsRef.current = update(readErrorsRef.current)
    setReadErrors(readErrorsRef.current)
  }, [])
  const [diffs, setDiffs] = useState<Record<string, { original: string; modified: string }>>({})
  const [gitCache, setGitCache] = useState<Record<string, GitState>>({})
  const [accountRole, setAccountRole] = useState('')
  const [accountDefaultModel, setAccountDefaultModel] = useState('')
  const [accountModelLevels, setAccountModelLevels] = useState<Partial<ModelLevels>>()
  const [gitError, setGitError] = useState('')
  const [generation, setGeneration] = useState(0)
  const [sessionGeneration, setSessionGeneration] = useState(0)
  const [error, setError] = useState('')
  const [modal, setModalState] = useState<'settings' | 'account' | 'palette' | null>(null)
  const [translationModalOpen, setTranslationModalOpen] = useState(false)
  useEffect(() => { setTranslationModalOpen(false) }, [preferences.project])
  const [isMac, setIsMac] = useState(false)
  const [pet, setPet] = useState<PetHostState | null>(null)
  const [sprite, setSprite] = useState('')
  const spriteRequest = useRef<Promise<string> | undefined>(undefined)
  const [selectedModel, setSelectedModel] = useState<Model>()
  const [query, setQuery] = useState('')
  const [xray, setXray] = useState(false)
  const [creating, setCreating] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [createdTerminal, setCreatedTerminal] = useState<TerminalInfo>()
  const [bottomTab, setBottomTab] = useState<BottomPanelTab>('terminal')
  const [bottomHeight, setBottomHeight] = useState(185)
  const [diagnosticsByProject, setDiagnosticsByProject] = useState<Record<string, LspDiagnostic[]>>({})
  const [problemsLoading, setProblemsLoading] = useState(false)
  const diagnosticRequest = useRef(0)
  const overlayTexts = useRef(new Map<string, string>())
  const overlayQueues = useRef(new Map<string, Promise<void>>())
  const [debugByProject, setDebugByProject] = useState<Record<string, DebugSessionSnapshot>>({})
  const debugRevision = useRef(new Map<string, number>())
  const [breakpointsByProject, setBreakpointsByProject] = useState<Record<string, Record<string, number[]>>>({})
  const breakpointRef = useRef(breakpointsByProject); breakpointRef.current = breakpointsByProject
  const breakpointQueues = useRef(new Map<string, Promise<void>>())
  const [debugEntries, setDebugEntries] = useState<Record<string, string>>({})
  const [selectedFrames, setSelectedFrames] = useState<Record<string, string | undefined>>({})
  const [debugOutputs, setDebugOutputs] = useState<Record<string, DebugOutput[]>>({})
  const navigateRef = useRef<(id: string, path: string, line: number, column: number) => void>(() => {})
  const [navigation, setNavigation] = useState<NavigationTarget>()
  const [splits, setSplits] = useState<Record<string, EditorSplitState>>({})
  const splitsRef = useRef(splits); splitsRef.current = splits
  const [editorStatuses, setEditorStatuses] = useState<Record<string, EditorStatus>>({})
  const [quickOpen, setQuickOpen] = useState<'files' | 'line'>()
  const setModal = (next: typeof modal) => { if (next !== null) setQuickOpen(undefined); setModalState(next) }
  const [filesRequestedFor, setFilesRequestedFor] = useState<string>()
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
  const git = projectID ? gitCache[projectID] : undefined
  const sessions = projectID ? sessionCache[projectID] || [] : []
  const project = projects.find(p => p.id === projectID)
  const view = projectID ? preferences.projects[projectID] || emptyView : emptyView
  const splitState = projectID && splits[projectID] || createSplitState(view.tabs.filter(tab => tab.mode === 'file'), selectedTab(view, 'file'))
  const problemsOpen = preferences.stage && preferences.terminalOpen && bottomTab === 'problems'
  const openSourcePaths = preferences.stage && preferences.panel === 'files'
    ? [...new Set([splitState.primary.active, splitState.secondary?.active].flatMap(tab => tab?.mode === 'file' && isSourceFile(tab.path) ? [tab.path.replace(/\\/g, '/')] : []))]
    : []
  const openSourceKey = JSON.stringify(openSourcePaths)
  const problemsOpenRef = useRef(problemsOpen); problemsOpenRef.current = problemsOpen
  const openSourcePathsRef = useRef(openSourcePaths); openSourcePathsRef.current = openSourcePaths
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
  const report = useCallback((e: unknown) => setError(humanizeIdeError(e)), [])
  const refresh = useCallback(() => setGeneration(g => g + 1), [])
  const refreshSessions = useCallback(() => setSessionGeneration(g => g + 1), [])
  const updateView = useCallback((id: string, update: (view: ProjectView) => ProjectView) => setPreferences(p => removedProjects.current.has(id) ? p : ({ ...p, projects: { ...p.projects, [id]: update(p.projects[id] || { tabs: [] }) } })), [])
  const toggle = (pane: Pane) => setPreferences(p => ({ ...p, [pane]: !p[pane] }))
  const setWidth = (pane: Pane, width: number) => setPreferences(p => ({ ...p, widths: { ...p.widths, [pane]: width } }))

  const diagnostics = projectID ? diagnosticsByProject[projectID] ?? [] : []
  const problemCounts = diagnostics.reduce((counts, item) => { if (item.severity !== 'info') counts[item.severity]++; return counts }, { error: 0, warning: 0 })
  const debugSnapshot = projectID ? debugByProject[projectID] ?? idleDebug : idleDebug
  const selectedFrameId = projectID ? selectedFrames[projectID] : undefined
  const pausedFrame = debugSnapshot.status === 'paused' ? debugSnapshot.frames.find(frame => frame.callFrameId === selectedFrameId) ?? debugSnapshot.frames[0] : undefined
  const debugEntry = projectID ? debugEntries[projectID] ?? view.tabs.find(tab => tab.mode === 'file' && /\.(?:ts|js|mjs)$/i.test(tab.path))?.path ?? '' : ''
  const requestDiagnostics = useCallback(async (id: string, reload = false, targetPaths?: readonly string[]) => {
    if (targetPaths && targetPaths.length === 0) return
    const request = ++diagnosticRequest.current
    if (preferencesRef.current.project === id) setProblemsLoading(true)
    try {
      await Promise.all([...overlayQueues.current].filter(([key]) => (JSON.parse(key) as string[])[0] === id).map(([, queue]) => queue))
      if (removedProjects.current.has(id)) return
      if (reload) await window.ame.lspRefresh(id)
      const items = targetPaths
        ? (await Promise.all(targetPaths.map(file => window.ame.lspDiagnostics(id, file)))).flat()
        : await window.ame.lspDiagnostics(id)
      const checked = targetPaths && new Set(targetPaths.map(file => file.replace(/\\/g, '/')))
      if (request === diagnosticRequest.current && preferencesRef.current.project === id && !removedProjects.current.has(id)) setDiagnosticsByProject(current => ({
        ...current,
        [id]: checked ? [...(current[id] ?? []).filter(item => !checked.has(item.path.replace(/\\/g, '/'))), ...items] : items,
      }))
    } catch (e) { if (request === diagnosticRequest.current && preferencesRef.current.project === id && !removedProjects.current.has(id)) report(e) }
    finally { if (request === diagnosticRequest.current) setProblemsLoading(false) }
  }, [report])
  const acceptDebugSnapshot = useCallback((id: string, snapshot: DebugSessionSnapshot) => {
    setDebugByProject(current => ({ ...current, [id]: snapshot }))
    const byPath: Record<string, number[]> = {}
    for (const point of snapshot.breakpoints) (byPath[point.path] ??= []).push(point.line)
    for (const key of breakpointQueues.current.keys()) {
      const [project, path] = JSON.parse(key) as string[]
      if (project === id) byPath[path] = breakpointRef.current[id]?.[path] ?? []
    }
    breakpointRef.current = { ...breakpointRef.current, [id]: byPath }
    setBreakpointsByProject(breakpointRef.current)
    setSelectedFrames(current => ({ ...current, [id]: snapshot.status === 'paused' ? snapshot.frames.some(frame => frame.callFrameId === current[id]) ? current[id] : snapshot.frames[0]?.callFrameId : undefined }))
  }, [])
  useEffect(() => {
    diagnosticRequest.current++
    setProblemsLoading(false)
    if (!projectID || !window.ame) return
    let alive = true
    const revision = debugRevision.current.get(projectID) ?? 0
    void window.ame.debugState(projectID).then(snapshot => {
      if (alive && !removedProjects.current.has(projectID) && revision === (debugRevision.current.get(projectID) ?? 0)) acceptDebugSnapshot(projectID, snapshot)
    }).catch(e => { if (alive) report(e) })
    return () => { alive = false; diagnosticRequest.current++ }
  }, [projectID, acceptDebugSnapshot, report])
  useEffect(() => {
    if (!projectID || !window.ame || (!problemsOpen && !openSourcePathsRef.current.length)) return
    const timer = setTimeout(() => { void requestDiagnostics(projectID, false, problemsOpen ? undefined : JSON.parse(openSourceKey) as string[]) }, 450)
    return () => clearTimeout(timer)
  }, [projectID, problemsOpen, openSourceKey, requestDiagnostics])
  useEffect(() => {
    if (!projectID || !window.ame) return
    const timer = setTimeout(() => {
      if (!problemsOpenRef.current && !openSourcePathsRef.current.length) return
      const changedPaths: string[] = []
      for (const [key, buffer] of Object.entries(buffers)) {
        if (buffer.projectID !== projectID || !isSourceFile(buffer.path) || overlayTexts.current.get(key) === buffer.text) continue
        changedPaths.push(buffer.path)
        overlayTexts.current.set(key, buffer.text)
        const queue = (overlayQueues.current.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
          if (!removedProjects.current.has(projectID)) await window.ame.lspUpdateDocument(projectID, buffer.path, buffer.text)
        })
        overlayQueues.current.set(key, queue)
        void queue.catch(e => { overlayTexts.current.delete(key); if (preferencesRef.current.project === projectID && !removedProjects.current.has(projectID)) report(e) }).finally(() => { if (overlayQueues.current.get(key) === queue) overlayQueues.current.delete(key) })
      }
      if (changedPaths.length) void requestDiagnostics(projectID, false, problemsOpenRef.current ? undefined : changedPaths)
    }, 300)
    return () => clearTimeout(timer)
  }, [projectID, buffers, problemsOpen, openSourceKey, requestDiagnostics, report])

  const requestFiles = useCallback(() => { if (projectID) setFilesRequestedFor(projectID) }, [projectID])
  const showQuickOpen = (mode: 'files' | 'line') => { setModal(null); requestFiles(); setQuickOpen(mode) }
  useEffect(() => {
    if (!projectID || filesRequestedFor !== projectID || !window.ame) return
    let alive = true
    setFileIndex({ key: fileIndexKey, files: [], loading: true })
    void window.ame.listFiles(projectID).then(files => { if (alive) setFileIndex({ key: fileIndexKey, files, loading: false }) }).catch(e => { if (alive) setFileIndex({ key: fileIndexKey, files: [], loading: false, error: errorText(e) }) })
    return () => { alive = false }
  }, [projectID, fileIndexKey, filesRequestedFor])
  useEffect(() => {
    if (preferences.panel !== 'usage' || !projectID || !view.session || !window.ame) return
    let alive = true
    setUsage({ key: usageKey, loading: true })
    void window.ame.sessionUsage(projectID, view.session).then(value => { if (alive) setUsage({ key: usageKey, value, loading: false }) }).catch(e => { if (alive) setUsage({ key: usageKey, loading: false, error: errorText(e) }) })
    return () => { alive = false }
  }, [preferences.panel, projectID, view.session, usageKey, usageAttempt])

  useEffect(() => {
    if (!window.ame) return
    let alive = true, generation = 0
    const load = async () => {
      const current = ++generation
      try {
        const status = await window.ame.account('status') as { account?: { role?: string }; models?: { default_model?: string; model_levels?: Partial<ModelLevels> } } | null
        if (alive && current === generation) {
          setAccountRole(status?.account?.role ?? '')
          setAccountDefaultModel(status?.models?.default_model ?? '')
          setAccountModelLevels(status?.models?.model_levels)
        }
      } catch (e) { if (alive && current === generation) { setAccountRole(''); setAccountDefaultModel(''); setAccountModelLevels(undefined); report(e) } }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    return () => { alive = false; window.removeEventListener('ame-account-changed', load) }
  }, [connection.connected, report])

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
    void window.ame.platform().then(value => { if (alive) setIsMac(isMacPlatform(value)) }).catch(() => {})
    void window.ame.petState().then(value => { if (alive) setPet(value) }).catch(report)
    void window.ame.projects().then(items => { if (alive) {
      projectsRef.current = items
      setProjects(items)
      setPreferences(p => ({ ...p, project: items.some(item => item.id === p.project) ? p.project : items[0]?.id, projects: Object.fromEntries(Object.entries(p.projects).map(([id, view]) => [id, sanitizeProjectView(view, items.find(item => item.id === id)?.directory)])) }))
    } }).catch(report).finally(() => { if (alive) setProjectsLoading(false) })
    void window.ame.connection().then(value => { if (alive) setConnection(value) }).catch(report)
    const fileTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let chatTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.ame.onEvent(event => {
      if (event.type === 'pet') { setPet(event.state); return }
      if (event.type === 'connection') { setConnection(event.connection); refreshSessions(); window.dispatchEvent(new Event('ame-account-changed')); return }
      if (event.type === 'terminal') return
      if (event.type === 'debug') {
        const id = event.projectID, update = event.event
        if (removedProjects.current.has(id)) return
        debugRevision.current.set(id, (debugRevision.current.get(id) ?? 0) + 1)
        if (update.type === 'output') setDebugOutputs(current => ({ ...current, [id]: [...(current[id] ?? []), { stream: update.stream, text: update.text }].slice(-500) }))
        else if (update.type === 'exited') {
          setDebugByProject(current => ({ ...current, [id]: { ...(current[id] ?? idleDebug), status: 'exited', frames: [], variables: [], exitCode: update.code ?? undefined } }))
          setSelectedFrames(current => ({ ...current, [id]: undefined }))
        } else {
          acceptDebugSnapshot(id, update.snapshot)
          if (update.type === 'stopped') {
            setBottomTab('debug')
            setPreferences(p => ({ ...p, project: id, stage: true, terminalOpen: true, layoutMode: 'swe' }))
            const frame = update.snapshot.frames[0]
            if (frame?.path) navigateRef.current(id, frame.path, frame.line, frame.column)
          }
        }
        return
      }
      if (event.type === 'opencode') {
        if (event.projectID === preferencesRef.current.project && !chatTimer) chatTimer = setTimeout(() => { chatTimer = undefined; refreshSessions() }, 300)
        else if (event.projectID !== preferencesRef.current.project && sessionCacheRef.current[event.projectID] && !sessionTimers.has(event.projectID)) {
          sessionTimers.set(event.projectID, setTimeout(() => {
            sessionTimers.delete(event.projectID)
            void window.ame.sessions(event.projectID).then(items => {
              if (alive && !removedProjects.current.has(event.projectID)) setSessionCache(current => ({ ...current, [event.projectID]: items }))
            }).catch(() => {})
          }, 300))
        }
        return
      }
      clearTimeout(fileTimers.get(event.projectID))
      fileTimers.set(event.projectID, setTimeout(() => {
        fileTimers.delete(event.projectID)
        if (event.projectID === preferencesRef.current.project) {
          refresh()
          if (problemsOpenRef.current || openSourcePathsRef.current.length) void requestDiagnostics(event.projectID, true, problemsOpenRef.current ? undefined : openSourcePathsRef.current)
        }
        for (const [id, buffer] of Object.entries(buffersRef.current)) {
          if (buffer.projectID !== event.projectID) continue
          void window.ame.read(buffer.projectID, buffer.path).then(incoming => { if (alive) setBuffers(current => current[id] ? { ...current, [id]: reconcileDocument(current[id], incoming) } : current) }).catch(() => {
            if (alive) setBuffers(current => current[id] ? { ...current, [id]: { ...current[id], conflict: true } } : current)
          })
        }
      }, 180))
    })
    return () => { alive = false; unsubscribe(); for (const timer of fileTimers.values()) clearTimeout(timer); for (const timer of sessionTimers.values()) clearTimeout(timer); clearTimeout(chatTimer) }
  }, [report, refresh, refreshSessions, requestDiagnostics, acceptDebugSnapshot])
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
      updateView(projectID, current => ({ ...current, session: !current.session && sessionCacheRef.current[projectID] !== undefined ? undefined : items.some(s => s.id === current.session) ? current.session : items[0]?.id }))
    }).catch(e => { if (alive) setSessionError(errorText(e)) }).finally(() => { if (alive) setSessionsLoading(false) })
    return () => { alive = false }
  }, [projectID, connection.connected, sessionGeneration, updateView])
  useEffect(() => { setGitError('') }, [projectID])
  useEffect(() => {
    if (!projectID || !window.ame) return
    let alive = true
    void window.ame.git(projectID).then(value => { if (alive && !removedProjects.current.has(projectID)) { setGitCache(current => ({ ...current, [projectID]: value })); setGitError('') } }).catch(e => { if (alive) setGitError(errorText(e)) })
    return () => { alive = false }
  }, [projectID, generation])
  const loadFile = useCallback(async (id: string, path: string, force = false) => {
    const key = documentID(id, path)
    if (buffersRef.current[key] || pendingReads.current.has(key) || (!force && readErrorsRef.current[key])) return
    pendingReads.current.add(key)
    const epoch = pathsEpoch.current
    try {
      const doc = await window.ame.read(id, path)
      if (removedProjects.current.has(id) || epoch !== pathsEpoch.current) return
      setBuffers(current => current[key] ? current : { ...current, [key]: { ...doc, projectID: id, text: doc.content, conflict: false } })
      updateReadErrors(current => withoutKey(current, key))
    } catch (e) {
      if (!removedProjects.current.has(id) && epoch === pathsEpoch.current) updateReadErrors(current => ({ ...current, [key]: humanizeIdeError(e) }))
    } finally { pendingReads.current.delete(key); if (epoch !== pathsEpoch.current) refresh() }
  }, [refresh, updateReadErrors])
  const visibleFiles = JSON.stringify([splitState.primary.active?.path, splitState.secondary?.active?.path])
  useEffect(() => {
    if (projectsLoading || !projectID || !window.ame) return
    for (const path of JSON.parse(visibleFiles) as (string | null)[]) if (path) void loadFile(projectID, path)
  }, [projectsLoading, projectID, visibleFiles, loadFile, generation])
  useEffect(() => {
    if (projectsLoading || !projectID || !activeTab || activeTab.mode !== 'diff' || !window.ame) return
    let alive = true
    const key = documentID(projectID, activeTab.path)
    void window.ame.diff(projectID, activeTab.path).then(value => { if (alive && !removedProjects.current.has(projectID)) setDiffs(current => ({ ...current, [key]: value })) }).catch(e => { if (alive) report(e) })
    return () => { alive = false }
  }, [projectsLoading, projectID, activeTab?.path, activeTab?.mode, generation, report])

  useEffect(() => {
    if (modal !== 'settings' && modal !== 'account' && !pet?.preferences.enabled) return
    let alive = true
    spriteRequest.current ??= window.ame.petSprite()
    spriteRequest.current.then(value => { if (alive) setSprite(value) }).catch(report)
    return () => { alive = false }
  }, [modal, pet?.preferences.enabled, report])
  useEffect(() => {
    if (!pet?.preferences.enabled) return
    const style = getComputedStyle(document.documentElement)
    void window.ame.petTheme({ background: style.getPropertyValue('--bg-elevated').trim(), foreground: style.getPropertyValue('--text-primary').trim(), border: style.getPropertyValue('--border-default').trim() }).catch(report)
  }, [preferences.theme, preferences.tint, pet?.preferences.enabled, report])
  useEffect(() => {
    if (!pet?.preferences.enabled) return
    const sessions: PetSession[] = Object.entries(sessionCache).flatMap(([project, items]) => items.map(item => ({
      key: `${project}:${item.id}`, running: item.status === 'running', waiting: false, thinking: item.status === 'running', child: Boolean(item.parentID), outcome: item.outcome,
    })))
    void window.ame.petReport(sessions).catch(report)
  }, [sessionCache, pet?.preferences.enabled, report])

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
      setGitCache(current => withoutKey(current, id))
      setSplits(current => withoutKey(current, id))
      setBuffers(current => withoutProjectDocuments(current, id))
      updateReadErrors(current => withoutProjectDocuments(current, id))
      setDiffs(current => withoutProjectDocuments(current, id))
      setPreferences(current => withoutProject(current, id, remaining))
      setCreatedTerminal(current => current?.projectID === id ? undefined : current)
      setDiagnosticsByProject(current => withoutKey(current, id))
      setDebugByProject(current => withoutKey(current, id))
      setBreakpointsByProject(current => withoutKey(current, id))
      setDebugEntries(current => withoutKey(current, id))
      setSelectedFrames(current => withoutKey(current, id))
      setDebugOutputs(current => withoutKey(current, id))
      for (const key of overlayTexts.current.keys()) if ((JSON.parse(key) as string[])[0] === id) { overlayTexts.current.delete(key); overlayQueues.current.delete(key) }
    } catch (e) { if (!errorText(e).includes('CANCELLED')) report(e) }
  }
  const newTerminal = async () => {
    setBottomTab('terminal')
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
  const openProjectTab = (id: string, path: string, mode: Tab['mode'], line?: number, column?: number) => {
    if (removedProjects.current.has(id)) return
    const dir = projectsRef.current.find(project => project.id === id)?.directory
    const resolved = resolveWorkspaceFilePath(path, dir)
    if (!resolved) { setError('Không thể mở đường dẫn thư mục hoặc tệp nằm ngoài dự án.'); return }
    path = resolved.path
    line ??= resolved.line
    const key = documentID(id, path)
    updateReadErrors(current => withoutKey(current, key))
    if (mode === 'file') void loadFile(id, path, true)
    setNavigation(mode === 'file' && line !== undefined ? { projectID: id, path, line, column, nonce: ++navigationNonce.current } : undefined)
    const tab = { path, mode }
    if (mode === 'file') updateSplit(id, current => openTabInGroup(current, tab))
    updateView(id, current => activateTab({ ...current, tabs: current.tabs.some(t => tabID(t) === tabID(tab)) ? current.tabs : [...current.tabs, tab] }, tab))
    setPreferences(p => ({ ...p, project: id, stage: true, panel: mode === 'diff' ? 'diff' : 'files', layoutMode: mode === 'diff' ? 'swe' : p.layoutMode }))
  }
  const openTab = (path: string, mode: Tab['mode'], line?: number, column?: number) => { if (projectID) openProjectTab(projectID, path, mode, line, column) }
  navigateRef.current = (id, path, line, column) => openProjectTab(id, path, 'file', line, column)
  const closeOverlay = (id: string, path: string) => {
    if (!isSourceFile(path)) return
    const key = documentID(id, path)
    overlayTexts.current.delete(key)
    const queue = (overlayQueues.current.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!removedProjects.current.has(id)) await window.ame.lspCloseDocument(id, path)
    }).catch(() => {})
    overlayQueues.current.set(key, queue)
    void queue.then(() => {
      if (overlayQueues.current.get(key) === queue) overlayQueues.current.delete(key)
      if (preferencesRef.current.project === id && (problemsOpenRef.current || openSourcePathsRef.current.length)) void requestDiagnostics(id, false, problemsOpenRef.current ? undefined : openSourcePathsRef.current)
    })
  }
  const toggleBreakpoint = (path: string, line: number) => {
    if (!projectID) return
    const id = projectID, byPath = breakpointRef.current[id] ?? {}, previous = byPath[path] ?? []
    const next = previous.includes(line) ? previous.filter(item => item !== line) : [...previous, line].sort((a, b) => a - b)
    const updated = { ...breakpointRef.current, [id]: { ...byPath, [path]: next } }
    breakpointRef.current = updated
    setBreakpointsByProject(updated)
    const key = documentID(id, path)
    const queue = (breakpointQueues.current.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!removedProjects.current.has(id)) await window.ame.debugSetBreakpoints(id, path, next)
    })
    breakpointQueues.current.set(key, queue)
    void queue.catch(e => {
      if (!removedProjects.current.has(id)) report(e)
    }).finally(() => {
      if (breakpointQueues.current.get(key) !== queue) return
      breakpointQueues.current.delete(key)
      if (removedProjects.current.has(id)) return
      const revision = debugRevision.current.get(id) ?? 0
      void window.ame.debugState(id).then(snapshot => {
        if (!removedProjects.current.has(id) && !breakpointQueues.current.has(key) && revision === (debugRevision.current.get(id) ?? 0)) acceptDebugSnapshot(id, snapshot)
      }).catch(report)
    })
  }
  const renameOpenPath = (id: string, from: string, to: string) => {
    for (const buffer of Object.values(buffersRef.current)) if (buffer.projectID === id && renamedPath(buffer.path, from, to) !== buffer.path) closeOverlay(id, buffer.path)
    pathsEpoch.current++
    updateView(id, current => renameView(current, from, to))
    updateSplit(id, current => renameInSplitState(current, from, to))
    setBuffers(current => renameBuffers(current, id, from, to))
    updateReadErrors(current => changePathDocuments(current, id, from))
    setDiffs(current => changePathDocuments(current, id, from, to))
    setNavigation(current => current?.projectID === id ? { ...current, path: renamedPath(current.path, from, to) } : current)
  }
  const deleteOpenPath = (id: string, path: string) => {
    for (const buffer of Object.values(buffersRef.current)) if (buffer.projectID === id && (buffer.path === path || buffer.path.startsWith(`${path}/`))) closeOverlay(id, buffer.path)
    pathsEpoch.current++
    updateView(id, current => deleteFromView(current, path))
    updateSplit(id, current => deleteInSplitState(current, path))
    setBuffers(current => changePathDocuments(current, id, path))
    updateReadErrors(current => changePathDocuments(current, id, path))
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
      if (isSourceFile(tab.path)) {
        const text = buffersRef.current[key]?.text ?? buffer.text
        overlayTexts.current.set(key, text)
        const queue = (overlayQueues.current.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
          if (!removedProjects.current.has(p.project!) && buffersRef.current[key]) await window.ame.lspUpdateDocument(p.project!, tab.path, text)
        })
        overlayQueues.current.set(key, queue)
        void queue.catch(e => { overlayTexts.current.delete(key); if (!removedProjects.current.has(p.project!)) report(e) }).finally(() => { if (overlayQueues.current.get(key) === queue) overlayQueues.current.delete(key) })
        void requestDiagnostics(p.project, true, problemsOpenRef.current ? undefined : [tab.path])
      }
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
    updateReadErrors(current => withoutKey(current, key))
    if (!buffersRef.current[key] && tab.mode === 'file') { await loadFile(projectID, tab.path, true); return }
    const epoch = pathsEpoch.current
    try {
      const incoming = await window.ame.read(projectID, tab.path)
      if (removedProjects.current.has(projectID) || epoch !== pathsEpoch.current) return
      setBuffers(current => ({ ...current, [key]: { ...incoming, projectID, text: incoming.content, conflict: false } }))
    } catch (e) { if (!removedProjects.current.has(projectID) && epoch === pathsEpoch.current) updateReadErrors(current => ({ ...current, [key]: humanizeIdeError(e) })) }
  }
  const closeTab = (tab: Tab, group: EditorGroupID = splitState.focused) => {
    if (!projectID) return
    const other = splitState[group === 'primary' ? 'secondary' : 'primary']
    const retained = tab.mode === 'file' && !!other?.tabs.some(item => tabID(item) === tabID(tab))
    const key = documentID(projectID, tab.path), buffer = buffersRef.current[key]
    if (!retained && tab.mode === 'file' && buffer && dirty(buffer) && !window.confirm(`Bỏ các thay đổi chưa lưu trong ${tab.path}?`)) return
    if (tab.mode === 'file') updateSplit(projectID, current => closeTabInGroup(current, tab, group))
    if (!retained) updateView(projectID, current => removeTab(current, tab))
    if (!retained && tab.mode === 'file') {
      if (pendingReads.current.has(key)) pathsEpoch.current++
      updateReadErrors(current => withoutKey(current, key))
      closeOverlay(projectID, tab.path)
      setBuffers(current => { const next = { ...current }; delete next[key]; return next })
    }
  }
  const selectPanel = (panel: Preferences['panel']) => {
    if (panel === 'subagents' || panel === 'btw') { window.dispatchEvent(new CustomEvent('ame-chat-drawer', { detail: panel === 'subagents' ? 'agents' : 'btw' })); return }
    if (panel === 'terminal') { setBottomTab('terminal'); setPreferences(p => ({ ...p, terminalOpen: true, stage: true, layoutMode: 'swe' })); return }
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
    { title: 'Dịch Android Strings', shortcut: '', run: () => { if (projectID) setTranslationModalOpen(true); else report(new Error('Mở dự án để dịch Android Strings.')) } },
    ...(import.meta.env.DEV ? [{ title: 'Layout X-Ray', shortcut: 'Ctrl+Shift+X', run: () => setXray(x => !x) }] : [])
  ]
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandler.current = event => {
    if (translationModalOpen) return
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
      <EditorStage projectID={projectID || ''} target={group === splitState.focused || diffMode ? navigation : undefined} dirtyPaths={projectDirtyPaths(buffers, projectID)} tabs={diffMode ? view.tabs.filter(tab => tab.mode === 'diff') : editorGroup?.tabs || []} active={tab} buffer={buffer} loadError={projectID && tab ? readErrors[documentID(projectID, tab.path)] : undefined} diff={projectID && tab ? diffs[documentID(projectID, tab.path)] : undefined} theme={preferences.theme}
        diagnostics={diagnostics} breakpoints={projectID && tab ? breakpointsByProject[projectID]?.[tab.path] ?? [] : []}
        pausedLine={tab?.path === pausedFrame?.path ? pausedFrame?.line : undefined}
        onToggleBreakpoint={line => { if (tab?.mode === 'file') toggleBreakpoint(tab.path, line) }}
        onNavigateLocation={(path, line, column) => openTab(path, 'file', line, column)}
        onSelect={selected => { if (projectID) { if (!diffMode) updateSplit(projectID, current => selectTabInGroup(current, selected, group)); updateView(projectID, current => activateTab(current, selected)) } }}
        onClose={tab => closeTab(tab, group)} onChange={text => { if (projectID && tab) { const key = documentID(projectID, tab.path); setBuffers(current => current[key] ? { ...current, [key]: { ...current[key], text } } : current) } }}
        onSave={() => void save(tab)} onReload={() => void reload(tab)} onToggleSplit={toggleSplit} isSplit={!!splitState.secondary}
        onStatus={status => { if (projectID && tab) setEditorStatuses(current => ({ ...current, [JSON.stringify([projectID, group, tab.path])]: status })) }} />
    </div>
  }
  return <div data-testid="shell" className={`app-shell ${isMac ? 'is-macos' : ''} ${xray ? 'xray' : ''}`}>
    <header className="titlebar" data-region="Titlebar"><div className="titlebar__left"><span className="brand-mark brand-mark--icon-only" title="Ame"><span className="brand-mark__icon"><Icon name="brand" /></span></span><IconButton label="Tài khoản & AmeKit" onClick={() => setModal('account')}><Icon name="account" /></IconButton><IconButton label="Settings" onClick={() => setModal('settings')}><Icon name="settings" /></IconButton><IconButton label={`Projects & Chats (${formatShortcut('Ctrl+B', isMac)})`} active={preferences.rail} onClick={() => toggle('rail')}><Icon name="sidebar" /></IconButton></div><div className="titlebar__center"><button className="cmd-trigger" onClick={() => { setQuery(''); setModal('palette') }}><span className="cmd-trigger__label"><Icon name="search" /><span className="truncate">{activeSession?.title || 'Lệnh & điều hướng'}</span></span><span className="kbd">{formatShortcut('Ctrl+K', isMac)}</span></button></div><div className="titlebar__right">{import.meta.env.DEV && <button className={`pill-btn ${xray ? 'is-active' : ''}`} onClick={() => setXray(value => !value)}><Icon name="grid" />Layout X-Ray</button>}<IconButton label={`Project Inspector (${formatShortcut('Ctrl+Shift+E', isMac)})`} active={preferences.inspector} onClick={() => toggle('inspector')}><Icon name="folder" /></IconButton><IconButton label={`Bottom Panel (${formatShortcut('Ctrl+J', isMac)})`} active={preferences.terminalOpen && preferences.stage} onClick={() => setPreferences(p => ({ ...p, terminalOpen: !p.terminalOpen, stage: true }))}><Icon name="bottom" /></IconButton><IconButton label={`File Stage (${formatShortcut('Ctrl+Alt+B', isMac)})`} active={preferences.stage} onClick={() => toggle('stage')}><Icon name="panel" /></IconButton><span className="titlebar__divider" /><div className="win-controls">{(['minimize', 'maximize', 'close'] as const).map((action, index) => <button key={action} className={`win-btn ${action === 'close' ? 'win-btn--close' : ''}`} aria-label={['Thu nhỏ', 'Phóng to / khôi phục', 'Đóng cửa sổ'][index]} onClick={() => void window.ame?.window(action).catch(report)}><Icon name={action} /></button>)}</div></div></header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><IconButton label="Đóng thông báo" onClick={() => setError('')}><Icon name="close" /></IconButton></div>}
    <div className={`workspace-body ${!preferences.rail ? 'is-sidebar-collapsed' : ''} ${!preferences.inspector ? 'is-inspector-collapsed' : ''} ${!preferences.stage ? 'is-sidepanel-collapsed' : ''} ${maximized && preferences.stage ? 'is-sidepanel-maximized' : ''}`} style={{ '--sidebar-w': `${preferences.widths.rail}px`, '--inspector-w': `${preferences.widths.inspector}px`, '--sidepanel-w': `${preferences.widths.stage}px` } as CSSProperties}>
      {preferences.rail && <><ProjectRail projects={projects} projectID={projectID} sessions={sessions} sessionCache={sessionCache} onRemove={id => void removeProject(id)} onSessionRemoved={(id, removed) => { const remaining = (sessionCacheRef.current[id] || []).filter(session => session.id !== removed); setSessionCache(current => ({ ...current, [id]: (current[id] || []).filter(session => session.id !== removed) })); updateView(id, current => current.session === removed ? { ...current, session: remaining[0]?.id } : current); refreshSessions() }} onSessions={(id, items) => { setSessionCache(current => removedProjects.current.has(id) ? current : ({ ...current, [id]: items })); updateView(id, current => ({ ...current, session: !current.session && sessionCacheRef.current[id] !== undefined ? undefined : items.some(item => item.id === current.session) ? current.session : items[0]?.id })) }} sessionID={view.session} loading={projectsLoading} sessionsLoading={sessionsLoading} error={sessionError} connected={connection.connected} creating={creating} git={git} generation={generation} onSelect={id => setPreferences(p => ({ ...p, project: id }))} onSession={(id, session) => { setPreferences(p => ({ ...p, project: id })); updateView(id, current => ({ ...current, session })) }} onTool={(id, tab) => setPreferences(p => ({ ...p, project: id, inspector: true, inspectorTab: tab }))} onCreate={id => void createSession(id)} onPick={() => void pickProject()} onRetry={refreshSessions} /><Resizer pane="rail" width={preferences.widths.rail} onChange={w => setWidth('rail', w)} /></>}
      {preferences.inspector && <><Inspector projectID={projectID} name={project?.name} connected={connection.connected} tab={preferences.inspectorTab} setTab={tab => setPreferences(p => ({ ...p, inspectorTab: tab }))} generation={generation} git={git} gitError={gitError} refresh={refresh} onOpen={(path, line, column) => openTab(path, 'file', line, column)} onRename={(from, to) => { if (projectID) renameOpenPath(projectID, from, to) }} onDelete={path => { if (projectID) deleteOpenPath(projectID, path) }} onDiff={path => openTab(path, 'diff')} onHide={() => toggle('inspector')} report={report} /><Resizer pane="inspector" width={preferences.widths.inspector} onChange={w => setWidth('inspector', w)} /></>}
      <Chat onOpenAndroidTranslation={() => setTranslationModalOpen(true)} timelineDetail={preferences.timelineDetail} projectDirectory={project?.directory} accountRole={accountRole} defaultModelID={accountDefaultModel} modelLevels={accountModelLevels} connectionUrl={connection.url} onModelChange={setSelectedModel} key={projectID || ''} files={files} activeFile={activeTab?.mode === 'file' ? activeTab.path : undefined} onRequestFiles={requestFiles} ready={!!projectID && sessionCache[projectID] !== undefined && !sessionsLoading && (!view.session || !!activeSession) && !sessionError} onCreated={session => { if (projectID) { updateView(projectID, current => ({ ...current, session: session.id })); setSessionCache(current => ({ ...current, [projectID]: [session, ...(current[projectID] || []).filter(s => s.id !== session.id)] })) } }} projectID={projectID} sessionID={view.session} title={activeSession?.title} connected={connection.connected} onCreate={() => void createSession()} report={report} onActivity={refreshSessions} onOpenPanel={selectPanel} onOpenFile={(path, line) => openTab(path, 'file', line)} sessions={sessions} tabs={view.tabs} changes={changesState.status === 'ready' ? changesState.files.length : 0} changesStatus={changesState.status} theme={preferences.theme} projectName={project?.name} branch={git?.branch} onSelectSession={id => { if (projectID) updateView(projectID, current => ({ ...current, session: id })) }} />
      {preferences.stage && <><Resizer pane="stage" width={preferences.widths.stage} onChange={w => setWidth('stage', w)} /><section className="side-panel" data-testid="side-panel" data-region="Auxiliary Side Panel">
        <div className="side-panel__tabs"><div className="side-panel__tab-list" role="tablist" aria-label="Workspace panel">{(['files', 'changes', 'diff', 'artifact', 'usage'] as const).filter(tab => preferences.layoutMode !== 'knowledge' || tab !== 'diff').map(tab => <button key={tab} role="tab" aria-selected={preferences.panel === tab} className={`panel-tab ${preferences.panel === tab ? 'is-active' : ''}`} onClick={() => selectPanel(tab)}>{({ files: 'Code', changes: 'Session Changes', diff: 'Git Diff', artifact: 'Artifact', usage: 'Usage' })[tab]}</button>)}</div><div className="stage-actions"><IconButton label="Toggle Terminal" active={preferences.terminalOpen} onClick={() => setPreferences(p => ({ ...p, terminalOpen: !p.terminalOpen }))}><Icon name="terminal" /></IconButton><IconButton label="Phóng to Side Panel" active={maximized} onClick={() => setMaximized(v => !v)}><Icon name="maximize" /></IconButton><IconButton label="Close Side Panel" onClick={() => toggle('stage')}><Icon name="close" /></IconButton></div></div>
        <div className="editor-breadcrumb"><span className="truncate"><strong>{project?.name || 'Local Workspace'}</strong> &rsaquo; {preferences.panel === 'changes' ? activeSession?.title || 'Session Changes' : activeTab?.path || (preferences.panel === 'diff' ? 'VS Code Diff' : 'Code')}</span><span>{preferences.panel === 'changes' ? 'OpenCode snapshots' : preferences.panel === 'diff' ? 'Git Engine' : 'UTF-8'}</span></div>
        <div className="side-panel__content"><div className={`workspace-tools ${preferences.panel === 'files' && splitState.secondary ? 'is-split' : ''}`} hidden={!['files', 'diff'].includes(preferences.panel)}>{renderEditor('primary')}{preferences.panel === 'files' && splitState.secondary && renderEditor('secondary')}</div>{preferences.panel === 'changes' && <SessionChanges key={changesKey} state={changesState} theme={preferences.theme} onRetry={() => setChangesAttempt(value => value + 1)} />}{preferences.panel === 'usage' && <><UsagePanel nodes={usage?.key === usageKey ? usage.value?.nodes || [] : []} loading={!!projectID && !!view.session && (usage?.key !== usageKey || usage.loading)} error={usage?.key === usageKey ? usage.error : undefined} origin={usage?.key === usageKey ? usage.value?.origin : null} selectedSessionID={view.session} onSelectSession={id => { if (projectID) updateView(projectID, current => ({ ...current, session: id })) }} onRefresh={() => setUsageAttempt(value => value + 1)} />{usage?.key === usageKey && usage.value?.limited && <p role="status">Giới hạn hiển thị 200 phiên.</p>}</>}{preferences.panel === 'artifact' && (projectID ? <ArtifactViewer projectID={projectID} sessionID={view.session} /> : <Empty>Chọn dự án để xem artifact.</Empty>)}</div>
        <TerminalPanel projectID={projectID} createdTerminal={createdTerminal} theme={preferences.theme} visible={preferences.terminalOpen && preferences.layoutMode !== 'knowledge'} close={() => setPreferences(p => ({ ...p, terminalOpen: false }))}
          height={bottomHeight} onHeightChange={setBottomHeight} activeTab={bottomTab} onSelectTab={setBottomTab} problemCounts={problemCounts} debugStatus={debugSnapshot.status}
          problemsProps={{ problems: diagnostics, loading: problemsLoading, onOpenLocation: (path, line, column) => openTab(path, 'file', line, column), onRefresh: projectID ? () => void requestDiagnostics(projectID, true) : undefined }}
          debugProps={{ snapshot: debugSnapshot, output: projectID ? debugOutputs[projectID] ?? [] : [], entry: debugEntry, selectedFrameId,
            onEntryChange: entry => { if (projectID) setDebugEntries(current => ({ ...current, [projectID]: entry })) },
            onStart: entry => { if (projectID) { setDebugOutputs(current => ({ ...current, [projectID]: [] })); void window.ame.debugStart(projectID, { entry, runtime: /\.(?:[cm]?ts|tsx)$/i.test(entry) ? 'tsx' : 'node' }).catch(report) } },
            onStop: () => { if (projectID) void window.ame.debugStop(projectID).catch(report) },
            onContinue: () => { if (projectID) void window.ame.debugContinue(projectID).catch(report) },
            onPause: () => { if (projectID) void window.ame.debugPause(projectID).catch(report) },
            onStepOver: () => { if (projectID) void window.ame.debugStepOver(projectID).catch(report) },
            onStepInto: () => { if (projectID) void window.ame.debugStepInto(projectID).catch(report) },
            onStepOut: () => { if (projectID) void window.ame.debugStepOut(projectID).catch(report) },
            onSelectFrame: (callFrameId, path, line, column) => { if (projectID) { setSelectedFrames(current => ({ ...current, [projectID]: callFrameId })); if (path) openTab(path, 'file', line, column) } },
            onOpenLocation: (path, line, column) => openTab(path, 'file', line, column), onRemoveBreakpoint: toggleBreakpoint,
            onEvaluate: expression => projectID ? window.ame.debugEvaluate(projectID, expression, selectedFrameId) : Promise.resolve({ value: '', type: 'error', error: 'Chưa mở project.' }),
            onClearOutput: () => { if (projectID) setDebugOutputs(current => ({ ...current, [projectID]: [] })) }
          }} />
        <footer className="side-panel__status statusbar"><button type="button" className="statusbar__problems" aria-label={`Vấn đề: ${problemCounts.error} lỗi, ${problemCounts.warning} cảnh báo`} onClick={() => { setBottomTab('problems'); setPreferences(p => ({ ...p, terminalOpen: true, stage: true, layoutMode: 'swe' })) }}>✕ {problemCounts.error} ⚠ {problemCounts.warning}</button><span className="truncate">{project?.name || 'Local Workspace'}{git?.branch ? ` · ${git.branch}` : ''}</span>{preferences.panel === 'files' && activeTab && <span className="statusbar__editor">Ln {editorStatus?.line || 1}, Col {editorStatus?.column || 1} · {editorStatus?.language || languageFor(activeTab.path)} · UTF-8 · {editorStatus?.indent || 'Spaces: 2'}</span>}<span>{dirtyCount ? `${dirtyCount} tệp chưa lưu` : 'Đã lưu'}</span></footer>
      </section></>}
    </div>
    {translationModalOpen && projectID && <AndroidTranslationModal key={projectID} projectID={projectID} projectName={project?.name} projectDirectory={project?.directory} connected={connection.connected} theme={preferences.theme} timelineDetail={preferences.timelineDetail} onClose={() => setTranslationModalOpen(false)} onActivity={refreshSessions} onOpenFile={(path, line) => openTab(path, 'file', line)} />}
    {(modal === 'settings' || modal === 'account') && <Settings isMac={isMac} pet={pet} sprite={sprite} selectedModel={selectedModel?.modelID ?? selectedModel?.id} onPet={setPet} initialSection={modal === 'account' ? 'amekit' : 'appearance'} preferences={preferences} setLayout={patch => setPreferences(p => ({ ...p, ...patch, panel: patch.layoutMode === 'knowledge' && ['diff', 'terminal', 'subagents'].includes(p.panel) ? 'files' : p.panel }))} theme={preferences.theme} setTheme={theme => setPreferences(p => ({ ...p, theme }))} connection={connection} setConnection={setConnection} close={() => setModal(null)} />}
    <QuickOpen open={!!quickOpen} mode={quickOpen || 'files'} files={files} recentPaths={view.tabs.filter(tab => tab.mode === 'file').map(tab => tab.path)} activeFile={activeTab?.mode === 'file' ? activeTab.path : undefined} activeLineCount={editorStatus?.lineCount || activeBuffer?.text.split('\n').length} loading={fileIndex?.key !== fileIndexKey || fileIndex.loading} onSelectFile={(path, line, column) => openTab(path, 'file', line, column)} onGoToLine={(line, column) => { if (activeTab?.mode === 'file') openTab(activeTab.path, 'file', line, column) }} onClose={() => setQuickOpen(undefined)} />
    {quickOpen && fileIndex?.key === fileIndexKey && fileIndex.error && <div className="error-banner" role="alert">{fileIndex.error}</div>}
    {modal === 'palette' && <Modal title="Bảng lệnh" close={() => setModal(null)}><input className="palette-input" aria-label="Tìm lệnh" placeholder="Nhập tên lệnh…" value={query} onChange={e => setQuery(e.target.value)} autoFocus /><div className="palette-actions">{actions.filter(action => action.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(action => <button key={action.title} onClick={() => { setModal(null); action.run() }}>{action.title}<kbd>{formatShortcut(action.shortcut, isMac)}</kbd></button>)}</div></Modal>}
  </div>
}
