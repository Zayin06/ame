import assert from 'node:assert/strict'
import { test } from 'node:test'
import { documentID, tabID, type Buffer, type ProjectView } from '../state'
import { changePathDocuments, deleteFromView, navigationPosition, renameBuffers, renameView, resolveWorkspaceFilePath, sanitizeProjectView } from '../workspace-paths'

test('workspace file paths normalize absolute Windows and POSIX references with line ranges', () => {
  const root = 'E:\\Extensions\\chrome-MD-This-Page'
  assert.deepEqual(resolveWorkspaceFilePath(' e:\\extensions\\CHROME-md-this-page\\build\\file with space.json:10-20 ', root), { path: 'build/file with space.json', line: 10, endLine: 20 })
  assert.deepEqual(resolveWorkspaceFilePath('E:/Extensions//chrome-MD-This-Page/README.md#L10-L20', root + '\\'), { path: 'README.md', line: 10, endLine: 20 })
  assert.deepEqual(resolveWorkspaceFilePath('/home/project/src/app.ts:42', '/home/project'), { path: 'src/app.ts', line: 42 })
  assert.deepEqual(resolveWorkspaceFilePath('/README.md', '/'), { path: 'README.md' })
  assert.deepEqual(resolveWorkspaceFilePath('\\\\server\\share\\project\\app.ts', '\\\\server\\share\\project'), { path: 'app.ts' })
  for (const directory of [undefined, 'workspace']) assert.deepEqual(resolveWorkspaceFilePath('././src\\app.ts#L10', directory), { path: 'src/app.ts', line: 10 })
})
test('workspace file paths reject root directories, external paths, metadata, traversal and invalid suffixes', () => {
  const root = 'E:\\Extensions\\chrome-MD-This-Page'
  for (const value of [root, root + '\\', root + '/:10', 'E:\\Extensions\\chrome-MD-This-Page-other\\README.md', 'C:\\outside.txt', '..', '../secret', 'src/../secret', 'src/./app.ts', '.git/config', '.GIT. /config', 'src/.git/config', 'https://example.com/app.ts', 'file:///tmp/a', 'src/', '.', '', 'C:', 'C:10', 'a.ts:0', 'a.ts:20-10', 'a.ts:9007199254740992', 'a.ts#L10-L0', 'a\u0000.ts', 'a\n.ts', '\ta.ts']) assert.equal(resolveWorkspaceFilePath(value, root), null, value)
  assert.equal(resolveWorkspaceFilePath('/Home/project/app.ts', '/home/project'), null)
  assert.equal(resolveWorkspaceFilePath('C:\\workspace\\app.ts'), null)
})
test('saved project views heal tabs, deduplicate by mode and remap active and selected IDs', () => {
  const root = 'E:\\Extensions\\chrome-MD-This-Page', absolute = root + '\\README.md'
  const broken: ProjectView = { session: 'session', tabs: [
    { path: root, mode: 'file' }, { path: absolute, mode: 'file' }, { path: 'README.md', mode: 'file' },
    { path: absolute, mode: 'diff' }, { path: '../secret', mode: 'diff' }, { path: 'C:\\outside.txt', mode: 'file' },
  ], active: `file:${absolute}`, selectedTabs: { file: `file:${root}`, diff: 'diff:../secret' } }
  const healed = sanitizeProjectView(broken, root)
  assert.deepEqual(healed, { session: 'session', tabs: [{ path: 'README.md', mode: 'file' }, { path: 'README.md', mode: 'diff' }], active: 'file:README.md', selectedTabs: { file: 'file:README.md', diff: 'diff:README.md' } })
  assert.equal(sanitizeProjectView(healed, root), healed)
  assert.equal(sanitizeProjectView(view), view)
  const empty: ProjectView = { tabs: [] }
  assert.equal(sanitizeProjectView(empty), empty)
  assert.equal(sanitizeProjectView({ ...broken, active: `file:${root}` }, root).active, 'file:README.md')
  assert.equal(sanitizeProjectView({ ...broken, selectedTabs: { file: `diff:${absolute}` } }, root).selectedTabs?.file, 'file:README.md')
  assert.deepEqual(sanitizeProjectView({ tabs: [{ path: root, mode: 'file' }], active: `file:${root}`, selectedTabs: { file: `file:${root}` } }, root), { tabs: [], active: undefined, selectedTabs: { file: undefined, diff: undefined } })
})

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
