import type { DiffTarget, FileDocument } from '../../../../packages/protocol/src/index'
import { isValidGitCommitHash } from '../../../../packages/protocol/src/index'

export type Pane = 'rail' | 'inspector' | 'stage'
export type Tab = { path: string; mode: 'file' | 'diff'; target?: DiffTarget }
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
export type TimelineDetailMode = 'compact' | 'detailed' | 'everything'
export type Preferences = {
  theme: 'dark' | 'light'; widths: Record<Pane, number>; rail: boolean; inspector: boolean; stage: boolean;
  terminalOpen: boolean; inspectorTab: 'files' | 'search' | 'git'; panel: 'artifact' | 'files' | 'diff' | 'changes' | 'usage' | 'terminal' | 'subagents' | 'btw';
  layoutMode: 'swe' | 'knowledge'; tint: 'default' | 'nord' | 'everforest'; chatWidth: 640 | 760 | 960; timelineDetail: TimelineDetailMode;
  project?: string; projects: Record<string, ProjectView>
}
export const defaultWidths = { rail: 256, inspector: 240, stage: 480 }
export const tabID = (tab: Tab) => tab.mode === 'diff' && tab.target
  ? `diff:${JSON.stringify(tab.target.kind === 'range'
    ? [tab.path, 'range', tab.target.baseCommit.toLowerCase(), !!tab.target.includeWorking]
    : tab.target.kind === 'commits'
      ? [tab.path, 'commits', tab.target.commits.map(c => c.toLowerCase()), !!tab.target.includeWorking]
      : [tab.path, tab.target.kind, tab.target.kind === 'commit' ? tab.target.commit.toLowerCase() : null])}`
  : `${tab.mode}:${tab.path}`
export const diffID = (project: string, tab: Tab) => documentID(project, tabID(tab))
export const tabTitle = (tab: Tab) => {
  const name = tab.path.split(/[\\/]/).pop()
  if (tab.mode !== 'diff') return name
  const label = tab.target?.kind === 'range' ? `${tab.target.baseCommit.slice(0, 7)}..${tab.target.includeWorking ? 'Disk' : 'HEAD'}`
    : tab.target?.kind === 'commits' ? `${tab.target.commits.length} commits${tab.target.includeWorking ? ' + Disk' : ''}`
      : tab.target?.kind === 'commit' ? tab.target.commit.slice(0, 7) : tab.target?.kind === 'staged' ? 'Staged' : tab.target?.kind === 'working' ? 'Changes' : 'HEAD → Disk'
  return `${name} (${label})`
}
export const documentID = (project: string, path: string) => JSON.stringify([project, path])
export const clampWidth = (pane: Pane, width: number) => Number.isFinite(width)
  ? Math.round(Math.max(pane === 'stage' ? 300 : 190, pane === 'stage' ? width : Math.min(360, width)))
  : defaultWidths[pane]
export const shouldMaximizeStage = (width: number, availableWidth: number) => availableWidth > 0 && availableWidth - width < 320
export const defaults = (): Preferences => ({ theme: 'dark', widths: { ...defaultWidths }, rail: true, inspector: false, stage: true, terminalOpen: true, inspectorTab: 'files', panel: 'files', layoutMode: 'swe', tint: 'default', chatWidth: 760, timelineDetail: 'compact', projects: {} })
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
    if (['compact', 'detailed', 'everything'].includes(value.timelineDetail)) result.timelineDetail = value.timelineDetail
    if (typeof value.project === 'string') result.project = value.project
    if (value.projects && typeof value.projects === 'object') for (const [id, view] of Object.entries(value.projects)) {
      if (!view || typeof view !== 'object') continue
      const v = view as Partial<ProjectView>
       const tabs: Tab[] = Array.isArray(v.tabs) ? v.tabs.filter(t => t && typeof t.path === 'string' && (t.mode === 'file' || t.mode === 'diff')).map(t => {
         const target = t.target
         const valid = target?.kind === 'staged' || target?.kind === 'working'
           || (target?.kind === 'commit' && isValidGitCommitHash(target.commit))
           || (target?.kind === 'range' && isValidGitCommitHash(target.baseCommit) && (target.includeWorking === undefined || typeof target.includeWorking === 'boolean'))
           || (target?.kind === 'commits' && Array.isArray(target.commits) && target.commits.length >= 1 && target.commits.length <= 50 && target.commits.every(isValidGitCommitHash) && (target.includeWorking === undefined || typeof target.includeWorking === 'boolean'))
         return { path: t.path, mode: t.mode, ...(t.mode === 'diff' && valid ? { target } : {}) }
       }) : []
      result.projects[id] = { session: typeof v.session === 'string' ? v.session : undefined, tabs, active: typeof v.active === 'string' ? v.active : undefined }
      if (v.selectedTabs && typeof v.selectedTabs === 'object') {
        result.projects[id].selectedTabs = {}
        for (const mode of ['file', 'diff'] as const) if (tabs.some(tab => tab.mode === mode && tabID(tab) === v.selectedTabs?.[mode])) result.projects[id].selectedTabs![mode] = v.selectedTabs[mode]
      }
    }
  } catch { /* Invalid saved preferences must not prevent startup. */ }
  return result
}
export type Buffer = FileDocument & { projectID: string; text: string; conflict: boolean; diskRevision?: string; diskContent?: string }
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
  if (current.revision === incoming.revision) return current.conflict && !dirty(current) ? { ...current, conflict: false, diskRevision: undefined, diskContent: undefined } : current
  if (!dirty(current)) return { ...current, ...incoming, text: incoming.content, conflict: false, diskRevision: undefined, diskContent: undefined }
  if (incoming.content === current.text) return { ...current, ...incoming, text: current.text, conflict: false, diskRevision: undefined, diskContent: undefined }
  return { ...current, conflict: true, diskRevision: incoming.revision, diskContent: incoming.content }
}
export function savedDocument(current: Buffer, saved: FileDocument, submitted: string): Buffer {
  return { ...current, ...saved, text: current.text === submitted ? saved.content : current.text, conflict: false, diskRevision: undefined, diskContent: undefined }
}
export const languageFor = (path: string) => {
  const name = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase()
  if (name === '.env' || name.endsWith('.env') || name.startsWith('.env.')) return 'dotenv'
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
  if (['makefile', 'gnumakefile'].includes(name)) return 'makefile'
  if (name === 'cmakelists.txt') return 'cmake'
  if (['podfile', 'fastfile', 'gemfile', 'appfile', 'matchfile', 'rakefile'].includes(name)) return 'ruby'
  if (name === 'gradlew') return 'shellscript'
  if (['.editorconfig', '.gitconfig', '.gitignore', '.gitattributes', '.dockerignore', '.npmignore'].includes(name)) return 'ini'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const languages: Record<string, string> = {
    kt: 'kotlin', kts: 'kotlin', java: 'java', gradle: 'groovy', groovy: 'groovy',
    xml: 'xml', svg: 'xml', xaml: 'xml', xsl: 'xml', xsd: 'xml', pom: 'xml',
    plist: 'xml', entitlements: 'xml', storyboard: 'xml', xib: 'xml', xcscheme: 'xml', xcworkspacedata: 'xml',
    properties: 'properties', pro: 'properties', proto: 'proto', swift: 'swift', m: 'objective-c', mm: 'objective-cpp',
    xcconfig: 'ini', pbxproj: 'c', podspec: 'ruby', rb: 'ruby', xcstrings: 'json', dart: 'dart', arb: 'json',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    json: 'json', webmanifest: 'json', jsonc: 'jsonc', json5: 'jsonc', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', astro: 'astro', md: 'markdown', mdx: 'mdx', graphql: 'graphql', gql: 'graphql',
    py: 'python', pyi: 'python', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
    cs: 'csharp', php: 'php', sql: 'sql', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ksh: 'shellscript',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini', mk: 'makefile', cmake: 'cmake', tf: 'hcl', hcl: 'hcl', lua: 'lua', r: 'r', scala: 'scala', ex: 'elixir', exs: 'elixir',
  }
  return Object.hasOwn(languages, ext) ? languages[ext] : 'plaintext'
}
