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

function render(diff?: DiffContent) {
  const require = createRequire(import.meta.url), exports: Record<string, any> = {}
  let diffMounts = 0
  const source = readFileSync(new URL('../components/EditorStage.tsx', import.meta.url), 'utf8')
  const noop = () => {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, self: {},
    require(id: string) {
      if (id === 'react') return { useRef: (current: unknown) => ({ current }), useEffect: noop, useState: (value: unknown) => [value, noop] }
      if (id === '@monaco-editor/react') return { default: () => null, loader: { config: noop }, DiffEditor: () => { diffMounts++; return 'DiffEditor' } }
      if (id === 'monaco-editor') return { languages: { CompletionItemKind: {} }, typescript: { typescriptDefaults: { setDiagnosticsOptions: noop }, javascriptDefaults: { setDiagnosticsOptions: noop } } }
      if (id.includes('?worker')) return { default: class {} }
      if (id === '../state') return state
      if (id === '../editor-model-lifecycle') return lifecycle
      if (id === '../workspace-paths') return { navigationPosition: noop }
      if (id === './Primitives') return { Empty: ({ children }: any) => children, IconButton: () => null }
      return require(id)
    },
  })
  const tabs: state.Tab[] = [{ path: 'README.md', mode: 'file' }, { path: 'assets/data.bin', mode: 'diff', target: { kind: 'commit', commit: 'abcdef1' } }]
  const html = renderToStaticMarkup(exports.EditorStage({ projectID: 'p', tabs, active: tabs[1], diff, dirtyPaths: new Set(), theme: 'dark' }))
  return { html, diffMounts }
}

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
