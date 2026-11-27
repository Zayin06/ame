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

type ChatMessage = {
  role?: string
  content?: unknown
  tool_call_id?: string
}

type ToolDef = {
  function?: {
    name?: string
    parameters?: {
      properties?: Record<string, unknown>
    }
  }
}

type GuardRecord = {
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  messages: ChatMessage[]
}

test('live runtime enforces tool output guard, forwards affinity headers, and retries mid-stream ECONNRESET once', { skip: !prepared, timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-guard-retry-'))
  const project = path.join(root, 'project')
  await mkdir(path.join(project, '.opencode', 'agents'), { recursive: true })
  await writeFile(
    path.join(project, '.opencode', 'agents', 'guard-retry-fixture.md'),
    '---\ndescription: Guard and retry live fixture\nmode: all\nmodel: amecode/guard-retry-fixture\npermissions: [{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]\n---\nFollow instructions concisely.\n',
  )

  const padding = 'x'.repeat(160)
  for (const name of ['huge-1.txt', 'huge-2.txt', 'huge-3.txt']) {
    const hugeLines = Array.from({ length: 450 }, (_, i) => `line-${String(i).padStart(4, '0')} NEEDLE_GUARD_TOKEN ${padding}`)
    await writeFile(path.join(project, name), hugeLines.join('\n') + '\n')
  }

  let guardSessionID = ''
  let retrySessionID = ''
  const guardRecords: GuardRecord[] = []
  const retryRecords: GuardRecord[] = []
  const errors: Error[] = []

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const sessionHeader = req.headers['x-session-id']
      const sid = typeof sessionHeader === 'string' ? sessionHeader : Array.isArray(sessionHeader) ? sessionHeader[0] ?? '' : ''

      if (!Array.isArray(input.tools) || input.tools.length === 0) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          `data: ${JSON.stringify({ id: 'title', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Guard retry fixture' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: 'title', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
          'data: [DONE]\n\n',
        )
        return
      }

      const record: GuardRecord = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: input,
        messages: Array.isArray(input.messages) ? (input.messages as ChatMessage[]) : [],
      }

      if (sid === retrySessionID) {
        retryRecords.push(record)
        if (retryRecords.length === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.flushHeaders()
          res.write(': keep-alive\n\n')
          const timer = setTimeout(() => res.socket?.destroy(new Error('ECONNRESET')), 30)
          res.once('close', () => clearTimeout(timer))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          `data: ${JSON.stringify({ id: `retry-${retryRecords.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'RECOVERED_AFTER_RESET' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: `retry-${retryRecords.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n` +
          'data: [DONE]\n\n',
        )
        return
      }

      if (sid === guardSessionID) {
        guardRecords.push(record)
        if (guardRecords.length === 1) {
          const tools = input.tools as ToolDef[]
          const readTool = tools.find(tool => tool.function?.name === 'read')
          assert.ok(readTool?.function?.name, 'expected read tool in OpenCode tools')
          const props = readTool.function.parameters?.properties ?? {}
          const pathKey = Object.hasOwn(props, 'filePath') ? 'filePath' : 'path'
          const toolCalls = ['huge-1.txt', 'huge-2.txt', 'huge-3.txt'].map((name, index) => ({
            index,
            id: `call_guard_${index + 1}`,
            type: 'function',
            function: {
              name: readTool.function!.name!,
              arguments: JSON.stringify({
                [pathKey]: path.join(project, name),
                ...(Object.hasOwn(props, 'limit') ? { limit: 450 } : {}),
              }),
            },
          }))
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            `data: ${JSON.stringify({ id: 'guard-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ id: 'guard-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n` +
            'data: [DONE]\n\n',
          )
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          `data: ${JSON.stringify({ id: `guard-${guardRecords.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'DONE_GUARD' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: `guard-${guardRecords.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n` +
          'data: [DONE]\n\n',
        )
        return
      }

      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Unexpected session ${sid}` } }))
    } catch (error) {
      errors.push(error as Error)
      res.writeHead(500)
      res.end('fixture failed')
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const runtime = new PrivateRuntime({ resources: path.resolve('resources'), profile: path.join(root, 'profile') })

  try {
    const endpoint = await runtime.start()
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers })
    const authRes = await fetch(`${endpoint.url}/api/rpc/amekit-models/update`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: {
          role: 'admin',
          catalog: {
            version: 'fixture',
            default_model: 'guard-retry-fixture',
            small_model: 'guard-retry-fixture',
            models: [{ id: 'guard-retry-fixture', name: 'Fixture', tool_call: true, vision: false, context: 200000, output: 4096 }],
          },
          provider: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'local-test-only' },
          expires: Date.now() + 85000,
        },
      }),
    })
    assert.equal(authRes.status, 200)

    const waitIdle = async (sessionID: string, label: string) => {
      const deadline = Date.now() + 30000
      for (;;) {
        if (errors.length) throw errors[0]
        const history = (await client.message.list({ sessionID, order: 'asc' })).data
        if (history.some(message => message.type === 'idle')) return history
        if (Date.now() > deadline) throw new Error(`${label} timeout: ${JSON.stringify(history)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    await t.test('tool output guard truncates oversized output end-to-end and forwards affinity + prompt_cache_key', async () => {
      const session = await client.session.create({ location: { directory: project }, agent: 'guard-retry-fixture', model: { providerID: 'amecode', id: 'guard-retry-fixture' } })
      guardSessionID = session.id
      await client.session.prompt({ sessionID: session.id, text: 'Run glob on many/*.txt.' })
      const history = await waitIdle(session.id, 'guard session')
      assert.deepEqual(errors, [])
      assert.ok(guardRecords.length >= 2, `expected at least 2 model turns, got ${guardRecords.length}`)

      const first = guardRecords[0]
      assert.equal(first.headers['authorization'], 'Bearer local-test-only')
      assert.equal(first.headers['x-session-id'], session.id)
      assert.equal(typeof first.body.prompt_cache_key, 'string')
      assert.ok(String(first.body.prompt_cache_key).length > 0)

      const second = guardRecords[1]
      const toolMessages = second.messages.filter(m => m.role === 'tool')
      assert.equal(toolMessages.length, 3)
      const toolTexts = toolMessages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      assert.ok(toolTexts.some(text => /\[amekit-output-guard:/.test(text)), `expected at least one tool output truncated by amekit-output-guard, lengths=${toolTexts.map(t => t.length).join(',')}`)
      for (const text of toolTexts) {
        assert.ok(text.length <= 65_000, `expected bounded tool text, got ${text.length}`)
      }

      const assistantParts = history
        .filter((m): m is Extract<SessionMessageInfo, { type: 'assistant' }> => m.type === 'assistant')
        .flatMap(m => m.content)
      const truncatedToolPart = assistantParts.find(
        part => part.type === 'tool' && (part.state as { metadata?: Record<string, unknown> }).metadata?.amekitTruncated === true,
      )
      assert.ok(truncatedToolPart && truncatedToolPart.type === 'tool', 'expected persisted truncated tool part in session history')
      assert.equal(truncatedToolPart.state.status, 'completed')
      const meta = (truncatedToolPart.state as { metadata?: Record<string, unknown> }).metadata
      assert.equal(meta?.amekitTruncated, true)
      assert.equal(typeof meta?.originalChars, 'number')
      assert.equal(typeof meta?.keptChars, 'number')
      assert.ok((meta!.originalChars as number) > (meta!.keptChars as number))
      assert.ok((meta!.keptChars as number) > 0)
    })

    await t.test('session retry recovers cleanly from a simulated mid-stream ECONNRESET', async () => {
      const retrySession = await client.session.create({ location: { directory: project }, agent: 'guard-retry-fixture', model: { providerID: 'amecode', id: 'guard-retry-fixture' } })
      retrySessionID = retrySession.id
      await client.session.prompt({ sessionID: retrySession.id, text: 'Reply with text only.' })
      const history = await waitIdle(retrySession.id, 'retry session')
      assert.deepEqual(errors, [])
      assert.equal(retryRecords.length, 2, `expected exactly 2 attempts for retry session, got ${retryRecords.length}`)
      assert.equal(retryRecords[0].headers['x-session-id'], retrySession.id)
      assert.equal(retryRecords[1].headers['x-session-id'], retrySession.id)
      assert.equal(typeof retryRecords[0].body.prompt_cache_key, 'string')
      assert.ok(String(retryRecords[0].body.prompt_cache_key).length > 0)
      assert.equal(retryRecords[1].body.prompt_cache_key, retryRecords[0].body.prompt_cache_key)

      const assistantMessages = history.filter((m): m is Extract<SessionMessageInfo, { type: 'assistant' }> => m.type === 'assistant')
      const combinedText = assistantMessages
        .flatMap(m => m.content)
        .filter((p): p is Extract<(typeof assistantMessages)[number]['content'][number], { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('\n')
      assert.match(combinedText, /RECOVERED_AFTER_RESET/)
    })
  } finally {
    await runtime.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
