import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { OpenCodeAdapter, localURL, normalizeMessages, parseCompletedTodos } from '../packages/opencode-adapter/src/index'
import { SessionActivity } from '../packages/opencode-adapter/src/session-activity'
import type { IdeEvent } from '../packages/protocol/src/index'
import type { BuildNotesSummary } from '../packages/ide-core/src/git-ops'
import type { SessionInfo, SessionMessageInfo } from '@opencode/client'
import { aggregateUsageTree, emptyTokens } from '../packages/amekit/src/usage'
import type { UsagePrices } from '../packages/amekit/src/usage-pricing'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)) }; throw new Error('TIMED_OUT') }

test('disposing the adapter aborts an acknowledged connection with a stalled prompt request', async () => {
  const directory = path.resolve('shutdown-project')
  let requestSignal: AbortSignal | null | undefined, finish!: () => void
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1') return json({ data: { location: { directory } } })
    if (url.pathname.endsWith('/prompt')) {
      requestSignal = init.signal
      return new Promise<Response>((resolve, reject) => {
        finish = () => resolve(new Response(null, { status: 204 }))
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    }
    return new Response(null, { status: 204 })
  })
  adapter.attach('p', directory)
  await adapter.connect('http://localhost:4096')
  const result = adapter.prompt('p', 's1', 'hello', { id: 'model', providerID: 'amecode', name: 'Model' }).then(() => 'completed', () => 'aborted')
  try {
    await waitFor(() => !!finish)
    adapter.dispose()
    assert.equal(requestSignal?.aborted, true)
    assert.equal(await result, 'aborted')
  } finally { finish?.(); adapter.dispose(); await result }
})

test('a newer persisted execution resets every recovery flag and invalidates old checkpoints', () => {
  const activity = new SessionActivity()
  const first = { id: 's', title: 'Session', status: 'running' as const, busyAt: 100 }
  activity.pending('s', 'permissions', ['old-permission'])
  activity.pending('s', 'forms', ['old-form'])
  activity.snapshot('s', ['old-tool'], 'working')
  activity.map(first)
  activity.accept({ id: 'completed', durable: { aggregateID: 's', seq: 1, version: 1 }, type: 'session.execution.succeeded', created: 200, data: { sessionID: 's' } })
  const kinds = ['permissions', 'forms', 'tools'] as const
  for (const kind of kinds) assert.equal(activity.needsRecovery('s', kind), false)
  const checkpoints = kinds.map(kind => activity.checkpoint('s', kind))
  const executionCurrent = activity.executionCheckpoint('s')

  const second = activity.map({ ...first, busyAt: 300, idleAt: 200 })
  assert.equal(second.status, 'running')
  assert.equal(second.activity, 'thinking')
  assert.equal(second.outcome, undefined)
  for (const kind of kinds) assert.equal(activity.needsRecovery('s', kind), true)
  for (const current of checkpoints) assert.equal(current(), false)
  assert.equal(executionCurrent(), false)
})

test('sessions recover a missed execution start after idle and reject old in-flight reconciliation', async () => {
  const calls = { permissions: 0, forms: 0, tools: 0 }
  let busy = 100, idle: number | undefined, activeCalls = 0, notifications = 0
  let stream!: ReadableStreamDefaultController<Uint8Array>, release!: (value: Response) => void
  const stale = new Promise<Response>(resolve => { release = resolve })
  const adapter = new OpenCodeAdapter(() => { notifications++ }, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      stream = controller; init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session') return json({ data: [{ id: 's', time: { busy, idle } }], cursor: {} })
    if (url.pathname === '/api/session/active') return ++activeCalls === 2 ? stale : json({ data: { s: { type: 'running' } } })
    if (url.pathname.endsWith('/permission')) { calls.permissions++; return json({ data: busy === 300 ? [{ id: 'new-permission', sessionID: 's' }] : [] }) }
    if (url.pathname.endsWith('/form')) { calls.forms++; return json({ data: [] }) }
    if (url.pathname.endsWith('/message')) { calls.tools++; return json({ data: [], cursor: {} }) }
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', process.cwd())
  try {
    await adapter.connect('http://localhost:4096')
    assert.equal((await adapter.sessions('p'))[0].activity, 'thinking')
    assert.deepEqual(calls, { permissions: 1, forms: 1, tools: 1 })
    const oldReconciliation = adapter.sessions('p')
    await waitFor(() => activeCalls === 2)
    const before = notifications
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.execution.succeeded', created: 200, data: { sessionID: 's' } })}\n\n`))
    await waitFor(() => notifications > before)
    idle = 200
    assert.equal((await adapter.sessions('p'))[0].status, 'idle')
    busy = 300 // No session.execution.started SSE for this turn.
    const second = (await adapter.sessions('p'))[0]
    assert.equal(second.status, 'running')
    assert.equal(second.activity, 'waiting')
    assert.deepEqual(calls, { permissions: 2, forms: 2, tools: 2 })
    release(json({ data: {} }))
    await oldReconciliation
    const current = (await adapter.sessions('p'))[0]
    assert.equal(current.status, 'running', 'old active response cannot mark the new execution idle')
    assert.equal(current.activity, 'waiting')
    assert.deepEqual(calls, { permissions: 2, forms: 2, tools: 2 })
  } finally { release(json({ data: {} })); adapter.dispose() }
})

test('persisted execution changes invalidate in-flight recovery before new snapshots arrive', async () => {
  let busy = 100, activeCalls = 0, recoveries = 0
  let releaseOld!: (value: Response) => void, releaseNew!: (value: Response) => void
  const oldSnapshot = new Promise<Response>(resolve => { releaseOld = resolve })
  const newActive = new Promise<Response>(resolve => { releaseNew = resolve })
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session') return json({ data: [{ id: 's', time: { busy } }], cursor: {} })
    if (url.pathname === '/api/session/active') return ++activeCalls === 2 ? newActive : json({ data: { s: { type: 'running' } } })
    if (url.pathname.endsWith('/permission') || url.pathname.endsWith('/form') || url.pathname.endsWith('/message')) {
      recoveries++
      if (busy === 100) return oldSnapshot
      return json({ data: [], cursor: {} })
    }
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', process.cwd())
  try {
    await adapter.connect('http://localhost:4096')
    const oldRecovery = adapter.sessions('p')
    await waitFor(() => recoveries === 3)
    busy = 300
    const newRecovery = adapter.sessions('p')
    await waitFor(() => activeCalls === 2)
    releaseOld(json({ data: [{ id: 'stale-prompt', sessionID: 's' }], cursor: {} }))
    assert.equal((await oldRecovery)[0].activity, 'thinking', 'old prompts must be discarded before new recovery finishes')
    releaseNew(json({ data: { s: { type: 'running' } } }))
    assert.equal((await newRecovery)[0].activity, 'thinking')
    assert.equal(recoveries, 6, 'stale snapshots must not mark new sections recovered')
  } finally { releaseOld(json({ data: [], cursor: {} })); releaseNew(json({ data: {} })); adapter.dispose() }
})

test('sessions reconcile persisted running state with live executions and safely fall back', async t => {
  for (const scenario of ['zombie', 'running', '404', 'array', 'invalid-value', 'null', 'new-execution'] as const) await t.test(scenario, async () => {
    const events: IdeEvent[] = [], recovery: string[] = []
    let stream!: ReadableStreamDefaultController<Uint8Array>, activeCalls = 0
    let release!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const adapter = new OpenCodeAdapter(event => events.push(event), async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/info') return json({ version: '2.3.2' })
      if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
        stream = controller; init.signal?.addEventListener('abort', () => controller.close())
      } }), { headers: { 'content-type': 'text/event-stream' } })
      if (url.pathname === '/api/session') return json({ data: [{ id: 's', time: { busy: 100 } }], cursor: {} })
      if (url.pathname === '/api/session/active') {
        activeCalls++
        assert.ok(init.signal)
        if (scenario === 'new-execution') return pending
        if (scenario === '404') return json({ error: 'not found' }, 404)
        return json({ data: scenario === 'running' ? { s: { type: 'running' } } : scenario === 'array' ? [] : scenario === 'invalid-value' ? { s: { type: 'idle' } } : scenario === 'null' ? null : {} })
      }
      recovery.push(url.pathname)
      if (url.pathname.endsWith('/permission')) return json({ data: [{ id: 'permission', sessionID: 's' }] })
      if (url.pathname.endsWith('/form')) return json({ data: [{ id: 'form', sessionID: 's', fields: [] }] })
      if (url.pathname.endsWith('/message')) return json({ data: [], cursor: {} })
      throw new Error('Unexpected ' + url.pathname)
    })
    const send = async (type: string, data: object) => {
      const before = events.length
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, created: 110, data: { sessionID: 's', ...data } })}\n\n`))
      await waitFor(() => events.length > before)
    }
    adapter.attach('p', process.cwd())
    try {
      await adapter.connect('http://localhost:4096')
      // Stale in-memory activity must be cleared as well as the persisted status.
      if (scenario === 'zombie') {
        await send('permission.asked', { id: 'stale-permission' })
        await send('form.created', { form: { id: 'stale-form', sessionID: 's', fields: [] } })
        await send('session.tool.called', { assistantMessageID: 'a', id: 'stale-tool' })
      }
      const result = adapter.sessions('p')
      if (scenario === 'new-execution') {
        await waitFor(() => activeCalls === 1)
        await send('session.execution.started', {})
        release(json({ data: {} }))
      }
      const session = (await result)[0]
      assert.equal(activeCalls, 1)
      assert.equal(session.status, scenario === 'zombie' ? 'idle' : 'running')
      assert.equal(session.activity, scenario === 'zombie' ? undefined : scenario === 'new-execution' ? 'thinking' : 'waiting')
      assert.equal(recovery.length, scenario === 'zombie' || scenario === 'new-execution' ? 0 : 3)
      if (scenario === 'zombie') {
        assert.ok(session.idleAt! >= 100)
        assert.equal((await adapter.sessions('p'))[0].activity, undefined)
        assert.deepEqual(recovery, [])
      }
    } finally { release(json({ data: {} })); adapter.dispose() }
  })
})

test('cancel unlocks a non-live execution, clears stale activity and notifies immediately', async t => {
  for (const interrupted of [false, true]) await t.test(String(interrupted), async () => {
    const events: IdeEvent[] = []
    const busy = Date.now() + 60_000
    let stream!: ReadableStreamDefaultController<Uint8Array>, recoveries = 0
    const adapter = new OpenCodeAdapter(event => events.push(event), async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/info') return json({ version: '2.3.2' })
      if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
        stream = controller; init.signal?.addEventListener('abort', () => controller.close())
      } }), { headers: { 'content-type': 'text/event-stream' } })
      if (url.pathname === '/api/session/s/interrupt') return json({ interrupted })
      if (url.pathname === '/api/session/s') return json({ data: { id: 's', location: { directory: process.cwd() }, time: { busy } } })
      if (url.pathname === '/api/session') return json({ data: [{ id: 's', time: { busy } }], cursor: {} })
      // Even without the live endpoint, the cancellation override must beat persisted busy.
      if (url.pathname === '/api/session/active') return json({}, 404)
      recoveries++
      return json({ data: [], cursor: {} })
    })
    adapter.attach('p', process.cwd())
    try {
      await adapter.connect('http://localhost:4096')
      for (const [type, data] of [
        ['permission.asked', { id: 'permission' }],
        ['form.created', { form: { id: 'form', sessionID: 's', fields: [] } }],
        ['session.tool.called', { assistantMessageID: 'a', id: 'tool' }],
      ] as const) {
        const before = events.length
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, created: busy, data: { sessionID: 's', ...data } })}\n\n`))
        await waitFor(() => events.length > before)
      }
      events.length = 0
      await adapter.cancel('p', 's')
      assert.deepEqual(events, interrupted ? [] : [{ type: 'opencode', projectID: 'p', sessionID: 's' }])
      const session = (await adapter.sessions('p'))[0]
      assert.equal(session.status, interrupted ? 'running' : 'idle')
      assert.equal(session.activity, interrupted ? 'waiting' : undefined)
      assert.equal(recoveries, 0)
      if (!interrupted) assert.ok(session.idleAt! >= busy)
    } finally { adapter.dispose() }
  })
})

test('recovery is independent per section and newer SSE wins over in-flight snapshots', async t => {
  for (const liveKind of ['permissions', 'forms', 'tools'] as const) await t.test(liveKind, async () => {
    const directory = process.cwd(), calls = { permissions: 0, forms: 0, tools: 0 }
    const failedKind = liveKind === 'permissions' ? 'forms' : 'permissions'
    let stream!: ReadableStreamDefaultController<Uint8Array>, notifications = 0
    let release!: (value: Response) => void
    const stale = new Promise<Response>(resolve => { release = resolve })
    const adapter = new OpenCodeAdapter(() => { notifications++ }, async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/info') return json({ version: '2.3.2' })
      if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
        stream = controller; init.signal?.addEventListener('abort', () => controller.close())
      } }), { headers: { 'content-type': 'text/event-stream' } })
      if (url.pathname === '/api/session') return json({ data: [{ id: 's', time: { busy: 100 } }], cursor: {} })
      const kind = url.pathname.endsWith('/permission') ? 'permissions' : url.pathname.endsWith('/form') ? 'forms' : url.pathname.endsWith('/message') ? 'tools' : undefined
      if (!kind) throw new Error('Unexpected ' + url.pathname)
      calls[kind]++
      if (kind === liveKind) return stale
      if (kind === failedKind && calls[kind] === 1) throw new Error('temporary failure')
      return json({ data: [], cursor: {} })
    })
    const send = async (type: string, data: object) => {
      const before = notifications
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, created: 110, data: { sessionID: 's', ...data } })}\n\n`))
      await waitFor(() => notifications > before)
    }
    adapter.attach('p', directory)
    try {
      await adapter.connect('http://localhost:4096')
      const recovery = adapter.sessions('p')
      await waitFor(() => calls[liveKind] === 1)
      if (liveKind === 'permissions') await send('permission.created', { id: 'live-permission' })
      else if (liveKind === 'forms') await send('form.created', { form: { id: 'live-form', sessionID: 's', fields: [] } })
      else await send('session.tool.called', { assistantMessageID: 'a', id: 'live-tool', input: {}, executed: false })
      release(json({ data: [], cursor: {} }))
      const expected = liveKind === 'tools' ? 'working' : 'waiting'
      assert.equal((await recovery)[0].activity, expected, 'empty stale snapshot cannot erase newer live activity')
      assert.equal((await adapter.sessions('p'))[0].activity, expected, 'retry preserves recovered sections')
      assert.deepEqual(calls, { permissions: failedKind === 'permissions' ? 2 : 1, forms: failedKind === 'forms' ? 2 : 1, tools: 1 })
      if (liveKind === 'permissions') await send('permission.replied', { requestID: 'live-permission', reply: 'once' })
      else if (liveKind === 'forms') await send('form.cancelled', { id: 'live-form' })
      else await send('session.tool.success', { assistantMessageID: 'a', id: 'live-tool', content: [] })
      assert.equal((await adapter.sessions('p'))[0].activity, 'thinking')
    } finally { release(json({ data: [], cursor: {} })); adapter.dispose() }
  })
})

test('session forms use real SDK routes, enforce ownership, and notify on all form SSE events', async () => {
  const directory = process.cwd(), events: IdeEvent[] = [], calls: { path: string; body: unknown; message: string | null }[] = []
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const form = { id: 'f', sessionID: 's', title: 'Locale', fields: [{ key: 'locale', type: 'string', options: [{ value: 'ja', label: 'Japanese' }] }] }
  const adapter = new OpenCodeAdapter(event => events.push(event), async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, message: url.searchParams.get('message') })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) { stream = controller; init.signal?.addEventListener('abort', () => controller.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s') return json({ data: { id: 's', location: { directory } } })
    if (url.pathname === '/api/session/foreign') return json({ data: { id: 'foreign', location: { directory: path.join(directory, 'foreign') } } })
    if (url.pathname === '/api/session/s/form') return json({ data: [form, { ...form, id: 'foreign-form', sessionID: 'foreign' }] })
    if (url.pathname.endsWith('/reply') || url.pathname === '/api/session/s/form/f') return new Response(null, { status: 204 })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    assert.deepEqual(await adapter.forms('p', 's'), [form])
    await adapter.replyForm('p', 's', 'f', { locale: 'ja', enabled: false, choices: ['a', 'b'] })
    await adapter.cancelForm('p', 's', 'f', 'skip')
    await adapter.cancelForm('p', 's', 'f')
    assert.deepEqual(calls.find(call => call.path.endsWith('/form/f/reply'))?.body, { answer: { locale: 'ja', enabled: false, choices: ['a', 'b'] } })
    assert.deepEqual(calls.filter(call => call.path.endsWith('/form/f')).map(call => call.message), ['skip', null])
    for (const action of [() => adapter.forms('p', 'foreign'), () => adapter.replyForm('p', 'foreign', 'f', {}), () => adapter.cancelForm('p', 'foreign', 'f'), () => adapter.forms('unknown', 's')]) await assert.rejects(action)
    const count = calls.length
    await assert.rejects(() => adapter.replyForm('p', 's', 'f', JSON.parse('{"__proto__":"bad"}')))
    assert.equal(calls.slice(count).some(call => call.path.endsWith('/reply')), false)
    events.length = 0
    for (const type of ['form.created', 'form.replied', 'form.cancelled']) {
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, location: { directory }, data: type === 'form.created' ? { form } : { id: 'f', sessionID: 's', answer: {} } })}\n\n`))
    }
    await waitFor(() => events.length === 3)
    assert.deepEqual(events, Array(3).fill({ type: 'opencode', projectID: 'p', sessionID: 's' }))
  } finally { adapter.dispose() }
})
test('only local origins accepted; unsupported server does not attach', async () => {
  for (const url of ['https://example.com', 'http://user:pass@localhost:4096', 'http://localhost:4096/api', 'http://localhost:4096/?token=x', 'http://192.168.1.5']) assert.throws(() => localURL(url), /LOCAL_SERVER_REQUIRED/)
  const adapter = new OpenCodeAdapter(() => {}, async () => json({ version: '1.0.0' }))
  await assert.rejects(adapter.connect('http://localhost:4096'), /UNSUPPORTED_SERVER_VERSION/)
  assert.equal(adapter.connection().connected, false)
})
test('reload waits for plugin activation and RPC readiness, tolerates absent plugins and bounds retries', async t => {
  for (const scenario of ['ready', 'reinitializing', 'absent', 'stalled'] as const) await t.test(scenario, async () => {
    const events: IdeEvent[] = [], calls: string[] = []
    let polls = 0, statuses = 0
    const adapter = new OpenCodeAdapter(event => events.push(event), async (input, init = {}) => {
      const url = new URL(String(input)); calls.push(url.pathname)
      if (url.pathname === '/api/info') return json({ version: '2.3.2' })
      if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => controller.close())
      } }), { headers: { 'content-type': 'text/event-stream' } })
      assert.equal(new Headers(init.headers).get('authorization'), 'Basic ' + Buffer.from('opencode:reload-secret').toString('base64'))
      if (url.pathname === '/api/location/reload') {
        assert.equal(init.method, 'POST')
        return new Response(null, { status: 204 })
      }
      assert.equal(calls.includes('/api/location/reload'), true)
      assert.equal(events.some(event => event.type === 'catalog'), false, 'catalog must wait for polling')
      if (url.pathname === '/api/plugin') {
        polls++
        if (scenario === 'absent') return json({ data: [{ id: 'other-plugin', state: { status: 'active' } }] })
        if (scenario === 'reinitializing' && polls <= 3) return json({ data: [] })
        if (scenario === 'stalled' || polls === 1) return json({ data: [{ id: 'amekit-models', state: { status: 'loading' } }] })
        if (polls === 2) throw new TypeError('transient plugin transport failure')
        if (polls === 3) return json({ invalid: true })
        return json({ data: [{ id: 'amekit-models', state: { status: 'active' } }] })
      }
      if (url.pathname === '/api/rpc/amekit-models/status') {
        assert.equal(init.method, 'POST')
        assert.deepEqual(JSON.parse(String(init.body)), { input: null })
        assert.ok(polls >= 4, 'RPC registration alone is insufficient before plugin activation')
        statuses++
        if (statuses === 1) throw new TypeError('transient RPC transport failure')
        return json({ output: { authenticated: false } }, statuses === 2 ? (scenario === 'reinitializing' ? 400 : 503) : 200)
      }
      throw new Error('Unexpected ' + url.pathname)
    })
    try {
      await adapter.connect('http://localhost:4096', 'opencode', 'reload-secret')
      events.length = 0
      await adapter.reload(scenario === 'stalled' ? { maxAttempts: 40, pollMs: 1 } : { pollMs: 1 })
      assert.deepEqual(events, [{ type: 'catalog' }])
      assert.equal(calls.filter(route => route === '/api/location/reload').length, 1)
      assert.equal(polls, scenario === 'ready' || scenario === 'reinitializing' ? 6 : scenario === 'absent' ? 1 : 40)
      assert.equal(statuses, scenario === 'ready' || scenario === 'reinitializing' ? 3 : 0)
    } finally { adapter.dispose() }
  })
})
test('reload is a no-op before connecting and after disconnecting or disposing', async () => {
  let requests = 0
  const adapter = new OpenCodeAdapter(() => {}, async () => { requests++; throw new Error('Unexpected request') })
  await adapter.reload()
  adapter.disconnected('offline')
  await adapter.reload()
  adapter.dispose()
  await adapter.reload()
  assert.equal(requests, 0)
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
    if (url.pathname.endsWith('/model') || url.pathname.endsWith('/agent')) return new Response(null, { status: 204 })
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
    const promptBodies = () => calls.filter(call => call.url.pathname === '/api/session/s1/prompt').map(call => JSON.parse(String(call.init.body)))
    assert.deepEqual(promptBodies().at(-1), { text: 'test' })
    await adapter.prompt('project', 's1', 'native skill', model, undefined, undefined, [{ id: 'skill-translation' }])
    assert.deepEqual(promptBodies().at(-1), { text: 'native skill', skills: [{ id: 'skill-translation' }] })
    await adapter.prompt('project', 's1', 'no skills', model, undefined, undefined, [])
    assert.deepEqual(promptBodies().at(-1), { text: 'no skills' })
    const file = { uri: 'data:image/png;base64,iVBOR', name: 'shot.png', mime: 'image/png', source: { type: 'inline' as const } }
    await adapter.prompt('project', 's1', '', model, undefined, [file])
    assert.deepEqual(promptBodies().at(-1), { text: '(Đính kèm tệp)', files: [{ uri: file.uri, name: file.name, source: file.source }] })
    await adapter.prompt('project', 's1', '  describe  ', model, 'agent', Array.from({ length: 10 }, (_, index) => ({ ...file, name: `${index}.png` })))
    assert.equal(promptBodies().at(-1).text, '  describe  ')
    assert.equal(promptBodies().at(-1).files.length, 8)
    assert.equal(promptBodies().at(-1).files[7].name, '7.png')
    assert.ok(calls.some(call => call.url.pathname === '/api/session/s1/agent'))
    await adapter.prompt('project', 's1', 'reference', model, undefined, [{ uri: 'file:///C:/notes.txt' }])
    assert.deepEqual(promptBodies().at(-1).files, [{ uri: 'file:///C:/notes.txt' }])
    const promptCount = promptBodies().length
    await assert.rejects(adapter.prompt('project', 's1', ' \n ', model, undefined, []), /INVALID_PROMPT/)
    await assert.rejects(adapter.prompt('project', 's1', 'x'.repeat(200001), model, undefined, [file]), /INVALID_PROMPT/)
    assert.equal(promptBodies().length, promptCount)
    assert.equal((await adapter.permissions('project', 's1'))[0].title, 'edit: a.ts')
    await adapter.replyPermission('project', 'p1', 'once')
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Basic ' + Buffer.from('opencode:private-password').toString('base64'))
    assert.ok(!JSON.stringify(adapter.connection()).includes('private-password'))
  } finally { adapter.dispose() }
})
test('normalization exposes compaction, assistant and idle errors with timestamps and fallbacks', () => {
  const items = normalizeMessages([
    { id: 'compact', type: 'compaction', status: 'failed', reason: 'auto', time: { created: 0 }, error: { type: 'CompactionError', message: 'Compaction summary reached the output token limit' } },
    { id: 'assistant', type: 'assistant', time: { created: 10, completed: 20 }, content: [{ type: 'text', text: 'Partial answer' }], error: { type: 'ProviderError', message: 'Provider failed' } },
    { id: 'idle', type: 'idle', outcome: 'failed', time: { created: 30 }, error: { type: 'ExecutionError', message: 'Execution failed' } },
    { id: 'type-only', type: 'assistant', content: [], error: { type: 'UnknownError', message: '' } },
    { id: 'fallback', type: 'compaction', status: 'failed', reason: 'auto', error: { type: '', message: '' } },
  ] as SessionMessageInfo[])
  assert.deepEqual(items, [
    { id: 'compact:error', role: 'assistant', kind: 'error', text: 'Compaction summary reached the output token limit', createdAt: 0 },
    { id: 'assistant:0', role: 'assistant', kind: 'text', text: 'Partial answer', createdAt: 10, completedAt: 20 },
    { id: 'assistant:error', role: 'assistant', kind: 'error', text: 'Provider failed', createdAt: 10, completedAt: 20 },
    { id: 'idle:error', role: 'assistant', kind: 'error', text: 'Execution failed', createdAt: 30, executionOutcome: 'failed' },
    { id: 'type-only:error', role: 'assistant', kind: 'error', text: 'UnknownError' },
    { id: 'fallback:error', role: 'assistant', kind: 'error', text: 'Phiên thực thi gặp lỗi.' },
  ])
})
test('failed idle only deduplicates an immediately preceding identical error within its turn', () => {
  const error = { type: 'ExecutionError', message: 'Failed' }
  const items = normalizeMessages([
    { id: 'u1', type: 'user', text: 'Start' },
    { id: 'a1', type: 'assistant', content: [], error },
    { id: 'idle1', type: 'idle', outcome: 'failed', error },
    { id: 'u2', type: 'user', text: 'Retry' },
    { id: 'idle2', type: 'idle', outcome: 'failed', error },
    { id: 'compact', type: 'compaction', status: 'failed', reason: 'auto', error },
    { id: 'idle3', type: 'idle', outcome: 'failed', error },
    { id: 'a2', type: 'assistant', content: [], error },
    { id: 'a3', type: 'assistant', content: [{ type: 'text', text: 'More output' }] },
    { id: 'idle4', type: 'idle', outcome: 'failed', error },
    { id: 'idle5', type: 'idle', outcome: 'succeeded', error },
    { id: 'idle6', type: 'idle', outcome: 'failed' },
  ] as SessionMessageInfo[])
  assert.deepEqual(items.filter(item => item.kind === 'error').map(item => item.id), ['a1:error', 'idle2:error', 'compact:error', 'a2:error', 'idle4:error'])
})
test('new Chat can select the API root without changing native helper sessions or later child prompts', async () => {
  const directory = process.cwd(), creations: Record<string, unknown>[] = []
  let switches = 0, pluginReads = 0, agentReads = 0
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/plugin') {
      assert.equal(url.searchParams.get('location[directory]'), directory)
      return json({ data: ++pluginReads === 1 ? [] : ['opencode.config.agent', 'amekit-models'].map(id => ({ id, state: { status: 'active' } })) })
    }
    if (url.pathname === '/api/agent') { agentReads++; return json({ data: [{ id: 'ame-orchestrator', mode: 'primary' }] }) }
    if (url.pathname === '/api/session' && init.method === 'POST') {
      assert.ok(pluginReads >= 2, 'must await lazy project plugin registration')
      const body = JSON.parse(String(init.body)); creations.push(body)
      return json({ data: { id: `s${creations.length}`, agent: body.agent ?? 'build', location: { directory } } })
    }
    if (url.pathname === '/api/session/child') return json({ data: { id: 'child', agent: 'ios-specialist', parentID: 'root', location: { directory } } })
    if (url.pathname.endsWith('/agent')) { switches++; return new Response(null, { status: 204 }) }
    if (url.pathname.endsWith('/model')) return new Response(null, { status: 204 })
    if (url.pathname.endsWith('/prompt')) return json({ data: { id: 'inbox' } })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    assert.equal((await adapter.createSession('p', 'readonly', 'ame-orchestrator')).agent, 'ame-orchestrator')
    assert.equal(creations[0].agent, 'ame-orchestrator')
    assert.deepEqual(creations[0].location, { directory })
    assert.ok((creations[0].permissions as { effect: string }[]).some(rule => rule.effect === 'deny'))
    assert.equal((await adapter.createSession('p')).agent, 'build')
    assert.equal(agentReads, 2, 'native helper creation does not wait for a coordinator')
    assert.equal(Object.hasOwn(creations[1], 'agent'), false)
    await adapter.prompt('p', 'child', 'Continue this scoped task', { id: 'model', providerID: 'amecode', name: 'Model' })
    assert.equal(switches, 0, 'opening or continuing a child must not reset it to the coordinator')
  } finally { adapter.dispose() }
})

test('failed project orchestrator plugin never silently creates a session with another agent', async () => {
  let creations = 0
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/plugin') return json({ data: [{ id: 'amekit-models', state: { status: 'failed' } }] })
    if (url.pathname === '/api/agent') return json({ data: [] })
    creations++; throw new Error('Unexpected session creation')
  })
  adapter.attach('p', process.cwd())
  try {
    await adapter.connect('http://localhost:4096')
    await assert.rejects(adapter.createSession('p', 'default', 'ame-orchestrator'), /ORCHESTRATOR_PLUGIN_FAILED/)
    assert.equal(creations, 0)
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

test('catalog SSE updates target normalized attached directories and broadcast unmatched or missing locations', async () => {
  const notifications: IdeEvent[] = [], directory = process.cwd()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const adapter = new OpenCodeAdapter(event => notifications.push(event), async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      stream = controller
      init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('project', directory); adapter.attach('alias', directory); adapter.attach('other', directory + '-other')
  const send = (type: string, location?: { directory: string }) => stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, location, data: {} })}\n\n`))
  try {
    await adapter.connect('http://localhost:4096'); await waitFor(() => !!stream)
    notifications.length = 0
    for (const type of ['skill.updated', 'agent.updated', 'model.updated', 'command.updated']) {
      const normalized = directory.toUpperCase() + (process.platform === 'win32' ? '\\.' : '/.')
      send(type, { directory: normalized })
      send(type, { directory: directory + '-global-workspace' })
      send(type)
      await waitFor(() => notifications.length >= 4)
      assert.deepEqual(notifications.splice(0), [
        { type: 'catalog', projectID: 'project' }, { type: 'catalog', projectID: 'alias' },
        { type: 'catalog' }, { type: 'catalog' },
      ], type)
    }
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

test('empty snapshot diffs fall back to completed tool files within whole-session and idle-bounded turn ranges', async () => {
  const directory = process.cwd(), calls: URL[] = []
  const firstPatch = '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+first\n'
  const secondPatch = '--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-first\n+second\n'
  const outside = path.resolve(directory + '-other', 'outside.ts')
  const tool = (name: string, files: unknown, status = 'completed') => ({ type: 'tool', name, state: { status, metadata: { files } } })
  const history = [
    { id: 'u1', type: 'user', text: 'create' },
    { id: 'a1', type: 'assistant', content: [tool('patch', [
      { file: path.join(directory, 'src', 'new.ts'), patch: firstPatch, status: 'added', additions: 1, deletions: 0 },
      null, {}, { file: ' ', patch: '' }, { file: 'missing-patch.ts' }, { file: 'bad-patch.ts', patch: 1 },
      { file: outside, patch: '', status: 'unknown', additions: -1, deletions: '2' },
      { file: './defaults.ts', patch: '', additions: Infinity, deletions: NaN },
    ])] },
    { id: 'steer', type: 'user', text: 'modify' },
    { id: 'a2', type: 'assistant', content: [
      tool('edit', [{ file: '.\\src\\new.ts', patch: secondPatch, status: 'modified', additions: 2, deletions: 1 }]),
      tool('patch', [{ file: 'unfinished.ts', patch: 'ignored' }], 'running'),
      tool('patch', [{ file: 'failed.ts', patch: 'ignored' }], 'error'),
      tool('read', { file: 'not-array.ts' }),
      { type: 'tool', name: 'read', state: { status: 'completed' } },
    ] },
    { id: 'idle1', type: 'idle' },
    { id: 'u2', type: 'user', text: 'delete' },
    { id: 'a3', type: 'assistant', content: [tool('patch', [{ file: 'src/new.ts', patch: 'delete patch', status: 'deleted', additions: 0, deletions: 1 }])] },
    { id: 'idle2', type: 'idle' },
    { id: 'u3', type: 'user', text: 'running' },
    { id: 'a4', type: 'assistant', content: [tool('write', [{ file: './running.ts', patch: 'running patch', status: 'added', additions: 4, deletions: 0 }])] },
  ]
  let failHistory = false, rejectDiff = false, primary: unknown[] = []
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push(url)
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1') return json({ data: { location: { directory } } })
    if (url.pathname.endsWith('/diff')) return rejectDiff ? json({ name: 'TurnRangeError', message: 'location changed' }, 400) : json({ data: primary })
    if (url.pathname.endsWith('/message')) {
      if (url.searchParams.get('type') === 'user') return json({ data: [history[url.searchParams.get('order') === 'asc' ? 0 : 8]], cursor: {} })
      assert.equal(url.searchParams.get('order'), 'asc')
      assert.equal(url.searchParams.get('limit'), '200')
      if (failHistory) throw new TypeError('History unavailable')
      return json({ data: history, cursor: {} })
    }
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    const firstTurn = [
      { file: 'src/new.ts', patch: firstPatch + '\n' + secondPatch, additions: 3, deletions: 1, status: 'added' },
      { file: outside.replace(/\\/g, '/'), patch: '', additions: 0, deletions: 0, status: 'modified' },
      { file: 'defaults.ts', patch: '', additions: 0, deletions: 0, status: 'modified' },
    ]
    const running = { file: 'running.ts', patch: 'running patch', additions: 4, deletions: 0, status: 'added' }
    assert.deepEqual(await adapter.sessionDiff('p', 's1'), [
      { ...firstTurn[0], patch: firstTurn[0].patch + '\ndelete patch', deletions: 2, status: 'deleted' },
      ...firstTurn.slice(1), running,
    ])
    assert.deepEqual(await adapter.sessionDiff('p', 's1', 'u1'), firstTurn)
    assert.deepEqual(await adapter.sessionDiff('p', 's1', 'u2'), [{ file: 'src/new.ts', patch: 'delete patch', additions: 0, deletions: 1, status: 'deleted' }])
    assert.deepEqual(await adapter.sessionDiff('p', 's1', 'u3'), [running])
    assert.deepEqual(await adapter.sessionDiff('p', 's1', 'missing'), [])
    failHistory = true
    await assert.rejects(adapter.sessionDiff('p', 's1', 'u1'), /SESSION_DIFF_HISTORY_FAILED/)
    primary = [{ file: 'snapshot.ts', patch: 'snapshot patch', additions: 1, deletions: 0, status: 'modified' }]
    calls.length = 0
    assert.deepEqual(await adapter.sessionDiff('p', 's1', 'u1'), primary)
    assert.equal(calls.some(url => url.pathname.endsWith('/message')), false)
    primary = []; rejectDiff = true; calls.length = 0
    await assert.rejects(adapter.sessionDiff('p', 's1', 'u1'))
    assert.equal(calls.some(url => url.pathname.endsWith('/message')), false, 'diff errors must not trigger fallback')
  } finally { adapter.dispose() }
})

test('tool diff fallback follows history cursors and finds turns after the first 200 messages', async () => {
  const directory = path.resolve('long-diff-project'), pages: URLSearchParams[] = []
  let brokenPage = false, repeatedCursor = false
  const tail = [
    { id: 'late-user', type: 'user', text: 'edit' },
    { id: 'late-assistant', type: 'assistant', content: [{ type: 'tool', name: 'write', state: { status: 'completed', metadata: { files: [{ file: 'late.ts', patch: '+late', additions: 1, deletions: 0 }] } } }] },
    { id: 'idle', type: 'idle' },
  ]
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1') return json({ data: { location: { directory } } })
    if (url.pathname.endsWith('/diff')) return json({ data: [] })
    if (url.pathname.endsWith('/message')) {
      if (url.searchParams.has('cursor') && url.searchParams.has('order')) return json({ message: 'Cursor cannot be combined with order' }, 400)
      if (url.searchParams.get('type') === 'user') return json({ data: [tail[0]], cursor: {} })
      const cursor = url.searchParams.get('cursor'); pages.push(url.searchParams)
      if (cursor === 'page2' && brokenPage) throw new Error('page failed')
      return cursor === 'page2' ? json({ data: tail, cursor: repeatedCursor ? { next: 'page2' } : {} }) : json({ data: Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, type: 'idle' })), cursor: { next: 'page2' } })
    }
    return json({ data: [] })
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    for (const from of [undefined, 'late-user']) {
      pages.length = 0
      assert.deepEqual(await adapter.sessionDiff('p', 's1', from), [{ file: 'late.ts', patch: '+late', additions: 1, deletions: 0, status: 'modified' }])
      assert.equal(pages.length, 2)
      assert.equal(pages[0].get('order'), 'asc'); assert.equal(pages[0].has('cursor'), false)
      assert.equal(pages[1].get('cursor'), 'page2'); assert.equal(pages[1].has('order'), false)
    }
    brokenPage = true
    await assert.rejects(adapter.sessionDiff('p', 's1'), /SESSION_DIFF_HISTORY_FAILED/)
    brokenPage = false; repeatedCursor = true
    await assert.rejects(adapter.sessionDiff('p', 's1'), /SESSION_DIFF_HISTORY_FAILED/)
  } finally { adapter.dispose() }
})

test('paginated revert boundary lookup omits order after the first user page', async () => {
  const directory = process.cwd(), pages: URLSearchParams[] = []
  const files = [{ file: 'before.ts', patch: '+before', additions: 1, deletions: 0, status: 'added' }]
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1') return json({ data: { location: { directory }, revert: { messageID: 'reverted-user' } } })
    if (url.pathname.endsWith('/message')) {
      pages.push(url.searchParams)
      if (url.searchParams.has('cursor') && url.searchParams.has('order')) return json({ message: 'Cursor cannot be combined with order' }, 400)
      return url.searchParams.has('cursor')
        ? json({ data: [{ id: 'last-before' }, { id: 'reverted-user' }, { id: 'after-boundary' }], cursor: { next: 'unused-page3' } })
        : json({ data: [{ id: 'first-before' }], cursor: { next: 'user-page2' } })
    }
    if (url.pathname.endsWith('/diff')) {
      assert.equal(url.searchParams.get('from'), 'first-before')
      assert.equal(url.searchParams.get('to'), 'last-before')
      return json({ data: files })
    }
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    assert.deepEqual(await adapter.sessionDiff('p', 's1'), files)
    assert.equal(pages.length, 2)
    for (const page of pages) { assert.equal(page.get('type'), 'user'); assert.equal(page.get('limit'), '200') }
    assert.equal(pages[0].get('order'), 'asc'); assert.equal(pages[0].has('cursor'), false)
    assert.equal(pages[1].get('cursor'), 'user-page2'); assert.equal(pages[1].has('order'), false)
  } finally { adapter.dispose() }
})

test('completed tool metadata emits turn changes without snapshots and preserves existing snapshot paths', () => {
  const items = normalizeMessages([
    { id: 'u1', type: 'user', text: 'edit' },
    { id: 'a1', type: 'assistant', content: [
      { type: 'tool', name: 'patch', state: { status: 'completed', metadata: { files: [
        { file: 'src\\new.ts' }, { file: 'src/new.ts' }, null, {}, { file: '' }, { file: ' ' }, { file: 12 },
      ] } } },
      { type: 'tool', name: 'edit', state: { status: 'running', metadata: { files: [{ file: 'running.ts' }] } } },
      { type: 'tool', name: 'write', state: { status: 'error', metadata: { files: [{ file: 'failed.ts' }] } } },
      { type: 'tool', name: 'read', state: { status: 'completed', metadata: { files: 'not-array' } } },
      { type: 'tool', name: 'read', state: { status: 'completed' } },
    ] },
    { id: 'idle1', type: 'idle' },
    { id: 'u2', type: 'user', text: 'edit more' },
    { id: 'a2', type: 'assistant', snapshot: { files: ['snapshot\\original.ts'] }, content: [
      { type: 'tool', name: 'edit', state: { status: 'completed', metadata: { files: [{ file: 'other\\file.ts' }] } } },
    ] },
    { id: 'idle2', type: 'idle' },
  ] as unknown as SessionMessageInfo[])
  assert.deepEqual(items.filter(item => item.kind === 'changes'), [
    { id: 'idle1:changes', role: 'assistant', kind: 'changes', text: '', turn: { from: 'u1', files: ['src/new.ts'] }, executionID: 'u1', executionOutcome: 'succeeded' },
    { id: 'idle2:changes', role: 'assistant', kind: 'changes', text: '', turn: { from: 'u2', files: ['other/file.ts', 'snapshot\\original.ts'] }, executionID: 'u2', executionOutcome: 'succeeded' },
  ])
})

test('user file parts preserve inline base64 and URI references without changing text-only history', () => {
  const items = normalizeMessages([
    { id: 'inline', type: 'user', text: '', files: [
      { name: 'shot.png', mime: 'image/png', data: ' Y Q==\n\t' },
      { name: 'report.pdf', mime: 'application/pdf', data: 'cGRm', uri: 'ignored' },
      { name: 'notes.txt', mime: 'text/plain', data: '  ', uri: 'file:///C:/notes.txt', bytes: 12 },
      { uri: 'file:///C:/unknown.bin', bytes: 0 },
    ] },
    { id: 'plain', type: 'user', text: 'unchanged', files: [] },
  ] as unknown as SessionMessageInfo[])
  assert.deepEqual(items, [
    { id: 'inline', role: 'user', text: '', executionID: 'inline', attachments: [
      { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,YQ==' },
      { name: 'report.pdf', mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,cGRm' },
      { name: 'notes.txt', mime: 'text/plain', uri: 'file:///C:/notes.txt', size: 12 },
      { name: 'attachment', mime: 'application/octet-stream', uri: 'file:///C:/unknown.bin', size: 0 },
    ] },
    { id: 'plain', role: 'user', text: 'unchanged', executionID: 'inline' },
  ])
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

test('timeline metadata spans an idle-bounded execution without restarting for steered prompts', () => {
  const items = normalizeMessages([
    { id: 'u1', type: 'user', text: 'first', time: { created: 0 } },
    { id: 'a1', type: 'assistant', time: { created: 10, completed: 20 }, snapshot: { files: ['z.ts'] }, content: [
      { type: 'text', text: 'Checking', native: { phase: 'commentary' } },
      { type: 'reasoning', text: 'Thinking', native: { phase: 'final_answer' } },
      { type: 'tool', name: 'read', state: { status: 'completed' } },
    ] },
    { id: 'steer', type: 'user', text: 'steer', time: { created: 30 } },
    { id: 'a2', type: 'assistant', time: { created: 40, completed: 50 }, snapshot: { files: ['a.ts', 'z.ts'] }, content: [
      { type: 'text', text: 'Done', native: { phase: 'final_answer' } },
    ] },
    { id: 'empty', type: 'assistant', time: { created: 55, completed: 55 }, content: [] },
    { id: 'idle1', type: 'idle', time: { created: 60 } },
    { id: 'u2', type: 'user', text: 'read only', time: { created: 100 } },
    { id: 'a3', type: 'assistant', time: { created: 110 }, content: [
      { type: 'tool', name: 'read', state: { status: 'completed' } },
    ] },
    { id: 'idle2', type: 'idle', time: { created: 130 } },
  ] as SessionMessageInfo[])
  assert.deepEqual(items.slice(0, 3), [
    { id: 'u1', role: 'user', text: 'first', createdAt: 0, executionID: 'u1', executionOutcome: 'succeeded' },
    { id: 'a1:0', role: 'assistant', kind: 'text', text: 'Checking', createdAt: 10, completedAt: 20, phase: 'commentary', executionID: 'u1', executionOutcome: 'succeeded' },
    { id: 'a1:1', role: 'assistant', kind: 'reasoning', text: 'Thinking', createdAt: 10, completedAt: 20, executionID: 'u1', executionOutcome: 'succeeded' },
  ])
  assert.equal(items[3].createdAt, 10)
  assert.equal(items[3].completedAt, 20)
  assert.equal(Object.hasOwn(items[3], 'phase'), false)
  assert.deepEqual(items[4], { id: 'steer', role: 'user', text: 'steer', createdAt: 30, executionID: 'u1', executionOutcome: 'succeeded' })
  assert.deepEqual(items[5], { id: 'a2:0', role: 'assistant', kind: 'text', text: 'Done', createdAt: 40, completedAt: 50, phase: 'final_answer', workedMs: 60, executionID: 'u1', executionOutcome: 'succeeded' })
  assert.deepEqual(items[6], { id: 'idle1:changes', role: 'assistant', kind: 'changes', text: '', turn: { from: 'u1', files: ['a.ts', 'z.ts'] }, executionID: 'u1', executionOutcome: 'succeeded' })
  assert.equal(items[8].workedMs, 30)
  assert.equal(items.filter(item => item.kind === 'changes').length, 1)
  for (const item of items.filter(item => !['a2:0', 'a3:0'].includes(item.id))) assert.equal(Object.hasOwn(item, 'workedMs'), false)
})

test('timeline metadata preserves minimal fixtures and omits unknown text phases', () => {
  const items = normalizeMessages([
    { id: 'u', type: 'user', text: 'hello' },
    { id: 'a', type: 'assistant', content: [{ type: 'text', text: 'Done' }, { type: 'reasoning', text: 'Thinking' }] },
    { id: 'idle', type: 'idle' },
  ] as SessionMessageInfo[])
  assert.deepEqual(items, [
    { id: 'u', role: 'user', text: 'hello', executionID: 'u', executionOutcome: 'succeeded' },
    { id: 'a:0', role: 'assistant', kind: 'text', text: 'Done', executionID: 'u', executionOutcome: 'succeeded' },
    { id: 'a:1', role: 'assistant', kind: 'reasoning', text: 'Thinking', executionID: 'u', executionOutcome: 'succeeded' },
  ])
  const [unknown] = normalizeMessages([{ id: 'a', type: 'assistant', time: { created: 0, completed: 0 }, content: [
    { type: 'text', text: 'Done', native: { phase: 'unknown' } },
  ] }] as unknown as SessionMessageInfo[])
  assert.deepEqual(unknown, { id: 'a:0', role: 'assistant', kind: 'text', text: 'Done', createdAt: 0, completedAt: 0 })
})

test('execution identity spans followups, stamps all outcomes and resets only at idle', () => {
  for (const outcome of ['succeeded', 'failed', 'interrupted', undefined] as const) {
    const items = normalizeMessages([
      { id: 'u1', type: 'user', text: 'start', time: { created: 0 } },
      { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Working' }] },
      { id: 'followup', type: 'user', text: 'also this', time: { created: 10 } },
      { id: 'compact', type: 'compaction', status: 'failed', error: { type: 'Error', message: 'Compaction failed' } },
      { id: 'a2', type: 'assistant', snapshot: { files: ['changed.ts'] }, content: [{ type: 'reasoning', text: 'Thinking' }], error: { type: 'Error', message: 'Assistant error' } },
      { id: 'idle', type: 'idle', outcome, time: { created: 20 }, error: { type: 'Error', message: 'Idle error' } },
      { id: 'orphan', type: 'assistant', content: [{ type: 'text', text: 'Outside execution' }] },
      { id: 'u2', type: 'user', text: 'new execution' },
      { id: 'a3', type: 'assistant', content: [{ type: 'text', text: 'Still running' }] },
    ] as unknown as SessionMessageInfo[])
    const finished = items.filter(item => item.executionID === 'u1')
    assert.deepEqual(finished.map(item => item.id), ['u1', 'a1:0', 'followup', 'compact:error', 'a2:0', 'a2:error', ...(outcome === 'failed' ? ['idle:error'] : []), 'idle:changes'])
    for (const item of finished) assert.equal(item.executionOutcome, outcome ?? 'succeeded')
    assert.equal(items.find(item => item.id === 'a2:error')?.workedMs, 20)
    const orphan = items.find(item => item.id === 'orphan:0')!
    assert.equal(Object.hasOwn(orphan, 'executionID'), false)
    assert.equal(Object.hasOwn(orphan, 'executionOutcome'), false)
    for (const item of items.slice(-2)) {
      assert.equal(item.executionID, 'u2')
      assert.equal(Object.hasOwn(item, 'executionOutcome'), false)
    }
  }
})

test('completed todowrite accepts structured snapshots from metadata, output and input including empty arrays', () => {
  const todos = [
    { content: '  Plan  ', status: 'pending', priority: 'high' },
    { content: 'Implement', status: 'in_progress' },
    { content: 'Verify', status: 'completed' },
    { content: 'Optional', status: 'cancelled' },
  ]
  const expected = todos.map(({ content, status }) => ({ content: content.trim(), status }))
  for (const source of ['metadata', 'output', 'input']) for (const value of [todos, []]) {
    const part = { type: 'tool', name: ' TodoWrite ', state: { status: 'completed', [source]: { todos: value } } }
    assert.deepEqual(parseCompletedTodos(part), value.length ? expected : [])
    const [item] = normalizeMessages([{ id: 'a', type: 'assistant', content: [part] }] as unknown as SessionMessageInfo[])
    assert.deepEqual(item.todos, value.length ? expected : [])
  }
  const part = (state: object) => ({ type: 'tool', name: 'todowrite', state: { status: 'completed', ...state } })
  assert.deepEqual(parseCompletedTodos(part({ metadata: { todos: [] }, output: { todos }, input: { todos } })), [])
  assert.deepEqual(parseCompletedTodos(part({ output: { todos: [] }, input: { todos } })), [])
  assert.deepEqual(parseCompletedTodos(part({ output: 'prose', input: { todos } })), expected)
  assert.equal(parseCompletedTodos(part({ metadata: { todos: 'malformed' }, input: { todos } })), undefined, 'malformed authoritative snapshots do not fall back')
})

test('todo normalization ignores noncompleted tools, prose and malformed snapshots without partial results', () => {
  class Todo { content = 'Class instance'; status = 'pending' }
  const valid = { content: 'Valid', status: 'pending' }
  const parts: unknown[] = [
    ...['running', 'streaming', 'error'].map(status => ({ type: 'tool', name: 'todowrite', state: { status, input: { todos: [valid] } } })),
    { type: 'tool', name: 'read', state: { status: 'completed', metadata: { todos: [valid] } } },
    { type: 'text', text: 'todos: [{content: "Done", status: "completed"}]' },
    ...[undefined, null, '[]', {}, [null], [[]], [new Todo()], [valid, {}], [{ content: ' ', status: 'pending' }], [{ content: 1, status: 'pending' }], [{ content: 'Task', status: 'unknown' }], [{ content: 'Task' }]].map(todos => ({ type: 'tool', name: 'todowrite', state: { status: 'completed', metadata: { todos }, content: [{ type: 'text', text: 'All tasks completed' }] } })),
    { type: 'tool', name: 'todowrite', state: { status: 'completed', output: JSON.stringify({ todos: [valid] }) } },
  ]
  for (const part of [null, [], {}, ...parts]) assert.equal(parseCompletedTodos(part), undefined)
  const items = normalizeMessages([{ id: 'a', type: 'assistant', content: parts }] as unknown as SessionMessageInfo[])
  for (const item of items) assert.equal(Object.hasOwn(item, 'todos'), false)
})

test('worked time requires a valid idle boundary and does not leak across turns', () => {
  for (const [startedAt, idleAt, expected] of [[10, 10, 0], [10, 9, undefined], [undefined, 20, undefined], [10, undefined, undefined]] as const) {
    const items = normalizeMessages([
      { id: 'u', type: 'user', text: 'hello', ...(startedAt !== undefined ? { time: { created: startedAt } } : {}) },
      { id: 'a', type: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      { id: 'idle', type: 'idle', ...(idleAt !== undefined ? { time: { created: idleAt } } : {}) },
      { id: 'orphan', type: 'assistant', content: [{ type: 'text', text: 'No opener' }] },
      { id: 'idle2', type: 'idle', time: { created: 100 } },
      { id: 'u2', type: 'user', text: 'running', time: { created: 110 } },
      { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'Not idle' }] },
    ] as SessionMessageInfo[])
    assert.equal(items[1].workedMs, expected)
    assert.equal(Object.hasOwn(items[1], 'workedMs'), expected !== undefined)
    for (const item of items.slice(2)) assert.equal(Object.hasOwn(item, 'workedMs'), false)
  }
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

test('live text merges field-by-field and completed history retires stale live entries', async () => {
  const directory = process.cwd(), notifications: IdeEvent[] = []
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let history: unknown[] = []
  const adapter = new OpenCodeAdapter(event => notifications.push(event), async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/session/s1') return json({ data: { location: { directory } } })
    if (url.pathname.endsWith('/message')) return json({ data: [...history].reverse(), cursor: {} })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      stream = controller
      init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    throw new Error('Unexpected ' + url.pathname)
  })
  const send = async (type: string, data: unknown) => {
    const before = notifications.length
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\n\n`))
    await waitFor(() => notifications.length > before)
  }
  const assistant = (text: string, completed?: number) => ({ id: 'a', type: 'assistant', time: { created: 10, ...(completed !== undefined ? { completed } : {}) }, content: [{ type: 'text', text, native: { phase: 'final_answer' } }] })
  const delta = (delta: string) => send('session.text.delta', { sessionID: 's1', assistantMessageID: 'a', ordinal: 0, delta })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    await delta('Saved')
    history = [assistant('Saved')]
    assert.deepEqual(await adapter.messages('p', 's1'), normalizeMessages(history as SessionMessageInfo[]), 'equal text preserves metadata')
    await delta(' plus live')
    const [merged] = await adapter.messages('p', 's1')
    assert.deepEqual(merged, { ...normalizeMessages(history as SessionMessageInfo[])[0], text: 'Saved plus live' })
    history = [{ id: 'u', type: 'user', text: 'go', time: { created: 0 } }, assistant('Saved', 20), { id: 'idle', type: 'idle', time: { created: 30 } }]
    const completed = normalizeMessages(history as SessionMessageInfo[])
    assert.deepEqual(await adapter.messages('p', 's1'), completed, 'completed history wins over longer stale live text')
    assert.deepEqual(completed[1], { id: 'a:0', role: 'assistant', kind: 'text', text: 'Saved', phase: 'final_answer', createdAt: 10, completedAt: 20, workedMs: 30, executionID: 'u', executionOutcome: 'succeeded' })
    history = []
    assert.deepEqual(await adapter.messages('p', 's1'), [], 'retired live entry cannot reappear when history is absent')
    history = [assistant('Saved', 0)]
    await delta('Saved')
    assert.deepEqual(await adapter.messages('p', 's1'), normalizeMessages(history as SessionMessageInfo[]), 'zero completedAt and equal live text are also authoritative')
    history = []
    assert.deepEqual(await adapter.messages('p', 's1'), [])
    for (const [type, extra] of [
      ['session.idle', {}], ['session.execution.succeeded', {}], ['session.execution.failed', {}],
      ['session.execution.interrupted', {}], ['session.status', { status: { type: 'idle' } }],
    ] as const) {
      await delta('Pending')
      assert.equal((await adapter.messages('p', 's1'))[0].text, 'Pending')
      await send(type, { sessionID: 's1', ...extra })
      assert.deepEqual(await adapter.messages('p', 's1'), [], type + ' clears live state')
    }
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
    assert.equal(body.prompt, [
      'Write a concise Conventional Commits message for the staged changes below.',
      'Use a subject of at most 72 characters and at most 3 short bullets if there are multiple changes.',
      'Return only the commit message, without markdown fences or extra explanation.',
      'Files:\na.ts\nb.ts',
      'Diff:\n+new behavior',
    ].join('\n\n'))
    assert.ok(call.init.signal instanceof AbortSignal)
    assert.equal(call.init.signal.aborted, false)
    const skill = { name: 'team-commit', instructions: 'Write a Vietnamese subject and summarize the intent.' }
    output = '```text\r\nCải thiện công cụ\r\n```'
    assert.deepEqual(await adapter.generateCommitMessage({ diff: '+team change', files: ['team.ts'], truncated: false }, model, skill), { message: 'Cải thiện công cụ', truncated: false })
    const custom = JSON.parse(String(calls.filter(c => c.url.pathname === '/api/experimental/generate/text').at(-1)!.init.body))
    for (const expected of [`Skill: /${skill.name}\n\n${skill.instructions}`, 'Files:\nteam.ts', 'Diff:\n+team change', 'only the commit message text', 'no markdown fences', 'no tool calls or git commands', 'no conversational preamble']) assert.ok(custom.prompt.includes(expected), expected)
    assert.ok(!custom.prompt.includes('Conventional Commits'))
    assert.deepEqual(custom.model, body.model)
    output = '  fix: keep plain messages  '
    assert.deepEqual(await adapter.generateCommitMessage({ diff: '', files: [], truncated: false }, model), { message: 'fix: keep plain messages', truncated: false })
    await adapter.generateCommitMessage({ diff: '+new behavior', files: ['a.ts', 'b.ts'], truncated: true }, model, { name: 'empty', instructions: '' })
    assert.equal(JSON.parse(String(calls.filter(c => c.url.pathname === '/api/experimental/generate/text').at(-1)!.init.body)).prompt, body.prompt)
    for (output of ['  \n ', '```\n\n```', '```text\n```']) await assert.rejects(adapter.generateCommitMessage({ diff: '', files: [], truncated: false }, model), /EMPTY_COMMIT_MESSAGE/)
  } finally { adapter.dispose() }
})

test('build notes generation includes committed and working context, skill and note, with a 90s timeout', async t => {
  const calls: { url: URL; init: RequestInit }[] = [], timeouts: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { timeouts.push(milliseconds); return timeout(milliseconds) })
  let output = '  ```markdown\n## Tổng quan bản build\n\nCải thiện công cụ.\n```  '
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/experimental/generate/text') return json({ data: { text: output } })
    throw new Error('Unexpected ' + url.pathname)
  })
  const model = { id: 'server-model', modelID: 'catalog-model', providerID: 'amecode', name: 'Model' }
  const summary: BuildNotesSummary = {
    branch: 'feature/qc',
    commits: [
      { hash: 'abcdef123456789', shortHash: 'abcdef1', subject: 'Improve tools', body: 'Preserve metadata\nHandle retries', author: 'Dev', date: '2026-11-24', refs: [] },
      { hash: '123456789abcdef', shortHash: '1234567', subject: 'Fix login', body: '', author: 'Dev', date: '2026-11-23', refs: [] },
    ],
    files: [
      { source: 'committed', status: 'M', path: 'a.ts', additions: 2, deletions: 1 },
      { source: 'working', status: 'U', path: 'local.ts', additions: 3, deletions: 0 },
      { source: 'both', status: 'M', path: 'shared.ts', additions: 4, deletions: 2 },
    ],
    workingFileCount: 2, additions: 9, deletions: 3, diff: '+local change\n+committed change', truncated: true,
  }
  const snapshot = structuredClone(summary)
  const lastCall = () => calls.filter(call => call.url.pathname === '/api/experimental/generate/text').at(-1)!
  const lastPrompt = (): string => JSON.parse(String(lastCall().init.body)).prompt
  try {
    await adapter.connect('http://localhost:4096')
    calls.length = 0; timeouts.length = 0
    assert.deepEqual(await adapter.generateBuildNotes(summary, model), { notes: '## Tổng quan bản build\n\nCải thiện công cụ.', truncated: true })
    assert.deepEqual(calls.map(call => call.url.pathname), ['/api/experimental/generate/text'])
    assert.equal(lastCall().init.method, 'POST')
    assert.deepEqual(JSON.parse(String(lastCall().init.body)).model, { id: 'server-model', providerID: 'amecode' })
    assert.deepEqual(timeouts, [90_000])
    assert.ok(lastCall().init.signal instanceof AbortSignal)
    assert.equal(lastCall().init.signal?.aborted, false)
    const defaultPrompt = lastPrompt()
    for (const expected of [
      'tiếng Việt', '## Tổng quan bản build', '## Tính năng mới / Cải tiến', '## Sửa lỗi', '## Khu vực QC cần kiểm tra kỹ & Lưu ý',
      'đã commit', 'chưa commit', 'không bịa', 'Branch: feature/qc',
      'abcdef1 Improve tools\nPreserve metadata\nHandle retries', '1234567 Fix login',
      'committed M a.ts +2 -1', 'working U local.ts +3 -0', 'both M shared.ts +4 -2', summary.diff,
      'Return only the Markdown build notes without conversational preamble or outer triple-backtick wrapping.',
    ]) assert.ok(defaultPrompt.includes(expected), expected)
    assert.equal(defaultPrompt.includes('Developer note:'), false)
    await adapter.generateBuildNotes(summary, model, { name: 'empty', instructions: '' }, ' \n ')
    assert.equal(lastPrompt(), defaultPrompt)
    const skill = { name: 'qc-release', instructions: 'Use team sections and flag risky changes.' }
    output = '```md\r\n## Team notes\r\nLocal changes need QC.\r\n```'
    assert.deepEqual(await adapter.generateBuildNotes({ ...summary, truncated: false }, model, skill, '  Check offline mode.\nKeep staged changes.  '), { notes: '## Team notes\r\nLocal changes need QC.', truncated: false })
    const custom = lastPrompt()
    assert.ok(custom.startsWith(`Write QC build notes / release notes using the following skill.\n\nSkill: /${skill.name}\n\n${skill.instructions}`))
    assert.equal(custom.includes('Viết ghi chú bản build'), false)
    for (const expected of ['Branch: feature/qc', 'abcdef1 Improve tools', 'working U local.ts +3 -0', summary.diff, 'Developer note:\nCheck offline mode.\nKeep staged changes.', 'Return only the Markdown build notes']) assert.ok(custom.includes(expected), expected)
    output = '  ## Plain Markdown\n\n```ts\nconst x = 1\n```  '
    assert.deepEqual(await adapter.generateBuildNotes(summary, model, undefined, '  Default note  '), { notes: output.trim(), truncated: true })
    assert.ok(lastPrompt().includes('Developer note:\nDefault note'))
    assert.ok(lastPrompt().includes('## Tổng quan bản build'))
    for (output of ['  \n ', '```\n\n```', '```markdown\n```']) await assert.rejects(adapter.generateBuildNotes(summary, model), /EMPTY_BUILD_NOTES/)
    assert.deepEqual(summary, snapshot)
  } finally { adapter.dispose() }
})

test('artifacts use project location, map native summaries and files, validate ids and enforce session ownership', async () => {
  const directory = process.cwd(), other = directory + '-other'
  const calls: { url: URL; init: RequestInit }[] = []
  const info = { id: 'artifact1', provider: 'local', sessionID: 's1', title: 'Preview', entry: 'index.html', url: 'http://localhost:4096/view/artifact1', time: { created: 10, updated: 20 } }
  const files = { 'index.html': '<h1>Preview</h1>', 'notes.md': '# Notes' }
  const summary = { id: info.id, provider: info.provider, sessionID: info.sessionID, title: info.title, entry: info.entry, url: info.url, createdAt: 10, updatedAt: 20 }
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname.startsWith('/api/session/')) return json({ data: { location: { directory: url.pathname.endsWith('/s1') ? directory : other } } })
    if (url.pathname.startsWith('/api/experimental/artifacts')) {
      if (url.searchParams.get('location[directory]') === other) return json({ _tag: 'ArtifactNotFoundError', message: 'Not found', artifactID: info.id }, 404)
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      return json({ location: { directory }, data: url.pathname.endsWith('/artifacts') ? [info] : { info, files } })
    }
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory); adapter.attach('other', other)
  try {
    await adapter.connect('http://localhost:4096')
    assert.deepEqual(await adapter.artifacts('p'), [summary])
    assert.equal(calls.at(-1)!.url.searchParams.has('sessionID'), false)
    calls.length = 0
    assert.deepEqual(await adapter.artifacts('p', 's1'), [summary])
    assert.deepEqual(calls.map(c => c.url.pathname), ['/api/session/s1', '/api/experimental/artifacts'])
    assert.equal(calls[1].url.searchParams.get('sessionID'), 's1')
    assert.deepEqual(await adapter.artifact('p', '  artifact1 \n'), { info: summary, files })
    await adapter.deleteArtifact('p', ' artifact1 ')
    assert.equal(calls.at(-1)!.init.method, 'DELETE')
    await adapter.artifact('p', 'a'.repeat(200))
    await adapter.deleteArtifact('p', 'x')
    for (const call of calls.filter(c => c.url.pathname.startsWith('/api/experimental/artifacts'))) assert.equal(call.url.searchParams.get('location[directory]'), directory)
    const before = calls.length
    for (const id of ['', ' \n ', 'a'.repeat(201), null, 123]) {
      await assert.rejects(adapter.artifact('p', id as string), /INVALID_ARTIFACT_ID/)
      await assert.rejects(adapter.deleteArtifact('p', id as string), /INVALID_ARTIFACT_ID/)
    }
    for (const operation of [() => adapter.artifacts('missing'), () => adapter.artifact('missing', info.id), () => adapter.deleteArtifact('missing', info.id)]) await assert.rejects(operation(), /UNKNOWN_PROJECT/)
    assert.equal(calls.length, before, 'invalid input never reaches the SDK')
    calls.length = 0
    await assert.rejects(adapter.artifacts('p', 'foreign'), /SESSION_PROJECT_MISMATCH/)
    assert.deepEqual(calls.map(c => c.url.pathname), ['/api/session/foreign'])
    await assert.rejects(adapter.artifact('other', info.id))
    await assert.rejects(adapter.deleteArtifact('other', info.id))
    for (const call of calls.slice(1)) assert.equal(call.url.searchParams.get('location[directory]'), other, 'artifact access stays in the requested project')
  } finally { adapter.dispose() }
})

test('artifact.updated SSE refreshes only matching attached projects and broadcasts when location is absent', async () => {
  const notifications: IdeEvent[] = [], directory = process.cwd(), other = directory + '-other'
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const adapter = new OpenCodeAdapter(event => notifications.push(event), async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { stream = c; init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    throw new Error('Unexpected ' + url.pathname)
  })
  const send = (location?: { directory: string }) => stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'artifact.updated', location, data: {} })}\n\n`))
  adapter.attach('p', directory); adapter.attach('other', other)
  try {
    await adapter.connect('http://localhost:4096'); await waitFor(() => !!stream)
    notifications.length = 0
    send({ directory: directory + '\\.' }); send({ directory: other }); send()
    await waitFor(() => notifications.length === 4)
    assert.deepEqual(notifications, [{ type: 'opencode', projectID: 'p' }, { type: 'opencode', projectID: 'other' }, { type: 'opencode', projectID: 'p' }, { type: 'opencode', projectID: 'other' }])
    notifications.length = 0
    adapter.detach('p'); send({ directory }); send({ directory: other })
    await waitFor(() => notifications.length === 1)
    assert.deepEqual(notifications, [{ type: 'opencode', projectID: 'other' }])
  } finally { adapter.dispose() }
})

test('btwAsk validates owned trimmed questions, switches selected model and generates with a 45s timeout without prompting', async t => {
  const directory = process.cwd(), calls: { url: URL; init: RequestInit }[] = [], timeouts: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return timeout(ms) })
  let failModel = false, failGenerate = false
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session/s1' || url.pathname === '/api/session/foreign') return json({ data: { location: { directory: url.pathname.endsWith('foreign') ? directory + '-other' : directory } } })
    if (url.pathname.endsWith('/model')) return failModel ? json({ _tag: 'ForbiddenError', message: 'Model denied' }, 403) : new Response(null, { status: 204 })
    if (url.pathname.endsWith('/generate')) return failGenerate ? json({ _tag: 'SessionBusyError', sessionID: 's1', message: 'Busy' }, 409) : json({ data: { text: ' \n Side answer \n ', tokens: emptyTokens(), cost: 1 } })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  const model = { id: 'server-model', modelID: 'catalog-model', providerID: 'amecode', name: 'Model' }
  try {
    await adapter.connect('http://localhost:4096')
    calls.length = 0; timeouts.length = 0
    assert.deepEqual(await adapter.btwAsk('p', 's1', ' \n Side question \n ', model), { answer: 'Side answer' })
    assert.deepEqual(calls.map(c => c.url.pathname), ['/api/session/s1', '/api/session/s1/model', '/api/session/s1/generate'])
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { model: { id: 'server-model', providerID: 'amecode' } })
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), { prompt: 'Side question' })
    assert.equal(calls[2].init.method, 'POST')
    assert.ok(calls[2].init.signal instanceof AbortSignal)
    assert.equal(calls[2].init.signal.aborted, false)
    assert.deepEqual(timeouts, [30000, 30000, 45000])
    calls.length = 0
    await adapter.btwAsk('p', 's1', ' ' + 'a'.repeat(20000) + ' ')
    assert.deepEqual(calls.map(c => c.url.pathname), ['/api/session/s1', '/api/session/s1/generate'], 'omitted model retains the session model')
    calls.length = 0
    for (const question of ['', ' \n ', 'a'.repeat(20001)]) await assert.rejects(adapter.btwAsk('p', 's1', question, model), /INVALID_PROMPT/)
    await assert.rejects(adapter.btwAsk('p', 'foreign', 'Question', model), /SESSION_PROJECT_MISMATCH/)
    assert.equal(calls.every(c => c.url.pathname === '/api/session/s1' || c.url.pathname === '/api/session/foreign'), true, 'invalid or foreign questions cause no mutation')
    calls.length = 0; failModel = true
    await assert.rejects(adapter.btwAsk('p', 's1', 'Question', model))
    assert.equal(calls.some(c => c.url.pathname.endsWith('/generate')), false)
    failModel = false; failGenerate = true
    await assert.rejects(adapter.btwAsk('p', 's1', 'Question', model))
  } finally { adapter.dispose() }
})

test('btwAsk retries empty answers once with a plain-text no-tool prompt and a fresh timeout', async t => {
  for (const [first, second, expected] of [
    ['', ' \n Recovered answer \n ', 'Recovered answer'],
    [' \n\t ', 'Context is missing.', 'Context is missing.'],
    ['', ' \n ', ''],
    [' Direct answer ', 'must not be used', 'Direct answer'],
  ]) await t.test(JSON.stringify([first, second]), async t => {
    const directory = process.cwd(), prompts: unknown[] = [], signals: AbortSignal[] = [], timeouts: number[] = []
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return timeout(ms) })
    const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/info') return json({ version: '2.3.2' })
      if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
      if (url.pathname === '/api/session/s1') return json({ data: { location: { directory } } })
      if (url.pathname.endsWith('/generate')) {
        prompts.push(JSON.parse(String(init.body)))
        assert.ok(init.signal instanceof AbortSignal)
        signals.push(init.signal)
        return json({ data: { text: prompts.length === 1 ? first : second, tokens: emptyTokens(), cost: 0 } })
      }
      throw new Error('Unexpected ' + url.pathname)
    })
    adapter.attach('p', directory)
    try {
      await adapter.connect('http://localhost:4096'); timeouts.length = 0
      assert.deepEqual(await adapter.btwAsk('p', 's1', ' \n What is the package name? \n '), { answer: expected })
      assert.deepEqual(prompts, [
        { prompt: 'What is the package name?' },
        ...(!first.trim() ? [{ prompt: 'Answer directly in plain text using only the existing conversation context. Do not call any tools; if the information is not present in the conversation, briefly say so.\n\nWhat is the package name?' }] : []),
      ])
      assert.deepEqual(timeouts, first.trim() ? [30000, 45000] : [30000, 45000, 45000])
      if (!first.trim()) assert.notEqual(signals[0], signals[1])
    } finally { adapter.dispose() }
  })
})

test('forkSession checks ownership and maps native session activity, parent, agent and fallback title', async () => {
  const directory = process.cwd(), calls: { url: URL; init: RequestInit }[] = []
  let forked = { id: 'fork1', parentID: 's1', agent: 'architect', title: 'Forked', outcome: 'succeeded', time: { created: 1, updated: 50, busy: 40, idle: 30 } }
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname.endsWith('/fork')) return json({ data: forked })
    if (url.pathname.startsWith('/api/session/')) return json({ data: { location: { directory: url.pathname.endsWith('foreign') ? directory + '-other' : directory } } })
    throw new Error('Unexpected ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096'); calls.length = 0
    await assert.rejects(adapter.forkSession('p', 'foreign'), /SESSION_PROJECT_MISMATCH/)
    assert.equal(calls.some(c => c.url.pathname.endsWith('/fork')), false)
    calls.length = 0
    assert.deepEqual(await adapter.forkSession('p', 's1'), { id: 'fork1', parentID: 's1', agent: 'architect', title: 'Forked', updatedAt: 50, status: 'running', busyAt: 40, idleAt: 30, outcome: 'succeeded' })
    assert.deepEqual(calls.map(c => c.url.pathname), ['/api/session/s1', '/api/session/s1/fork'])
    assert.equal(calls[1].init.method, 'POST')
    assert.equal(calls[1].url.searchParams.has('before'), false)
    forked = { ...forked, title: '', time: { ...forked.time, idle: 45 } }
    const idle = await adapter.forkSession('p', 's1')
    assert.equal(idle.title, 'Untitled'); assert.equal(idle.status, 'idle')
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
