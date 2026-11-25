import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatItem } from '../../../../../packages/protocol/src/index'
import { summarizeWorkItems } from '../chat-timeline'
import { ActiveToolsView, LiveTurnStatus, TurnWorkGroup } from '../components/TurnWorkGroup'
import { resolveWorkspaceFilePath } from '../workspace-paths'

const tool = (id: string, name: string, target: string, extra = {}): ChatItem => ({ id, role: 'assistant', kind: 'tool', text: '', tool: { name, target, status: 'completed', ...extra } })
const items: ChatItem[] = [
  tool('read-1', 'read', 'src/index.ts'),
  tool('read-2', 'read_file', 'C:\\work\\project\\README.md'),
  tool('shell', 'shell', 'npm run build', { input: { command: 'npm run build' }, output: '<script>alert("output")</script>', durationMs: 47900 }),
  tool('agent', 'subagent', 'Review changes'),
  { id: 'thought', role: 'assistant', kind: 'reasoning', text: 'Check **types**.' },
  { id: 'note', role: 'assistant', text: 'Intermediate commentary.' },
  tool('bad', 'read', 'src/error.ts', { status: 'error', error: 'Failed <img src=x onerror=alert(1)>\nMore detail' }),
]
const props = { id: 'turn:work', items, summary: summarizeWorkItems(items, 52000), projectDirectory: 'C:\\work\\project', onOpenFile: () => {}, onOpenAgentMap: () => {} }

test('settled work starts collapsed and exposes error and subagent counts without intermediate content', () => {
  const html = renderToStaticMarkup(createElement(TurnWorkGroup, props))
  assert.match(html, /data-testid="turn-work-toggle"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /1 lỗi/)
  assert.match(html, /class="turn-work__pill">1 subagent</)
  assert.doesNotMatch(html, /gọi 1 subagent/)
  assert.match(html, /title="Đã chạy 1 lệnh trong 52s · đọc 3 tệp · 1 subagent · 1 lỗi"/)
  assert.doesNotMatch(html, /turn-work__list|Intermediate commentary|npm run build/)
})

test('expanded work renders read rail, file chips, commands, raw panels, Agent map and escaped notes', () => {
  const html = renderToStaticMarkup(createElement(TurnWorkGroup, { ...props, defaultOpen: true }))
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /turn-work__list/)
  assert.match(html, /work-row--read-group/)
  assert.match(html, /class="work-row__read-label" title="">Đã đọc</)
  assert.match(html, /title="Mở tệp: src\/index.ts" aria-label="Mở tệp src\/index.ts">index.ts<\/button>/)
  assert.match(html, /aria-label="Mở tệp C:\\work\\project\\README.md">README.md<\/button>/)
  assert.doesNotMatch(html, /Đã đọc index.ts|Đã đọc README.md|>Mở tệp</)
  assert.match(html, /npm run build/)
  assert.match(html, /47.9s/)
  assert.match(html, /Agent map/)
  assert.match(html, /Intermediate commentary/)
  assert.match(html, /Suy nghĩ/)
  assert.match(html, /Input|Output|Error/)
  assert.match(html, /Sao chép Input/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<script>|<img/)
})

test('compact file actions reject directories, traversals, URLs and external files', () => {
  for (const target of ['src/', 'C:\\work\\project', 'C:\\external\\secret.ts', '../secret.ts', 'https://example.com/file.ts']) {
    assert.equal(resolveWorkspaceFilePath(target, props.projectDirectory), null)
    const invalid = [tool('invalid', 'read', target)]
    const html = renderToStaticMarkup(createElement(TurnWorkGroup, { ...props, items: invalid, summary: summarizeWorkItems(invalid), defaultOpen: true }))
    assert.doesNotMatch(html, /class="file-chip"/)
  }
  assert.deepEqual(resolveWorkspaceFilePath('C:\\work\\project\\src\\index.ts:12', props.projectDirectory), { path: 'src/index.ts', line: 12 })
})

test('read groups keep nonclickable targets as text and all workspace basenames as chips', () => {
  const reads = ['README.md', 'src/app.ts', 'src/third.ts', 'src/fourth.ts', 'C:\\external\\notes.md'].map((target, index) => tool(`read-${index}`, 'read', target))
  const html = renderToStaticMarkup(createElement(TurnWorkGroup, { ...props, items: reads, summary: summarizeWorkItems(reads), defaultOpen: true }))
  assert.match(html, /Đã đọc notes.md</)
  for (const name of ['README.md', 'app.ts', 'third.ts', 'fourth.ts']) assert.ok(html.includes(`>${name}</button>`))
  assert.doesNotMatch(html, />notes.md<\/button>/)
  const noActions = renderToStaticMarkup(createElement(TurnWorkGroup, { ...props, items: reads, summary: summarizeWorkItems(reads), onOpenFile: undefined, defaultOpen: true }))
  assert.match(noActions, /Đã đọc README.md, app.ts, third.ts, fourth.ts, notes.md/)
  assert.doesNotMatch(noActions, /class="file-chip"/)
})

test('completed rows show only inline durations while running and error rows retain badges', () => {
  const durations = [80, 1500, 47000]
  const completed = durations.map((durationMs, index) => tool(`run-${index}`, 'shell', 'npm run build', { durationMs }))
  const html = renderToStaticMarkup(createElement(ActiveToolsView, { items: [...completed, tool('no-duration', 'grep', '**/*.ts')] }))
  assert.match(html, /class="work-row__duration">&lt;1s</)
  assert.match(html, /class="work-row__duration">1.5s</)
  assert.match(html, /class="work-row__duration">47s</)
  assert.doesNotMatch(html, /Hoàn tất|turn-work__pill/)
  assert.match(html, /work-row__main/)
})

test('active tools expose running command, concise error and live status with escaped text', () => {
  const html = renderToStaticMarkup(createElement(ActiveToolsView, { ...props, items: [tool('running', 'shell', 'npm run build', { status: 'running' }), items.at(-1)!] }))
  assert.match(html, /Đang chạy/)
  assert.match(html, /npm run build/)
  assert.match(html, /work-row__error/)
  assert.doesNotMatch(html, /<img/)
  const status = renderToStaticMarkup(createElement(LiveTurnStatus, { label: 'Đang đọc <manifest>…' }))
  assert.match(status, /role="status"/)
  assert.match(status, /turn-live-status__dot/)
  assert.match(status, /Đang đọc &lt;manifest&gt;…/)
})

test('pending question rows never duplicate raw question JSON above the response form', () => {
  for (const status of ['running', 'streaming']) {
    const question = tool('q', 'question', '', { status, input: { questions: [{ question: 'RAW_QUESTION_PAYLOAD', options: Array(50).fill({ label: 'RAW_OPTION' }) }] } })
    const html = renderToStaticMarkup(createElement(ActiveToolsView, { items: [question] }))
    assert.match(html, /Trả lời trong biểu mẫu bên dưới/)
    assert.doesNotMatch(html, /RAW_QUESTION_PAYLOAD|RAW_OPTION|<pre/)
  }
})
