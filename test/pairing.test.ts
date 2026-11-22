import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { PairingHost, pairingPayload, tunnelAddress } from '../packages/opencode-adapter/src/pairing'

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

test('Pairing uses the upstream Android QR JSON and one-time link, rejects unsafe tunnel addresses', () => {
  assert.equal(tunnelAddress(' https://tunnel.example.com/ '), 'https://tunnel.example.com')
  assert.deepEqual(pairingPayload('https://tunnel.example.com', 'Ab_12-xy'), { url: 'https://tunnel.example.com/auth/connect/Ab_12-xy', qr: '{"code":"Ab_12-xy","urls":["https://tunnel.example.com"]}' })
  for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/prefix', 'https://example.com/?token=secret', 'https://example.com/#hash', 'https://localhost', 'https://127.0.0.1', 'not a url']) assert.throws(() => tunnelAddress(value), /PAIRING_HTTPS_REQUIRED/)
  assert.throws(() => pairingPayload('https://example.com', '../bad'), /PAIRING_INVALID_CODE/)
})

test('loopback tunnel gateway forwards client auth without injecting master credentials and supports streams/upgrades', { timeout: 15000 }, async () => {
  const seen: { url?: string; authorization?: string }[] = []
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); return }
    if (req.url === '/api/pair' && req.headers.authorization === 'Basic master') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 'native_code', expires_in: 300 })); return }
    res.writeHead(req.headers.authorization === 'Basic client' ? 200 : 401)
    req.pipe(res)
  })
  upstream.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
    if (head.length) socket.write(head)
    socket.pipe(socket)
  })
  const upstreamSockets = new Set<import('node:net').Socket>()
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)) })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const port = await freePort()
  const endpoint = { url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, headers: { authorization: 'Basic master' } }
  let current: typeof endpoint | undefined = endpoint
  const host = new PairingHost(() => current)
  const settings = { enabled: true, publicURL: 'https://tunnel.example.com', port, keepScreenActive: false }
  const url = `http://127.0.0.1:${port}`
  try {
    await host.configure(settings)
    assert.equal((await fetch(`${url}/api/info`)).status, 401)
    assert.equal(seen.at(-1)?.authorization, undefined)
    const response = await fetch(`${url}/echo?key=value`, { method: 'POST', headers: { authorization: 'Basic client' }, body: 'body' })
    assert.equal(response.status, 200); assert.equal(await response.text(), 'body')
    assert.deepEqual(seen.at(-1), { url: '/echo?key=value', authorization: 'Basic client' })
    const code = await host.issue()
    assert.equal(JSON.parse(code.qr).code, 'native_code')
    assert.ok(code.expiresAt > Date.now() + 290000)
    assert.equal(seen.at(-1)?.authorization, 'Basic master', 'only code creation uses the private endpoint directly')
    const controller = new AbortController()
    const stream = await fetch(`${url}/stream`, { signal: controller.signal })
    const reader = stream.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: ready\n\n')
    controller.abort(); await reader.cancel().catch(() => {})
    await new Promise<void>((resolve, reject) => {
      const req = request(`${url}/socket`, { headers: { connection: 'Upgrade', upgrade: 'test' } })
      req.on('upgrade', (_, socket) => { socket.on('error', reject); socket.once('data', data => { assert.equal(data.toString(), 'ping'); socket.destroy(); resolve() }); socket.write('ping') })
      req.on('error', reject); req.end()
    })
    // Raw absolute-form requests must never make this an arbitrary forward proxy.
    assert.equal(await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: 'http://other.example/api/info' }, res => { resolve(res.statusCode!); res.resume() }); req.on('error', reject); req.end()
    }), 400)
    current = undefined
    assert.equal((await fetch(`${url}/api/info`)).status, 503)
    await assert.rejects(host.issue(), /PAIRING_NOT_READY/)
    current = endpoint
    await host.stop()
    assert.equal(host.status().enabled, false)
    await assert.rejects(fetch(`${url}/api/info`))
    await host.configure(settings)
    await host.configure({ ...settings, enabled: false })
    await assert.rejects(fetch(`${url}/api/info`))
  } finally { await host.stop(); for (const socket of upstreamSockets) socket.destroy(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
})

test('Pairing fails closed without a backend or when the tunnel port belongs to another service', async () => {
  const blocker = createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = (blocker.address() as { port: number }).port
  const settings = { enabled: true, publicURL: 'https://tunnel.example.com', port, keepScreenActive: false }
  const absent = new PairingHost(() => undefined)
  const occupied = new PairingHost(() => ({ url: 'http://127.0.0.1:12345', headers: {} }))
  try {
    await assert.rejects(absent.configure(settings), /PRIVATE_BACKEND_REQUIRED/)
    await assert.rejects(occupied.configure(settings), /PORT_UNAVAILABLE/)
    assert.equal(occupied.status().enabled, false)
    assert.equal(blocker.listening, true)
  } finally { await absent.stop(); await occupied.stop(); await new Promise<void>(resolve => blocker.close(() => resolve())) }
})
