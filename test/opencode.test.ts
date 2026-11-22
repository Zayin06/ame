import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeAdapter, localURL, normalizeMessages } from '../packages/opencode-adapter/src/index'
import type { IdeEvent } from '../packages/protocol/src/index'
import type { SessionInfo, SessionMessageInfo } from '@opencode/client'
import { aggregateUsageTree, emptyTokens } from '../packages/amekit/src/usage'
import type { UsagePrices } from '../packages/amekit/src/usage-pricing'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)) }; throw new Error('TIMED_OUT') }
test('only local origins accepted; unsupported server does not attach', async () => {
  for (const url of ['https://example.com', 'http://user:pass@localhost:4096', 'http://localhost:4096/api', 'http://localhost:4096/?token=x', 'http://192.168.1.5']) assert.throws(() => localURL(url), /LOCAL_SERVER_REQUIRED/)
  const adapter = new OpenCodeAdapter(() => {}, async () => json({ version: '1.0.0' }))
  await assert.rejects(adapter.connect('http://localhost:4096'), /UNSUPPORTED_SERVER_VERSION/)
  assert.equal(adapter.connection().connected, false)
})
test('real SDK requests use location, main-only auth, session binding, prompt and permissions', async () => {
  const calls: { url: URL; init: RequestInit }[] = []
  const directory = process.cwd()
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n')); init.signal?.addEventListener('abort', () => { try { c.close() } catch {} }) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname.endsWith('/permission/p1/reply')) return new Response(null, { status: 204 })
    if (url.pathname.endsWith('/permission')) return json({ data: [{ id: 'p1', sessionID: 's1', action: 'edit', resources: ['a.ts'] }] })
    if (url.pathname === '/api/session/s1') return json({ data: { id: 's1', location: { directory } } })
    if (url.pathname === '/api/session/foreign') return json({ data: { id: 'foreign', location: { directory: 'C:\\other-project' } } })
    if (url.pathname === '/api/model') return json({ data: [{ id: 'server-model-id', modelID: 'catalog-id', providerID: 'amecode', name: 'Model' }] })
    if (url.pathname === '/api/session') return json({ data: [{ id: 's1', title: 'Hello' }], cursor: {} })
    if (url.pathname.endsWith('/model')) return new Response(null, { status: 204 })
    if (url.pathname.endsWith('/prompt')) return json({ data: { id: 'inbox1' } })
    if (url.pathname.endsWith('/interrupt')) return json({ data: {} })
    if (url.pathname.endsWith('/message')) return json({ data: [{ id: 'u1', type: 'user', text: 'Hello' }], cursor: {} })
    throw new Error('Unexpected ' + url.pathname)
  }
  const adapter = new OpenCodeAdapter(() => {}, fetcher)
  adapter.attach('project', directory)
  try {
    await adapter.connect('http://localhost:4096', 'opencode', 'private-password')
    assert.equal((await adapter.sessions('project'))[0].title, 'Hello')
    assert.equal(calls.find(c => c.url.pathname === '/api/session')!.url.searchParams.get('directory'), directory)
    await assert.rejects(adapter.messages('project', 'foreign'), /SESSION_PROJECT_MISMATCH/)
    assert.equal((await adapter.messages('project', 's1'))[0].text, 'Hello')
    const model = (await adapter.models('project'))[0]
    assert.equal(model.modelID, 'catalog-id')
    await adapter.prompt('project', 's1', 'test', model)
    assert.deepEqual(JSON.parse(String(calls.find(c => c.url.pathname === '/api/session/s1/model')!.init.body)).model, { id: 'server-model-id', providerID: 'amecode' })
    assert.equal((await adapter.permissions('project', 's1'))[0].title, 'edit: a.ts')
    await adapter.replyPermission('project', 'p1', 'once')
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Basic ' + Buffer.from('opencode:private-password').toString('base64'))
    assert.ok(!JSON.stringify(adapter.connection()).includes('private-password'))
  } finally { adapter.dispose() }
})
test('detaching a project rejects its API access and stops its event routing without disconnecting other projects', async () => {
  const notifications: IdeEvent[] = []
  const directory = process.cwd(), otherDirectory = directory + '-other'
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const adapter = new OpenCodeAdapter(event => notifications.push(event), async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/session') return json({ data: [{ id: 's1', title: 'Kept' }], cursor: {} })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      stream = controller
      init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    throw new Error('Unexpected ' + url.pathname)
  })
  const send = (event: unknown) => stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
  adapter.attach('removed', directory); adapter.attach('kept', otherDirectory)
  try {
    await adapter.connect('http://localhost:4096')
    await waitFor(() => !!stream)
    send({ type: 'server.connected' })
    await waitFor(() => notifications.some(event => event.type === 'opencode' && event.projectID === 'removed'))
    adapter.detach('removed'); adapter.detach('removed')
    notifications.length = 0
    await assert.rejects(adapter.sessions('removed'), /UNKNOWN_PROJECT/)
    await assert.rejects(adapter.createSession('removed'), /UNKNOWN_PROJECT/)
    await assert.rejects(adapter.models('removed'), /UNKNOWN_PROJECT/)
    assert.equal((await adapter.sessions('kept'))[0].title, 'Kept')
    send({ type: 'session.text.delta', location: { directory }, data: { sessionID: 's1', assistantMessageID: 'a1', ordinal: 0, delta: 'Ignored' } })
    send({ type: 'server.connected' })
    await waitFor(() => notifications.some(event => event.type === 'opencode' && event.projectID === 'kept'))
    assert.equal(notifications.some(event => event.type === 'opencode' && event.projectID === 'removed'), false)
    assert.equal(adapter.connection().connected, true)
  } finally { adapter.dispose() }
})

test('SSE deltas render before persistence and reconnect resyncs history', async () => {
  const notifications: IdeEvent[] = []; let connections = 0
  const directory = process.cwd()
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/session/s1') return json({ data: { id: 's1', location: { directory } } })
    if (url.pathname.endsWith('/message')) return json({ data: [], cursor: {} })
    if (url.pathname === '/api/event') {
      connections++
      const events = connections === 1 ? [{ type: 'server.connected' }, { type: 'session.text.delta', location: { directory }, data: { sessionID: 's1', assistantMessageID: 'a1', ordinal: 0, delta: 'Streamed' } }] : [{ type: 'server.connected' }]
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')))
        if (connections === 1) setTimeout(() => controller.close(), 100)
        else init.signal?.addEventListener('abort', () => { try { controller.close() } catch {} })
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error('Unexpected ' + url.pathname)
  }
  const adapter = new OpenCodeAdapter(e => notifications.push(e), fetcher); adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    await waitFor(() => notifications.some(e => e.type === 'opencode' && e.sessionID === 's1'))
    assert.equal((await adapter.messages('p', 's1'))[0].text, 'Streamed')
    await waitFor(() => connections >= 2 && notifications.filter(e => e.type === 'opencode' && !e.sessionID).length >= 2)
    assert.deepEqual(await adapter.messages('p', 's1'), [])
  } finally { adapter.dispose() }
})
test('session changes use snapshot ranges, not the latest-turn default or Git', async () => {
  const calls: URL[] = []; const directory = process.cwd()
  let empty = false, rejected = false
  const files = [{ file: 'session-only.ts', patch: '', additions: 2, deletions: 0, status: 'added' }]
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push(url)
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1') return json({ data: { id: 's1', location: { directory } } })
    if (url.pathname === '/api/session/foreign') return json({ data: { id: 'foreign', location: { directory: 'C:\\other-project' } } })
    if (url.pathname.endsWith('/message')) return json({ data: empty ? [] : [{ id: url.searchParams.get('order') === 'asc' ? 'first-user' : 'last-user' }], cursor: { next: 'older-history' } })
    if (url.pathname.endsWith('/diff')) return rejected ? json({ name: 'TurnRangeError', message: 'location changed' }, 400) : json({ data: files })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    assert.deepEqual(await adapter.sessionDiff('p', 's1'), files)
    const bounds = calls.filter(url => url.pathname.endsWith('/message'))
    assert.equal(bounds.length, 2)
    for (const url of bounds) { assert.equal(url.searchParams.get('type'), 'user'); assert.equal(url.searchParams.get('limit'), '1') }
    const whole = calls.find(url => url.pathname.endsWith('/diff'))!
    assert.equal(whole.searchParams.get('from'), 'first-user'); assert.equal(whole.searchParams.get('to'), 'last-user')
    calls.length = 0
    await adapter.sessionDiff('p', 's1', 'turn-opener')
    assert.equal(calls.some(url => url.pathname.endsWith('/message')), false)
    const turn = calls.find(url => url.pathname.endsWith('/diff'))!
    assert.equal(turn.searchParams.get('from'), 'turn-opener'); assert.equal(turn.searchParams.has('to'), false)
    calls.length = 0; empty = true
    assert.deepEqual(await adapter.sessionDiff('p', 's1'), [])
    assert.equal(calls.some(url => url.pathname.endsWith('/diff')), false)
    await assert.rejects(adapter.sessionDiff('p', 'foreign'), /SESSION_PROJECT_MISMATCH/)
    empty = false; rejected = true
    await assert.rejects(adapter.sessionDiff('p', 's1'))
  } finally { adapter.dispose() }
})

test('completed turns follow native idle/snapshot boundaries, including steered prompts', () => {
  const items = normalizeMessages([
    { id: 'u1', type: 'user', text: 'first' },
    { id: 'a1', type: 'assistant', snapshot: { files: ['z.ts', 'a.ts'] }, content: [] },
    { id: 'steer', type: 'user', text: 'steer' },
    { id: 'a2', type: 'assistant', snapshot: { files: ['a.ts'] }, content: [] },
    { id: 'idle1', type: 'idle' },
    { id: 'u2', type: 'user', text: 'second' },
    { id: 'a3', type: 'assistant', snapshot: { files: ['b.ts'] }, content: [] },
    { id: 'idle2', type: 'idle' },
    { id: 'u3', type: 'user', text: 'no changes' }, { id: 'idle3', type: 'idle' },
    { id: 'u4', type: 'user', text: 'still running' },
    { id: 'a4', type: 'assistant', snapshot: { files: ['pending.ts'] }, content: [] },
  ] as SessionMessageInfo[])
  assert.deepEqual(items.filter(item => item.turn).map(item => item.turn), [{ from: 'u1', files: ['a.ts', 'z.ts'] }, { from: 'u2', files: ['b.ts'] }])
  assert.equal(items[2].id, 'idle1:changes')
})

test('history normalizes reasoning and tool state without rendering HTML', () => {
  const items = normalizeMessages([{ id: 'u', type: 'user', text: '<script>not markup</script>' }, { id: 'a', type: 'assistant', content: [{ type: 'reasoning', text: 'Thinking' }, { type: 'tool', name: 'edit', state: { status: 'completed' } }] }] as SessionMessageInfo[])
  assert.equal(items[0].text, '<script>not markup</script>')
  assert.equal(items[1].kind, 'reasoning'); assert.equal(items[2].text, 'edit · completed')
})

test('tool metadata preserves inputs, text and file output, errors and execution timing', () => {
  const states = [
    { status: 'streaming', input: '{"file"' },
    { status: 'running', input: { file: 'a.ts' } },
    { status: 'completed', input: { file: 'a.ts' }, content: [
      { type: 'text', text: 'Updated' },
      { type: 'file', name: 'a.ts', uri: 'file:///a.ts' },
      { type: 'file', uri: 'file:///b.ts' },
    ] },
    { status: 'error', input: {}, error: { type: 'ToolError', message: 'Denied' }, content: [{ type: 'text', text: 'Partial output' }] },
    { status: 'error', input: {}, error: 'String error' },
    { status: 'error', input: {}, error: { type: 'Unknown' } },
    { status: 'completed', input: {}, content: [] },
  ]
  const items = normalizeMessages([{ id: 'a', type: 'assistant', content: states.map((state, i) => ({
    type: 'tool', name: 'edit', state,
    time: i === 2 ? { created: 10, ran: 20, completed: 55 } : i === 3 ? { created: 10, completed: 25 } : { created: 10, completed: 5 },
  })) }] as SessionMessageInfo[])
  assert.deepEqual(items[2], {
    id: 'a:2', role: 'assistant', kind: 'tool', text: 'edit · completed',
    tool: { name: 'edit', status: 'completed', input: { file: 'a.ts' }, output: 'Updated\n[file: a.ts]\n[file: file:///b.ts]', error: undefined, durationMs: 35 },
  })
  assert.equal(items[0].tool?.status, 'streaming')
  assert.equal(items[0].tool?.input, '{"file"')
  assert.deepEqual(items[1].tool?.input, { file: 'a.ts' })
  assert.equal(items[1].tool?.status, 'running')
  assert.equal(items[1].tool?.durationMs, 0)
  assert.equal(items[1].tool?.output, undefined)
  assert.equal(items[3].tool?.error, 'Denied')
  assert.equal(items[3].tool?.output, 'Partial output')
  assert.equal(items[3].tool?.durationMs, 15)
  assert.equal(items[4].tool?.error, 'String error')
  assert.equal(items[5].tool?.error, '{"type":"Unknown"}')
  assert.equal(items[6].tool?.output, undefined)
})

test('tool output is bounded including its truncation suffix and preserves Unicode boundaries', () => {
  const suffix = '\n…[truncated]'
  const normalize = (content: unknown[], time?: unknown) => normalizeMessages([{ id: 'a', type: 'assistant', content: [
    { type: 'tool', name: 'read', state: { status: 'completed', input: {}, content }, time },
  ] }] as SessionMessageInfo[])[0].tool!
  const exact = 'a'.repeat(65536)
  assert.equal(normalize([{ type: 'text', text: exact }]).output, exact)
  const truncated = normalize([{ type: 'text', text: exact + 'b' }])
  assert.equal(truncated.output, 'a'.repeat(65536 - suffix.length) + suffix)
  assert.equal(truncated.output!.length, 65536)
  assert.equal(truncated.durationMs, undefined)
  const split = normalize([{ type: 'text', text: 'a'.repeat(65536 - suffix.length - 1) + '😀' + exact }]).output!
  assert.ok(split.endsWith(suffix))
  assert.ok(split.length <= 65536)
  assert.equal(split.charAt(split.length - suffix.length - 1), 'a')
  const combined = normalize([{ type: 'text', text: exact }, { type: 'file', uri: 'file:///extra' }]).output!
  assert.equal(combined, truncated.output)
  assert.equal(normalize([{ type: 'text', text: '' }]).output, undefined)
})

test('session mutations enforce ownership, validate titles and clean deleted live history; catalogs use project location', async () => {
  const calls: { url: URL; init: RequestInit }[] = []
  const directory = process.cwd()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let deleted = false, failDelete = false, delivered = false
  const adapter = new OpenCodeAdapter(event => { if (event.type === 'opencode' && event.sessionID === 's1') delivered = true }, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) {
      stream = c; init.signal?.addEventListener('abort', () => c.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1' || url.pathname === '/api/session/foreign') {
      if (init.method === 'PATCH') return new Response(null, { status: 204 })
      if (init.method === 'DELETE') {
        if (failDelete) return json({ name: 'UnknownError', message: 'Delete failed' }, 500)
        deleted = true; return new Response(null, { status: 204 })
      }
      return json({ data: { id: 's1', location: { directory: url.pathname.endsWith('foreign') ? directory + '-other' : directory } } })
    }
    if (url.pathname.endsWith('/message')) return json({ data: [], cursor: {} })
    if (url.pathname === '/api/command') return json({ data: [{ name: 'review', description: 'Review changes', ignored: true }, { name: 'compact' }] })
    if (url.pathname === '/api/skill') return json({ data: [{ id: 'skill1', name: 'testing', description: 'Run tests', path: directory, content: 'Not forwarded' }] })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    await waitFor(() => !!stream)
    for (const mutation of [
      () => adapter.renameSession('p', 'foreign', 'Title'),
      () => adapter.archiveSession('p', 'foreign', true),
      () => adapter.deleteSession('p', 'foreign'),
    ]) await assert.rejects(mutation(), /SESSION_PROJECT_MISMATCH/)
    for (const title of ['', '  \n ', 'a'.repeat(501)]) await assert.rejects(adapter.renameSession('p', 's1', title), /INVALID_SESSION_TITLE/)
    assert.equal(calls.some(c => c.init.method === 'PATCH' || c.init.method === 'DELETE'), false)
    await adapter.renameSession('p', 's1', '  New title \n')
    await adapter.renameSession('p', 's1', 'a'.repeat(500))
    await adapter.archiveSession('p', 's1', true)
    await adapter.archiveSession('p', 's1', false)
    assert.deepEqual(calls.filter(c => c.init.method === 'PATCH').map(c => JSON.parse(String(c.init.body))), [
      { title: 'New title' }, { title: 'a'.repeat(500) }, { archived: true }, { archived: false },
    ])
    assert.deepEqual(await adapter.commands('p'), [{ name: 'review', description: 'Review changes' }, { name: 'compact', description: undefined }])
    assert.deepEqual(await adapter.skills('p'), [{ id: 'skill1', name: 'testing', description: 'Run tests', path: directory }])
    for (const route of ['/api/command', '/api/skill']) assert.equal(calls.find(c => c.url.pathname === route)!.url.searchParams.get('location[directory]'), directory)
    await assert.rejects(adapter.commands('missing'), /UNKNOWN_PROJECT/)
    await assert.rejects(adapter.skills('missing'), /UNKNOWN_PROJECT/)
    stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.text.delta', data: { sessionID: 's1', assistantMessageID: 'a', ordinal: 0, delta: 'Live' } })}\n\n`))
    await waitFor(() => delivered)
    assert.equal((await adapter.messages('p', 's1'))[0].text, 'Live')
    failDelete = true
    await assert.rejects(adapter.deleteSession('p', 's1'))
    assert.equal((await adapter.messages('p', 's1'))[0].text, 'Live')
    failDelete = false
    await adapter.deleteSession('p', 's1')
    assert.equal(deleted, true)
    assert.deepEqual(await adapter.messages('p', 's1'), [])
  } finally { adapter.dispose() }
})

test('persisted tool metadata wins over colliding live text while longer text deltas still merge', async () => {
  const directory = process.cwd()
  let delivered = 0
  const adapter = new OpenCodeAdapter(event => { if (event.type === 'opencode' && event.sessionID) delivered++ }, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/session/s1') return json({ data: { location: { directory } } })
    if (url.pathname.endsWith('/message')) return json({ data: [{ id: 'a', type: 'assistant', content: [
      { type: 'tool', name: 'read', time: { created: 1, completed: 5 }, state: { status: 'completed', input: { path: 'a.ts' }, content: [{ type: 'text', text: 'File contents' }] } },
      { type: 'text', text: 'Saved' },
    ] }], cursor: {} })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) {
      const events = [0, 1].map(ordinal => ({ type: 'session.text.delta', data: { sessionID: 's1', assistantMessageID: 'a', ordinal, delta: 'A longer live text that must not erase a tool' } }))
      c.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
      init.signal?.addEventListener('abort', () => c.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    await waitFor(() => delivered === 2)
    const items = await adapter.messages('p', 's1')
    assert.equal(items[0].text, 'read · completed')
    assert.equal(items[0].kind, 'tool')
    assert.deepEqual(items[0].tool, { name: 'read', status: 'completed', input: { path: 'a.ts' }, output: 'File contents', error: undefined, durationMs: 4 })
    assert.equal(items[1].text, 'A longer live text that must not erase a tool')
  } finally { adapter.dispose() }
})

test('commit generation sends staged context and selected model, strips fences, rejects empty output and preserves truncation', async () => {
  const calls: { url: URL; init: RequestInit }[] = []
  let output = '  ```text\nfeat: improve tools\n\n- Preserve metadata\n```  '
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/experimental/generate/text') return json({ data: { text: output } })
    throw new Error('Unexpected ' + url.pathname)
  })
  const model = { id: 'server-model', modelID: 'catalog-model', providerID: 'amecode', name: 'Model' }
  try {
    await adapter.connect('http://localhost:4096')
    assert.deepEqual(await adapter.generateCommitMessage({ diff: '+new behavior', files: ['a.ts', 'b.ts'], truncated: true }, model), { message: 'feat: improve tools\n\n- Preserve metadata', truncated: true })
    const call = calls.find(c => c.url.pathname === '/api/experimental/generate/text')!
    assert.equal(call.init.method, 'POST')
    const body = JSON.parse(String(call.init.body))
    assert.deepEqual(body.model, { id: 'server-model', providerID: 'amecode' })
    for (const expected of ['Conventional Commits', '72 characters', '3 short bullets', 'only the commit message', 'without markdown fences', 'a.ts\nb.ts', '+new behavior']) assert.ok(body.prompt.includes(expected), expected)
    assert.ok(call.init.signal instanceof AbortSignal)
    assert.equal(call.init.signal.aborted, false)
    output = '  fix: keep plain messages  '
    assert.deepEqual(await adapter.generateCommitMessage({ diff: '', files: [], truncated: false }, model), { message: 'fix: keep plain messages', truncated: false })
    for (output of ['  \n ', '```\n\n```', '```text\n```']) await assert.rejects(adapter.generateCommitMessage({ diff: '', files: [], truncated: false }, model), /EMPTY_COMMIT_MESSAGE/)
  } finally { adapter.dispose() }
})

const usageSession = (id: string, parentID?: string): SessionInfo => ({
  id, parentID, projectID: 'p', title: id, location: { directory: process.cwd() },
  time: { created: 0, updated: 1 }, cost: 999, tokens: emptyTokens(),
})
const usageMessage = (id: string): SessionMessageInfo => ({
  id, type: 'assistant', agent: 'coder', model: { id: 'model', providerID: 'amecode' }, content: [],
  tokens: { ...emptyTokens(), input: 100, output: 20 }, time: { created: 0, completed: 10 },
})
async function usageHarness(sessions: SessionInfo[], histories: Record<string, { data: SessionMessageInfo[]; cursor: { next?: string } }> = {}) {
  const lists: URL[] = [], messages: { url: URL; init: RequestInit }[] = []
  let active = 0, peak = 0, repeated = false
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) {
      init.signal?.addEventListener('abort', () => c.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session') {
      lists.push(url)
      const offset = Number(url.searchParams.get('cursor') || 0)
      return json({ data: sessions.slice(offset, offset + 100), cursor: {
        next: repeated ? '100' : offset + 100 < sessions.length ? String(offset + 100) : null,
      } })
    }
    const match = /^\/api\/session\/([^/]+)(\/message)?$/.exec(url.pathname)
    if (match?.[2]) {
      messages.push({ url, init }); active++; peak = Math.max(peak, active)
      await new Promise(resolve => setImmediate(resolve))
      active--
      return json(histories[match[1]] ?? { data: [], cursor: {} })
    }
    if (match) return json({ data: match[1] === 'foreign' ? {
      ...usageSession('foreign'), location: { directory: process.cwd() + '-other' },
    } : sessions.find(session => session.id === match[1]) ?? usageSession(match[1]) })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', process.cwd())
  await adapter.connect('http://localhost:4096')
  return { adapter, lists, messages, peak: () => peak, repeat: () => { repeated = true } }
}

test('sessionUsage paginates a four-level subagent family, reverses history and preserves pricing and partial flags', async t => {
  const sessions = [usageSession('L0'), usageSession('L1', 'L0'),
    ...Array.from({ length: 99 }, (_, index) => usageSession(`unrelated-${index}`)),
    usageSession('L2', 'L1'), usageSession('L3', 'L2')]
  sessions[1].fork = { sessionID: 'L0', boundary: { type: 'through', messageID: 'boundary' } }
  const prices: UsagePrices = { model: {
    model_id: 'catalog-model', upstream_model_id: 'model', provider_route: 'amecode', status: 'priced',
    price_kind: 'catalog_estimate', currency: 'USD', unit: 'per_1m_tokens', source: { id: 'catalog', source_model_id: 'model' },
    profiles: { standard: { base: { input: '1', output: '2' }, overrides: [] } }, revision: 1,
  } }
  const h = await usageHarness(sessions, {
    L0: { data: [usageMessage('root')], cursor: {} },
    L1: { data: [usageMessage('own'), usageMessage('boundary'), usageMessage('inherited')], cursor: { next: 'older' } },
    L2: { data: [usageMessage('child')], cursor: {} },
    L3: { data: [usageMessage('grandchild')], cursor: {} },
  })
  t.after(() => h.adapter.dispose())
  const result = await h.adapter.sessionUsage('p', 'L0', prices, 'https://usage.example')
  assert.equal(result.origin, 'https://usage.example')
  assert.equal(result.limited, false)
  assert.deepEqual(result.nodes.map(node => [node.id, node.depth, node.parentID]), [
    ['L0', 0, undefined], ['L1', 1, 'L0'], ['L2', 2, 'L1'], ['L3', 3, 'L2'],
  ])
  assert.deepEqual(h.lists.map(url => url.searchParams.get('cursor')), [null, '100'])
  for (const url of h.lists) {
    assert.equal(url.searchParams.get('directory'), process.cwd())
    assert.equal(url.searchParams.get('archived'), 'false')
    assert.equal(url.searchParams.get('limit'), '100')
  }
  for (const { url, init } of h.messages) {
    assert.equal(url.searchParams.get('limit'), '200')
    assert.equal(url.searchParams.get('order'), 'desc')
    assert.ok(init.signal instanceof AbortSignal)
  }
  assert.equal(h.messages.length, 4, 'history is bounded to one page per family node')
  assert.equal(result.nodes[0].partial, false)
  assert.equal(result.nodes[1].partial, true)
  assert.equal(result.nodes[1].groups[0].requests, 1, 'fork excludes inherited messages after chronological reversal')
  const total = aggregateUsageTree(result.nodes)
  assert.equal(total.tokens.input, 400)
  assert.equal(total.tokens.output, 80)
  assert.equal(total.priced, 4)
  assert.ok(Math.abs(total.knownCost - 0.00056) < 1e-12, 'uses safe prices rather than reported legacy cost')
  h.messages.length = 0; h.lists.length = 0
  await assert.rejects(h.adapter.sessionUsage('p', 'foreign', prices, null), /SESSION_PROJECT_MISMATCH/)
  assert.equal(h.messages.length, 0)
  assert.equal(h.lists.length, 0, 'ownership is checked before listing any history')
  h.repeat()
  await assert.rejects(h.adapter.sessionUsage('p', 'L0', prices, null), /SESSION_CURSOR_REPEATED/)
  assert.equal(h.messages.length, 0)
})

test('sessionUsage limits large families to 200 ordered nodes with at most six concurrent histories', async t => {
  const sessions = [usageSession('root'), ...Array.from({ length: 204 }, (_, index) => usageSession(`child-${index}`, 'root'))]
  const h = await usageHarness(sessions)
  t.after(() => h.adapter.dispose())
  const result = await h.adapter.sessionUsage('p', 'root', {}, null)
  assert.equal(result.origin, null)
  assert.equal(result.limited, true)
  assert.equal(result.nodes.length, 200)
  assert.deepEqual(result.nodes.map(node => node.id), sessions.slice(0, 200).map(session => session.id))
  assert.equal(h.lists.length, 3, 'all session pages are read before limiting the family')
  assert.equal(h.messages.length, 200)
  assert.equal(h.peak(), 6)
})

test('session pagination preserves nested activity and rejects repeated cursors', async () => {
  let repeated = false
  const seen: string[] = []
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session') {
      const cursor = url.searchParams.get('cursor') || ''; seen.push(cursor)
      return cursor ? json({ data: [{ id: 'child', parentID: 'root', agent: 'architect', title: 'Child', outcome: 'succeeded', time: { updated: 40, busy: 30, idle: 20 } }], cursor: { next: repeated ? 'page2' : null } }) : json({ data: [{ id: 'root', title: 'Root', outcome: 'succeeded', time: { busy: 10, idle: 20 } }], cursor: { next: 'page2' } })
    }
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', process.cwd())
  try {
    await adapter.connect('http://localhost:4096')
    const sessions = await adapter.sessions('p')
    assert.deepEqual(seen, ['', 'page2'])
    assert.equal(sessions[0].status, 'idle')
    assert.equal(sessions[1].parentID, 'root')
    assert.equal(sessions[1].status, 'running', 'new busy takes precedence over previous outcome')
    assert.equal(sessions[1].agent, 'architect')
    assert.equal(sessions[1].updatedAt, 40, 'chat activity timestamp is forwarded for project ordering')
    repeated = true
    await assert.rejects(adapter.sessions('p'), /SESSION_CURSOR_REPEATED/)
  } finally { adapter.dispose() }
})
