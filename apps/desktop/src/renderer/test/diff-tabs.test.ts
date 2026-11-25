import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activateTab, defaults, diffID, parsePreferences, removeTab, selectedTab, tabID, tabTitle, type ProjectView, type Tab } from '../state'
import { sanitizeProjectView } from '../workspace-paths'
import { modelUri } from '../editor-model-lifecycle'

test('same-path diff contexts have independent tabs, cache and Monaco models and survive restoration', () => {
  const tabs: Tab[] = [
    { path: 'src/file.ts', mode: 'diff', target: { kind: 'staged' } },
    { path: 'src/file.ts', mode: 'diff', target: { kind: 'working' } },
    { path: 'src/file.ts', mode: 'diff', target: { kind: 'commit', commit: 'abcdef1234567' } },
    { path: 'src/file.ts', mode: 'diff', target: { kind: 'commit', commit: '1234567abcdef' } }
  ]
  assert.equal(new Set(tabs.map(tabID)).size, 4)
  assert.equal(new Set(tabs.map(tab => diffID('p', tab))).size, 4)
  assert.equal(new Set(tabs.map(tab => modelUri('p', tabID(tab), 'original'))).size, 4)
  assert.deepEqual(tabs.map(tabTitle), ['file.ts (Staged)', 'file.ts (Changes)', 'file.ts (abcdef1)', 'file.ts (1234567)'])
  let view: ProjectView = { tabs }
  view = activateTab(view, tabs[0]); assert.equal(selectedTab(view, 'diff'), tabs[0])
  view = activateTab(view, tabs[1]); assert.equal(selectedTab(view, 'diff'), tabs[1])
  const restored = parsePreferences(JSON.stringify({ ...defaults(), projects: { p: view } })).projects.p
  assert.deepEqual(sanitizeProjectView(restored), { session: undefined, ...view })
  view = removeTab(view, tabs[0])
  assert.equal(view.tabs.length, 3)
  assert.equal(selectedTab(view, 'diff'), tabs[1])
})
