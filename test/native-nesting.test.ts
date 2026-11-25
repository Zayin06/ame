import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCode, type SessionMessageInfo } from '@opencode/client'
import { PrivateRuntime } from '../packages/opencode-adapter/src/runtime'

const runtimeBin = path.resolve('resources', 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const serverJs = path.resolve('resources', 'amekit-models', 'server.js')
const prepared = await Promise.all([access(runtimeBin), access(serverJs)]).then(() => true, () => false)

// A local scripted model exercises the bundled scheduler, tools and completion inbox without external inference.
test('bundled native subagent runs depths 0–3, rejects depth 4 and delivers final results through every parent', { skip: !prepared, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-native-nesting-'))
  const project = path.join(root, 'project')
  await mkdir(path.join(project, '.opencode', 'agents'), { recursive: true })
  for (let depth = 0; depth <= 3; depth++) await writeFile(path.join(project, '.opencode', 'agents', `nesting-${depth}.md`), `---\ndescription: Isolated native nesting fixture ${depth}\nmode: all\nmodel: amecode/nesting-${depth}\npermissions: [{"action":"*","resource":"*","effect":"deny"},{"action":"subagent","resource":"nesting-*","effect":"allow"}]\n---\nLocal deterministic scheduler test.\n`)
  const calls = new Map<number, number>(), requests: { depth: number; body: string }[] = []
  const errors: Error[] = []
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString())
      const depth = Number(input.model.split('-').at(-1))
      assert.ok(depth >= 0 && depth <= 3)
      const body = JSON.stringify(input.messages)
      requests.push({ depth, body })
      const auxiliary = !input.tools
      const count = calls.get(depth) ?? 0
      if (!auxiliary) calls.set(depth, count + 1)
      let content: string | null = null
      let tool: { id: string; type: string; function: { name: string; arguments: string } } | undefined
      if (auxiliary) content = 'Native nesting test'
      else if (count === 0) {
        const name = input.tools?.find((tool: { function: { name: string } }) => tool.function.name === 'subagent')?.function.name
        assert.ok(name, `native subagent tool must be advertised: ${JSON.stringify(input.tools?.map((t: { function: { name: string } }) => t.function.name))}`)
        tool = { id: `call_depth_${depth}`, type: 'function', function: { name, arguments: JSON.stringify({ agent: `nesting-${Math.min(depth + 1, 3)}`, description: `Native child depth ${depth + 1}`, prompt: 'Execute the isolated nesting fixture.' }) } }
      } else if (depth === 3) {
        assert.match(body, /Subagent depth limit reached \(3\)/)
        content = 'NATIVE_RECEIPT_3_DEPTH_BLOCKED'
      } else if (body.includes('state=\\"completed\\"') && body.includes(`NATIVE_RECEIPT_${depth + 1}`)) {
        content = `NATIVE_RECEIPT_${depth}`
      } else content = 'Waiting for native completion.'
      const finish = tool ? 'tool_calls' : 'stop'
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : { role: 'assistant', content }
        res.write(`data: ${JSON.stringify({ id: `chat-${depth}-${count}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: `chat-${depth}-${count}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `chat-${depth}-${count}`, object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message: { role: 'assistant', content, ...(tool ? { tool_calls: [tool] } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
    } catch (error) { errors.push(error as Error); res.writeHead(500); res.end('fixture failed') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const runtime = new PrivateRuntime({ resources: path.resolve('resources'), profile: path.join(root, 'profile') })
  try {
    const endpoint = await runtime.start()
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers })
    const models = Array.from({ length: 4 }, (_, depth) => ({ id: `nesting-${depth}`, name: `Nesting ${depth}`, tool_call: true, vision: false, context: 200000, output: 4096 }))
    const response = await fetch(`${endpoint.url}/api/rpc/amekit-models/update`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: { role: 'admin', catalog: { version: 'fixture', default_model: 'nesting-0', small_model: 'nesting-0', models }, provider: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'local-test-only' }, expires: Date.now() + 85000 } }) })
    assert.equal(response.status, 200)
    const session = await client.session.create({ location: { directory: project }, agent: 'nesting-0', model: { providerID: 'amecode', id: 'nesting-0' } })
    await client.session.prompt({ sessionID: session.id, text: 'Execute the isolated nesting fixture.' })
    let sessions = (await client.session.list({ directory: project })).data
    let messages: SessionMessageInfo[] = []
    const deadline = Date.now() + 55000
    for (;;) {
      if (errors.length) throw errors[0]
      sessions = (await client.session.list({ directory: project })).data
      messages = (await client.message.list({ sessionID: session.id })).data
      if (messages.some(m => m.type === 'assistant' && m.content.some(c => c.type === 'text' && c.text === 'NATIVE_RECEIPT_0')) && sessions.every(s => s.time.idle !== undefined && s.time.idle >= (s.time.busy ?? 0))) break
      if (Date.now() >= deadline) throw new Error(`Native completion timed out: ${JSON.stringify({ calls: [...calls], sessions: sessions.map(s => ({ id: s.id, parentID: s.parentID, outcome: s.outcome })), messages })}`)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    assert.equal(sessions.length, 4, 'depth limit must prevent creation of a fifth session')
    let parent = session
    for (let depth = 0; depth <= 3; depth++) {
      assert.equal(parent.agent, `nesting-${depth}`)
      assert.equal(sessions.find(s => s.id === parent.id)?.outcome, 'succeeded')
      const history = (await client.message.list({ sessionID: parent.id })).data
      const tools = history.flatMap(m => m.type === 'assistant' ? m.content.filter(c => c.type === 'tool') : [])
      if (depth < 3) {
        assert.ok(tools.some(t => t.name === 'subagent' && t.state.status === 'completed'))
        assert.ok(history.some(m => m.type === 'synthetic' && m.metadata?.source === 'subagent' && m.text.includes('state="completed"') && m.text.includes(`NATIVE_RECEIPT_${depth + 1}`)), `native final completion must reach parent at depth ${depth}`)
        parent = sessions.find(s => s.parentID === parent.id)!
        assert.ok(parent)
      } else assert.ok(tools.some(t => t.name === 'subagent' && t.state.status === 'error'))
    }
    assert.ok(requests.some(r => r.depth === 3 && r.body.includes('Subagent depth limit reached (3)')))
    assert.deepEqual(errors, [])
  } finally {
    await runtime.stop()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
