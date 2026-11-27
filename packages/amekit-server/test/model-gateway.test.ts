import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { modelGateway } from '../src/model-gateway'
import { modelPolicy } from '../../amekit/src/model-policy'

async function fixture(t: TestContext, handler: RequestListener, options: { headerTimeoutMs?: number; idleTimeoutMs?: number } = {}) {
  const upstream = createServer(handler)
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const policy = modelPolicy('admin', { version: 'test', default_model: 'allowed', small_model: 'allowed', models: [{ id: 'allowed', name: 'Allowed', tool_call: true, vision: false, context: 8000, output: 1000 }] })
  const gateway = await modelGateway(() => ({ policy, provider: { base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, api_key: 'test' } }), options)
  t.after(() => gateway.close())
  return (model = 'allowed') => fetch(`${gateway.baseURL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(5000),
  })
}

test('active streams outlive the header timeout and reset the idle timeout', async t => {
  const request = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
    let chunks = 0
    const timer = setInterval(() => { res.write(`chunk-${++chunks}\n`); if (chunks === 5) { clearInterval(timer); res.end() } }, 40)
    res.once('close', () => clearInterval(timer))
  }, { headerTimeoutMs: 80, idleTimeoutMs: 120 })
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'chunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\n')
})

test('stalled streams abort cleanly and cancel the upstream body', async t => {
  let closed!: () => void
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve })
  const request = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('first\n')
    res.once('close', closed)
  }, { headerTimeoutMs: 1000, idleTimeoutMs: 60 })
  const response = await request()
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  await upstreamClosed
})

test('retryable upstream statuses and valid Retry-After survive while unauthorized models stay forbidden', async t => {
  for (const status of [429, 503, 401]) await t.test(String(status), async child => {
    let calls = 0
    const request = await fixture(child, (_req, res) => { calls++; res.writeHead(status, { 'retry-after': '30' }); res.end('private provider error') })
    const response = await request()
    assert.equal(response.status, status === 401 ? 403 : status)
    assert.equal(response.headers.get('retry-after'), status === 401 ? null : '30')
    assert.deepEqual(await response.json(), { error: { code: 'AMECODE_PROVIDER_ERROR', message: 'AMECODE_PROVIDER_ERROR' } })
    const denied = await request('unauthorized')
    assert.equal(denied.status, 403)
    assert.equal(calls, 1)
    await denied.body?.cancel()
  })
})
