import type { FileDocument } from '../../../../packages/protocol/src/index'

export type Pane = 'rail' | 'inspector' | 'stage'
export type Tab = { path: string; mode: 'file' | 'diff' }
export type ProjectView = { session?: string; tabs: Tab[]; active?: string; selectedTabs?: Partial<Record<Tab['mode'], string>> }
export function selectedTab(view: ProjectView, mode: Tab['mode']) {
  return view.tabs.find(tab => tab.mode === mode && tabID(tab) === view.active)
    ?? view.tabs.find(tab => tab.mode === mode && tabID(tab) === view.selectedTabs?.[mode])
    ?? view.tabs.find(tab => tab.mode === mode)
}
export function activateTab(view: ProjectView, tab: Tab): ProjectView {
  return { ...view, active: tabID(tab), selectedTabs: { ...view.selectedTabs, [tab.mode]: tabID(tab) } }
}
export function removeTab(view: ProjectView, tab: Tab): ProjectView {
  const matching = view.tabs.filter(item => item.mode === tab.mode)
  const index = matching.findIndex(item => tabID(item) === tabID(tab))
  const tabs = view.tabs.filter(item => tabID(item) !== tabID(tab))
  const remaining = tabs.filter(item => item.mode === tab.mode)
  const next = remaining[Math.min(index, remaining.length - 1)]
  const selected = selectedTab(view, tab.mode)
  const result = { ...view, tabs }
  if (selected && tabID(selected) === tabID(tab)) {
    result.selectedTabs = { ...view.selectedTabs, [tab.mode]: next && tabID(next) }
    if (view.active === tabID(tab)) result.active = next && tabID(next)
  }
  return result
}
export type Preferences = {
  theme: 'dark' | 'light'; widths: Record<Pane, number>; rail: boolean; inspector: boolean; stage: boolean;
  terminalOpen: boolean; inspectorTab: 'files' | 'search' | 'git'; panel: 'artifact' | 'files' | 'diff' | 'changes' | 'usage' | 'terminal' | 'subagents' | 'btw';
  layoutMode: 'swe' | 'knowledge'; tint: 'default' | 'nord' | 'everforest'; chatWidth: 640 | 760 | 960;
  project?: string; projects: Record<string, ProjectView>
}
export const defaultWidths = { rail: 256, inspector: 240, stage: 480 }
export const tabID = (tab: Tab) => `${tab.mode}:${tab.path}`
export const documentID = (project: string, path: string) => JSON.stringify([project, path])
export const clampWidth = (pane: Pane, width: number) => Math.round(Math.max(pane === 'stage' ? 300 : 190, Math.min(pane === 'stage' ? 780 : 360, width)))
export const defaults = (): Preferences => ({ theme: 'dark', widths: { ...defaultWidths }, rail: true, inspector: false, stage: true, terminalOpen: true, inspectorTab: 'files', panel: 'files', layoutMode: 'swe', tint: 'default', chatWidth: 760, projects: {} })
export function parsePreferences(raw: string | null): Preferences {
  const result = defaults()
  try {
    const value = JSON.parse(raw || '{}')
    if (!value || typeof value !== 'object') return result
    if (value.theme === 'light') result.theme = 'light'
    for (const pane of ['rail', 'inspector', 'stage'] as const) {
      if (typeof value[pane] === 'boolean') result[pane] = value[pane]
      if (Number.isFinite(value.widths?.[pane])) result.widths[pane] = clampWidth(pane, value.widths[pane])
    }
    if (typeof value.terminalOpen === 'boolean') result.terminalOpen = value.terminalOpen
    if (value.inspectorTab === 'git' || value.inspectorTab === 'search') result.inspectorTab = value.inspectorTab
    if (['artifact', 'files', 'diff', 'changes', 'usage'].includes(value.panel)) result.panel = value.panel
    else if (value.panel === 'terminal') result.terminalOpen = true
    else if (value.inspectorTab === 'git') result.panel = 'diff'
    if (value.layoutMode === 'knowledge') result.layoutMode = 'knowledge'
    if (['nord', 'everforest'].includes(value.tint)) result.tint = value.tint
    if ([640, 760, 960].includes(value.chatWidth)) result.chatWidth = value.chatWidth
    if (typeof value.project === 'string') result.project = value.project
    if (value.projects && typeof value.projects === 'object') for (const [id, view] of Object.entries(value.projects)) {
      if (!view || typeof view !== 'object') continue
      const v = view as Partial<ProjectView>
      const tabs = Array.isArray(v.tabs) ? v.tabs.filter(t => t && typeof t.path === 'string' && (t.mode === 'file' || t.mode === 'diff')).map(t => ({ path: t.path, mode: t.mode })) : []
      result.projects[id] = { session: typeof v.session === 'string' ? v.session : undefined, tabs, active: typeof v.active === 'string' ? v.active : undefined }
      if (v.selectedTabs && typeof v.selectedTabs === 'object') {
        result.projects[id].selectedTabs = {}
        for (const mode of ['file', 'diff'] as const) if (tabs.some(tab => tab.mode === mode && tabID(tab) === v.selectedTabs?.[mode])) result.projects[id].selectedTabs![mode] = v.selectedTabs[mode]
      }
    }
  } catch { /* Invalid saved preferences must not prevent startup. */ }
  return result
}
export type Buffer = FileDocument & { projectID: string; text: string; conflict: boolean }
export const dirty = (buffer: Buffer) => buffer.text !== buffer.content
export const projectDirtyPaths = (buffers: Record<string, Buffer>, projectID?: string): ReadonlySet<string> => new Set(Object.values(buffers).filter(buffer => buffer.projectID === projectID && dirty(buffer)).map(buffer => buffer.path))
export const tabIsDirty = (tab: Tab, paths: ReadonlySet<string>) => tab.mode === 'file' && paths.has(tab.path)
export function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }; delete next[key]; return next
}
export const withoutProjectDocuments = <T>(documents: Record<string, T>, projectID: string) => Object.fromEntries(Object.entries(documents).filter(([key]) => JSON.parse(key)[0] !== projectID))
export function withoutProject(preferences: Preferences, id: string, remaining: ReadonlyArray<{ id: string }>): Preferences {
  return { ...preferences, projects: withoutKey(preferences.projects, id), project: preferences.project === id ? remaining[0]?.id : preferences.project }
}
export function reconcileDocument(current: Buffer, incoming: FileDocument): Buffer {
  if (current.revision === incoming.revision) return current
  return dirty(current) ? { ...current, conflict: true } : { ...current, ...incoming, text: incoming.content, conflict: false }
}
export function savedDocument(current: Buffer, saved: FileDocument, submitted: string): Buffer {
  return { ...current, ...saved, text: current.text === submitted ? saved.content : current.text, conflict: false }
}
export const languageFor = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase()
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python', rs: 'rust', go: 'go', yaml: 'yaml', yml: 'yaml', sh: 'shell', ps1: 'powershell', sql: 'sql', xml: 'xml', cs: 'csharp', java: 'java', c: 'c', h: 'c', cpp: 'cpp' } as Record<string, string>)[ext || ''] || 'plaintext'
}
