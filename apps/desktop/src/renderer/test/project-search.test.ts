import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReplacementReport } from '../components/ProjectSearch'
import { Inspector } from '../components/Inspector'
import { humanizeIdeError } from '../components/Primitives'
import type { ReplaceResult } from '../../../../../packages/protocol/src/index'

const result: ReplaceResult = { filesChanged: 2, replacements: 4, previews: [], writtenFiles: ['a.txt', 'd.txt'], conflicts: ['b.txt'], errors: [{ path: 'c.txt', code: 'ENOENT' }] }
test('partial replacement names conflicts and failed files alongside actual successful writes', () => {
  const html = renderToStaticMarkup(createElement(ReplacementReport, { result, dryRun: false }))
  for (const expected of ['Đã thay thế', '4 vị trí trong 2 tệp', 'Chưa thay thế 2 tệp', 'b.txt', 'sau Preview', 'c.txt', 'Không tìm thấy', 'Preview lại']) assert.ok(html.includes(expected), expected)
  const allFailed = renderToStaticMarkup(createElement(ReplacementReport, { result: { ...result, filesChanged: 0, replacements: 0, writtenFiles: [] }, dryRun: false }))
  assert.ok(allFailed.includes('0 vị trí trong 0 tệp'))
  assert.ok(allFailed.includes('Chưa thay thế 2 tệp'))
})
test('successful previews and replacements have distinct labels and escape filenames in errors', () => {
  const success = { ...result, conflicts: [], errors: [] }
  const html = renderToStaticMarkup(createElement(ReplacementReport, { result: success, dryRun: true }))
  assert.match(html, /Preview: 4 vị trí trong 2 tệp/)
  assert.doesNotMatch(html, /Chưa thay thế/)
  const unsafe = renderToStaticMarkup(createElement(ReplacementReport, { result: { ...result, conflicts: ['<script>bad</script>'] }, dryRun: false }))
  assert.doesNotMatch(unsafe, /<script>/)
  assert.match(unsafe, /&lt;script&gt;/)
  assert.match(humanizeIdeError(new Error('SEARCH_TIMEOUT')), /giới hạn phạm vi/)
})

test('the Inspector search tab renders the shared project search controls', () => {
  const html = renderToStaticMarkup(createElement(Inspector, {
    projectID: 'p', tab: 'search', generation: 0, gitError: '', setTab() {}, refresh() {},
    onOpen() {}, onRename() {}, onDelete() {}, onDiff() {}, onHide() {}, report() {},
  }))
  assert.match(html, /data-testid="project-search"/)
  for (const label of ['Tìm trong dự án', 'Include globs', 'Exclude globs']) assert.ok(html.includes(label))
})
