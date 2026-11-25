import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatItem } from '../../../../../packages/protocol/src/index'
import { classifyTool, extractUserDisplayText, formatAgentDuration, groupExpandedWork, projectChatTimeline, summarizeWorkItems, toolTarget } from '../chat-timeline'
import type { TimelineBlock } from '../chat-timeline'

const text = (id: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id, role: 'assistant', text: id, ...extra })
const tool = (id: string, name: string, extra: Partial<NonNullable<ChatItem['tool']>> = {}): ChatItem => text(id, { kind: 'tool', tool: { name, status: 'completed', ...extra } })
const user = (id = 'user', extra: Partial<ChatItem> = {}): ChatItem => text(id, { role: 'user', ...extra })
const reasoning = (id = 'reasoning'): ChatItem => text(id, { kind: 'reasoning' })
const changes = (id = 'changes'): ChatItem => text(id, { kind: 'changes', turn: { from: 'user', files: ['src/main.ts'] } })
const compact = (items: ChatItem[], running = false) => projectChatTimeline(items, { running, mode: 'compact' })
const work = (block: TimelineBlock) => {
  assert.equal(block.kind, 'work-group')
  if (block.kind !== 'work-group') throw new Error('Expected work group')
  return block
}
const blockItems = (blocks: TimelineBlock[]) => blocks.flatMap(block => {
  if (block.kind === 'work-group' || block.kind === 'active-tools') return block.items.map(item => item.id)
  return 'item' in block ? [block.item.id] : []
})

test('translation display text strips only scoped wrappers and the supported mode header after the last request marker', () => {
  const scope = '[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY]'
  const request = 'file tạo ở đâu rồi?'
  const skill = `SKILL.md\n${'translation instructions '.repeat(800)}\n\nUser request:\nexample embedded in skill`
  assert.equal(extractUserDisplayText(`${scope}\n${skill}\n\nUser request:\n[Translation mode: full]\n${request}`), request)
  assert.equal(extractUserDisplayText(`${scope}\nFollow-up constraints\n\nUser request:\n${request}`), request)
  for (const mode of ['update', 'full', 'scan', 'custom']) {
    assert.equal(extractUserDisplayText(`${scope}\n\nUser request:\n[Translation mode: ${mode}]\n${request}`), request)
  }
  for (const normal of [request, '', `${scope}\nMissing request marker`, `Ordinary message\n\nUser request:\n${request}`, `[Translation mode: full]\n${request}`]) {
    assert.equal(extractUserDisplayText(normal), normal)
  }
})

test('session errors always remain standalone blocks in all detail modes, live and settled', () => {
  for (const mode of ['compact', 'detailed', 'everything'] as const) for (const running of [false, true]) {
    const errors = [text('early-error', { kind: 'error', phase: 'commentary', text: 'Compaction summary reached the output token limit' }), text('last-error', { kind: 'error', text: '' })]
    const items = [user(), errors[0], reasoning(), tool('read', 'read'), text('answer', { phase: 'final_answer' }), errors[1]]
    const [turn] = projectChatTimeline(items, { mode, running })
    assert.deepEqual(turn.blocks.filter(block => block.kind === 'error'), errors.map(item => ({ kind: 'error', id: item.id, item })))
    assert.ok(!turn.blocks.some(block => (block.kind === 'work-group' || block.kind === 'active-tools') && block.items.some(item => item.kind === 'error')))
    assert.equal(blockItems(turn.blocks).filter(id => errors.some(item => item.id === id)).length, errors.length)
  }
})

test('a finished error does not strand later completed tools outside the live work group', () => {
  const items = [user(), tool('missing', 'read', { status: 'error', error: 'File not found' }), ...Array.from({ length: 8 }, (_, i) => tool(`read-${i}`, 'read')), tool('running', 'shell', { status: 'running' })]
  const blocks = compact(items, true)[0].blocks
  const group = work(blocks[0])
  assert.deepEqual(group.items.map(item => item.id), items.slice(1, -1).map(item => item.id))
  assert.equal(group.summary.errorCount, 1)
  assert.equal(blocks.filter(block => block.kind === 'tool').length, 0)
  assert.equal(blocks[1].kind, 'active-tools')
})

test('question tools and pending forms announce that user input is required', () => {
  for (const blocks of [compact([user(), tool('q', 'question', { status: 'running' })], true)[0].blocks, projectChatTimeline([user(), text('wait')], { running: false, mode: 'compact', pendingForms: true })[0].blocks]) {
    assert.deepEqual(blocks.at(-1), { kind: 'live-status', id: 'user:status', label: 'Đang chờ bạn trả lời câu hỏi…' })
  }
})

test('interrupted questions do not keep idle turns live or announce a missing form', () => {
  for (const mode of ['compact', 'detailed', 'everything'] as const) for (const status of ['running', 'streaming'] as const) {
    const items = [user(), tool('q', 'question', { status })]
    const [turn] = projectChatTimeline(items, { running: false, pendingForms: false, mode })
    assert.equal(turn.live, false)
    assert.ok(!turn.blocks.some(block => block.kind === 'active-tools' || block.kind === 'live-status'))
    assert.deepEqual(blockItems(turn.blocks), ['q'], 'historical question is retained')
    for (const options of [{ running: true, pendingForms: false }, { running: false, pendingForms: true }]) {
      const [active] = projectChatTimeline(items, { ...options, mode })
      assert.equal(active.live, true)
      assert.equal(active.blocks.at(-1)?.kind, 'live-status')
      assert.match(JSON.stringify(active.blocks.at(-1)), /Đang chờ bạn trả lời câu hỏi…/)
    }
  }
})

test('stale questions do not override other active tool status in idle sessions', () => {
  for (const name of ['shell', 'bash', 'read']) {
    const [turn] = projectChatTimeline([user(), tool('active', name, { status: 'running' }), tool('q', 'question', { status: 'running' })], { running: false, pendingForms: false, mode: 'compact' })
    assert.equal(turn.live, true)
    assert.deepEqual(turn.blocks.filter(block => block.kind === 'active-tools').flatMap(block => block.items.map(item => item.id)), ['active'])
    assert.doesNotMatch(JSON.stringify(turn.blocks.at(-1)), /Đang chờ bạn trả lời câu hỏi…/)
    assert.match(JSON.stringify(turn.blocks.at(-1)), name === 'read' ? /Đang đọc/ : /Đang chạy/)
  }
})

test('classifies every specified alias, normalizes names, and hides only todowrite', () => {
  const cases = [
    ['explore', 'read', ['read', 'read_file', 'view_file']],
    ['explore', 'search', ['glob', 'grep', 'search', 'list', 'webfetch', 'websearch']],
    ['explore', 'skill', ['skill']],
    ['edit', 'edit', ['edit', 'edit_file', 'write', 'write_file', 'patch', 'apply_patch']],
    ['run', 'run', ['shell', 'bash', 'execute', 'run_command', 'terminal']],
    ['subagent', 'subagent', ['subagent', 'task']],
    ['tool', 'other', ['unknown', '']],
  ] as const
  for (const [mode, kind, names] of cases) for (const name of names) {
    assert.deepEqual(classifyTool(` ${name.toUpperCase()} `), { mode, kind })
  }
  assert.deepEqual(classifyTool('TodoWrite'), { mode: 'tool', kind: 'other', hidden: true })
})

test('toolTarget prefers explicit target and extracts nonempty string input fields in order', () => {
  const fields = ['filePath', 'file_path', 'path', 'command', 'cmd', 'pattern', 'query', 'description', 'target']
  for (const key of fields) assert.equal(toolTarget(tool(key, 'read', { input: { [key]: 'value' } })), 'value')
  assert.equal(toolTarget(tool('explicit', 'read', { target: 'explicit', input: { filePath: 'input' } })), 'explicit')
  assert.equal(toolTarget(tool('ordered', 'read', { target: ' ', input: { filePath: 4, file_path: '', path: 'file', command: 'command' } })), 'file')
  for (const input of [null, undefined, [], 'text', 4, { filePath: false, path: ' ' }]) {
    assert.equal(toolTarget(tool('invalid', 'read', { input })), undefined)
  }
  assert.equal(toolTarget(text('not-tool')), undefined)
})

test('formats duration boundaries and rejects absent, negative, and non-finite durations', () => {
  for (const input of [undefined, -1, NaN, Infinity, -Infinity]) assert.equal(formatAgentDuration(input), '')
  const cases = [[0, '<1s'], [999, '<1s'], [1000, '1s'], [12999, '12s'], [60000, '1m 0s'], [74000, '1m 14s'], [3599999, '59m 59s'], [3900000, '1h 5m']] as const
  for (const [input, output] of cases) assert.equal(formatAgentDuration(input), output)
})

test('summaries deduplicate targets, count untargeted calls and errors, and prioritize edits', () => {
  const items = [
    tool('r1', 'read', { target: 'a.ts' }), tool('r2', 'read_file', { input: { path: 'a.ts' } }),
    tool('r3', 'view_file', { input: { filePath: 'b.ts' } }), tool('r4', 'read'),
    tool('e1', 'edit', { target: 'a.ts' }), tool('e2', 'apply_patch', { target: 'a.ts', status: 'error' }),
    tool('e3', 'write'), tool('s', 'grep'), tool('s2', 'websearch'), tool('skill', 'skill'),
    tool('run', 'shell'), tool('agent', 'task'), tool('other', 'custom', { status: 'error' }),
    reasoning(), text('note', { phase: 'commentary' }), tool('hidden', 'todowrite', { status: 'error' }), changes(),
  ]
  assert.deepEqual(summarizeWorkItems(items, 52000), {
    label: 'Đã sửa 2 tệp trong 52s · đọc 3 tệp, tìm 2 lần, chạy 1 lệnh, nạp 1 skill',
    stepCount: 15, errorCount: 2, subagentCount: 1, durationLabel: '52s',
  })
})

test('summary headlines honor mode priority and omit the main secondary clause', () => {
  const cases: [ChatItem[], string][] = [
    [[tool('run', 'bash'), tool('agent', 'task'), tool('read', 'read')], 'Đã chạy 1 lệnh · đọc 1 tệp'],
    [[tool('agent', 'task'), tool('read', 'read')], 'Đã chạy 1 tác vụ con · đọc 1 tệp'],
    [[tool('read', 'read'), tool('search', 'search'), tool('skill', 'skill')], 'Đã đọc 1 tệp · tìm 1 lần, nạp 1 skill'],
    [[tool('search', 'glob'), tool('skill', 'skill')], 'Đã tìm kiếm 1 lần · nạp 1 skill'],
    [[tool('skill', 'skill')], 'Đã nạp 1 skill'],
    [[tool('other', 'custom')], 'Đã dùng 1 công cụ'],
    [[reasoning(), reasoning('r2')], 'Đã suy nghĩ 2 bước'],
    [[text('note')], 'Đã xử lý 1 bước'],
    [[], 'Đã suy nghĩ 1 bước'],
  ]
  for (const [items, label] of cases) assert.equal(summarizeWorkItems(items).label, label)
  assert.equal(summarizeWorkItems([reasoning()], 74000).label, 'Đã suy nghĩ trong 1m 14s')
  assert.equal(summarizeWorkItems([text('note')], 0).label, 'Đã xử lý trong <1s')
  assert.equal(summarizeWorkItems([tool('hidden', 'todowrite')]).stepCount, 0)
  assert.equal(summarizeWorkItems([reasoning()], NaN).label, 'Đã suy nghĩ 1 bước')
})

test('compact QA summaries leave subagent counts to the trigger badge', () => {
  const agent = tool('agent', 'task')
  const read = tool('read', 'read', { target: 'README.md' })
  const edit = summarizeWorkItems([tool('edit', 'edit', { target: 'README.md' }), read, agent])
  assert.equal(edit.label, 'Đã sửa 1 tệp · đọc 1 tệp')
  assert.equal(edit.subagentCount, 1)
  const run = summarizeWorkItems([tool('run', 'shell'), read, tool('read2', 'read', { target: 'src/app.ts' }), tool('search', 'glob'), tool('search2', 'grep'), agent], 89000)
  assert.equal(run.label, 'Đã chạy 1 lệnh trong 1m 29s · đọc 2 tệp, tìm 2 lần')
  assert.equal(run.subagentCount, 1)
})

test('expanded grouping combines adjacent visible reads, splits errors and other work, and preserves references', () => {
  const r1 = tool('r1', 'read', { target: 'a' })
  const r2 = tool('r2', 'read_file', { input: { path: 'a' } })
  const r3 = tool('r3', 'view_file', { target: 'b' })
  const error = tool('error', 'read', { status: 'error', target: 'c' })
  const rows = groupExpandedWork([r1, tool('hidden', 'todowrite'), r2, r3, error, tool('r4', 'read'), reasoning(), text('note'), tool('search', 'search'), changes()])
  assert.deepEqual(rows.map(row => row.kind), ['read-group', 'tool', 'read-group', 'reasoning', 'note', 'tool'])
  assert.deepEqual(rows[0], { kind: 'read-group', id: 'r1', items: [r1, r2, r3], targets: ['a', 'b'] })
  assert.deepEqual(rows[1], { kind: 'tool', id: 'error', item: error, classification: { mode: 'explore', kind: 'read' } })
  assert.equal(rows[0].kind === 'read-group' && rows[0].items[0], r1)
  assert.deepEqual(groupExpandedWork([]), [])
})

test('expanded rows retain each non-read tool classification and never merge across notes or reasoning', () => {
  const tools = ['grep', 'edit', 'bash', 'subagent', 'skill', 'custom'].map(name => tool(name, name))
  const rows = groupExpandedWork(tools)
  assert.deepEqual(rows, tools.map(item => ({ kind: 'tool', id: item.id, item, classification: classifyTool(item.tool!.name) })))
  const interrupted = groupExpandedWork([tool('r1', 'read'), text('note'), tool('r2', 'read'), reasoning(), tool('r3', 'read')])
  assert.deepEqual(interrupted.map(row => row.kind), ['read-group', 'note', 'read-group', 'reasoning', 'read-group'])
})

test('settled compact turn folds tools, reasoning, and commentary but leaves final answer and changes', () => {
  const items = [user(), text('intro'), tool('read', 'read'), reasoning(), text('progress', { phase: 'commentary' }), tool('run', 'shell'), text('answer', { phase: 'final_answer', workedMs: 52000 }), changes()]
  const [turn] = compact(items)
  assert.equal(turn.id, 'user')
  assert.equal(turn.user, items[0])
  assert.equal(turn.live, false)
  assert.deepEqual(turn.blocks.map(block => block.kind), ['work-group', 'text', 'changes'])
  const group = work(turn.blocks[0])
  assert.equal(group.id, 'user:work')
  assert.equal(group.defaultOpen, false)
  assert.equal(group.live, false)
  assert.equal(group.workedMs, 52000)
  assert.deepEqual(group.items.map(item => item.id), ['intro', 'read', 'reasoning', 'progress', 'run'])
  assert.equal(turn.blocks[1].id, 'answer')
})

test('settled fallback promotes last nonempty commentary text, including text before tools', () => {
  for (const items of [
    [user(), text('only', { phase: 'commentary' }), tool('run', 'shell')],
    [user(), text('early'), tool('read', 'read'), text('only', { phase: 'commentary' }), tool('run', 'shell'), text('blank', { text: '  ' })],
    [user(), text('only', { phase: 'commentary' })],
  ]) {
    const [turn] = compact(items)
    const answers = turn.blocks.filter(block => block.kind === 'text')
    assert.deepEqual(answers.map(block => block.id), ['only'])
    assert.ok(!turn.blocks.some(block => block.kind === 'work-group' && block.items.some(item => item.id === 'only')))
  }
})

test('explicit final answer survives before later work; hidden tools never change commentary or summaries', () => {
  const [turn] = compact([user(), text('answer', { phase: 'final_answer' }), tool('run', 'shell'), text('comment', { phase: 'commentary' }), tool('hidden', 'todowrite', { status: 'error' })])
  assert.deepEqual(blockItems(turn.blocks), ['run', 'comment', 'answer'])
  const [hiddenOnly] = compact([user(), text('answer'), tool('hidden', 'todowrite')])
  assert.deepEqual(hiddenOnly.blocks.map(block => block.kind), ['text'])
})

test('live compact folds prior completed work and surfaces active tools, errors, final text, and status', () => {
  const [turn] = compact([user(), text('intro'), tool('read', 'read'), reasoning(), tool('running', 'shell', { status: 'running', input: { command: 'npm run build' } }), tool('error', 'edit', { status: 'error' }), text('stream', { phase: 'final_answer' })])
  assert.equal(turn.live, true)
  assert.deepEqual(turn.blocks.map(block => block.kind), ['work-group', 'active-tools', 'text', 'live-status'])
  const group = work(turn.blocks[0])
  assert.deepEqual(group.items.map(item => item.id), ['intro', 'read', 'reasoning'])
  assert.equal(group.defaultOpen, false)
  assert.equal(group.live, true)
  assert.equal(group.workedMs, undefined)
  assert.deepEqual(turn.blocks[1].kind === 'active-tools' && turn.blocks[1].items.map(item => item.id), ['running', 'error'])
  assert.deepEqual(turn.blocks.at(-1), { kind: 'live-status', id: 'user:status', label: 'Đang chạy npm run build…' })
})

test('live tail reasoning and late commentary stay inline, with no settled-answer promotion', () => {
  const [thinking] = compact([user(), tool('done', 'read'), reasoning()], true)
  assert.deepEqual(thinking.blocks.map(block => block.kind), ['work-group', 'reasoning', 'live-status'])
  assert.deepEqual(thinking.blocks.at(-1), { kind: 'live-status', id: 'user:status', label: 'Đang suy nghĩ…' })
  const [late] = compact([user(), text('prior'), tool('done', 'read'), text('late', { phase: 'commentary' })], true)
  assert.deepEqual(late.blocks.map(block => block.kind), ['work-group', 'text', 'live-status'])
  assert.equal(late.blocks[1].id, 'late')
  const [active] = compact([user(), tool('run', 'bash', { status: 'streaming' }), text('late', { phase: 'commentary' }), reasoning('live-thought')])
  assert.deepEqual(active.blocks.map(block => block.kind), ['active-tools', 'text', 'reasoning', 'live-status'])
})

test('live commentary after active work is not collapsed even when more active tools follow', () => {
  const [turn] = compact([user(), tool('active', 'shell', { status: 'running' }), text('late', { phase: 'commentary' }), tool('active2', 'read', { status: 'running' }), tool('completed-late', 'grep')])
  assert.deepEqual(turn.blocks.map(block => block.kind), ['active-tools', 'text', 'active-tools', 'tool', 'live-status'])
  assert.deepEqual(blockItems(turn.blocks), ['active', 'late', 'active2', 'completed-late'])
})

test('live status describes each active category, while errors alone do not imply a live turn', () => {
  const cases = [
    ['read', 'Đang đọc'], ['grep', 'Đang tìm kiếm'], ['skill', 'Đang nạp skill'],
    ['edit', 'Đang sửa'], ['shell', 'Đang chạy'], ['task', 'Đang chạy tác vụ con'], ['custom', 'Đang dùng công cụ'],
  ]
  for (const [name, verb] of cases) {
    const [turn] = compact([user(), tool('active', name, { status: 'streaming', target: 'target' })])
    assert.equal(turn.live, true)
    assert.deepEqual(turn.blocks.at(-1), { kind: 'live-status', id: 'user:status', label: `${verb} target…` })
  }
  assert.equal(compact([user(), tool('error', 'shell', { status: 'error' })])[0].live, false)
})

test('only the last turn can be live; leading assistant and consecutive user turns remain intact', () => {
  const items = [text('leading'), tool('old-active', 'shell', { status: 'running' }), user('u1'), user('u2'), text('answer')]
  const turns = compact(items, true)
  assert.deepEqual(turns.map(turn => [turn.id, turn.live, turn.user?.id]), [['leading', false, undefined], ['u1', false, 'u1'], ['u2', true, 'u2']])
  assert.deepEqual(turns[1].blocks, [])
  assert.deepEqual(compact([]), [])
  assert.deepEqual(compact([user()], true)[0].blocks, [{ kind: 'live-status', id: 'user:status', label: 'Đang xử lý…' }])
})

test('detailed and everything preserve source order including commentary, final text, changes, and errors', () => {
  const items = [user(), text('intro'), tool('read', 'read'), reasoning(), tool('hidden', 'todowrite'), text('comment', { phase: 'commentary' }), tool('error', 'shell', { status: 'error' }), changes('early-changes'), text('answer'), changes()]
  const expectedIds = items.slice(1).filter(item => item.id !== 'hidden').map(item => item.id)
  const [detailed] = projectChatTimeline(items, { running: false, mode: 'detailed' })
  assert.deepEqual(detailed.blocks.map(block => block.kind), ['text', 'work-group', 'text', 'work-group', 'changes', 'text', 'changes'])
  assert.deepEqual(blockItems(detailed.blocks), expectedIds)
  assert.equal(work(detailed.blocks[1]).defaultOpen, false)
  assert.equal(work(detailed.blocks[3]).summary.errorCount, 1)
  const [everything] = projectChatTimeline(items, { running: false, mode: 'everything' })
  assert.deepEqual(everything.blocks.map(block => block.kind), ['text', 'tool', 'reasoning', 'text', 'tool', 'changes', 'text', 'changes'])
  assert.deepEqual(blockItems(everything.blocks), expectedIds)
  for (const mode of ['detailed', 'everything'] as const) {
    const [live] = projectChatTimeline(items, { running: true, mode })
    assert.deepEqual(blockItems(live.blocks), expectedIds)
    assert.equal(live.blocks.at(-1)?.kind, 'live-status')
  }
})

test('detailed and everything retain empty text items rather than reordering their neighboring work', () => {
  const items = [user(), tool('read', 'read'), text('blank', { text: '' }), tool('run', 'shell')]
  for (const mode of ['detailed', 'everything'] as const) {
    assert.deepEqual(blockItems(projectChatTimeline(items, { running: false, mode })[0].blocks), ['read', 'blank', 'run'])
  }
})

test('worked duration honors latest explicit metadata, then user interval, assistant interval, and tool sums', () => {
  const cases: [ChatItem[], number | undefined][] = [
    [[user('u', { createdAt: 0 }), tool('t', 'read', { durationMs: 9999 }), text('a', { workedMs: 4000 }), text('b', { workedMs: 0, completedAt: 9000 })], 0],
    [[user('u', { createdAt: 1000 }), tool('t', 'read', { durationMs: 9999 }), text('a', { completedAt: 6000, createdAt: 2000 })], 5000],
    [[user('u', { createdAt: 1000 }), tool('t', 'read'), text('a', { createdAt: 3000 })], 2000],
    [[user('u', { createdAt: 1000 }), tool('t', 'read'), text('a', { createdAt: 1000 })], 0],
    [[user('u', { createdAt: 8000 }), text('a', { createdAt: 2000 }), tool('t', 'read', { durationMs: 9999 }), text('b', { createdAt: 3000, completedAt: 5000 })], 3000],
    [[user(), text('a', { createdAt: 5000 }), tool('t', 'read', { durationMs: 9999 }), text('b', { createdAt: 1000, completedAt: 6000 })], 5000],
    [[user(), tool('t', 'read', { durationMs: 800 }), tool('s', 'shell', { durationMs: 1200 }), tool('negative', 'grep', { durationMs: -50 }), text('a')], 2000],
    [[user(), tool('t', 'read'), text('a')], undefined],
  ]
  for (const [items, expected] of cases) assert.equal(work(compact(items)[0].blocks[0]).workedMs, expected)
})

test('projection and helpers do not mutate frozen source arrays, items, tools, or metadata', () => {
  const items = [user(), text('intro'), tool('read', 'read', { target: 'file' }), reasoning(), text('final'), changes()]
  for (const item of items) {
    if (item.tool) Object.freeze(item.tool)
    if (item.turn) { Object.freeze(item.turn.files); Object.freeze(item.turn) }
    Object.freeze(item)
  }
  Object.freeze(items)
  for (const mode of ['compact', 'detailed', 'everything'] as const) for (const running of [false, true]) {
    assert.doesNotThrow(() => projectChatTimeline(items, { mode, running }))
  }
  assert.doesNotThrow(() => summarizeWorkItems(items))
  assert.doesNotThrow(() => groupExpandedWork(items))
})
