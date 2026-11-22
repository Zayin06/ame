import { documentID, removeTab, tabID, type Buffer, type ProjectView } from './state'

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
