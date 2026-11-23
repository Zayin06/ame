import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OpenCode, type SessionInfo, type SessionMessageInfo } from '@opencode/client'
import { buildAgentMap, resolveAgentMapFamily, summarizeAgentMapNode, truncateSafe } from '../packages/opencode-adapter/src/agent-map'
import { OpenCodeAdapter } from '../packages/opencode-adapter/src/index'
import { PrivateRuntime } from '../packages/opencode-adapter/src/runtime'

const session = (id: string, extra: object = {}) => ({ id, title: id, agent: 'builder', time: { created: 100, updated: 900 }, ...extra }) as SessionInfo
const message = (id: string, type: string, extra: object = {}) => ({ id, type, time: { created: 100 }, ...extra }) as SessionMessageInfo
const assistant = (id: string, extra: object = {}) => message(id, 'assistant', { agent: 'assistant-agent', model: { id: 'assistant-model', providerID: 'local', variant: 'high' }, content: [], ...extra })
const tool = (name: string, status = 'completed', input: unknown = {}, time: object = { created: 10, ran: 20, completed: 50 }) => ({ type: 'tool', name, state: { status, input }, time })
const summarize = (messages: SessionMessageInfo[] = [], extra: object = {}) => summarizeAgentMapNode({ id: 'root', depth: 0, childIDs: [], messages, now: 1000, ...extra })
const text = (value: string) => ({ type: 'text', text: value })
const tokens = (input: number, output = 2, reasoning = 3, read = 4, write = 5) => ({ input, output, reasoning, cache: { read, write } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

// Pure family resolution and aggregation share fixtures with the SDK/native checks below.
test('agent map resolves a depth-3 active child to the full BFS family with stable siblings and parent attribution', () => {
  const sessions = [session('L3', { parentID: 'L2' }), session('unrelated'), session('later', { parentID: 'L0', time: { created: 200 } }), session('L1', { parentID: 'L0' }), session('L0', { title: ' Root title ' }), session('L2', { parentID: 'L1' }), session('alpha', { parentID: 'L0' }), session('unknown-time', { parentID: 'L0', time: undefined })]
  const family = resolveAgentMapFamily(sessions, 'L3')
  assert.equal(family.rootID, 'L0')
  assert.equal(family.limited, false)
  assert.deepEqual(family.entries.map(entry => [entry.id, entry.depth]), [['L0', 0], ['alpha', 1], ['L1', 1], ['later', 1], ['unknown-time', 1], ['L2', 2], ['L3', 3]])
  const view = buildAgentMap({ family, activeSessionID: 'L3', messagesBySession: new Map(), now: 1234 })
  assert.equal(view.activeSessionID, 'L3')
  assert.equal(view.fetchedAt, 1234)
  assert.deepEqual(view.nodes[0].childIDs, ['alpha', 'L1', 'later', 'unknown-time'])
  assert.equal(view.nodes.find(node => node.id === 'L1')?.spawnedByTitle, 'Root title')
  assert.equal(view.nodes.find(node => node.id === 'L1')?.spawnedByAgent, 'builder')
  assert.ok(view.nodes.every(node => node.historyComplete))
  assert.equal(view.nodes[0].prompt, '')
  assert.equal(view.nodes[0].tokens.total, 0)
})

test('agent map handles unknown sessions, missing parents, duplicate sessions and parent cycles', () => {
  assert.deepEqual(resolveAgentMapFamily([], 'missing').entries.map(entry => [entry.id, entry.depth, entry.info]), [['missing', 0, undefined]])
  const orphan = resolveAgentMapFamily([session('orphan', { parentID: 'missing' }), session('child', { parentID: 'orphan' })], 'child')
  assert.equal(orphan.rootID, 'orphan')
  assert.deepEqual(orphan.entries.map(entry => entry.id), ['orphan', 'child'])
  const family = resolveAgentMapFamily([session('a', { parentID: 'b' }), session('b', { parentID: 'a' }), session('b', { parentID: 'a', title: 'Latest B' })], 'a', 2)
  assert.equal(family.rootID, 'b')
  assert.deepEqual(family.entries.map(entry => entry.id), ['b', 'a'])
  assert.equal(family.entries[0].info?.title, 'Latest B')
  assert.equal(family.limited, false, 'already-seen queued cycle is not truncation')
  assert.equal(resolveAgentMapFamily([session('self', { parentID: 'self' })], 'self').entries.length, 1)
})

test('agent map caps BFS nodes and filters child references to selected entries', () => {
  const sessions = [session('root'), ...Array.from({ length: 205 }, (_, i) => session(`child-${String(i).padStart(3, '0')}`, { parentID: 'root' }))]
  const family = resolveAgentMapFamily(sessions, 'root')
  assert.equal(family.entries.length, 200)
  assert.equal(family.limited, true)
  assert.equal(family.entries[0].childIDs.length, 199)
  const selected = new Set(family.entries.map(entry => entry.id))
  assert.ok(family.entries.every(entry => entry.childIDs.every(id => selected.has(id))))
  assert.equal(resolveAgentMapFamily(sessions, 'root', 206).limited, false)
  assert.deepEqual(resolveAgentMapFamily(sessions, 'root', 0), { rootID: 'root', entries: [], limited: true })
})

test('agent map deduplicates and orders prompts, preserves first/latest prompts and ignores blank user turns', () => {
  const first = message('first', 'user', { text: ' first prompt ', time: { created: 1 } })
  const latest = message('latest', 'user', { text: 'latest prompt', time: { created: 3 } })
  const node = summarize([latest, message('blank', 'user', { text: '  ', time: { created: 2 } }), first, latest])
  assert.equal(node.prompt, ' first prompt ')
  assert.equal(node.latestPrompt, 'latest prompt')
  assert.equal(node.promptCount, 2)
  assert.equal(summarize([first, message('again', 'user', { text: ' first prompt ' })]).latestPrompt, undefined)
  assert.equal(summarize([first]).latestPrompt, undefined)
})

test('agent map uses non-subagent synthetic prompts then uniquely matching parent task/subagent input', () => {
  const notifications = [message('notification', 'synthetic', { text: 'not input', metadata: { source: 'subagent' } }), message('blank', 'synthetic', { text: ' ' }), message('synthetic', 'synthetic', { text: 'synthetic input' })]
  assert.equal(summarize(notifications).prompt, 'synthetic input')
  assert.equal(summarize(notifications.slice(0, 1)).prompt, '')
  const parentMessages = [assistant('parent', { content: [tool('subagent', 'completed', { description: 'child title', agent: 'worker', prompt: 'exact title input' }), tool('TASK', 'completed', { description: 'other', agent: 'other-agent', prompt: 'agent input' }), tool('read', 'completed', { description: 'child title', prompt: 'not a spawn' }), tool('task', 'streaming', '{"prompt":'), tool('task', 'completed', null)] })]
  assert.equal(summarize([], { info: session('child', { title: 'child title', agent: 'worker' }), parentMessages }).prompt, 'exact title input')
  assert.equal(summarize([], { info: session('child', { title: 'unmatched', agent: 'other-agent' }), parentMessages }).prompt, 'agent input')
  const ambiguous = [assistant('ambiguous', { content: [tool('task', 'completed', { description: 'same', agent: 'same', prompt: 'one' }), tool('task', 'completed', { description: 'same', agent: 'same', prompt: 'two' })] })]
  assert.equal(summarize([], { info: session('child', { title: 'same', agent: 'same' }), parentMessages: ambiguous }).prompt, '')
  assert.equal(summarize([message('user', 'user', { text: 'user wins' }), ...notifications], { parentMessages }).prompt, 'user wins')
})

test('agent map selects latest nonblank assistant text, overlays only longer running live text and reports errors/outcome', () => {
  const history = [assistant('old', { time: { created: 1 }, content: [text('old output')] }), assistant('latest-text', { time: { created: 2 }, content: [text('first part'), { type: 'reasoning', text: 'private reasoning' }, text('second part')] }), assistant('tool-only', { time: { created: 3 }, content: [text(' '), tool('read')], error: { message: 'assistant failed', type: 'Failure' } }), message('idle', 'idle', { time: { created: 4 }, outcome: 'failed', error: { message: 'idle failed', type: 'IdleFailure' } })]
  const node = summarize([...history].reverse())
  assert.equal(node.output, 'first part\n\nsecond part')
  assert.equal(node.error, 'assistant failed')
  assert.equal(node.outcome, 'failed')
  const running = session('root', { time: { created: 1, busy: 10, idle: 5 } })
  const liveText = '  a much longer live streaming output  '
  assert.equal(summarize(history, { info: running, liveText }).output, liveText.trim())
  assert.equal(summarize(history, { info: running, liveText: 'short' }).output, node.output)
  assert.equal(summarize(history, { info: session('root'), liveText }).output, node.output)
  assert.equal(summarize([], { info: running, liveText: ' live only ' }).output, 'live only')
  assert.equal(summarize(history, { info: running }).outcome, undefined)
  assert.equal(summarize(history, { info: { ...running, outcome: 'interrupted' } }).outcome, 'interrupted')
  assert.equal(summarize([message('idle', 'idle', { error: { type: 'IdleFailure' } })]).error, 'IdleFailure')
  assert.equal(summarize([assistant('failed', { error: { type: 'AssistantFailure' } })]).error, 'AssistantFailure')
  assert.equal(summarize([message('old-idle', 'idle', { time: { created: 1 }, error: { type: 'OldError' } }), message('new-idle', 'idle', { time: { created: 2 } })]).error, undefined)
})

test('agent map bounds prompts, latest prompts, synthetic/parent inputs and output without splitting UTF-16 pairs', () => {
  for (const limit of [0, 1, 32768, 65536]) {
    const value = 'x'.repeat(Math.max(0, limit - 1)) + '😀tail'
    const result = truncateSafe(value, limit)
    assert.ok(result.length <= limit)
    assert.doesNotMatch(result, /[\uD800-\uDBFF]$/)
  }
  assert.equal(truncateSafe('😀', 2), '😀')
  const longPrompt = 'x'.repeat(32767) + '😀tail'
  const longOutput = 'x'.repeat(65535) + '😀tail'
  const node = summarize([message('u1', 'user', { text: longPrompt }), message('u2', 'user', { text: longPrompt + 'latest' }), assistant('a', { content: [text(longOutput)] })])
  assert.equal(node.prompt.length, 32767)
  assert.equal(node.latestPrompt?.length, 32767)
  assert.equal(node.output.length, 65535)
  assert.equal(summarize([message('s', 'synthetic', { text: longPrompt })]).prompt.length, 32767)
  assert.equal(summarize([], { info: session('c'), parentMessages: [assistant('p', { content: [tool('task', 'completed', { description: 'c', prompt: longPrompt })] })] }).prompt.length, 32767)
})

test('agent map combines explicit skills and inferred mentions without double counting; aggregates all tool states', () => {
  const a = assistant('a', { content: [tool('skill', 'completed', { name: ' android-dev ' }), tool('skill', 'completed', { skill: 'tool-only' }), tool('read', 'running', {}, { created: 1 }), tool('read', 'streaming', {}, { created: 1 }), tool('read', 'error', {}, { created: 10, completed: 5 }), tool('read', 'completed', {}, { created: 10, completed: 25 }), tool('edit', 'error')] })
  const history = [message('u', 'user', { text: '/android-dev', skills: [{ name: 'android-dev', id: 'duplicate' }, { id: 'user-only' }] }), a, message('s1', 'skill', { name: 'android-dev', skill: 'id' }), message('s2', 'skill', { name: ' android-dev ', skill: 'id' }), message('s3', 'skill', { name: '', skill: 'fallback' }), a]
  const node = summarize(history)
  assert.deepEqual(node.skills, [{ name: 'android-dev', count: 2 }, { name: 'fallback', count: 1 }, { name: 'tool-only', count: 1 }, { name: 'user-only', count: 1 }])
  assert.deepEqual(node.tools, [{ name: 'read', calls: 4, errors: 1, running: 2, durationMs: 15 }, { name: 'skill', calls: 2, errors: 0, running: 0, durationMs: 60 }, { name: 'edit', calls: 1, errors: 1, running: 0, durationMs: 30 }])
  assert.equal(node.status, 'running', 'tool state is fallback only without session info')
  assert.equal(summarize(history, { info: session('root') }).status, 'idle')
})

test('agent map token totals prefer session counters; otherwise sum valid deduplicated assistant counters only', () => {
  const a = assistant('a', { tokens: tokens(1) })
  const history = [a, a, assistant('b', { tokens: tokens(10, Number.NaN, -1, Number.POSITIVE_INFINITY, 1) }), message('u', 'user', { text: 'input', tokens: tokens(999) })]
  assert.deepEqual(summarize(history).tokens, { input: 11, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 6, total: 26 })
  assert.deepEqual(summarize(history, { info: session('root', { tokens: tokens(100) }) }).tokens, { input: 100, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, total: 114 })
  assert.equal(summarize(history, { info: session('root', { tokens: tokens(0, 0, 0, 0, 0) }) }).tokens.total, 26)
  assert.equal(summarize(history, { info: session('root', { tokens: tokens(0, 0, 0, 0, 7) }) }).tokens.total, 7)
})

test('agent map duration distinguishes running, child wall-clock, root completed assistant time and fallbacks', () => {
  const a = assistant('a', { time: { created: 100, completed: 150 } })
  const history = [a, a, assistant('b', { time: { created: 200, completed: 280 } }), assistant('unfinished', { time: { created: 300 } }), assistant('negative', { time: { created: 400, completed: 350 } })]
  assert.equal(summarize(history).durationMs, 130)
  const info = session('root', { time: { created: 10, updated: 900, busy: 200, idle: 800 } })
  assert.equal(summarize(history, { info }).durationMs, 130)
  assert.equal(summarize(history, { info, depth: 1 }).durationMs, 790)
  assert.equal(summarize([], { info }).durationMs, 600)
  assert.equal(summarize([], { info: session('root') }).durationMs, 800)
  assert.equal(summarize([], { info: session('c', { time: { created: 10, updated: 70 } }), depth: 1 }).durationMs, 60)
  assert.equal(summarize(history, { info: session('c', { time: { created: 100, idle: 20 } }), depth: 1 }).durationMs, 130)
  assert.equal(summarize([], { info: session('c', { time: { created: Number.NaN, updated: 200 } }), depth: 1 }).durationMs, undefined)
  assert.equal(summarize([], { info: session('c', { time: { created: 100, idle: 100 } }), depth: 1 }).durationMs, 0)
  assert.equal(summarize(history, { info: session('running', { time: { created: 10, busy: 900, idle: 800 } }) }).durationMs, 100)
  assert.equal(summarize([], { info: session('future', { time: { busy: 1100 } }) }).durationMs, 0)
  assert.equal(summarize(history, { info: session('no-start', { time: { created: 300 } }), liveText: '' }).durationMs, 130)
  assert.equal(summarize([assistant('tool', { content: [tool('read', 'running')] })]).durationMs, undefined)
  assert.equal(summarize([a, assistant('tool', { content: [tool('read', 'running')] })]).durationMs, 50)
})

test('agent map metadata precedence and build maps preserve bounded links, partial history and live overlays', () => {
  const selected = [message('agent', 'agent-switched', { agent: 'switched' }), message('model', 'model-switched', { model: { id: 'switched-model', providerID: 'switched-provider' } })]
  assert.equal(summarize().title, 'Untitled')
  assert.equal(summarize().agent, 'default')
  assert.equal(summarize(selected).agent, 'switched')
  assert.equal(summarize(selected).model, 'switched-model')
  const a = assistant('a')
  assert.equal(summarize([...selected, a], { info: session('r', { agent: ' info-agent ', title: ' title ', model: { id: 'info-model' } }) }).agent, 'info-agent')
  assert.equal(summarize([...selected, a]).model, 'assistant-model')
  assert.equal(summarize([...selected, a]).providerID, 'local')
  assert.equal(summarize([...selected, a]).variant, 'high')
  assert.equal(summarize([a], { info: session('r', { agent: ' ' }) }).agent, 'assistant-agent')
  assert.equal(summarize([], { info: session('r', { title: ' ', model: { id: 'info-model' } }) }).title, 'builder')
  assert.equal(summarize([], { info: session('r', { model: { id: 'info-model' } }) }).model, 'info-model')
  const family = resolveAgentMapFamily([session('r'), session('c', { parentID: 'r', time: { created: 1, busy: 2 } })], 'c')
  const view = buildAgentMap({ family, activeSessionID: 'c', messagesBySession: new Map([['r', [assistant('p', { content: [tool('task', 'completed', { description: 'c', prompt: 'parent prompt' })] })]]]), historyCompleteBySession: new Map([['c', false]]), liveTextBySession: new Map([['c', 'live result']]), now: 1000 })
  assert.equal(view.nodes[1].prompt, 'parent prompt')
  assert.equal(view.nodes[1].output, 'live result')
  assert.equal(view.nodes[1].historyComplete, false)
  assert.equal(view.nodes[1].spawnedByTitle, 'r')
  assert.equal(view.nodes[1].createdAt, 1)
})

async function mockAdapter(route: (url: URL, init: RequestInit) => Promise<Response> | Response, events: object[] = []) {
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode([{ type: 'server.connected' }, ...events].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
      init.signal?.addEventListener('abort', () => controller.close(), { once: true })
    } }), { headers: { 'content-type': 'text/event-stream' } })
    return route(url, init)
  })
  adapter.attach('project', process.cwd())
  await adapter.connect('http://localhost:4096')
  return adapter
}

test('adapter agentMap rejects foreign ownership before listing or reading history', async () => {
  const requests: string[] = []
  const adapter = await mockAdapter(url => {
    requests.push(url.pathname)
    return json({ data: { id: 'foreign', location: { directory: path.join(process.cwd(), 'foreign') } } })
  })
  try {
    await assert.rejects(adapter.agentMap('project', 'foreign'), /SESSION_PROJECT_MISMATCH/)
    assert.deepEqual(requests, ['/api/session/foreign'])
  } finally { adapter.dispose() }
})

test('adapter agentMap paginates, deduplicates sessions, caps concurrency at six, reverses histories and joins live text only', async t => {
  const infos = [session('root'), ...Array.from({ length: 12 }, (_, i) => session(`child-${i}`, { parentID: 'root' }))]
  infos[1] = session('child-0', { parentID: 'root', time: { created: 10, busy: 20 } })
  const cursors: (string | null)[] = [], timeoutCalls: number[] = []
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeoutCalls.push(ms); return originalTimeout(ms) })
  let active = 0, peak = 0, histories = 0
  const adapter = await mockAdapter(async (url, init) => {
    if (url.pathname === '/api/session/child-0') return json({ data: { ...infos[1], location: { directory: process.cwd() } } })
    if (url.pathname === '/api/session') {
      assert.equal(url.searchParams.get('directory'), process.cwd())
      assert.equal(url.searchParams.get('archived'), 'false')
      assert.equal(url.searchParams.get('limit'), '100')
      const cursor = url.searchParams.get('cursor'); cursors.push(cursor)
      return json(cursor ? { data: [...infos.slice(5), { ...infos[0], title: 'updated root' }], cursor: {} } : { data: infos.slice(0, 5), cursor: { next: 'second-page' } })
    }
    if (url.pathname.endsWith('/message')) {
      assert.equal(url.searchParams.get('limit'), '200')
      assert.equal(url.searchParams.get('order'), 'desc')
      assert.ok(init.signal instanceof AbortSignal)
      active++; peak = Math.max(peak, active); histories++
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      const id = url.pathname.split('/')[3]
      return json({ data: [message('u2', 'user', { text: 'second', time: { created: 20 } }), message('u1', 'user', { text: 'first', time: { created: 10 } })], cursor: id === 'child-0' ? { next: 'older' } : {} })
    }
    throw new Error(`Unexpected ${url.pathname}`)
  }, [
    { type: 'session.text.delta', location: { directory: process.cwd() }, data: { sessionID: 'child-0', assistantMessageID: 'a', ordinal: 0, delta: 'first live' } },
    { type: 'session.text.delta', location: { directory: process.cwd() }, data: { sessionID: 'child-0', assistantMessageID: 'a', ordinal: 1, delta: 'second live' } },
  ])
  try {
    const view = await adapter.agentMap('project', 'child-0')
    assert.deepEqual(cursors, [null, 'second-page'])
    assert.equal(histories, 13)
    assert.equal(peak, 6)
    assert.equal(view.rootID, 'root')
    assert.equal(view.nodes[0].title, 'updated root')
    const child = view.nodes.find(node => node.id === 'child-0')!
    assert.equal(child.prompt, 'first'); assert.equal(child.latestPrompt, 'second')
    assert.equal(child.historyComplete, false)
    assert.equal(child.output, 'first live\n\nsecond live')
    assert.equal(timeoutCalls.filter(ms => ms === 15000).length, 13)
    assert.equal(view.nodes.filter(node => node.historyComplete).length, 12)
  } finally { adapter.dispose() }
})

test('adapter agentMap detects repeated cursors before fetching histories', async () => {
  let lists = 0
  const adapter = await mockAdapter(url => {
    if (url.pathname === '/api/session/root') return json({ data: { location: { directory: process.cwd() } } })
    assert.equal(url.pathname, '/api/session')
    lists++
    return json({ data: [session('root')], cursor: { next: 'repeated' } })
  })
  try {
    await assert.rejects(adapter.agentMap('project', 'root'), /SESSION_CURSOR_REPEATED/)
    assert.equal(lists, 2)
  } finally { adapter.dispose() }
})

test('adapter agentMap caps fetched histories at 200 and handles an active session absent from listing', async () => {
  let empty = false, histories = 0
  const adapter = await mockAdapter(url => {
    if (url.pathname === '/api/session/root') return json({ data: { location: { directory: process.cwd() } } })
    if (url.pathname === '/api/session') return json({ data: empty ? [] : [session('root'), ...Array.from({ length: 201 }, (_, i) => session(`child-${i}`, { parentID: 'root' }))], cursor: {} })
    histories++
    return json({ data: [], cursor: {} })
  })
  try {
    const view = await adapter.agentMap('project', 'root')
    assert.equal(histories, 200)
    assert.equal(view.nodes.length, 200)
    assert.equal(view.limited, true)
    empty = true
    const missing = await adapter.agentMap('project', 'root')
    assert.equal(missing.nodes.length, 1)
    assert.equal(missing.nodes[0].id, 'root')
    assert.equal(missing.nodes[0].title, 'Untitled')
  } finally { adapter.dispose() }
})

test('adapter agentMap propagates history deadline cancellation using the 15-second AbortSignal', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  let timedSignal: AbortSignal | undefined
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const signal = originalTimeout(ms === 15000 ? 10 : ms)
    if (ms === 15000) timedSignal = signal
    return signal
  })
  const adapter = await mockAdapter(async (url, init) => {
    if (url.pathname === '/api/session/root') return json({ data: { location: { directory: process.cwd() } } })
    if (url.pathname === '/api/session') return json({ data: [session('root')], cursor: {} })
    assert.equal(url.pathname, '/api/session/root/message')
    assert.equal(init.signal, timedSignal)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1000)
      init.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason) }, { once: true })
    })
    throw new Error('deadline failed to abort')
  })
  try {
    await assert.rejects(adapter.agentMap('project', 'root'))
    assert.equal(timedSignal?.aborted, true)
    assert.equal(timedSignal?.reason.name, 'TimeoutError')
  } finally { adapter.dispose() }
})

// Local scripted inference drives the actual bundled scheduler; no external model or credentials.
test('bundled OpenCode 2.3.2 agentMap exposes real nested prompts, output, tokens and tools from deepest child', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-map-native-'))
  const project = path.join(root, 'project')
  let runtime: PrivateRuntime | undefined
  let adapter: OpenCodeAdapter | undefined
  const calls = new Map<number, number>(), errors: Error[] = []
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString())
      const depth = Number(input.model.split('-').at(-1))
      assert.ok(depth >= 0 && depth <= 2)
      const body = JSON.stringify(input.messages)
      const auxiliary = !input.tools
      const count = calls.get(depth) ?? 0
      if (!auxiliary) calls.set(depth, count + 1)
      let content: string | null = null
      let call: { id: string; type: string; function: { name: string; arguments: string } } | undefined
      if (auxiliary) content = 'Agent map native fixture'
      else if (count === 0 && depth < 2) {
        assert.ok(input.tools.some((item: { function: { name: string } }) => item.function.name === 'subagent'))
        call = { id: `call_map_${depth}`, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ agent: `map-${depth + 1}`, description: `Map child ${depth + 1}`, prompt: `Execute map prompt ${depth + 1}.` }) } }
      } else if (depth === 2 || body.includes('state=\\"completed\\"') && body.includes(`MAP_RESULT_${depth + 1}`)) content = `MAP_RESULT_${depth}`
      else content = 'Waiting for child completion.'
      const finish = call ? 'tool_calls' : 'stop'
      const usage = { prompt_tokens: 10 + depth, completion_tokens: 5 + depth, total_tokens: 15 + 2 * depth }
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content }
        res.write(`data: ${JSON.stringify({ id: `map-${depth}-${count}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.end(`data: ${JSON.stringify({ id: `map-${depth}-${count}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `map-${depth}-${count}`, object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message: { role: 'assistant', content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: finish }], usage }))
      }
    } catch (error) { errors.push(error as Error); res.writeHead(500); res.end('fixture failed') }
  })
  try {
    await mkdir(path.join(project, '.opencode', 'agents'), { recursive: true })
    for (let depth = 0; depth <= 2; depth++) await writeFile(path.join(project, '.opencode', 'agents', `map-${depth}.md`), `---\ndescription: Local agent map fixture ${depth}\nmode: all\nmodel: amecode/map-${depth}\npermissions: [{"action":"*","resource":"*","effect":"deny"},{"action":"subagent","resource":"map-*","effect":"allow"}]\n---\nExecute the isolated map fixture.\n`)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as import('node:net').AddressInfo).port
    runtime = new PrivateRuntime({ resources: path.resolve('resources'), profile: path.join(root, 'profile') })
    const endpoint = await runtime.start()
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers })
    const models = Array.from({ length: 3 }, (_, depth) => ({ id: `map-${depth}`, name: `Map ${depth}`, tool_call: true, vision: false, context: 200000, output: 4096 }))
    const response = await fetch(`${endpoint.url}/api/rpc/amekit-models/update`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: { role: 'admin', catalog: { version: 'fixture', default_model: 'map-0', small_model: 'map-0', models }, provider: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'local-test-only' }, expires: Date.now() + 85000 } }) })
    assert.equal(response.status, 200)
    const initial = await client.session.create({ location: { directory: project }, agent: 'map-0', model: { providerID: 'amecode', id: 'map-0' } })
    await client.session.update({ sessionID: initial.id, title: 'Map root' })
    await client.session.prompt({ sessionID: initial.id, text: 'Execute map prompt 0.' })
    const deadline = Date.now() + 55000
    let sessions: SessionInfo[] = []
    for (;;) {
      if (errors.length) throw errors[0]
      sessions = (await client.session.list({ directory: project })).data
      const history = (await client.message.list({ sessionID: initial.id })).data
      if (sessions.length === 3 && sessions.every(info => info.time.idle !== undefined && info.time.idle >= (info.time.busy ?? 0)) && history.some(item => item.type === 'assistant' && item.content.some(part => part.type === 'text' && part.text === 'MAP_RESULT_0'))) break
      if (Date.now() >= deadline) throw new Error(`Native agent map timed out: ${JSON.stringify({ calls: [...calls], sessions, history })}`)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    const deepest = sessions.find(info => info.agent === 'map-2')!
    assert.ok(deepest)
    adapter = new OpenCodeAdapter(() => {})
    adapter.attach('native', project)
    await adapter.connect(endpoint.url, endpoint.username, endpoint.password)
    const view = await adapter.agentMap('native', deepest.id)
    assert.equal(view.rootID, initial.id)
    assert.equal(view.activeSessionID, deepest.id)
    assert.equal(view.limited, false)
    assert.deepEqual(view.nodes.map(node => node.depth), [0, 1, 2])
    for (const [depth, node] of view.nodes.entries()) {
      const info = sessions.find(item => item.id === node.id)!
      assert.equal(node.title, info.title)
      assert.equal(node.agent, `map-${depth}`)
      assert.equal(node.model, `map-${depth}`)
      assert.equal(node.providerID, 'amecode')
      assert.equal(node.status, 'idle')
      assert.equal(node.outcome, 'succeeded')
      const nativeHistory = await client.message.list({ sessionID: node.id, limit: 200, order: 'desc' })
      const chronological = [...nativeHistory.data].reverse()
      const nativePrompt = chronological.find(item => item.type === 'user' && item.text.trim())
        ?? chronological.find(item => item.type === 'synthetic' && item.metadata?.source !== 'subagent' && item.text.trim())
      assert.ok(nativePrompt && (nativePrompt.type === 'user' || nativePrompt.type === 'synthetic'))
      assert.equal(node.prompt, nativePrompt.text)
      assert.ok(node.prompt.includes(`Execute map prompt ${depth}.`))
      assert.equal(node.output, `MAP_RESULT_${depth}`)
      assert.equal(node.historyComplete, !nativeHistory.cursor.next)
      assert.ok(node.tokens.total > 0)
      assert.deepEqual(node.tokens, { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning, cacheRead: info.tokens.cache.read, cacheWrite: info.tokens.cache.write, total: info.tokens.input + info.tokens.output + info.tokens.reasoning + info.tokens.cache.read + info.tokens.cache.write })
      assert.ok(node.durationMs !== undefined && node.durationMs >= 0)
      if (depth > 0) {
        assert.equal(node.parentID, view.nodes[depth - 1].id)
        assert.equal(node.spawnedByTitle, view.nodes[depth - 1].title)
        assert.equal(node.spawnedByAgent, `map-${depth - 1}`)
      }
      assert.deepEqual(node.childIDs, depth < 2 ? [view.nodes[depth + 1].id] : [])
      if (depth < 2) assert.ok(node.tools.some(item => item.name === 'subagent' && item.calls === 1 && item.errors === 0 && item.running === 0))
    }
    assert.deepEqual(errors, [])
  } finally {
    adapter?.dispose()
    await runtime?.stop()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
