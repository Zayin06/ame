import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { modelGateway, type GatewayTelemetryEvent } from '../src/model-gateway'
import { modelPolicy } from '../../amekit/src/model-policy'

async function fixture(
  t: TestContext,
  handler: RequestListener,
  options: { headerTimeoutMs?: number; idleTimeoutMs?: number; onTelemetry?: (event: GatewayTelemetryEvent) => void } = {},
) {
  const upstream = createServer(handler)
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const policy = modelPolicy('admin', {
    version: 'test',
    default_model: 'allowed',
    small_model: 'allowed',
    models: [{ id: 'allowed', name: 'Allowed', tool_call: true, vision: false, context: 8000, output: 1000 }],
  })
  const gateway = await modelGateway(() => ({
    policy,
    provider: { base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, api_key: 'secret-upstream-key' },
  }), options)
  t.after(() => gateway.close())
  return (model = 'allowed', extraHeaders: Record<string, string> = {}, bodyExtra: Record<string, unknown> = {}) =>
    fetch(`${gateway.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ model, stream: true, ...bodyExtra }),
      signal: AbortSignal.timeout(5000),
    })
}

test('active streams outlive the header timeout and reset the idle timeout', async t => {
  const telemetry: GatewayTelemetryEvent[] = []
  const request = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'up-req-1' }); res.flushHeaders()
    let chunks = 0
    const timer = setInterval(() => { res.write(`chunk-${++chunks}\n`); if (chunks === 5) { clearInterval(timer); res.end() } }, 40)
    res.once('close', () => clearInterval(timer))
  }, { headerTimeoutMs: 80, idleTimeoutMs: 120, onTelemetry: event => telemetry.push(event) })
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'chunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\n')
  assert.equal(telemetry.length, 1)
  assert.equal(telemetry[0].event, 'stream_complete')
  assert.equal(telemetry[0].upstreamRequestId, 'up-req-1')
  assert.equal(telemetry[0].bytesSent, 40)
  assert.ok(telemetry[0].firstByteMs !== undefined && telemetry[0].firstByteMs >= 0)
})

test('stalled streams abort cleanly, emit idle_timeout telemetry, and cancel the upstream body', async t => {
  let closed!: () => void
  const telemetry: GatewayTelemetryEvent[] = []
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve })
  const request = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('first\n')
    res.once('close', closed)
  }, { headerTimeoutMs: 1000, idleTimeoutMs: 60, onTelemetry: event => telemetry.push(event) })
  const response = await request()
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  await upstreamClosed
  assert.equal(telemetry.at(-1)?.event, 'idle_timeout')
  assert.equal(telemetry.at(-1)?.errorCode, 'AMECODE_IDLE_TIMEOUT')
})

test('retryable upstream statuses and valid Retry-After survive while unauthorized models stay forbidden', async t => {
  for (const status of [429, 503, 401]) await t.test(String(status), async child => {
    let calls = 0
    const telemetry: GatewayTelemetryEvent[] = []
    const request = await fixture(child, (_req, res) => { calls++; res.writeHead(status, { 'retry-after': '30', 'x-request-id': `err-${status}` }); res.end('private provider error') }, { onTelemetry: event => telemetry.push(event) })
    const response = await request()
    assert.equal(response.status, status === 401 ? 403 : status)
    assert.equal(response.headers.get('retry-after'), status === 401 ? null : '30')
    assert.deepEqual(await response.json(), { error: { code: 'AMECODE_PROVIDER_ERROR', message: 'AMECODE_PROVIDER_ERROR' } })
    const denied = await request('unauthorized')
    assert.equal(denied.status, 403)
    assert.equal(calls, 1)
    await denied.body?.cancel()
    assert.equal(telemetry[0]?.event, 'http_error')
    assert.equal(telemetry[0]?.status, status)
    assert.equal(telemetry[0]?.upstreamRequestId, `err-${status}`)
    assert.equal(telemetry[1]?.event, 'fetch_error')
  })
})

test('forwards allowlisted affinity headers, blocks sensitive/injected headers, and preserves prompt_cache_key through tier resolution', async t => {
  let receivedHeaders: IncomingHttpHeaders = {}
  let receivedBody: Record<string, unknown> = {}
  const telemetry: GatewayTelemetryEvent[] = []
  const request = await fixture(t, async (req, res) => {
    receivedHeaders = req.headers
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ok\n\n')
  }, { onTelemetry: event => telemetry.push(event) })

  const response = await request('amecode/default', {
    'X-Session-ID': 'ses_abc123',
    'X-Session-Affinity': 'aff_root_1',
    'x-opencode-session-id': 'op_ses_1',
    'Session-Id': 'ses_abc123',
    'x-parent-session-id': 'ses_parent_1',
    'x-parent-session-affinity': 'aff_parent_1',
    'x-client-request-id': 'req_trace_1',
    'x-codex-turn-state': 'spoofed-turn-state',
    'x-api-key': 'spoofed-api-key',
    cookie: 'session=spoof',
    authorization: 'Bearer spoofed-auth',
    'x-unlisted-header': 'ignore-me',
  }, { prompt_cache_key: 'pck_ses_abc123' })

  assert.equal(response.status, 200)
  await response.text()
  assert.equal(receivedHeaders['authorization'], 'Bearer secret-upstream-key')
  assert.equal(receivedHeaders['x-session-id'], 'ses_abc123')
  assert.equal(receivedHeaders['x-session-affinity'], 'aff_root_1')
  assert.equal(receivedHeaders['x-opencode-session-id'], 'op_ses_1')
  assert.equal(receivedHeaders['session-id'], 'ses_abc123')
  assert.equal(receivedHeaders['x-parent-session-id'], 'ses_parent_1')
  assert.equal(receivedHeaders['x-parent-session-affinity'], 'aff_parent_1')
  assert.equal(receivedHeaders['x-client-request-id'], 'req_trace_1')
  assert.equal(receivedHeaders['x-codex-turn-state'], undefined)
  assert.equal(receivedHeaders['x-api-key'], undefined)
  assert.equal(receivedHeaders['cookie'], undefined)
  assert.equal(receivedHeaders['x-unlisted-header'], undefined)
  assert.equal(receivedBody.model, 'allowed')
  assert.equal(receivedBody.prompt_cache_key, 'pck_ses_abc123')
  assert.equal(telemetry[0]?.requestId, 'req_trace_1')
  assert.equal(telemetry[0]?.sessionId, 'ses_abc123')
  assert.equal(telemetry[0]?.sessionAffinity, 'aff_root_1')
  assert.equal(telemetry[0]?.requestedModel, 'amecode/default')
  assert.equal(telemetry[0]?.model, 'allowed')
  assert.equal(telemetry[0]?.hasPromptCacheKey, true)
})

test('truncated upstream stream resets emit stream_error telemetry without leaking secrets and never retry silently', async t => {
  let upstreamCalls = 0
  const telemetry: GatewayTelemetryEvent[] = []
  const request = await fixture(t, (_req, res) => {
    upstreamCalls++
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
    res.write('partial-data\n')
    const timer = setTimeout(() => res.socket?.destroy(new Error('ECONNRESET')), 30)
    res.once('close', () => clearTimeout(timer))
  }, { onTelemetry: event => telemetry.push(event) })

  const response = await request('allowed', { 'x-session-id': 'ses_drop' })
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  assert.equal(upstreamCalls, 1, 'gateway must never silently open a second upstream request mid-stream')
  assert.equal(telemetry.length, 1)
  assert.equal(telemetry[0].event, 'stream_error')
  assert.equal(telemetry[0].sessionId, 'ses_drop')
  assert.ok(telemetry[0].bytesSent > 0)
  assert.doesNotMatch(JSON.stringify(telemetry[0]), /secret-upstream-key/)
})


test('telemetry redacts sk- keys and inline api_key/token query values in error messages', async t => {
  const telemetry: GatewayTelemetryEvent[] = []
  const request = await fixture(t, (_req, res) => { res.writeHead(200); res.end('ok') }, { onTelemetry: event => telemetry.push(event) })
  const realFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get('authorization') === 'Bearer secret-upstream-key') {
      throw new Error('Upstream rejected sk-testSecretKey123456 with Bearer bearerSecret and api_key=rawSecret99 token=tok_abc123')
    }
    return realFetch(input, init)
  })
  const response = await request()
  assert.equal(response.status, 403)
  await response.body?.cancel()
  assert.equal(telemetry.length, 1)
  assert.equal(telemetry[0].event, 'fetch_error')
  assert.doesNotMatch(JSON.stringify(telemetry[0]), /sk-testSecretKey123456|bearerSecret|rawSecret99|tok_abc123/)
  assert.match(telemetry[0].errorMessage ?? '', /Bearer \[REDACTED\]/)
  assert.match(telemetry[0].errorMessage ?? '', /\[REDACTED_KEY\]/)
  assert.match(telemetry[0].errorMessage ?? '', /api_key=\[REDACTED\]/)
  assert.match(telemetry[0].errorMessage ?? '', /token=\[REDACTED\]/)
})
