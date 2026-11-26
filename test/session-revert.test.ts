import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCode, type SessionMessageInfo } from '@opencode/client'
import { OpenCodeAdapter } from '../packages/opencode-adapter/src/index'
import { PrivateRuntime } from '../packages/opencode-adapter/src/runtime'
import type { IdeEvent } from '../packages/protocol/src/index'

const runtimeBin = path.resolve('resources', 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const prepared = await Promise.all([access(runtimeBin), access(path.resolve('resources', 'amekit-models', 'server.js'))]).then(() => true, () => false)

async function fixture(git: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-session-revert-'))
  const project = path.join(root, 'project')
  await mkdir(path.join(project, '.opencode', 'agents'), { recursive: true })
  await writeFile(path.join(project, '.opencode', 'agents', 'rewind-fixture.md'), '---\ndescription: Local rewind fixture\nmode: all\nmodel: amecode/rewind-fixture\npermissions: [{"action":"*","resource":"*","effect":"deny"},{"action":"edit","resource":"*","effect":"allow"}]\n---\nUse the write tool.\n')
  if (git) {
    execFileSync('git', ['init', '--quiet', project])
    execFileSync('git', ['add', '.'], { cwd: project })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'Fixture'], { cwd: project })
  }
  let turn = 0, calls = 0
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const errors: Error[] = [], events: IdeEvent[] = []
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString())
      if (input.tools && gate) await gate
      const useTool = input.tools && turn <= 2 && calls++ === 0
      const name = input.tools?.find((tool: { function: { name: string } }) => tool.function.name === 'write')?.function.name
      if (useTool) assert.ok(name)
      const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: `write-${turn}`, type: 'function', function: { name, arguments: JSON.stringify({ path: 'note.txt', content: `v${turn}\n` }) } }] } : { role: 'assistant', content: input.tools ? `DONE_${turn}` : 'Rewind fixture' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ id: `fixture-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `fixture-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    } catch (error) { errors.push(error as Error); res.writeHead(500); res.end('fixture failed') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const runtime = new PrivateRuntime({ resources: path.resolve('resources'), profile: path.join(root, 'profile') })
  const adapter = new OpenCodeAdapter(event => events.push(event))
  const reconnects: OpenCodeAdapter[] = []
  const close = async () => {
    release?.(); reconnects.forEach(item => item.dispose()); adapter.dispose(); await runtime.stop()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  try {
    const endpoint = await runtime.start()
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers })
    const response = await fetch(`${endpoint.url}/api/rpc/amekit-models/update`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: { role: 'admin', catalog: { version: 'fixture', default_model: 'rewind-fixture', small_model: 'rewind-fixture', models: [{ id: 'rewind-fixture', name: 'Fixture', tool_call: true, vision: false, context: 200000, output: 4096 }] }, provider: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'local-test-only' }, expires: Date.now() + 85000 } }) })
    assert.equal(response.status, 200)
    adapter.attach('p', project); await adapter.connect(endpoint.url, endpoint.username, endpoint.password)
    const session = await client.session.create({ location: { directory: project }, agent: 'rewind-fixture', model: { providerID: 'amecode', id: 'rewind-fixture' } })
    const history = async () => (await client.message.list({ sessionID: session.id, order: 'asc' })).data
    const waitIdle = async () => {
      const deadline = Date.now() + 25000
      for (;;) {
        if (errors.length) throw errors[0]
        const info = await client.session.get({ sessionID: session.id })
        const messages = await history()
        if (info.time?.idle !== undefined && (info.time.busy === undefined || info.time.idle >= info.time.busy) && messages.at(-1)?.type === 'idle') return messages
        if (Date.now() > deadline) throw new Error(`Rewind fixture timeout: ${JSON.stringify(messages)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const prompt = async (number: number) => {
      turn = number; calls = 0
      await adapter.prompt('p', session.id, `TURN_${number}`, { id: 'rewind-fixture', providerID: 'amecode', name: 'Fixture' })
    }
    return { adapter, client, session, events, project, close, history, waitIdle, prompt,
      disk: () => readFile(path.join(project, 'note.txt'), 'utf8'),
      reconnect: async () => { const next = new OpenCodeAdapter(() => {}); reconnects.push(next); next.attach('p', project); await next.connect(endpoint.url, endpoint.username, endpoint.password); return next },
      block: () => { gate = new Promise<void>(resolve => { release = resolve }) },
      unblock: () => { release?.(); gate = undefined },
    }
  } catch (error) { await close(); throw error }
}

const users = (history: SessionMessageInfo[]) => history.filter(message => message.type === 'user')

test('native Rewind stages, persists, clears and auto-commits Git conversation and file changes', { skip: !prepared, timeout: 90000 }, async () => {
  const f = await fixture(true)
  try {
    await f.prompt(1); await f.waitIdle(); assert.equal(await f.disk(), 'v1\n')
    await f.prompt(2); const history = await f.waitIdle(); assert.equal(await f.disk(), 'v2\n')
    const boundary = users(history)[1].id
    await f.adapter.stageRevert('p', f.session.id, boundary, false)
    assert.equal(await f.disk(), 'v2\n')
    assert.equal((await f.client.session.get({ sessionID: f.session.id })).revert?.messageID, boundary)
    assert.equal((await f.adapter.sessions('p')).find(s => s.id === f.session.id)?.revert?.messageID, boundary)
    assert.equal((await (await f.reconnect()).sessions('p')).find(s => s.id === f.session.id)?.revert?.messageID, boundary)
    await f.adapter.clearRevert('p', f.session.id)
    assert.equal((await f.client.session.get({ sessionID: f.session.id })).revert, undefined)
    assert.equal(await f.disk(), 'v2\n')
    f.events.length = 0
    const revert = await f.adapter.stageRevert('p', f.session.id, boundary, true)
    assert.ok(revert.snapshot); assert.ok(revert.files?.some(file => file.file === 'note.txt'))
    assert.equal(await f.disk(), 'v1\n')
    const diffs = await f.adapter.sessionDiff('p', f.session.id)
    assert.deepEqual(diffs.map(file => file.file), ['note.txt'])
    assert.match(diffs[0].patch, /\+v1/); assert.doesNotMatch(diffs[0].patch, /\+v2/)
    assert.ok(f.events.some(event => event.type === 'files')); assert.ok(f.events.some(event => event.type === 'opencode'))
    f.events.length = 0
    await f.adapter.clearRevert('p', f.session.id)
    assert.equal(await f.disk(), 'v2\n')
    assert.equal((await f.client.session.get({ sessionID: f.session.id })).revert, undefined)
    assert.ok(f.events.some(event => event.type === 'files')); assert.ok(f.events.some(event => event.type === 'opencode'))
    await f.adapter.stageRevert('p', f.session.id, boundary, true)
    await f.prompt(3); const after = await f.waitIdle()
    assert.equal((await f.client.session.get({ sessionID: f.session.id })).revert, undefined)
    assert.equal(await f.disk(), 'v1\n')
    assert.ok(!after.some(message => message.id === boundary))
    assert.equal(users(after).length, 2)
    assert.ok(JSON.stringify(after).includes('TURN_3'))
  } finally { await f.close() }
})

test('native Rewind supports non-Git conversation fallback and rejects child and busy sessions', { skip: !prepared, timeout: 90000 }, async () => {
  const f = await fixture(false)
  try {
    await f.prompt(1); const history = await f.waitIdle()
    const boundary = users(history)[0].id
    const revert = await f.adapter.stageRevert('p', f.session.id, boundary, true)
    assert.equal(revert.snapshot, undefined); assert.deepEqual(revert.files, [])
    assert.equal(await f.disk(), 'v1\n')
    assert.deepEqual(await f.adapter.sessionDiff('p', f.session.id), [])
    await f.adapter.clearRevert('p', f.session.id)
    const child = await f.client.session.create({ location: { directory: f.project }, parentID: f.session.id })
    await assert.rejects(f.adapter.stageRevert('p', child.id, boundary, true), /REVERT_CHILD_UNSUPPORTED/)
    await assert.rejects(f.adapter.clearRevert('p', child.id), /REVERT_CHILD_UNSUPPORTED/)
    await assert.rejects(f.adapter.stageRevert('p', f.session.id, ' ', true), /INVALID_MESSAGE_ID/)
    await assert.rejects(f.adapter.stageRevert('p', f.session.id, boundary, 'true' as unknown as boolean), /INVALID_REVERT_OPTIONS/)
    f.block(); await f.prompt(3)
    await assert.rejects(f.adapter.stageRevert('p', f.session.id, boundary, true), /SESSION_BUSY/)
    await assert.rejects(f.adapter.clearRevert('p', f.session.id), /SESSION_BUSY/)
    f.unblock(); await f.waitIdle()
  } finally { await f.close() }
})
