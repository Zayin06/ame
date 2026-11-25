import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeAdapter } from '../packages/opencode-adapter/src/index'
import { PetActivity } from '../packages/amekit/src/pet'
import { petSessions } from '../apps/desktop/src/renderer/pet-sessions'
import type { SessionInfo } from '@opencode/client'

test('reconnect retries failed permissions independently and moves Pet from thinking to waiting', async () => {
  const directory = process.cwd(), calls = { permissions: 0, forms: 0, messages: 0 }
  let stream!: ReadableStreamDefaultController<Uint8Array>, notifications = 0, failPermissions = false
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const adapter = new OpenCodeAdapter(() => { notifications++ }, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      stream = controller; init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session') return json({ data: [{ id: 's', title: 'Pet', time: { busy: 100 } }], cursor: {} })
    if (url.pathname.endsWith('/permission')) {
      calls.permissions++
      if (failPermissions) { failPermissions = false; throw new Error('permissions temporarily unavailable') }
      return json({ data: [{ id: 'pending', sessionID: 's', action: 'edit', resources: [] }] })
    }
    if (url.pathname.endsWith('/form')) { calls.forms++; return json({ data: [] }) }
    if (url.pathname.endsWith('/message')) { calls.messages++; return json({ data: [], cursor: {} }) }
    throw new Error('Unexpected ' + url.pathname)
  })
  const activity = new PetActivity()
  const report = async () => activity.report('window', petSessions({ p: await adapter.sessions('p') }), 100)
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    assert.equal(await report(), 'waiting')
    failPermissions = true
    const before = notifications
    stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'))
    for (let i = 0; i < 100 && notifications === before; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(notifications > before, 'reconnect was consumed')
    assert.equal(await report(), 'thinking')
    assert.deepEqual(calls, { permissions: 2, forms: 2, messages: 2 })
    assert.equal(await report(), 'waiting')
    assert.deepEqual(calls, { permissions: 3, forms: 2, messages: 2 }, 'only the failed section is retried')
    assert.equal(await report(), 'waiting')
    assert.deepEqual(calls, { permissions: 3, forms: 2, messages: 2 })
  } finally { adapter.dispose() }
})

test('SessionInfo + real SDK SSE → sessions → renderer mapper → all Pet activity states', async () => {
  const directory = process.cwd()
  let stream!: ReadableStreamDefaultController<Uint8Array>, notifications = 0
  let info = { id: 's', title: 'Pet', location: { directory }, time: { created: 0, updated: 0, busy: 100 } } as SessionInfo
  let permissions: unknown[] = [], forms: unknown[] = [], messages: unknown[] = []
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const adapter = new OpenCodeAdapter(() => { notifications++ }, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      stream = controller; init.signal?.addEventListener('abort', () => controller.close())
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session') return json({ data: [info], cursor: {} })
    if (url.pathname === '/api/session/s') return json({ data: info })
    if (url.pathname.endsWith('/permission')) return json({ data: permissions })
    if (url.pathname.endsWith('/form')) return json({ data: forms })
    if (url.pathname.endsWith('/message')) return json({ data: messages, cursor: {} })
    throw new Error('Unexpected ' + url.pathname)
  })
  const send = async (type: string, created: number, data: object = {}) => {
    const before = notifications
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, created, location: { directory }, data: { sessionID: 's', ...data } })}\n\n`))
    for (let i = 0; i < 100 && notifications === before; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(notifications > before, type)
  }
  const activity = new PetActivity()
  const report = async (now: number) => activity.report('window', petSessions({ p: await adapter.sessions('p') }), now)
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    assert.equal(await report(100), 'thinking')
    assert.equal((await adapter.sessions('p'))[0].busyAt, 100)
    await send('session.reasoning.started', 110, { assistantMessageID: 'a', ordinal: 0 })
    await send('session.reasoning.delta', 120, { assistantMessageID: 'a', ordinal: 0, delta: 'Plan' })
    assert.equal(await report(120), 'thinking')
    await send('session.tool.called', 130, { assistantMessageID: 'a', id: 'tool1', input: {}, executed: false })
    await send('session.tool.called', 140, { assistantMessageID: 'a', id: 'tool2', input: {}, executed: false })
    assert.equal(await report(140), 'working')
    await send('session.reasoning.delta', 150, { assistantMessageID: 'a', ordinal: 1, delta: 'Parallel' })
    await send('session.tool.success', 160, { assistantMessageID: 'a', id: 'tool1', content: [] })
    assert.equal(await report(160), 'working', 'another active tool outranks reasoning')
    await send('permission.asked', 170, { id: 'permission1', action: 'edit', resources: [] })
    await send('permission.created', 175, { id: 'permission2' })
    await send('form.created', 180, { form: { id: 'form1', sessionID: 's', fields: [] } })
    assert.equal(await report(180), 'waiting')
    await send('permission.replied', 190, { requestID: 'permission1', reply: 'once' })
    await send('form.replied', 200, { id: 'form1', answer: {} })
    assert.equal(await report(200), 'waiting', 'all pending requests must be resolved')
    await send('permission.replied', 210, { requestID: 'permission2', reply: 'reject' })
    assert.equal(await report(210), 'working')
    await send('session.tool.success', 220, { assistantMessageID: 'a', id: 'tool2', content: [] })
    assert.equal(await report(220), 'thinking')
    await send('session.text.delta', 230, { assistantMessageID: 'a', ordinal: 2, delta: 'Done' })
    assert.equal(await report(230), 'working')
    await send('session.execution.succeeded', 1000)
    assert.equal(await report(1000), 'wave', 'SSE completion wins over stale running snapshot')
    info = { ...info, time: { ...info.time, idle: 1000 }, outcome: 'succeeded' }
    assert.equal((await adapter.sessions('p'))[0].idleAt, 1000)
    assert.equal(await report(4000), 'idle')
    for (const [busy, idle, outcome, expected] of [
      [5000, 25000, 'succeeded', 'celebrating'], [30000, 31000, 'failed', 'failed'],
      [40000, 41000, 'interrupted', 'idle'],
    ] as const) {
      await send('session.execution.started', busy)
      assert.equal(await report(busy), 'thinking')
      await send(`session.execution.${outcome}`, idle)
      assert.equal(await report(idle), expected)
      assert.equal((await adapter.sessions('p'))[0].outcome, outcome)
    }
    // Reconnect drops live caches and recovers tools / pending forms from snapshots.
    info = { ...info, time: { ...info.time, busy: 50000, idle: 41000 }, outcome: undefined }
    messages = [{ id: 'a2', type: 'assistant', time: { created: 50000 }, content: [{ type: 'tool', id: 't', state: { status: 'running' } }] }]
    permissions = [{ id: 'p', sessionID: 's', action: 'read', resources: [] }]
    forms = [{ id: 'f', sessionID: 's', fields: [] }]
    await send('server.connected', 50000)
    assert.equal(await report(50000), 'waiting')
    permissions = []; await adapter.permissions('p', 's')
    assert.equal(await report(50001), 'waiting')
    await send('form.cancelled', 50002, { id: 'f' })
    assert.equal(await report(50002), 'working')
    await send('session.tool.success', 50003, { assistantMessageID: 'a2', id: 't', content: [] })
    assert.equal(await report(50003), 'thinking')
    const mapped = petSessions({ p: [{ id: 'child', title: '', parentID: 's', busyAt: 0, idleAt: 20000, status: 'idle', outcome: 'succeeded' }] })[0]
    assert.equal(mapped.child, true); assert.equal(mapped.busy, 0); assert.equal(mapped.idle, 20000)
  } finally { adapter.dispose() }
})
