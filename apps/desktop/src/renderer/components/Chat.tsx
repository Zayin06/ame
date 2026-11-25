import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { Agent, AndroidTranslationInfo, ChatItem, Model, Permission, ResolvedDroppedFile, Session, SkillSummary, SlashCommand } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'
import { type Preferences, type Tab, type TimelineDetailMode } from '../state'
import { projectChatTimeline } from '../chat-timeline'
import { ActiveToolsView, LiveTurnStatus, TurnWorkGroup } from './TurnWorkGroup'
import { AgentList } from './AgentList'
import { AgentMap } from './AgentMap'
import { familySummaryFromSessions } from '../agent-map-model'
import { Empty, errorText, IconButton } from './Primitives'
import { chatSubmit } from '../chat-submit'
import { formatModelOptionLabel, modelKey, resolvePreferredModel, type ModelLevels } from '../model-selection'
import { TurnChanges } from './SessionChanges'
import { ToolCard } from './ToolCard'
import { ArtifactViewer } from './ArtifactViewer'
import { applyComposerCompletion, detectComposerTrigger, filterFileMentions, filterSlashEntries, WORKSPACE_DRAG_MIME, readBrowserFileAttachment, splitComposerAttachments, MAX_PROMPT_FILES, type ComposerAttachment, type ComposerTrigger } from '../composer-mentions'
import { ComposerAttachmentStrip, ComposerDropOverlay, MessageAttachmentList } from './ComposerAttachments'

type ProjectCatalog = { key: string; fetchedAt: number; models: Model[]; agents: Agent[]; commands: SlashCommand[]; skills: SkillSummary[] }
const projectCatalogCache = new Map<string, ProjectCatalog>()
let catalogRevision = 0
const clearProjectCatalogs = () => { projectCatalogCache.clear(); catalogRevision++ }

export function chatModelsForPolicy(models: readonly Model[], role?: string, defaultModel?: string): Model[] {
  return models.filter(model => model.providerID === 'amecode' && (role !== 'user' || !!defaultModel && (model.modelID === defaultModel || model.id === defaultModel)))
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]))
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]))
}

function sameChatItems(a: ChatItem[], b: ChatItem[]): boolean {
  return a === b || a.length === b.length && a.every((item, index) => {
    const next = b[index]
    return item.id === next.id && item.role === next.role && item.text === next.text && item.kind === next.kind
      && item.createdAt === next.createdAt && item.completedAt === next.completedAt && item.phase === next.phase && item.workedMs === next.workedMs
      && sameValue(item.tool, next.tool) && sameValue(item.turn, next.turn) && sameValue(item.attachments, next.attachments)
  })
}

export function Chat({ focusNonce, timelineDetail = 'compact', projectID, projectDirectory, sessionID, title, connected, connectionUrl = '', accountRole, defaultModelID, modelLevels, onCreate, report, onActivity, onOpenPanel, onOpenFile, sessions, tabs, changes, changesStatus, theme, projectName, branch, onSelectSession, onCreated, onModelChange, onOpenAndroidTranslation, ready, files = [], activeFile, onRequestFiles }: { focusNonce?: number; timelineDetail?: TimelineDetailMode; accountRole?: string; defaultModelID?: string; modelLevels?: Partial<ModelLevels>; connectionUrl?: string; files?: readonly string[]; activeFile?: string; onRequestFiles?: () => void; onOpenAndroidTranslation?: () => void; ready: boolean; onCreated: (session: Session) => void; onModelChange?: (model?: Model) => void; projectID?: string; projectDirectory?: string; sessionID?: string; title?: string; connected: boolean; onCreate: () => void; report: (e: unknown) => void; onActivity: () => void; onOpenPanel: (panel: Preferences['panel']) => void; onOpenFile: (path: string, line?: number) => void; sessions: Session[]; tabs: Tab[]; changes: number; changesStatus: 'loading' | 'ready' | 'error'; theme: 'dark' | 'light'; projectName?: string; branch?: string; onSelectSession: (id: string) => void }) {
  const cached = projectID && connected ? projectCatalogCache.get(projectID) : undefined
  const initialCatalog = cached?.key === connectionUrl ? cached : undefined
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [catalogModels, setModels] = useState<Model[]>(() => initialCatalog?.models ?? [])
  const [modelProject, setModelProject] = useState<string | undefined>(() => initialCatalog ? projectID : undefined)
  const [agents, setAgents] = useState<Agent[]>(() => initialCatalog?.agents ?? [])
  const [fallbackRole, setFallbackRole] = useState<string>()
  const [fallbackDefaultModel, setFallbackDefaultModel] = useState<string>()
  const [fallbackModelLevels, setFallbackModelLevels] = useState<Partial<ModelLevels>>()
  const role = accountRole !== undefined ? accountRole : fallbackRole
  const effectiveDefaultModel = defaultModelID !== undefined ? defaultModelID : fallbackDefaultModel
  const effectiveModelLevels = modelLevels !== undefined ? modelLevels : fallbackModelLevels
  const models = chatModelsForPolicy(catalogModels, role, effectiveDefaultModel)
  const [androidInfo, setAndroidInfo] = useState<AndroidTranslationInfo>()
  const lockedTranslationIDs = androidInfo?.lockedSessionIDs ?? []
  const translationSessionIDs = androidInfo?.translationSessionIDs ?? []
  const lockedTranslation = !!sessionID && lockedTranslationIDs.includes(sessionID)
  const translationSession = !!sessionID && translationSessionIDs.includes(sessionID)
  useEffect(() => {
    let alive = true, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setAndroidInfo(undefined)
    const load = async () => {
      if (!projectID || !connected || !window.ame.androidTranslationInfo) return
      const request = ++generation
      try {
        const info = await window.ame.androidTranslationInfo(projectID)
        if (alive && request === generation) setAndroidInfo(info)
      } catch (e) { if (alive && request === generation) report(e) }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    window.addEventListener('ame-translation-changed', load)
    const unsubscribe = window.ame.onEvent(event => {
      if (event.type === 'opencode' && event.projectID === projectID && (!event.sessionID || event.sessionID === sessionID)) { clearTimeout(timer); timer = setTimeout(() => void load(), 300) }
    })
    return () => { alive = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('ame-account-changed', load); window.removeEventListener('ame-translation-changed', load) }
  }, [projectID, connected, sessionID, report])
  const userPickedModel = useRef(false)
  const [model, setModel] = useState(() => resolvePreferredModel({ models: chatModelsForPolicy(initialCatalog?.models ?? [], role, effectiveDefaultModel), currentValue: '', defaultModelID: effectiveDefaultModel, role }))
  const modelPolicy = useRef({ role, defaultModelID: effectiveDefaultModel })
  modelPolicy.current = { role, defaultModelID: effectiveDefaultModel }
  const [agent, setAgent] = useState('')
  const [text, setText] = useState('')
  const [commands, setCommands] = useState<SlashCommand[]>(() => initialCatalog?.commands ?? [])
  const [skills, setSkills] = useState<SkillSummary[]>(() => initialCatalog?.skills ?? [])
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const dragDepth = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  const canAttach = !lockedTranslation && !translationSession && !!projectID && connected
  useEffect(() => { dragDepth.current = 0; setDragActive(false) }, [projectID, sessionID, canAttach])
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [attachmentPicker, setAttachmentPicker] = useState(false)
  const [attachmentQuery, setAttachmentQuery] = useState('')
  const [completionIndex, setCompletionIndex] = useState(0)
  const composing = useRef(false)
  const attachmentSequence = useRef(0)
  const popoverID = useId()
  const [busy, setBusy] = useState(false)
  const [replying, setReplying] = useState(false)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<'artifacts' | 'agents' | 'btw' | null>(null)
  const [agentMapOpen, setAgentMapOpen] = useState(false)
  const agentFamily = familySummaryFromSessions(sessions, sessionID)
  useEffect(() => { setAgentMapOpen(false) }, [projectID])
  const [menu, setMenu] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focusNonce) input.current?.focus()
  }, [focusNonce])
  const currentSession = useRef(sessionID); currentSession.current = sessionID
  const currentProject = useRef(projectID); currentProject.current = projectID
  const createdSession = useRef<string | undefined>(undefined)
  const submit = useRef<ReturnType<typeof chatSubmit> | undefined>(undefined)
  const submitProject = useRef(projectID)
  if (!submit.current || submitProject.current !== projectID) {
    submitProject.current = projectID
    submit.current = chatSubmit(window.ame, session => {
      if (currentProject.current !== projectID) return
      createdSession.current = session.id; onCreated(session)
    })
  }
  const drafts = useRef<Record<string, { text: string; attachments: ComposerAttachment[] }>>({})
  const draftKey = (project: string | undefined, session: string | undefined) => JSON.stringify([project, session])
  const previousSession = useRef(sessionID)
  const previousProject = useRef(projectID)
  useEffect(() => {
    if (previousSession.current === sessionID && previousProject.current === projectID) return
    const oldKey = draftKey(previousProject.current, previousSession.current)
    drafts.current[oldKey] = { text, attachments }
    if (previousProject.current !== projectID || previousSession.current || sessionID !== createdSession.current) {
      const draft = drafts.current[draftKey(projectID, sessionID)]
      setText(draft?.text || ''); setAttachments(draft?.attachments || [])
    } else delete drafts.current[oldKey]
    if (previousProject.current !== projectID) createdSession.current = undefined
    previousSession.current = sessionID; previousProject.current = projectID
    setTrigger(null); setAttachmentPicker(false)
    setMessages([]); setPermissions([]); setLoaded(false)
  }, [projectID, sessionID])
  useEffect(() => {
    const open = (event: Event) => { setTrigger(null); setAttachmentPicker(false); setDrawer((event as CustomEvent).detail || 'artifacts') }
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
    if (accountRole !== undefined && defaultModelID !== undefined && modelLevels !== undefined) return
    let alive = true, generation = 0
    const load = async () => {
      const current = ++generation
      try {
        const status = await window.ame.account('status') as { account?: { role?: string }; models?: { default_model?: string; model_levels?: Partial<ModelLevels> } } | null
        if (alive && current === generation) {
          setFallbackRole(status?.account?.role)
          setFallbackDefaultModel(status?.models?.default_model)
          setFallbackModelLevels(status?.models?.model_levels)
          if (!status?.account) userPickedModel.current = false
        }
      } catch (e) { if (alive && current === generation) { setFallbackRole(undefined); setFallbackDefaultModel(undefined); setFallbackModelLevels(undefined); setError(errorText(e)) } }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    return () => { alive = false; window.removeEventListener('ame-account-changed', load) }
  }, [connected, accountRole, defaultModelID, modelLevels])
  useEffect(() => {
    let alive = true, generation = 0
    let catalogTimer: ReturnType<typeof setTimeout> | undefined
    const hydrate = (catalog?: ProjectCatalog) => {
      const allowed = chatModelsForPolicy(catalog?.models ?? [], modelPolicy.current.role, modelPolicy.current.defaultModelID)
      setModels(catalog?.models ?? []); setAgents(catalog?.agents ?? [])
      setCommands(catalog?.commands ?? []); setSkills(catalog?.skills ?? [])
      setModelProject(catalog ? projectID : undefined)
      if (!allowed.length) userPickedModel.current = false
      setModel(currentValue => resolvePreferredModel({ models: allowed, currentValue, ...modelPolicy.current, userPicked: userPickedModel.current }))
    }
    const load = async () => {
      if (!projectID || !connected) return
      const current = ++generation, revision = catalogRevision
      const results = await Promise.allSettled([window.ame.models(projectID), window.ame.agents(projectID), window.ame.commands(projectID), window.ame.skills(projectID)])
      if (!alive || current !== generation || revision !== catalogRevision) return
      const cached = projectCatalogCache.get(projectID)
      const previous = cached?.key === connectionUrl ? cached : undefined
      const catalog: ProjectCatalog = {
        key: connectionUrl,
        fetchedAt: results.every(result => result.status === 'fulfilled') ? Date.now() : 0,
        models: results[0].status === 'fulfilled' ? results[0].value.filter(item => item.providerID === 'amecode') : previous?.models ?? [],
        agents: results[1].status === 'fulfilled' ? results[1].value : previous?.agents ?? [],
        commands: results[2].status === 'fulfilled' ? results[2].value : previous?.commands ?? [],
        skills: results[3].status === 'fulfilled' ? results[3].value : previous?.skills ?? [],
      }
      projectCatalogCache.set(projectID, catalog)
      hydrate(catalog)
      for (const [index, result] of results.entries()) if (result.status === 'rejected') {
        if (index < 2) setError(errorText(result.reason))
        else report(result.reason)
      }
    }
    if (!connected) clearProjectCatalogs()
    const cached = projectID && connected ? projectCatalogCache.get(projectID) : undefined
    const catalog = cached?.key === connectionUrl ? cached : undefined
    hydrate(catalog)
    if (!catalog || Date.now() - catalog.fetchedAt >= 30_000) void load()
    const accountChanged = () => { clearProjectCatalogs(); void load() }
    window.addEventListener('ame-account-changed', accountChanged)
    const unsubscribeCatalog = window.ame?.onEvent?.(event => {
      if (event.type !== 'catalog' || (event.projectID && event.projectID !== projectID)) return
      if (event.projectID) projectCatalogCache.delete(event.projectID)
      else clearProjectCatalogs()
      clearTimeout(catalogTimer)
      catalogTimer = setTimeout(() => { if (alive) void load() }, 80)
    })
    return () => { alive = false; clearTimeout(catalogTimer); unsubscribeCatalog?.(); window.removeEventListener('ame-account-changed', accountChanged) }
  }, [projectID, connected, connectionUrl, report])
  useEffect(() => {
    if (!role || !models.length) userPickedModel.current = false
    setModel(currentValue => resolvePreferredModel({ models, currentValue, defaultModelID: effectiveDefaultModel, role, userPicked: userPickedModel.current }))
  }, [role, catalogModels, effectiveDefaultModel])
  const activeModel = projectID && connected && modelProject === projectID ? models.find(item => modelKey(item) === model) : undefined
  const activeAgent = agents.find(a => a.id === agent)
  useEffect(() => { onModelChange?.(ready ? activeModel : undefined) }, [activeModel, onModelChange, connected, ready, projectID])
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
        if (alive) { permissionsCountRef.current = pending.length; setMessages(old => sameChatItems(old, items) ? old : items); setPermissions(pending); setLoaded(true); setError('') }
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
  const recentPaths = [...new Set([...(activeFile ? [activeFile] : []), ...tabs.map(tab => tab.path)])]
  const fileChoices = [...new Set([...files, ...recentPaths])]
  const choices = attachmentPicker
    ? filterFileMentions(attachmentQuery, fileChoices, recentPaths, 40).map(item => ({ label: item.path, insertText: item.path, description: 'Tệp' }))
    : trigger?.kind === '@'
      ? filterFileMentions(trigger.query, fileChoices, recentPaths, 40).map(item => ({ label: item.path, insertText: `@${item.path}`, description: 'Tệp' }))
      : trigger?.kind === '/'
        ? filterSlashEntries(trigger.query, commands, skills).slice(0, 40).map(item => ({ label: `/${item.name}`, insertText: item.insertText, description: item.description || (item.kind === 'skill' ? 'Skill' : 'Lệnh') }))
        : []
  const selectedCompletion = Math.min(completionIndex, Math.max(0, choices.length - 1))
  const popoverOpen = attachmentPicker || !!trigger
  useEffect(() => {
    if (!popoverOpen) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composing.current) return
      event.preventDefault(); setTrigger(null); setAttachmentPicker(false); input.current?.focus()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [popoverOpen])
  const updateTrigger = (value: string, cursor: number) => {
    if (composing.current) return
    const next = detectComposerTrigger(value, cursor)
    if (next?.kind === '@' && trigger?.kind !== '@') onRequestFiles?.()
    setAttachmentPicker(false); setTrigger(next); setCompletionIndex(0)
  }
  const restoreCursor = (cursor: number) => requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(cursor, cursor) })
  const insertTrigger = (kind: '@' | '/') => {
    const start = input.current?.selectionStart ?? text.length
    const end = input.current?.selectionEnd ?? start
    const token = (start > 0 && !/\s/.test(text[start - 1]) ? ' ' : '') + kind
    const value = text.slice(0, start) + token + text.slice(end)
    const cursor = start + token.length
    setText(value); setAttachmentPicker(false); setTrigger(detectComposerTrigger(value, cursor)); setCompletionIndex(0)
    if (kind === '@') onRequestFiles?.()
    restoreCursor(cursor)
  }
  const addAttachment = (path: string) => {
    setAttachments(current => current.some(item => item.kind === 'file' && item.path === path) ? current : [...current, { id: `file-${++attachmentSequence.current}`, kind: 'file', path }])
    setAttachmentPicker(false); setTrigger(null); input.current?.focus()
  }
  const addResolvedAttachments = (resolved: readonly ResolvedDroppedFile[]) => {
    const errors = resolved.filter(item => !item.ok).map(item => `${item.name}: ${item.reason}`)
    setError(errors.join('\n'))
    setAttachments(current => {
      const next = [...current]
      for (const item of resolved) {
        if (!item.ok) continue
        if (item.kind === 'workspace-file') {
          if (!next.some(attachment => attachment.kind === 'file' && attachment.path === item.path)) next.push({ id: `file-${++attachmentSequence.current}`, kind: 'file', path: item.path })
        } else {
          if (next.some(attachment => 'dataUrl' in attachment && attachment.dataUrl === item.dataUrl && attachment.name === item.name)) continue
          if (next.filter(attachment => attachment.kind === 'media' || attachment.kind === 'external-text').length >= MAX_PROMPT_FILES) {
            setError([...errors, `Chỉ có thể đính kèm tối đa ${MAX_PROMPT_FILES} tệp ảnh/PDF hoặc văn bản bên ngoài.`].join('\n'))
            continue
          }
          next.push({ id: `attachment-${++attachmentSequence.current}`, kind: item.kind, name: item.name, mime: item.mime, dataUrl: item.dataUrl, size: item.size, ...('workspacePath' in item && item.workspacePath ? { workspacePath: item.workspacePath } : {}) })
        }
      }
      return next
    })
    setAttachmentPicker(false); setTrigger(null)
  }
  const receiveAttachments = async (load: () => Promise<ResolvedDroppedFile[]>) => {
    const project = projectID, session = sessionID
    try {
      const resolved = await load()
      if (currentProject.current === project && currentSession.current === session) addResolvedAttachments(resolved)
    } catch (e) {
      if (currentProject.current === project && currentSession.current === session) setError(errorText(e))
    }
  }
  const isSupportedDrag = (dt: DataTransfer) => dt.types.includes(WORKSPACE_DRAG_MIME) || dt.types.includes('Files')
  const complete = (index: number) => {
    const choice = choices[index]
    if (!choice) return
    if (attachmentPicker) { addAttachment(choice.insertText); return }
    if (!trigger) return
    const result = applyComposerCompletion(text, trigger, choice.insertText)
    setText(result.text); setTrigger(null); restoreCursor(result.cursor)
  }
  const handlePopoverKey = (event: KeyboardEvent) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
    if (!popoverOpen) return false
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setTrigger(null); setAttachmentPicker(false); input.current?.focus(); return true
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && choices.length) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const next = (selectedCompletion + direction + choices.length) % choices.length
      setCompletionIndex(next)
      requestAnimationFrame(() => document.getElementById(`${popoverID}-${next}`)?.scrollIntoView({ block: 'nearest' }))
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && choices.length) {
      event.preventDefault(); complete(selectedCompletion); return true
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); return true }
    return false
  }
  const send = async () => {
    const selectedModel = activeModel
    const { text: prompt, files } = splitComposerAttachments(text, attachments)
    if (!projectID || (!prompt.trim() && !files.length) || busy || !connected || !ready || !selectedModel || translationSession || lockedTranslation || composing.current) return
    const submitted = text, submittedSession = sessionID, submittedProject = projectID, submittedAttachments = attachments
    const submittedIDs = new Set(submittedAttachments.map(item => item.id))
    setBusy(true)
    try {
      if (!await submit.current!(projectID, sessionID, prompt, selectedModel, agent || undefined, files.length ? files : undefined)) return
      if (currentProject.current === submittedProject && (currentSession.current === submittedSession || (!submittedSession && currentSession.current === createdSession.current))) {
        setText(current => current === submitted ? '' : current)
        setAttachments(current => current.filter(item => !submittedIDs.has(item.id)))
        setTrigger(null); setAttachmentPicker(false)
      }
      for (const key of [draftKey(submittedProject, submittedSession), ...(!submittedSession ? [draftKey(submittedProject, createdSession.current)] : [])]) {
        const draft = drafts.current[key]
        if (draft) drafts.current[key] = { text: draft.text === submitted ? '' : draft.text, attachments: draft.attachments.filter(item => !submittedIDs.has(item.id)) }
      }
      refresh.current(); onActivity()
    } catch (e) { report(e) } finally { setBusy(false) }
  }
  const reply = async (permission: Permission, response: 'once' | 'always' | 'reject') => {
    if (!projectID) return
    setReplying(true)
    try { await window.ame.replyPermission(projectID, permission.id, response); refresh.current() } catch (e) { report(e) } finally { setReplying(false) }
  }
  return <main data-testid="chat" className="chat-pane" data-region="Chat Canvas" data-translation-session={sessionID && translationSessionIDs.includes(sessionID) || undefined}
    onDragEnter={event => {
      if (!canAttach || !isSupportedDrag(event.dataTransfer)) return
      event.preventDefault(); dragDepth.current++; setDragActive(true)
    }}
    onDragOver={event => {
      if (!canAttach || !isSupportedDrag(event.dataTransfer)) return
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'
    }}
    onDragLeave={event => {
      if (!dragDepth.current) return
      event.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragActive(false)
    }}
    onDrop={event => {
      dragDepth.current = 0; setDragActive(false)
      if (!canAttach || !projectID || !isSupportedDrag(event.dataTransfer)) return
      event.preventDefault()
      const workspacePath = event.dataTransfer.getData(WORKSPACE_DRAG_MIME)
      if (workspacePath) addAttachment(workspacePath)
      const osPaths: string[] = [], browserFiles: File[] = []
      for (const file of Array.from(event.dataTransfer.files)) {
        const path = window.ame?.filePath?.(file) || ''
        if (path) osPaths.push(path)
        else browserFiles.push(file)
      }
      void receiveAttachments(async () => (await Promise.all([
        osPaths.length ? window.ame.resolveDroppedPaths(projectID, osPaths) : Promise.resolve([]),
        Promise.all(browserFiles.map(readBrowserFileAttachment)),
      ])).flat())
    }}>
    <header className="chat-pane__header"><div className="chat-title-group"><span className="status-dot status-dot--active" /><span className="chat-title-text truncate">{title || 'Cuộc trò chuyện'}</span></div><div className="chat-header-actions">{androidInfo?.isAndroid && <button type="button" className="pill-btn android-translate-trigger" data-testid="android-translate-trigger" title="Dịch Android" aria-label="Dịch Android" onClick={() => onOpenAndroidTranslation?.()}><Icon name="globe" /><span className="pill-btn__label">Dịch Android</span></button>}{(['artifacts', 'agents', 'btw'] as const).map(tab => <button key={tab} data-chat-drawer={tab} className={`pill-btn ${drawer === tab ? 'is-active' : ''}`} title={tab === 'artifacts' ? 'Artifacts' : tab === 'agents' ? 'Agents' : '/btw'} aria-label={tab === 'artifacts' ? 'Artifacts' : tab === 'agents' ? 'Agents' : '/btw'} onClick={() => { if (drawer !== tab) { setTrigger(null); setAttachmentPicker(false) } setDrawer(value => value === tab ? null : tab) }}><Icon name={tab === 'artifacts' ? 'layers' : tab === 'agents' ? 'agents' : 'message'} /><span className="pill-btn__label">{tab === 'artifacts' ? 'Artifacts' : tab === 'agents' ? 'Agents' : '/btw'}</span></button>)}<IconButton label="Tùy chọn hội thoại" active={menu} onClick={() => setMenu(value => !value)}><Icon name="more" /></IconButton></div></header>
    {!connected && <div className="warning">Đang kết nối OpenCode. Có thể thử lại trong Cài đặt.</div>}
    {error && <div className="inline-error" role="status">{error}</div>}
    <div className="chat-pane__body">{menu && <div className="chat-corner-drawer is-open" role="menu"><button className="chat-drawer__row" role="menuitem" onClick={() => { onCreate(); setMenu(false) }}>Cuộc trò chuyện mới</button><button className="chat-drawer__row" role="menuitem" onClick={() => { void navigator.clipboard.writeText(messages.map(item => `${item.role}: ${item.text}`).join('\n\n')).catch(report); setMenu(false) }}>Copy conversation</button></div>}
      <aside className={`chat-corner-drawer ${drawer ? 'is-open' : ''}`} data-testid="chat-drawer" data-drawer={drawer || ''}><div className="chat-drawer__head"><span>{drawer === 'agents' ? 'Subagents' : drawer === 'btw' ? '/btw' : 'Artifacts'}</span><div className="chat-drawer__head-actions">{drawer === 'agents' && projectID && sessionID && <button type="button" className="chat-drawer__action" onClick={() => { setDrawer(null); setAgentMapOpen(true) }}>Agent map</button>}<IconButton label="Đóng công cụ Chat" onClick={() => setDrawer(null)}><Icon name="close" /></IconButton></div></div>{drawer === 'agents' ? <AgentList sessions={sessions} selected={sessionID} loading={false} error="" connected={connected} onRetry={onActivity} onSelect={onSelectSession} /> : drawer === 'btw' ? lockedTranslation || translationSession ? <Empty>Dùng Chat chính mới cho /btw; phiên dịch Android chỉ dành cho bản địa hóa.</Empty> : projectID && sessionID ? <BtwPanel key={JSON.stringify([projectID, sessionID])} projectID={projectID} sessionID={sessionID} connected={connected} ready={ready} model={activeModel} onCreated={onCreated} onSelectSession={onSelectSession} onActivity={onActivity} /> : <Empty>Chọn một phiên để mở luồng phụ /btw.</Empty> : <>{drawer === 'artifacts' && (projectID ? <ArtifactViewer projectID={projectID} sessionID={sessionID} /> : <Empty>Mở dự án để xem artifacts.</Empty>)}<button className="chat-drawer__row" onClick={() => onOpenPanel('artifact')}>Mở bảng Artifacts</button><button className="chat-drawer__row" onClick={() => onOpenPanel('changes')}>{changesStatus === 'loading' ? 'Đang tải thay đổi session…' : changesStatus === 'error' ? 'Không tải được thay đổi session' : `${changes} files modified · session`}</button>{[...new Set(tabs.map(tab => tab.path))].map(path => <button className="chat-drawer__row" key={path} onClick={() => onOpenFile(path)}><Icon name="file" /><span className="truncate">{path}</span></button>)}</>}</aside><div className="chat-column">
      <div ref={timeline} className="chat-stream" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}><div className="chat-stream__inner">
        {!projectID ? <Empty><span className="welcome-mark">A</span><h1>Không gian làm việc của bạn</h1><p>Mở một dự án để duyệt mã nguồn và trò chuyện với agent.</p></Empty> : !sessionID ? <Empty><h1>Bắt đầu từ dự án thật.</h1><p>Nhập yêu cầu bên dưới để bắt đầu. Cuộc trò chuyện sẽ được tạo khi gửi.</p></Empty> : (!loaded || previousSession.current !== sessionID) && connected ? <Empty>Đang tải lịch sử…</Empty> : !messages.length ? <Empty><h1>Bạn muốn làm gì tiếp theo?</h1><p>Gửi yêu cầu bên dưới. Phản hồi và công cụ sẽ hiển thị từ máy chủ.</p></Empty>         : projectChatTimeline(messages, { running, mode: timelineDetail }).map(turn => <section key={turn.id} className="chat-turn">
                 {turn.user && <article className="msg-user"><MessageContent text={turn.user.text || '…'} onOpenFile={onOpenFile} /><MessageAttachmentList attachments={turn.user.attachments} /></article>}
                 <div className="msg-turn-body">{turn.blocks.map(block => {
                   const actions = { projectDirectory, onOpenFile, onOpenAgentMap: () => { setTrigger(null); setAttachmentPicker(false); setAgentMapOpen(true) } }
                   if (block.kind === 'work-group') return <TurnWorkGroup key={block.id} id={block.id} items={block.items} summary={block.summary} live={block.live} defaultOpen={block.defaultOpen} {...actions} />
                   if (block.kind === 'active-tools') return <ActiveToolsView key={block.id} items={block.items} {...actions} />
                   if (block.kind === 'live-status') return <LiveTurnStatus key={block.id} label={block.label} />
                   const item = block.item
                   return <article key={block.id} className="msg-agent">{block.kind === 'tool' && item.tool ? <ToolCard call={item.tool} onOpenFile={onOpenFile} projectDirectory={projectDirectory} /> : block.kind === 'changes' && item.turn && projectID && sessionID ? <TurnChanges key={`${sessionID}:${item.id}`} projectID={projectID} sessionID={sessionID} from={item.turn.from} files={item.turn.files} theme={theme} /> : block.kind === 'tool' ? <details className="tool-card"><summary><Icon name="terminal" /> Công cụ</summary><pre>{item.text || 'Đang cập nhật công cụ…'}</pre></details> : block.kind === 'reasoning' ? <details className="thought-block"><summary>Suy nghĩ</summary><div className="thought-block__content"><MessageContent text={item.text || '…'} onOpenFile={onOpenFile} /></div></details> : <MessageContent text={item.text || '…'} onOpenFile={onOpenFile} />}</article>
                 })}</div>
               </section>)}
        {permissions.map(permission => <section className="permission" key={permission.id} role="alert"><h3>Yêu cầu quyền</h3><p>{permission.title}</p><div className="button-row"><button disabled={replying} onClick={() => void reply(permission, 'once')}>Cho phép một lần</button><button disabled={replying} onClick={() => void reply(permission, 'always')}>Luôn cho phép</button><button disabled={replying} onClick={() => void reply(permission, 'reject')}>Từ chối</button></div></section>)}
      </div></div>
      {lockedTranslation || translationSession ? <div className="translation-locked-banner" role="status" data-testid="translation-locked-banner"><Icon name="lock" /><p>{lockedTranslation ? 'Phiên dịch Android này đã hoàn tất và được khóa để tránh dùng nhầm model cho việc code.' : 'Đây là phiên Dịch Android riêng. Mở Dịch Android để tiếp tục, hoặc tạo cuộc trò chuyện mới để lập trình.'}</p>{!lockedTranslation && <button type="button" onClick={() => onOpenAndroidTranslation?.()}>Dịch Android</button>}<button type="button" onClick={onCreate}>Cuộc trò chuyện mới</button></div> : <div className="composer-dock"><div className="composer-dock__inner">{(projectName || sessionID) && <div className="composer-context-strip">{sessionID ? <button className="ctx-strip-chip" onClick={() => onOpenPanel('changes')} title="Thay đổi của toàn bộ session, từ OpenCode snapshots"><Icon name="diff" /><span>{changesStatus === 'loading' ? 'Đang tải thay đổi session…' : changesStatus === 'error' ? 'Không tải được thay đổi session' : `${changes} files changed`}</span>{changesStatus === 'ready' && projectName && <span className="ctx-strip-chip__meta">· {projectName}</span>}</button> : <span>Project: <strong>{projectName}</strong>{branch ? ` (${branch})` : ''}</span>}{sessionID && <button type="button" className="agent-map-trigger" data-testid="agent-map-trigger" title="Mở Agent map (sơ đồ subagents, skill, prompt và output)" onClick={() => { setTrigger(null); setAttachmentPicker(false); setAgentMapOpen(true) }}><span className={`agent-map-dot ${agentFamily.runningCount > 0 ? 'agent-map-dot--running' : agentFamily.subagentCount > 0 ? 'agent-map-dot--succeeded' : 'agent-map-dot--idle'}`} aria-hidden="true" /><span>{agentFamily.subagentCount > 0 ? `${agentFamily.subagentCount} subagent` : 'Agent map'}</span></button>}</div>}      <form className="composer-card" onSubmit={e => { e.preventDefault(); void send() }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setTrigger(null); setAttachmentPicker(false) } }}>
              <ComposerAttachmentStrip attachments={attachments} onRemove={id => setAttachments(current => current.filter(attachment => attachment.id !== id))} />
              <ComposerDropOverlay active={dragActive} />
              {popoverOpen && <div className="composer-popover is-open">
                {attachmentPicker && <><div className="composer-popover__header">Đính kèm ngữ cảnh</div><button type="button" className="composer-popover__pick-file" disabled={!canAttach} onClick={() => { if (projectID && canAttach) { setAttachmentPicker(false); void receiveAttachments(() => window.ame.pickAttachmentFiles(projectID)) } }}>Chọn tệp / ảnh từ máy…</button>{activeFile && <button type="button" className="composer-popover__active-file" onClick={() => addAttachment(activeFile)}>Đính kèm tệp đang mở: {activeFile}</button>}<input autoFocus className="composer-attachment-search" placeholder="Tìm tệp trong dự án..." aria-label="Tìm tệp đính kèm" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={popoverID} aria-activedescendant={choices.length ? `${popoverID}-${selectedCompletion}` : undefined} value={attachmentQuery} onChange={e => { setAttachmentQuery(e.target.value); setCompletionIndex(0) }} onKeyDown={handlePopoverKey} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} /></>}
                <div className="composer-popover__list" role="listbox" id={popoverID} aria-label={attachmentPicker ? 'Tệp đính kèm' : trigger?.kind === '@' ? 'File mentions' : 'Slash commands & skills'}>{choices.map((choice, index) => <button type="button" role="option" id={`${popoverID}-${index}`} aria-selected={index === selectedCompletion} tabIndex={-1} className={`composer-popover__option ${index === selectedCompletion ? 'is-active' : ''}`} key={choice.insertText} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setCompletionIndex(index)} onClick={() => complete(index)}><span className="truncate">{choice.label}</span><span className="muted truncate">{choice.description}</span></button>)}{!choices.length && <div className="composer-popover__empty" role="status">Không có kết quả.</div>}</div>
              </div>}
              <textarea ref={input} className="composer-input" onPaste={event => {
                if (!canAttach) return
                const images = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file)
                if (!images.length) return
                if (!event.clipboardData.getData('text/plain')) event.preventDefault()
                void receiveAttachments(() => Promise.all(images.map(readBrowserFileAttachment)))
              }} aria-label="Yêu cầu cho agent" aria-autocomplete="list" aria-expanded={!!trigger} aria-controls={trigger ? popoverID : undefined} aria-activedescendant={trigger && choices.length ? `${popoverID}-${selectedCompletion}` : undefined} placeholder="Hỏi bất cứ điều gì — gõ yêu cầu cho agent…" value={text} disabled={!projectID || !connected} onChange={e => { setText(e.target.value); updateTrigger(e.target.value, e.target.selectionStart) }} onClick={e => updateTrigger(e.currentTarget.value, e.currentTarget.selectionStart)} onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateTrigger(e.currentTarget.value, e.currentTarget.selectionStart) }} onCompositionStart={() => { composing.current = true; setTrigger(null) }} onCompositionEnd={e => { composing.current = false; updateTrigger(e.currentTarget.value, e.currentTarget.selectionStart) }} onKeyDown={e => { if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || handlePopoverKey(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} rows={1} />
        <div className="composer-toolbar"><div className="composer-toolbar__left"><button className="icon-btn" type="button" disabled={!projectID || !connected} title="Đính kèm ngữ cảnh" aria-label="Đính kèm ngữ cảnh" aria-expanded={attachmentPicker} aria-controls={attachmentPicker ? popoverID : undefined} onClick={() => { const open = !attachmentPicker; setAttachmentPicker(open); setAttachmentQuery(''); setCompletionIndex(0); setTrigger(null); if (open) onRequestFiles?.() }}><Icon name="plus" /></button><button className="icon-btn" type="button" disabled={!projectID || !connected} title="Slash commands & skills" aria-label="Slash commands & skills" onMouseDown={e => e.preventDefault()} onClick={() => insertTrigger('/')}>/</button><button className="icon-btn" type="button" disabled={!projectID || !connected} title="File mentions" aria-label="File mentions" onMouseDown={e => e.preventDefault()} onClick={() => insertTrigger('@')}>@</button>{role === 'user' ? <span className="composer-picker composer-picker--model composer-picker--locked" role="status" aria-label="Mô hình cố định theo chính sách máy chủ" title={`Tài khoản user dùng model cố định từ máy chủ: ${activeModel?.name || model}`}>
          <span className="composer-picker__face"><Icon name="lock" /><span className="composer-picker__label">{activeModel?.name || model}</span></span>
        </span> : <label className="composer-picker composer-picker--model" title={activeModel ? `Model: ${formatModelOptionLabel(activeModel, effectiveModelLevels)}` : 'Chọn model'}>
          <span className="composer-picker__face" aria-hidden="true"><Icon name="sparkles" /><span className="composer-picker__label">{activeModel?.name || 'Chọn model'}</span><Icon name="down" /></span>
          <select className="composer-picker__native" aria-label="Mô hình" value={model} onChange={e => { userPickedModel.current = true; setModel(e.target.value) }} disabled={!connected || busy}><option value="">Chọn model</option>{models.map(m => <option key={modelKey(m)} value={modelKey(m)}>{formatModelOptionLabel(m, effectiveModelLevels)}</option>)}</select>
        </label>}</div><div className="composer-toolbar__right"><label className="composer-picker composer-picker--agent" title={`Agent: ${activeAgent?.name || 'Default'} (policy quyền do OpenCode quản lý)`}>
          <span className="composer-picker__face" aria-hidden="true"><Icon name="shield" /><span className="composer-picker__label">{activeAgent?.name || 'Default'}</span><Icon name="down" /></span>
          <select className="composer-picker__native" aria-label="Agent" value={agent} onChange={e => setAgent(e.target.value)} disabled={!connected || busy}><option value="">Default</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </label>{running && <button className="icon-btn" type="button" disabled={!sessionID || !connected} title="Dừng phản hồi" onClick={() => { if (projectID && sessionID) void window.ame.cancel(projectID, sessionID).then(() => refresh.current()).catch(report) }}><Icon name="stop" /></button>}<button className="send-btn" aria-label="Gửi yêu cầu" disabled={!projectID || !connected || !ready || busy || (!text.trim() && !attachments.length) || !activeModel}><Icon name="send" /></button></div></div>
      </form></div></div>}
    </div>
    </div>
    {agentMapOpen && projectID && sessionID && <AgentMap projectID={projectID} sessionID={sessionID} connected={connected} onSelectSession={id => { onSelectSession(id); setAgentMapOpen(false) }} onOpenFile={(path, line) => { onOpenFile(path, line); setAgentMapOpen(false) }} onClose={() => setAgentMapOpen(false)} />}
  </main>
}

type BtwItem = { id: number; question: string; answer?: string; error?: string }
type BtwState = { draft: string; items: BtwItem[]; pending: boolean; forking: boolean; error: string }
type BtwThread = { state: BtwState; listeners: Set<() => void>; sequence: number }
// Renderer-only storage survives Chat's project-keyed remounts, never persisting to OpenCode.
const btwThreads = new Map<string, BtwThread>()
function btwThread(projectID: string, sessionID: string): BtwThread {
  const key = JSON.stringify([projectID, sessionID])
  let thread = btwThreads.get(key)
  if (!thread) {
    thread = { state: { draft: '', items: [], pending: false, forking: false, error: '' }, listeners: new Set(), sequence: 0 }
    btwThreads.set(key, thread)
  }
  return thread
}
function updateBtw(thread: BtwThread, update: (state: BtwState) => BtwState) {
  thread.state = update(thread.state)
  thread.listeners.forEach(listener => listener())
}

function BtwPanel({ projectID, sessionID, connected, ready, model, onCreated, onSelectSession, onActivity }: { projectID: string; sessionID: string; connected: boolean; ready: boolean; model?: Model; onCreated: (session: Session) => void; onSelectSession: (id: string) => void; onActivity: () => void }) {
  const thread = btwThread(projectID, sessionID)
  const state = useSyncExternalStore(listener => {
    thread.listeners.add(listener)
    return () => { thread.listeners.delete(listener) }
  }, () => thread.state)
  const mounted = useRef(false)
  const composing = useRef(false)
  const callbacks = useRef({ onCreated, onSelectSession, onActivity })
  callbacks.current = { onCreated, onSelectSession, onActivity }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const available = connected && ready && !!model && !state.pending && !state.forking
  const ask = async () => {
    const question = thread.state.draft.trim()
    if (!connected || !ready || !model || thread.state.pending || thread.state.forking || composing.current || !question) return
    if (question.length > 20000) { updateBtw(thread, current => ({ ...current, error: 'Câu hỏi không được vượt quá 20.000 ký tự.' })); return }
    const id = ++thread.sequence
    updateBtw(thread, current => ({ ...current, draft: '', pending: true, error: '', items: [...current.items, { id, question }] }))
    try {
      const result = await window.ame.btwAsk(projectID, sessionID, question, model)
      updateBtw(thread, current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, answer: result.answer } : item) }))
    } catch (e) {
      updateBtw(thread, current => ({ ...current, draft: current.draft || question, items: current.items.map(item => item.id === id ? { ...item, error: errorText(e) } : item) }))
    } finally { updateBtw(thread, current => ({ ...current, pending: false })) }
  }
  const fork = async () => {
    if (!connected || !ready || !model || thread.state.pending || thread.state.forking) return
    updateBtw(thread, current => ({ ...current, forking: true, error: '' }))
    try {
      const session = await window.ame.forkSession(projectID, sessionID)
      // Never navigate the newly selected context when an old fork finishes late.
      if (mounted.current) {
        callbacks.current.onCreated(session)
        callbacks.current.onSelectSession(session.id)
        callbacks.current.onActivity()
      }
    } catch (e) { updateBtw(thread, current => ({ ...current, error: errorText(e) })) }
    finally { updateBtw(thread, current => ({ ...current, forking: false })) }
  }
  return <section className="btw-panel" aria-label="Luồng phụ /btw">
    <p className="muted">Hỏi nhanh mà không thêm vào lịch sử chat chính. Fork tách lịch sử chat chính, không gồm luồng phụ này.</p>
    <div className="btw-panel__actions button-row">
      <button type="button" disabled={state.pending || state.forking || (!state.items.length && !state.draft && !state.error)} onClick={() => updateBtw(thread, current => ({ ...current, draft: '', items: [], error: '' }))}>Xóa luồng phụ</button>
      <button type="button" disabled={!available} onClick={() => void fork()}>{state.forking ? 'Đang tách…' : 'Tách thành chat mới (Fork)'}</button>
    </div>
    {state.error && <div className="inline-error" role="status">{state.error}</div>}
    <div className="btw-panel__messages" aria-live="polite">
      {!state.items.length && <Empty>Chưa có câu hỏi trong luồng phụ.</Empty>}
      {state.items.map(item => <article className="btw-panel__turn" key={item.id}>
        <div className="btw-panel__question"><strong>Bạn</strong><MessageContent text={item.question} /></div>
        {item.answer !== undefined ? <div className="btw-panel__answer"><strong>Trợ lý</strong><MessageContent text={item.answer || 'Không có nội dung trả lời.'} /><BtwCopy text={item.answer} /></div> : item.error ? <div className="inline-error" role="status">{item.error}</div> : <p role="status">Đang trả lời…</p>}
      </article>)}
    </div>
    <form className="btw-panel__form" onSubmit={event => { event.preventDefault(); void ask() }}>
      <label htmlFor="btw-question">Câu hỏi /btw</label>
      <textarea id="btw-question" aria-label="Câu hỏi /btw" placeholder="Hỏi trong luồng phụ…" rows={3} maxLength={20000} value={state.draft} disabled={!available} onChange={event => updateBtw(thread, current => ({ ...current, draft: event.target.value }))} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask() }
      }} />
      <button type="submit" disabled={!available || !state.draft.trim()}>{state.pending ? 'Đang gửi…' : 'Gửi /btw'}</button>
      {!connected ? <p role="status">Đang ngắt kết nối OpenCode.</p> : !ready || !model ? <p role="status">Đang chờ phiên và mô hình sẵn sàng.</p> : null}
    </form>
  </section>
}

function BtwCopy({ text }: { text: string }) {
  const [feedback, setFeedback] = useState('')
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { generation.current++; clearTimeout(timer.current) }, [])
  const copy = async () => {
    const current = ++generation.current
    clearTimeout(timer.current)
    let result = 'Đã sao chép'
    try { await navigator.clipboard.writeText(text) } catch { result = 'Không thể sao chép' }
    if (current !== generation.current) return
    setFeedback(result)
    timer.current = setTimeout(() => setFeedback(''), 1500)
  }
  return <button type="button" aria-label="Sao chép câu trả lời" onClick={() => void copy()}><span role="status">{feedback || 'Sao chép'}</span></button>
}
