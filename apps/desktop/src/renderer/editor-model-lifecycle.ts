import { diffID, tabID, type Buffer, type ProjectView } from './state'

export const modelUri = (projectID: string, path: string, mode = 'file') => `ame://${encodeURIComponent(projectID)}/${mode}/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`

type Document = Pick<Buffer, 'projectID' | 'path'>
type TextModel = {
  uri: { scheme: string; path: string; toString(): string }
  isDisposed(): boolean
  dispose(): void
  getValue(): string
  setValue(value: string): void
}

type MonacoModels = {
  Uri: { parse(uri: string): { toString(): string } }
  editor: { getModels(): readonly TextModel[] }
}
export function disposeDiffModels(monaco: MonacoModels, projectID: string, diffTabID: string) {
  const uris = new Set(['original', 'modified'].map(mode => monaco.Uri.parse(modelUri(projectID, diffTabID, mode)).toString()))
  for (const model of monaco.editor.getModels()) if (!model.isDisposed() && uris.has(model.uri.toString())) model.dispose()
}
export function disposeProjectModels(monaco: MonacoModels, projectID: string) {
  const prefix = monaco.Uri.parse(modelUri(projectID, '')).toString().replace(/file\/$/, '')
  for (const model of monaco.editor.getModels()) if (!model.isDisposed() && model.uri.scheme === 'ame' && model.uri.toString().startsWith(prefix)) model.dispose()
}

// Called after the React commit: editors detach first, then tab-owned resources die.
export function reconcileDiffResources<T>(monaco: MonacoModels, previous: Record<string, ProjectView>, current: Record<string, ProjectView>, cache: Record<string, T>): Record<string, T> {
  const retained = new Set(Object.entries(current).flatMap(([project, view]) => view.tabs.filter(tab => tab.mode === 'diff').map(tab => diffID(project, tab))))
  for (const [project, view] of Object.entries(previous)) {
    if (!current[project]) { disposeProjectModels(monaco, project); continue }
    for (const tab of view.tabs) if (tab.mode === 'diff' && !retained.has(diffID(project, tab))) disposeDiffModels(monaco, project, tabID(tab))
  }
  const entries = Object.entries(cache).filter(([key]) => retained.has(key))
  return entries.length === Object.keys(cache).length ? cache : Object.fromEntries(entries)
}

// Buffers, not mounted panes, own file models: switching tabs/projects or
// closing one half of a split must not throw away a shared undo stack.
// Run after React commits so removed editors detach before their models die.
export function disposeOrphanedFileModels(models: readonly TextModel[], documents: readonly Document[], serializeUri: (uri: string) => string) {
  const retained = new Set(documents.map(document => serializeUri(modelUri(document.projectID, document.path))))
  for (const model of models) {
    if (model.uri.scheme !== 'ame' || !model.uri.path.startsWith('/file/') || model.isDisposed()) continue
    if (!retained.has(model.uri.toString())) model.dispose()
  }
}

// @monaco-editor/react reuses an existing URI model without applying the
// initial value. Repair that cache before attaching the editor. Dirty buffers
// may lag a live edit in the other pane and must never reset its undo history.
export function synchronizeCleanFileModel(model: TextModel | null, buffer: Pick<Buffer, 'text' | 'content'>) {
  if (!model || model.isDisposed() || buffer.text !== buffer.content || model.getValue() === buffer.text) return
  model.setValue(buffer.text)
}
