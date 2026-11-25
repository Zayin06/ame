import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeTabInGroup, createSplitState, splitRight } from '../editor-split'
import { disposeOrphanedFileModels, modelUri, synchronizeCleanFileModel } from '../editor-model-lifecycle'
import type { Tab } from '../state'

// Small structural Monaco double: setValue resets undo, while an editor edit
// appends to it. This catches accidental resets when mounting a second pane.
class Model {
  disposed = false
  resets = 0
  undo: string[] = []
  uri: { scheme: string; path: string; toString(): string }
  constructor(public text: string, uri: string) {
    const parsed = new URL(uri)
    this.uri = { scheme: parsed.protocol.slice(0, -1), path: parsed.pathname, toString: () => uri }
  }
  isDisposed() { return this.disposed }
  dispose() { assert.equal(this.disposed, false); this.disposed = true }
  getValue() { return this.text }
  setValue(value: string) { this.text = value; this.undo = []; this.resets++ }
  edit(value: string) { this.undo.push(this.text); this.text = value }
}

const document = { projectID: 'project', path: 'src/a.ts' }
const tab: Tab = { path: document.path, mode: 'file' }
const serialize = (uri: string) => uri

test('discarding the last tab releases the model and reopening reads the latest disk content', () => {
  let disk = 'original on disk\n'
  let buffers = [{ ...document, content: disk, text: disk }]
  const models: Model[] = []
  const open = () => {
    const buffer = { ...document, content: disk, text: disk }
    buffers = [buffer]
    let model = models.find(item => !item.isDisposed() && item.uri.toString() === modelUri(document.projectID, document.path))
    synchronizeCleanFileModel(model ?? null, buffer)
    if (!model) { model = new Model(buffer.text, modelUri(document.projectID, document.path)); models.push(model) }
    return model
  }
  const discarded = open()
  discarded.edit('unsaved text to discard\n')
  buffers[0].text = discarded.getValue()
  // Confirm discard; React removes the last tab's buffer, then commits cleanup.
  buffers = []
  disposeOrphanedFileModels(models, buffers, serialize)
  assert.equal(discarded.isDisposed(), true)
  disk = 'externally updated on disk\nwith a new line\n'
  const reopened = open()
  assert.notEqual(reopened, discarded)
  assert.equal(reopened.getValue(), disk)
  assert.deepEqual(reopened.undo, [])
})

test('split panes share edits and undo until the final tab closes', () => {
  let split = splitRight(createSplitState([tab]))
  const buffer = { ...document, content: 'disk', text: 'disk' }
  const model = new Model(buffer.text, modelUri(document.projectID, document.path))
  model.edit('edited in primary')
  buffer.text = model.getValue()
  synchronizeCleanFileModel(model, buffer)
  assert.equal(model.resets, 0)
  split = closeTabInGroup(split, tab, 'primary')
  const remainingDocuments = () => [split.primary, split.secondary].some(group => group?.tabs.some(item => item.mode === 'file' && item.path === tab.path)) ? [buffer] : []
  disposeOrphanedFileModels([model], remainingDocuments(), serialize)
  assert.equal(model.isDisposed(), false)
  assert.equal(model.getValue(), 'edited in primary')
  assert.deepEqual(model.undo, ['disk'])
  // Even if a dirty buffer is one edit behind the live shared model, preserve it.
  model.edit('newer edit in secondary')
  synchronizeCleanFileModel(model, buffer)
  assert.equal(model.getValue(), 'newer edit in secondary')
  assert.deepEqual(model.undo, ['disk', 'edited in primary'])
  split = closeTabInGroup(split, tab, 'secondary')
  disposeOrphanedFileModels([model], remainingDocuments(), serialize)
  assert.equal(model.isDisposed(), true)
})

test('mount repairs a stale cached model from a clean disk buffer, but equal values preserve undo', () => {
  const buffer = { ...document, content: 'new disk content', text: 'new disk content' }
  const model = new Model('discarded edit', modelUri(document.projectID, document.path))
  synchronizeCleanFileModel(model, buffer)
  assert.equal(model.getValue(), buffer.text)
  assert.equal(model.resets, 1)
  model.edit('temporary edit')
  model.edit(buffer.text)
  synchronizeCleanFileModel(model, buffer)
  assert.equal(model.resets, 1)
  assert.deepEqual(model.undo, [buffer.text, 'temporary edit'])
  synchronizeCleanFileModel(null, buffer)
  model.dispose()
  synchronizeCleanFileModel(model, buffer)
  assert.equal(model.resets, 1)
})

test('buffer removal releases only orphaned file models, including inactive projects', () => {
  const retained = new Model('unsaved', modelUri('other project', 'a b.ts'))
  const removed = new Model('discarded', modelUri(document.projectID, document.path))
  const head = new Model('head', modelUri(document.projectID, document.path, 'head'))
  const working = new Model('working', modelUri(document.projectID, document.path, 'working'))
  const foreign = new Model('foreign', 'file:///a.ts')
  const models = [retained, removed, head, working, foreign]
  disposeOrphanedFileModels(models, [{ projectID: 'other project', path: 'a b.ts' }], serialize)
  assert.equal(removed.isDisposed(), true)
  for (const model of [retained, head, working, foreign]) assert.equal(model.isDisposed(), false)
  // Removing the remaining project releases its models; cleanup is idempotent.
  disposeOrphanedFileModels(models, [], serialize)
  disposeOrphanedFileModels(models, [], serialize)
  assert.equal(retained.isDisposed(), true)
})

test('URI identity handles separators and reserved characters without cross-project disposal', () => {
  assert.equal(modelUri('a/b', 'src\\a #%.ts'), 'ame://a%2Fb/file/src/a%20%23%25.ts')
  const retained = new Model('text', modelUri('p', 'src/a.ts'))
  const serializeUri = (uri: string) => uri.toUpperCase()
  retained.uri.toString = () => serializeUri(modelUri('p', 'src/a.ts'))
  disposeOrphanedFileModels([retained], [{ projectID: 'p', path: 'src\\a.ts' }], serializeUri)
  assert.equal(retained.isDisposed(), false)
})
