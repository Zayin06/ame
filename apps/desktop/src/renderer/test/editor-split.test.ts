import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeTabInGroup, createSplitState, deleteInSplitState, focusGroup, moveTabToOtherGroup, openTabInGroup, renameInSplitState, selectTabInGroup, splitRight, unsplit, type EditorSplitState } from '../editor-split'
import { tabID, type Tab } from '../state'

const a: Tab = { path: 'src/a.ts', mode: 'file' }
const b: Tab = { path: 'src/b.ts', mode: 'file' }
const diff: Tab = { path: a.path, mode: 'diff' }
const other: Tab = { path: 'src-other/c.ts', mode: 'file' }
const ids = (tabs: readonly Tab[]) => tabs.map(tabID)
function freeze(state: EditorSplitState): EditorSplitState {
  for (const group of [state.primary, state.secondary]) {
    if (!group) continue
    group.tabs.forEach(Object.freeze)
    Object.freeze(group.tabs)
    Object.freeze(group)
  }
  return Object.freeze(state)
}

function invariant(state: EditorSplitState) {
  assert.ok(state.focused === 'primary' || state.secondary)
  for (const group of [state.primary, state.secondary]) {
    if (!group) continue
    assert.equal(new Set(ids(group.tabs)).size, group.tabs.length)
    assert.ok(group.active ? group.tabs.includes(group.active) : group.tabs.length === 0)
  }
}

test('creation copies arrays, deduplicates tabIDs and reconciles active selection', () => {
  const tabs = Object.freeze([a, b, diff, a])
  const state = createSplitState(tabs, { ...b })
  assert.deepEqual(ids(state.primary.tabs), ['file:src/a.ts', 'file:src/b.ts', 'diff:src/a.ts'])
  assert.equal(state.primary.active, b)
  assert.notEqual(state.primary.tabs, tabs)
  assert.equal(createSplitState([a], other).primary.active, a)
  assert.deepEqual(createSplitState(), { primary: { tabs: [], active: undefined }, focused: 'primary' })
})

test('split creates secondary with the primary active tab and never mutates primary', () => {
  const state = freeze(createSplitState([a, b], b))
  const split = splitRight(state)
  assert.equal(split.focused, 'secondary')
  assert.equal(split.secondary?.active, b)
  assert.equal(split.primary, state.primary)
  const explicit = splitRight(split, diff)
  assert.deepEqual(ids(explicit.secondary!.tabs), ['file:src/b.ts', 'diff:src/a.ts'])
  assert.equal(splitRight(explicit, diff).secondary?.tabs.length, 2)
  assert.deepEqual(splitRight(createSplitState()).secondary?.tabs, [])
  assert.equal(focusGroup(state, 'secondary'), state)
  assert.equal(focusGroup(explicit, 'primary').focused, 'primary')
})

test('opening and selecting respect groups, file/diff identities and missing selections', () => {
  let state = splitRight(createSplitState([a]))
  state = openTabInGroup(state, diff)
  assert.deepEqual(ids(state.secondary!.tabs), ['file:src/a.ts', 'diff:src/a.ts'])
  state = selectTabInGroup(state, a, 'secondary')
  assert.equal(state.secondary?.active, a)
  assert.equal(selectTabInGroup(state, b, 'secondary'), state)
  assert.equal(selectTabInGroup(createSplitState(), a, 'secondary').secondary, undefined)
  assert.equal(openTabInGroup(state, { ...a }).secondary?.tabs.length, 2)
  assert.equal(openTabInGroup(createSplitState(), b, 'secondary').focused, 'secondary')
})

test('closing active tabs selects the right neighbor then left, preserving inactive selection', () => {
  const initial = freeze(createSplitState([a, b, diff], b))
  const closed = closeTabInGroup(initial, b, 'primary')
  assert.equal(closed.primary.active, diff)
  assert.equal(closeTabInGroup(closed, diff, 'primary').primary.active, a)
  assert.equal(closeTabInGroup(initial, a, 'primary').primary.active, b)
  assert.equal(closeTabInGroup(initial, other, 'primary'), initial)
  assert.equal(closeTabInGroup(initial, a, 'secondary'), initial)
  const empty = closeTabInGroup(createSplitState([a]), a, 'primary')
  assert.equal(empty.primary.active, undefined)
  assert.deepEqual(empty.primary.tabs, [])
})

test('closing the last secondary tab collapses even when primary is focused', () => {
  const split = freeze(focusGroup(splitRight(createSplitState([a, b]), b), 'primary'))
  const closed = closeTabInGroup(split, b, 'secondary')
  assert.equal(closed.secondary, undefined)
  assert.equal(closed.focused, 'primary')
  assert.deepEqual(closed.primary.tabs, [a, b])
  assert.equal(split.secondary?.active, b)
})

test('moving opens or reuses the other group, selects the moved tab and collapses empty secondary', () => {
  const initial = freeze(createSplitState([a, b]))
  const moved = moveTabToOtherGroup(initial, a, 'primary')
  assert.deepEqual(moved.primary.tabs, [b])
  assert.deepEqual(moved.secondary?.tabs, [a])
  assert.equal(moved.focused, 'secondary')
  const returned = moveTabToOtherGroup(freeze(moved), a, 'secondary')
  assert.deepEqual(returned.primary.tabs, [b, a])
  assert.equal(returned.primary.active, a)
  assert.equal(returned.secondary, undefined)
  const shared = splitRight(createSplitState([a, diff]), diff)
  const deduped = moveTabToOtherGroup(shared, diff, 'secondary')
  assert.deepEqual(ids(deduped.primary.tabs), ['file:src/a.ts', 'diff:src/a.ts'])
  assert.equal(deduped.primary.active, diff)
  assert.equal(moveTabToOtherGroup(initial, other, 'primary'), initial)
  invariant(moveTabToOtherGroup(createSplitState([a]), a, 'primary'))
})

test('unsplit merges both modes without duplicate IDs and preserves focused selection', () => {
  const split = freeze(openTabInGroup(splitRight(createSplitState([a, diff]), a), b))
  const merged = unsplit(split)
  assert.deepEqual(ids(merged.primary.tabs), ['file:src/a.ts', 'diff:src/a.ts', 'file:src/b.ts'])
  assert.equal(merged.primary.active, b)
  assert.equal(merged.focused, 'primary')
  assert.equal(merged.secondary, undefined)
  assert.equal(unsplit(focusGroup(split, 'primary')).primary.active, a)
  assert.equal(unsplit(merged), merged)
})

test('folder rename and delete affect both groups, both modes, Windows paths and Unicode only at boundaries', () => {
  const windows: Tab = { path: 'src\\nested\\文件.ts', mode: 'file' }
  const initial = freeze(openTabInGroup(splitRight(createSplitState([a, diff, other]), diff), windows))
  const renamed = renameInSplitState(initial, 'src\\', '目录\\')
  assert.deepEqual(ids(renamed.primary.tabs), ['file:目录/a.ts', 'diff:目录/a.ts', 'file:src-other/c.ts'])
  assert.deepEqual(ids(renamed.secondary!.tabs), ['diff:目录/a.ts', 'file:目录/nested/文件.ts'])
  assert.equal(renamed.primary.active?.path, '目录/a.ts')
  assert.equal(renamed.secondary?.active?.path, '目录/nested/文件.ts')
  const fileRename = renameInSplitState(renamed, '目录/a.ts', '目录/new.ts')
  assert.equal(fileRename.secondary?.tabs[0].path, '目录/new.ts')
  const deleted = deleteInSplitState(freeze(fileRename), '目录\\')
  assert.deepEqual(deleted.primary.tabs, [other])
  assert.equal(deleted.primary.active, other)
  assert.equal(deleted.secondary, undefined)
  assert.equal(deleted.focused, 'primary')
  assert.equal(initial.primary.tabs[0].path, 'src/a.ts')
  assert.equal(renameInSplitState(initial, '', 'x'), initial)
  assert.equal(deleteInSplitState(initial, ''), initial)
})

test('delete preserves remaining secondary and picks a valid neighboring active tab', () => {
  const state = openTabInGroup(splitRight(createSplitState([a, other]), a), other)
  const deleted = deleteInSplitState(state, 'src')
  assert.deepEqual(deleted.primary.tabs, [other])
  assert.deepEqual(deleted.secondary?.tabs, [other])
  assert.equal(deleted.focused, 'secondary')
  invariant(deleted)
})

test('rename collisions deduplicate IDs and preserve valid selections through subsequent transitions', () => {
  const state = splitRight(createSplitState([a, b], a))
  const renamed = renameInSplitState(state, a.path, b.path)
  assert.equal(renamed.primary.tabs.length, 1)
  for (const result of [renamed, unsplit(renamed), closeTabInGroup(renamed, b, 'secondary'), deleteInSplitState(renamed, 'src'), moveTabToOtherGroup(renamed, b, 'secondary')]) invariant(result)
})
