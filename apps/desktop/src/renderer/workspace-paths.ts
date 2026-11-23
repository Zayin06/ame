import { activateTab, documentID, removeTab, tabID, type Buffer, type ProjectView, type Tab } from './state'

export function resolveWorkspaceFilePath(rawPath: string, projectDirectory?: string): { path: string; line?: number; endLine?: number } | null {
  const value = rawPath.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(rawPath) || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) return null
  const match = /^(.*?)(?::([1-9]\d*)(?:-([1-9]\d*))?|#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/.exec(value)
  if (!match) return null
  const target = match[1].trimEnd()
  const line = match[2] || match[4] ? Number(match[2] || match[4]) : undefined
  const endLine = match[3] || match[5] ? Number(match[3] || match[5]) : undefined
  if ((line !== undefined && !Number.isSafeInteger(line)) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line!))) return null
  if (/[\\/]$/.test(target) || /#L\d/.test(target) || (/^[a-zA-Z]$/.test(target) && value.startsWith(`${target}:`))) return null
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '')
  let relative: string
  if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(target)) {
    if (!projectDirectory?.trim()) return null
    const candidate = normalize(target), root = normalize(projectDirectory.trim())
    const windows = /^[a-zA-Z]:\//.test(candidate) || /^[a-zA-Z]:\//.test(root)
    const compare = (path: string) => windows ? path.toLowerCase() : path
    if (compare(candidate) === compare(root) || !compare(candidate).startsWith(`${compare(root)}/`)) return null
    relative = candidate.slice(root.length + 1)
  } else relative = target.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+/g, '/')
  if (!relative || relative === '.' || relative.startsWith('/') || relative.includes('\0') || relative.includes(':')) return null
  if (relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || segment.replace(/[. ]+$/, '').toLowerCase() === '.git')) return null
  return { path: relative, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) }
}

export function sanitizeProjectView(view: ProjectView, projectDirectory?: string): ProjectView {
  const tabs: Tab[] = [], mapped = new Map<string, Tab>(), seen = new Set<string>()
  for (const tab of view.tabs) {
    if (tab.mode !== 'file' && tab.mode !== 'diff') continue
    const file = resolveWorkspaceFilePath(tab.path, projectDirectory)
    if (!file) continue
    const resolved = { path: file.path, mode: tab.mode }
    const key = tabID(resolved)
    mapped.set(tabID(tab), resolved)
    if (!seen.has(key)) { tabs.push(resolved); seen.add(key) }
  }
  const remap = (id: string | undefined, mode?: Tab['mode']) => {
    if (id === undefined) return undefined
    const resolved = mapped.get(id)
    const tab = resolved && (!mode || resolved.mode === mode) ? resolved : tabs.find(tab => tab.mode === (mode ?? (id.startsWith('diff:') ? 'diff' : 'file')))
    return tab && tabID(tab)
  }
  const active = remap(view.active)
  const selectedTabs = view.selectedTabs && { file: remap(view.selectedTabs.file, 'file'), diff: remap(view.selectedTabs.diff, 'diff') }
  if (tabs.length === view.tabs.length && tabs.every((tab, index) => tabID(tab) === tabID(view.tabs[index])) && active === view.active && selectedTabs?.file === view.selectedTabs?.file && selectedTabs?.diff === view.selectedTabs?.diff) return view
  const activeTab = tabs.find(tab => tabID(tab) === active)
  const result = activeTab ? activateTab({ ...view, tabs }, activeTab) : { ...view, tabs, active }
  return { ...result, selectedTabs }
}

export const containsPath = (parent: string, candidate: string) => candidate === parent || candidate.startsWith(`${parent}/`)
export const renamedPath = (path: string, from: string, to: string) => containsPath(from, path) ? to + path.slice(from.length) : path

export function renameView(view: ProjectView, from: string, to: string): ProjectView {
  const mapped = (id?: string) => {
    const tab = view.tabs.find(item => tabID(item) === id)
    return tab ? tabID({ ...tab, path: renamedPath(tab.path, from, to) }) : id
  }
  return { ...view, tabs: view.tabs.map(tab => ({ ...tab, path: renamedPath(tab.path, from, to) })), active: mapped(view.active), selectedTabs: { file: mapped(view.selectedTabs?.file), diff: mapped(view.selectedTabs?.diff) } }
}
export function deleteFromView(view: ProjectView, path: string): ProjectView {
  return view.tabs.filter(tab => containsPath(path, tab.path)).reduce(removeTab, view)
}
export function changePathDocuments<T>(documents: Record<string, T>, projectID: string, from: string, to?: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(documents)) {
    const [project, path] = JSON.parse(key) as [string, string]
    if (project !== projectID || !containsPath(from, path)) next[key] = value
    else if (to !== undefined) next[documentID(projectID, renamedPath(path, from, to))] = value
  }
  return next
}
export function renameBuffers(buffers: Record<string, Buffer>, projectID: string, from: string, to: string) {
  const next = changePathDocuments(buffers, projectID, from, to)
  for (const [key, buffer] of Object.entries(next)) {
    if (buffer.projectID === projectID && containsPath(from, buffer.path)) next[key] = { ...buffer, path: renamedPath(buffer.path, from, to) }
  }
  return next
}

export type NavigationTarget = { projectID: string; path: string; line: number; column?: number; nonce: number }
export function navigationPosition(target: NavigationTarget | undefined, projectID: string, path?: string, mode?: 'file' | 'diff') {
  if (!target || target.projectID !== projectID || target.path !== path || mode !== 'file') return undefined
  return { lineNumber: Math.max(1, Math.floor(target.line)), column: Math.max(1, Math.floor(target.column ?? 1)) }
}
