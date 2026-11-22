import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { activateTab, removeTab, selectedTab, defaults, dirty, documentID, parsePreferences, reconcileDocument, savedDocument, type Buffer } from '../state'

test('starts with Explorer hidden but preserves an explicitly saved Inspector choice', () => {
  for (const raw of [null, '{}', 'invalid json']) assert.equal(parsePreferences(raw).inspector, false)
  assert.equal(parsePreferences('{"inspector":true}').inspector, true)
  assert.equal(parsePreferences('{"inspector":false}').inspector, false)
})

test('restores sticky inspector, widths and per-project tabs without accepting buffer contents', () => {
  const value = parsePreferences(JSON.stringify({ inspector: false, widths: { rail: -10, stage: 99999 }, project: 'one', projects: { one: { session: 's1', active: 'file:a.ts', tabs: [{ path: 'a.ts', mode: 'file', text: 'unsaved secret' }, { path: 'b.ts', mode: 'bad' }] }, two: { session: 's2', tabs: [{ path: 'b.ts', mode: 'diff' }] } } }))
  assert.equal(value.inspector, false)
  assert.equal(value.widths.rail, 190)
  assert.equal(value.widths.stage, 780)
  assert.deepEqual(value.projects.one, { session: 's1', active: 'file:a.ts', tabs: [{ path: 'a.ts', mode: 'file' }] })
  assert.equal(value.projects.two.session, 's2')
  assert.equal(JSON.stringify(value).includes('unsaved secret'), false)
  assert.deepEqual(parsePreferences('invalid json'), defaults())
})
test('restores independent search and terminal state and migrates removed stage tools', () => {
  const restored = parsePreferences('{"inspector":false,"inspectorTab":"search","terminalOpen":false,"panel":"diff"}')
  assert.equal(restored.inspector, false)
  assert.equal(restored.inspectorTab, 'search')
  assert.equal(restored.terminalOpen, false)
  assert.equal(restored.panel, 'diff')
  assert.equal(parsePreferences('{"panel":"terminal","terminalOpen":false}').terminalOpen, true)
  for (const panel of ['terminal', 'subagents', 'btw']) assert.equal(parsePreferences(JSON.stringify({ panel })).panel, 'files')
})
test('restores layout settings and migrates old Git selection without losing project metadata', () => {
  const restored = parsePreferences(JSON.stringify({ layoutMode: 'knowledge', tint: 'nord', chatWidth: 960, panel: 'artifact', projects: { one: { session: 's1', tabs: [] } } }))
  assert.equal(restored.layoutMode, 'knowledge')
  assert.equal(restored.tint, 'nord')
  assert.equal(restored.chatWidth, 960)
  assert.equal(restored.panel, 'artifact')
  assert.equal(restored.projects.one.session, 's1')
  assert.equal(parsePreferences('{"inspectorTab":"git"}').panel, 'diff')
  const invalid = parsePreferences('{"chatWidth":0,"tint":"invalid","panel":"invalid"}')
  assert.equal(invalid.chatWidth, 760)
  assert.equal(invalid.tint, 'default')
  assert.equal(invalid.panel, 'files')
})
const clean: Buffer = { projectID: 'one', path: 'a.ts', content: 'before', text: 'before', revision: 'r1', conflict: false }
test('file invalidation reloads clean buffers but preserves dirty edits with conflict marker', () => {
  const incoming = { path: 'a.ts', content: 'external', revision: 'r2' }
  const reloaded = reconcileDocument(clean, incoming)
  assert.equal(reloaded.text, 'external')
  assert.equal(dirty(reloaded), false)
  const edited = { ...clean, text: 'my edits' }
  const conflict = reconcileDocument(edited, incoming)
  assert.equal(conflict.text, 'my edits')
  assert.equal(conflict.content, 'before')
  assert.equal(conflict.revision, 'r1')
  assert.equal(conflict.conflict, true)
  assert.equal(reconcileDocument(edited, { ...incoming, revision: 'r1' }), edited)
})
test('save completion preserves keystrokes typed while save was in flight', () => {
  const saved = { path: 'a.ts', content: 'submitted', revision: 'r2' }
  const result = savedDocument({ ...clean, text: 'newer typing' }, saved, 'submitted')
  assert.equal(result.text, 'newer typing')
  assert.equal(result.content, 'submitted')
  assert.equal(dirty(result), true)
  assert.equal(dirty(savedDocument({ ...clean, text: 'submitted' }, saved, 'submitted')), false)
})
test('buffers are isolated by project and unambiguous path key', () => {
  assert.notEqual(documentID('project:a', 'b'), documentID('project', 'a:b'))
  assert.notEqual(documentID('one', 'a.ts'), documentID('two', 'a.ts'))
})

test('file and diff selection survive switching, closing and preference restore independently', () => {
  const tabs = [{ path: 'a.ts', mode: 'file' as const }, { path: 'a.ts', mode: 'diff' as const }, { path: 'b.ts', mode: 'file' as const }, { path: 'b.ts', mode: 'diff' as const }]
  let view = activateTab({ tabs }, tabs[2])
  view = activateTab(view, tabs[3])
  assert.equal(selectedTab(view, 'file')?.path, 'b.ts')
  assert.equal(selectedTab(view, 'diff')?.path, 'b.ts')
  const restored = parsePreferences(JSON.stringify({ projects: { one: view } })).projects.one
  assert.equal(selectedTab(restored, 'file')?.path, 'b.ts')
  view = removeTab(view, tabs[3])
  assert.equal(selectedTab(view, 'diff')?.path, 'a.ts')
  assert.equal(selectedTab(view, 'file')?.path, 'b.ts')
  view = removeTab(view, tabs[1])
  assert.equal(selectedTab(view, 'diff'), undefined)
  assert.equal(selectedTab(view, 'file')?.path, 'b.ts')
})
