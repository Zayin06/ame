import type { Buffer } from './state'

export const modelUri = (projectID: string, path: string, mode = 'file') => `ame://${encodeURIComponent(projectID)}/${mode}/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`

type Document = Pick<Buffer, 'projectID' | 'path'>
type TextModel = {
  uri: { scheme: string; path: string; toString(): string }
  isDisposed(): boolean
  dispose(): void
  getValue(): string
  setValue(value: string): void
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
