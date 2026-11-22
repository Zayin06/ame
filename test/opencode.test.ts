import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeAdapter, localURL, normalizeMessages } from '../packages/opencode-adapter/src/index'
import type { IdeEvent } from '../packages/protocol/src/index'
import type { SessionMessageInfo } from '@opencode/client'

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
