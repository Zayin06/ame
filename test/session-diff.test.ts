import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCode, type SessionMessageInfo } from '@opencode/client'
import { OpenCodeAdapter, normalizeMessages } from '../packages/opencode-adapter/src/index'
import { PrivateRuntime } from '../packages/opencode-adapter/src/runtime'

const runtimeBin = path.resolve('resources', 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const serverJs = path.resolve('resources', 'amekit-models', 'server.js')
const prepared = await Promise.all([access(runtimeBin), access(serverJs)]).then(() => true, () => false)

test('native snapshot API isolates whole-session and per-turn edits from pre-existing Git changes', { skip: !prepared, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-session-diff-'))
  const project = path.join(root, 'project')
  await mkdir(path.join(project, '.opencode', 'agents'), { recursive: true })
  await writeFile(path.join(project, '.opencode', 'agents', 'changes-fixture.md'), '---\ndescription: Local snapshot fixture\nmode: all\nmodel: amecode/changes-fixture\npermissions: [{"action":"*","resource":"*","effect":"deny"},{"action":"edit","resource":"*","effect":"allow"}]\n---\nUse the write tool.\n')
  await writeFile(path.join(project, 'unrelated.ts'), 'original\n')
  execFileSync('git', ['init', '--quiet', project])
  execFileSync('git', ['add', '.'], { cwd: project })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'Fixture'], { cwd: project })
  await writeFile(path.join(project, 'unrelated.ts'), 'pre-existing Git change\n')
  let turn = 0, calls = 0
  const errors: Error[] = []
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString())
      const name = input.tools?.find((tool: { function: { name: string } }) => tool.function.name === 'write')?.function.name
      const useTool = input.tools && calls++ === 0
      if (useTool) assert.ok(name, 'native write tool is available')
      const tool = { id: `write-${turn}`, type: 'function', function: { name, arguments: JSON.stringify({ path: `turn-${turn}.ts`, content: `export const turn${turn} = ${turn}\n` }) } }
      const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : { role: 'assistant', content: input.tools ? `DONE_${turn}` : 'Snapshot fixture' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ id: `fixture-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `fixture-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    } catch (error) { errors.push(error as Error); res.writeHead(500); res.end('fixture failed') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const runtime = new PrivateRuntime({ resources: path.resolve('resources'), profile: path.join(root, 'profile') })
  const adapter = new OpenCodeAdapter(() => {})
  try {
    const endpoint = await runtime.start()
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers })
    const response = await fetch(`${endpoint.url}/api/rpc/amekit-models/update`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: { role: 'admin', catalog: { version: 'fixture', default_model: 'changes-fixture', small_model: 'changes-fixture', models: [{ id: 'changes-fixture', name: 'Fixture', tool_call: true, vision: false, context: 200000, output: 4096 }] }, provider: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'local-test-only' }, expires: Date.now() + 85000 } }) })
    assert.equal(response.status, 200)
    adapter.attach('p', project); await adapter.connect(endpoint.url, endpoint.username, endpoint.password)
    const session = await client.session.create({ location: { directory: project }, agent: 'changes-fixture', model: { providerID: 'amecode', id: 'changes-fixture' } })
    let history: SessionMessageInfo[] = []
    for (turn = 1; turn <= 2; turn++) {
      calls = 0
      await client.session.prompt({ sessionID: session.id, text: `Create turn-${turn}.ts using write.` })
      const deadline = Date.now() + 25000
      for (;;) {
        if (errors.length) throw errors[0]
        history = (await client.message.list({ sessionID: session.id, order: 'asc' })).data
        if (history.filter(message => message.type === 'idle').length >= turn) break
        if (Date.now() > deadline) throw new Error(`Snapshot fixture timeout: ${JSON.stringify(history)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const summaries = normalizeMessages(history).filter(item => item.turn)
    assert.equal(summaries.length, 2)
    const whole = await adapter.sessionDiff('p', session.id)
    assert.deepEqual(whole.map(file => path.basename(file.file)).sort(), ['turn-1.ts', 'turn-2.ts'])
    for (let index = 0; index < 2; index++) {
      const diffs = await adapter.sessionDiff('p', session.id, summaries[index].turn!.from)
      assert.deepEqual(diffs.map(file => path.basename(file.file)), [`turn-${index + 1}.ts`])
      assert.match(diffs[0].patch, new RegExp(`export const turn${index + 1}`))
    }
    assert.deepEqual((await client.session.diff({ sessionID: session.id })).map(file => path.basename(file.file)), ['turn-2.ts'], 'unbounded upstream API is only the latest turn')
    const empty = await client.session.create({ location: { directory: project } })
    assert.deepEqual(await adapter.sessionDiff('p', empty.id), [])
    assert.deepEqual(errors, [])
  } finally {
    adapter.dispose(); await runtime.stop()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
