import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as state from '../state'
import * as lifecycle from '../editor-model-lifecycle'
import type { DiffContent } from '../../../../../packages/protocol/src/index'

function render(diff?: DiffContent, tabs: state.Tab[] = [{ path: 'README.md', mode: 'file' }, { path: 'assets/data.bin', mode: 'diff', target: { kind: 'commit', commit: 'abcdef1' } }], props: { active?: state.Tab; loadError?: string; isMac?: boolean; onReveal?: (path: string) => void; onReload?: () => void; onClose?: (tab: state.Tab) => void } = {}) {
  const require = createRequire(import.meta.url), exports: Record<string, any> = {}
  let diffMounts = 0
  let diffProps: Record<string, any> | undefined
  const source = readFileSync(new URL('../components/EditorStage.tsx', import.meta.url), 'utf8')
  const noop = () => {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, self: {},
    require(id: string) {
      if (id === 'react') return { useRef: (current: unknown) => ({ current }), useEffect: noop, useState: (value: unknown) => [value, noop] }
      if (id === '@monaco-editor/react') return { default: () => null, loader: { config: noop }, DiffEditor: (props: Record<string, any>) => { diffMounts++; diffProps = props; return 'DiffEditor' } }
      if (id === 'monaco-editor') return { languages: { CompletionItemKind: {} }, typescript: { typescriptDefaults: { setDiagnosticsOptions: noop }, javascriptDefaults: { setDiagnosticsOptions: noop } } }
      if (id.includes('?worker')) return { default: class {} }
      if (id === '../state') return state
      if (id === '../editor-model-lifecycle') return lifecycle
      if (id === '../monaco-shiki') return { ensureMonacoShikiLanguage: async () => true, shikiThemeName: (theme: string, ready: boolean) => ready ? `ame-${theme}` : theme === 'dark' ? 'vs-dark' : 'light' }
      if (id === '../workspace-paths') return { navigationPosition: noop }
      if (id === './Primitives') return { Empty: ({ children }: any) => children, IconButton: () => null }
      if (id === './Icon') return { Icon: ({ name }: any) => name }
      return require(id)
    },
  })
  const tree = exports.EditorStage({ projectID: 'p', tabs, active: tabs.find(tab => tab.mode === 'diff'), diff, dirtyPaths: new Set(), theme: 'dark', ...props })
  const html = renderToStaticMarkup(tree)
  return { html, tree, diffMounts, diffProps }
}

function findElements(tree: any, matches: (element: any) => boolean): any[] {
  if (Array.isArray(tree)) return tree.flatMap(child => findElements(child, matches))
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [...(matches(tree) ? [tree] : []), ...findElements(tree.props.children, matches)]
}

test('unreadable files reveal the active path with platform labels between retry and close', () => {
  const active: state.Tab = { path: 'assets/unreadable.bin', mode: 'file' }
  for (const isMac of [false, true]) {
    const revealed: string[] = [], closed: state.Tab[] = []
    let reloads = 0
    const { html, tree } = render(undefined, [active], { active, loadError: 'Cannot read file', isMac, onReveal: path => revealed.push(path), onReload: () => reloads++, onClose: tab => closed.push(tab) })
    const label = isMac ? 'Show in Finder' : 'Show in File Explorer'
    assert.match(html, /class="editor-load-error"/)
    assert.ok(html.includes(`data-testid="editor-reveal-btn">folder<span>${label}</span>`))
    const [error] = findElements(tree, element => element.props.className === 'editor-load-error')
    const buttons = findElements(error, element => element.type === 'button')
    assert.equal(buttons.length, 3)
    assert.equal(buttons[0].props.children, 'Thử lại')
    assert.equal(buttons[1].props['data-testid'], 'editor-reveal-btn')
    assert.equal(buttons[2].props.children, 'Đóng tab')
    buttons.forEach(button => button.props.onClick())
    assert.equal(reloads, 1)
    assert.deepEqual(revealed, [active.path])
    assert.deepEqual(closed, [active])
  }
  assert.doesNotMatch(render(undefined, [active], { active, loadError: 'Cannot read file' }).html, /editor-reveal-btn/)
})

test('binary and too-large diffs reveal the active path with platform labels without Monaco', () => {
  const active: state.Tab = { path: 'assets/data.bin', mode: 'diff', target: { kind: 'working' } }
  for (const metadata of [{ binary: true }, { tooLarge: true }]) {
    for (const isMac of [false, true]) {
      const revealed: string[] = []
      const diff = { original: '', modified: '', ...metadata }
      const { html, tree, diffMounts } = render(diff, [active], { isMac, onReveal: path => revealed.push(path) })
      const label = isMac ? 'Show in Finder' : 'Show in File Explorer'
      assert.equal(diffMounts, 0)
      assert.match(html, /Không có bản xem trước/)
      assert.ok(html.includes(`<div class="button-row"><button type="button" class="editor-reveal-btn" data-testid="editor-reveal-btn">folder<span>${label}</span></button></div>`))
      const buttons = findElements(tree, element => element.props['data-testid'] === 'editor-reveal-btn')
      assert.equal(buttons.length, 1)
      buttons[0].props.onClick()
      assert.deepEqual(revealed, [active.path])
      assert.doesNotMatch(render(diff, [active]).html, /editor-reveal-btn/)
    }
  }
})

test('unpreviewable diff names the file, both sizes and reason without mounting Monaco', () => {
  for (const metadata of [{ binary: true, reason: 'Tệp nhị phân' }, { tooLarge: true, reason: 'Vượt giới hạn 4 MiB' }]) {
    const result = render({ original: '', modified: '', originalSize: 12, modifiedSize: 4194305, ...metadata })
    assert.equal(result.diffMounts, 0)
    assert.match(result.html, /assets\/data.bin/)
    assert.match(result.html, /12 bytes/); assert.match(result.html, /4194305 bytes/)
    assert.ok(result.html.includes(metadata.reason))
  }
  assert.equal(render({ original: 'before', modified: 'after' }).diffMounts, 1)
})

test('tab identity is stable and file tooltip preserves protected desktop smoke contract', () => {
  const { html } = render()
  assert.match(html, /title="README.md"/)
  assert.doesNotMatch(html, /README.md · README.md/)
  assert.match(html, /data-tab-id="file:README.md"/)
  assert.match(html, /data-tab-path="assets\/data.bin" data-tab-mode="diff"/)
  assert.match(html, /title="assets\/data.bin · data.bin \(abcdef1\)"/)
})

test('preferences retain SHA-256 commit, range and selected-commits tabs and selection', () => {
  for (const hash of ['abcdef1', 'a'.repeat(40), 'AbCdEf01'.repeat(8)]) {
    const targets: state.Tab['target'][] = [
      { kind: 'commit', commit: hash },
      ...[undefined, false, true].flatMap(includeWorking => [
        { kind: 'range' as const, baseCommit: hash, includeWorking },
        { kind: 'commits' as const, commits: [hash, 'b'.repeat(64)], includeWorking },
      ]),
      { kind: 'commits', commits: Array(50).fill(hash) },
    ]
    const tabs: state.Tab[] = targets.map(target => ({ path: 'notes.md', mode: 'diff', target }))
    const active = state.tabID(tabs[0])
    const parsed = state.parsePreferences(JSON.stringify({ projects: { p: { tabs, active, selectedTabs: { diff: active } } } })).projects.p
    assert.deepEqual(parsed.tabs, JSON.parse(JSON.stringify(tabs)))
    assert.equal(parsed.active, active)
    assert.equal(parsed.selectedTabs?.diff, active)
  }
})

test('preferences reject invalid hashes, commit lists and includeWorking values', () => {
  const hash = 'a'.repeat(64)
  const invalidHashes = ['', 'a'.repeat(6), 'a'.repeat(65), 'g'.repeat(64), `${hash} `, null, 123]
  const targets = [
    ...invalidHashes.flatMap(value => [
      { kind: 'commit', commit: value },
      { kind: 'range', baseCommit: value },
      { kind: 'commits', commits: [hash, value] },
    ]),
    ...[[], Array(51).fill(hash), hash, null].map(commits => ({ kind: 'commits', commits })),
    ...['true', 1, null].flatMap(includeWorking => [
      { kind: 'range', baseCommit: hash, includeWorking },
      { kind: 'commits', commits: [hash], includeWorking },
    ]),
  ]
  const tabs = targets.map(target => ({ path: 'notes.md', mode: 'diff', target }))
  const parsed = state.parsePreferences(JSON.stringify({ projects: { p: { tabs } } })).projects.p
  assert.equal(parsed.tabs.length, tabs.length)
  assert.ok(parsed.tabs.every(tab => tab.target === undefined))
})

test('aggregated patches render as preformatted text without DiffEditor or Split/Inline controls', () => {
  for (const patch of ['diff --git a/notes.md b/notes.md\n-old\n+new <text> & notes\n', '']) {
    const { html, diffMounts } = render({ original: '', modified: '', patch })
    assert.equal(diffMounts, 0)
    const escaped = patch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    assert.ok(html.includes(`<pre class="git-commit-patch" data-testid="diff-patch-view">${escaped}</pre>`))
    assert.doesNotMatch(html, /Chế độ diff|Split|Inline/)
  }
  for (const metadata of [{ binary: true }, { tooLarge: true }]) {
    const { html, diffMounts } = render({ original: '', modified: '', patch: 'hidden patch', ...metadata })
    assert.equal(diffMounts, 0)
    assert.doesNotMatch(html, /diff-patch-view|hidden patch/)
    assert.match(html, /Không có bản xem trước/)
  }
})

test('range and selected-commits tabs have distinct serialized IDs and descriptive titles', () => {
  const hash = 'abcdef01'.repeat(8), other = '12345678'.repeat(8)
  const targets: NonNullable<state.Tab['target']>[] = [
    { kind: 'range', baseCommit: hash },
    { kind: 'range', baseCommit: hash, includeWorking: true },
    { kind: 'range', baseCommit: other },
    { kind: 'commits', commits: [hash] },
    { kind: 'commits', commits: [hash], includeWorking: true },
    { kind: 'commits', commits: [other] },
    { kind: 'commits', commits: [hash, other] },
    { kind: 'commits', commits: [other, hash] },
  ]
  const tabs: state.Tab[] = targets.map(target => ({ path: 'notes.md', mode: 'diff', target }))
  const ids = tabs.map(state.tabID)
  assert.equal(new Set(ids).size, tabs.length)
  const { html } = render(undefined, tabs)
  const renderedIDs = [...html.matchAll(/data-tab-id="([^"]+)"/g)].map(match => match[1].replace(/&quot;/g, '"'))
  assert.deepEqual(renderedIDs, ids)
  const titles = ['abcdef0..HEAD', 'abcdef0..Disk', '1234567..HEAD', '1 commits', '1 commits + Disk', '1 commits', '2 commits', '2 commits']
  tabs.forEach((tab, index) => {
    assert.equal(state.tabTitle(tab), `notes.md (${titles[index]})`)
    assert.ok(html.includes(`title="notes.md · notes.md (${titles[index]})"`))
  })
  assert.equal(ids[0], `diff:${JSON.stringify(['notes.md', 'range', hash, false])}`)
  assert.equal(ids[6], `diff:${JSON.stringify(['notes.md', 'commits', [hash, other], false])}`)
  assert.equal(state.tabID({ ...tabs[0], target: { kind: 'range', baseCommit: hash.toUpperCase(), includeWorking: false } }), ids[0])
  assert.equal(state.tabID({ ...tabs[3], target: { kind: 'commits', commits: [hash.toUpperCase()], includeWorking: false } }), ids[3])
})

test('non-patch staged, working, commit and range diffs still mount DiffEditor with the toggle', () => {
  const targets: NonNullable<state.Tab['target']>[] = [
    { kind: 'staged' }, { kind: 'working' }, { kind: 'commit', commit: 'abcdef1' }, { kind: 'range', baseCommit: 'abcdef1' },
  ]
  for (const target of targets) {
    const { html, diffMounts } = render({ original: 'before', modified: 'after' }, [{ path: 'notes.md', mode: 'diff', target }])
    assert.equal(diffMounts, 1)
    assert.match(html, /Chế độ diff/)
    assert.doesNotMatch(html, /diff-patch-view/)
  }
})

test('diff language and fallback theme preserve both retained model paths', () => {
  for (const path of ['view.tsx', 'view.jsx', 'main.ts', 'main.js', 'notes.md']) {
    const tab: state.Tab = { path, mode: 'diff', target: { kind: 'working' } }
    const { diffProps } = render({ original: 'before', modified: 'after' }, [tab])
    assert.ok(diffProps)
    assert.equal(diffProps.language, state.languageFor(path))
    assert.equal(diffProps.theme, 'vs-dark')
    assert.equal(diffProps.keepCurrentOriginalModel, true)
    assert.equal(diffProps.keepCurrentModifiedModel, true)
    assert.equal(diffProps.originalModelPath, lifecycle.modelUri('p', state.tabID(tab), 'original'))
    assert.equal(diffProps.modifiedModelPath, lifecycle.modelUri('p', state.tabID(tab), 'modified'))
    assert.equal(diffProps.options.readOnly, true)
    assert.equal(diffProps.options.originalEditable, false)
  }
})
