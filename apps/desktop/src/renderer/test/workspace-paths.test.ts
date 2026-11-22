import assert from 'node:assert/strict'
import { test } from 'node:test'
import { documentID, tabID, type Buffer, type ProjectView } from '../state'
import { changePathDocuments, deleteFromView, navigationPosition, renameBuffers, renameView } from '../workspace-paths'

const view: ProjectView = {
  tabs: [{ path: 'src/app.ts', mode: 'file' }, { path: 'src/app.ts', mode: 'diff' }, { path: 'src-other.ts', mode: 'file' }],
  active: 'file:src/app.ts', selectedTabs: { file: 'file:src/app.ts', diff: 'diff:src/app.ts' }
}
test('directory rename remaps both tab modes and selections without touching sibling prefixes', () => {
  const result = renameView(view, 'src', 'lib')
  assert.deepEqual(result.tabs.map(tabID), ['file:lib/app.ts', 'diff:lib/app.ts', 'file:src-other.ts'])
  assert.equal(result.active, 'file:lib/app.ts')
  assert.deepEqual(result.selectedTabs, { file: 'file:lib/app.ts', diff: 'diff:lib/app.ts' })
  assert.equal(view.tabs[0].path, 'src/app.ts')
})
test('deleting a directory closes all child tabs and chooses remaining file tab', () => {
  const result = deleteFromView(view, 'src')
  assert.deepEqual(result.tabs, [{ path: 'src-other.ts', mode: 'file' }])
  assert.equal(result.active, 'file:src-other.ts')
  assert.equal(result.selectedTabs?.diff, undefined)
})
test('renaming keeps unsaved buffer text and revision and isolates projects', () => {
  const buffer: Buffer = { projectID: 'p', path: 'src/app.ts', content: 'saved', text: 'draft', revision: 'revision', conflict: false }
  const key = documentID('p', buffer.path), other = documentID('other', buffer.path)
  const buffers = { [key]: buffer, [other]: { ...buffer, projectID: 'other' } }
  const result = renameBuffers(buffers, 'p', 'src', 'lib')
  assert.equal(result[key], undefined)
  assert.deepEqual(result[documentID('p', 'lib/app.ts')], { ...buffer, path: 'lib/app.ts' })
  assert.equal(result[other], buffers[other])
  assert.equal(buffers[key], buffer)
  const deleted = changePathDocuments(result, 'p', 'lib')
  assert.deepEqual(Object.keys(deleted), [other])
})
test('navigation accepts only matching file/project and supplies a one-based column', () => {
  const target = { projectID: 'p', path: 'src/app.ts', line: 42, nonce: 1 }
  assert.deepEqual(navigationPosition(target, 'p', target.path, 'file'), { lineNumber: 42, column: 1 })
  assert.deepEqual(navigationPosition({ ...target, column: 7 }, 'p', target.path, 'file'), { lineNumber: 42, column: 7 })
  assert.equal(navigationPosition(target, 'other', target.path, 'file'), undefined)
  assert.equal(navigationPosition(target, 'p', 'other.ts', 'file'), undefined)
  assert.equal(navigationPosition(target, 'p', target.path, 'diff'), undefined)
})
