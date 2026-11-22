import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuickOpen } from '../components/QuickOpen'
import { fuzzyMatchPath, parseQuickOpenInput, rankQuickOpenFiles } from '../quick-open'

test('parses line and file positions, trims input, and clamps columns', () => {
  for (const [raw, expected] of [
    [':42', { mode: 'line', line: 42 }],
    [' :42:10 ', { mode: 'line', line: 42, column: 10 }],
    [':1:0', { mode: 'line', line: 1, column: 1 }],
    ['src/App.tsx:120', { mode: 'file', query: 'src/App.tsx', line: 120 }],
    ['App.tsx:12:4', { mode: 'file', query: 'App.tsx', line: 12, column: 4 }],
    ['C:\\src\\ỨngDụng.tsx:12:4', { mode: 'file', query: 'C:\\src\\ỨngDụng.tsx', line: 12, column: 4 }],
    ['foo:1:-2', { mode: 'file', query: 'foo', line: 1, column: 1 }]
  ] as const) assert.deepEqual(parseQuickOpenInput(raw), expected)
})

test('invalid positions remain literal file queries', () => {
  for (const raw of ['foo:abc', ':0', ':-3', ':2:abc', 'foo:0', 'foo:3.2', ':', 'https://example.com/a', ' C:\\src\\a.ts ', '']) {
    assert.deepEqual(parseQuickOpenInput(raw), { mode: 'file', query: raw.trim() })
  }
})

test('fuzzy subsequences are case insensitive with exact original indices across separators and Unicode', () => {
  for (const candidate of ['src/AppMain.tsx', 'src\\AppMain.tsx']) {
    assert.deepEqual(fuzzyMatchPath('amt', candidate)?.indices, [4, 7, 12])
    assert.equal(fuzzyMatchPath('zq', candidate), null)
  }
  assert.deepEqual(fuzzyMatchPath('ỨD', 'src/ỨngDụng.ts')?.indices, [4, 7])
  assert.deepEqual(fuzzyMatchPath('界😀', '目录/世界😀.ts')?.indices, [4, 5, 6])
  assert.deepEqual(fuzzyMatchPath('İ', 'src/İ.ts')?.indices, [4])
  assert.deepEqual(fuzzyMatchPath('', 'a'), { score: 0, indices: [] })
  assert.equal(fuzzyMatchPath('long', 'a'), null)
  assert.equal(fuzzyMatchPath('a', ''), null)
  assert.deepEqual(fuzzyMatchPath('src/a', 'src\\a')?.indices, [0, 1, 2, 3, 4])
})

test('fuzzy ranking rewards basename, boundaries, consecutive runs, exact case and short paths', () => {
  const score = (query: string, path: string) => fuzzyMatchPath(query, path)!.score
  assert.ok(score('app', 'src/app.ts') > score('app', 'app/src/other.ts'))
  assert.ok(score('ab', 'a-b.ts') > score('ab', 'axb.ts'))
  assert.ok(score('ab', 'aB.ts') > score('ab', 'axb.ts'))
  assert.ok(score('app', 'app.ts') > score('app', 'axpxp.ts'))
  assert.ok(score('App', 'App.ts') > score('App', 'app.ts'))
  assert.ok(score('app', 'app.ts') > score('app', 'long/path/app.ts'))
  assert.deepEqual(fuzzyMatchPath('ab', 'a___ab')?.indices, [4, 5])
})

test('ranking lists recents in supplied order, omits stale paths and duplicates, and limits results', () => {
  const files = Object.freeze(['z.ts', 'a.ts', 'b.ts', 'a.ts'])
  const recents = Object.freeze(['missing.ts', 'b.ts', 'z.ts', 'b.ts'])
  assert.deepEqual(rankQuickOpenFiles('', files, recents).map(item => item.path), ['b.ts', 'z.ts', 'a.ts'])
  assert.deepEqual(rankQuickOpenFiles('', files, recents, 1).map(item => item.path), ['b.ts'])
  assert.deepEqual(rankQuickOpenFiles('', files, recents, -1), [])
  assert.equal(rankQuickOpenFiles('', Array.from({ length: 80 }, (_, i) => `${i}.ts`)).length, 60)
  assert.deepEqual(rankQuickOpenFiles('zzz', files), [])
  const item = rankQuickOpenFiles('App', ['src\\App.ts'])[0]
  assert.equal(item.name, 'App.ts')
  assert.equal(item.directory, 'src')
  assert.deepEqual(item.indices, [4, 5, 6])
})

test('query ranking uses score first and recency to break equal scores', () => {
  assert.equal(rankQuickOpenFiles('a', ['b/a.ts', 'c/a.ts'], ['c/a.ts'])[0].path, 'c/a.ts')
  assert.equal(rankQuickOpenFiles('app', ['src/app.ts', 'app/src/no.ts'], ['app/src/no.ts'])[0].path, 'src/app.ts')
})

test('modal renders accessible file and line states without interpreting filenames as HTML', () => {
  const props = { open: true, mode: 'files' as const, files: ['<img src=x>.ts'], recentPaths: ['<img src=x>.ts'], onSelectFile() {}, onGoToLine() {}, onClose() {} }
  const markup = renderToStaticMarkup(createElement(QuickOpen, props))
  assert.match(markup, /role="dialog"/)
  assert.match(markup, /role="combobox"/)
  assert.match(markup, /role="listbox"/)
  assert.match(markup, /role="option"/)
  assert.match(markup, /aria-selected="true"/)
  assert.match(markup, /đang mở/)
  assert.doesNotMatch(markup, /<img /)
  assert.match(markup, /&lt;/)
  assert.equal(renderToStaticMarkup(createElement(QuickOpen, { ...props, open: false })), '')
  const line = renderToStaticMarkup(createElement(QuickOpen, { ...props, mode: 'line', activeFile: 'app.ts' }))
  assert.match(line, /value=":"/)
  assert.match(line, /app.ts/)
  assert.doesNotMatch(line, /role="listbox"/)
  const loading = renderToStaticMarkup(createElement(QuickOpen, { ...props, loading: true }))
  assert.match(loading, /aria-busy="true"/)
  assert.doesNotMatch(loading, /role="option"/)
})
