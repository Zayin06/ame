import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { PairingHost, pairingPayload, tunnelAddress } from '../packages/opencode-adapter/src/pairing'
import { PairingDeviceStore, parseDeviceLabel } from '../packages/opencode-adapter/src/pairing-store'
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

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

test('permanent store hashes credentials, sanitizes public metadata, serializes writes and survives restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const file = path.join(directory, 'devices.json')
  try {
    const store = new PairingDeviceStore(file)
    await store.ready()
    const entries = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(`<Phone>\n${i}\u0000${'x'.repeat(100)}`)))
    assert.equal(store.list().length, 8)
    for (const entry of entries) {
      assert.match(entry.token, /^[\w-]{43}$/)
      assert.equal(store.authenticate(entry.token)?.id, entry.device.id)
      assert.ok(entry.device.label.length <= 80)
      assert.ok(!/[<>\n\u0000]/.test(entry.device.label))
      assert.deepEqual(Object.keys(entry.device).sort(), ['createdAt', 'id', 'label', 'lastUsedAt'])
    }
    const contents = await readFile(file, 'utf8')
    for (const { token } of entries) assert.ok(!contents.includes(token))
    assert.ok(!JSON.stringify(store.list()).includes('tokenHash'))
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(directory), ['devices.json'])
    const restored = new PairingDeviceStore(file)
    await restored.ready()
    assert.deepEqual(restored.list().map(item => item.id).sort(), store.list().map(item => item.id).sort())
    assert.equal(restored.authenticate('not-a-token'), undefined)
    assert.equal(restored.authenticate('a'.repeat(43)), undefined)
    await restored.revoke(entries[0].device.id)
    assert.equal(restored.authenticate(entries[0].token), undefined)
    await restored.revokeAll()
    const empty = new PairingDeviceStore(file); await empty.ready()
    assert.deepEqual(empty.list(), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('store fails closed on corrupt documents and throttles last-used persistence with flush', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const file = path.join(directory, 'devices.json')
  const realNow = Date.now
  try {
    for (const contents of ['{', '{}', '{"version":2,"devices":[]}', '{"version":1,"devices":[{"tokenHash":"bad"}]}']) {
      await writeFile(file, contents)
      const store = new PairingDeviceStore(file); await store.ready()
      assert.deepEqual(store.list(), [])
    }
    const store = new PairingDeviceStore(file); await store.ready()
    let now = realNow()
    Date.now = () => now
    const { token, device } = await store.create('Phone')
    now += 59999
    assert.equal(store.authenticate(token)?.lastUsedAt, now)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).devices[0].lastUsedAt, device.createdAt)
    await store.flush()
    assert.equal(JSON.parse(await readFile(file, 'utf8')).devices[0].lastUsedAt, now, 'flush persists latest use within the throttle window')
    now++
    assert.equal(store.authenticate(token)?.lastUsedAt, now)
    await store.flush()
    let saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.devices[0].lastUsedAt, now)
    now += 60000
    store.authenticate(token)
    await new Promise(resolve => setTimeout(resolve, 30))
    await store.flush()
    saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.devices[0].lastUsedAt, now)
    saved.devices.push({ ...saved.devices[0], id: '' })
    await writeFile(file, JSON.stringify(saved))
    const corrupt = new PairingDeviceStore(file); await corrupt.ready()
    assert.deepEqual(corrupt.list(), [], 'one invalid record invalidates the document')
  } finally { Date.now = realNow; await rm(directory, { recursive: true, force: true }) }
})

test('device labels prefer OpenCode mobile and provide concise browser/OS or Vietnamese fallback', () => {
  assert.equal(parseDeviceLabel('OpenCode/1 Android Chrome/123'), 'OpenCode Android')
  assert.equal(parseDeviceLabel('OpenCode Mobile iOS'), 'OpenCode iOS')
  assert.equal(parseDeviceLabel('OpenCode/1'), 'OpenCode Mobile')
  assert.equal(parseDeviceLabel('Mozilla Windows Chrome/123 Edg/123'), 'Edge (Windows)')
  assert.equal(parseDeviceLabel('Mozilla Macintosh Chrome/123'), 'Chrome (macOS)')
  assert.equal(parseDeviceLabel('Mozilla iPhone Safari/123'), 'Safari (iOS)')
  assert.equal(parseDeviceLabel('iPadOS'), 'iOS / iPadOS')
  assert.equal(parseDeviceLabel('iOS EdgiOS/1'), 'Edge (iOS)')
  assert.equal(parseDeviceLabel('Android EdgA/1'), 'Edge (Android)')
  assert.equal(parseDeviceLabel('Open\u0000Code Android'), 'OpenCode Android')
  assert.equal(parseDeviceLabel('<script>\u0000'), 'Thiết bị OpenCode')
})

test('store authenticates arbitrary nonempty persisted tokens and safe legacy IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const file = path.join(directory, 'devices.json')
  try {
    const token = 'legacy-token-not-43-characters'
    await writeFile(file, JSON.stringify({ version: 1, devices: [{ id: 'legacy-device', label: 'Phone', createdAt: 1, lastUsedAt: 1, tokenHash: createHash('sha256').update(token).digest('hex').toUpperCase() }] }))
    const store = new PairingDeviceStore(file); await store.ready()
    assert.equal(store.authenticate(''), undefined)
    assert.equal(store.authenticate(token)?.id, 'legacy-device')
    const another = await store.create('Android')
    assert.equal(store.list()[0].id, another.device.id)
    const now = Date.now
    try { Date.now = () => now() + 1000; store.authenticate(token) } finally { Date.now = now }
    assert.equal(store.list()[0].id, 'legacy-device', 'list sorts descending by latest authentication')
    await store.revoke(another.device.id)
    assert.equal(await store.revoke('missing'), false)
    assert.equal(await store.revoke('legacy-device'), true)
    await store.create(); await store.create()
    assert.equal(await store.revokeAll(), 2)
    await store.flush()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('permanent gateway persists credentials across complete restart and master rotation; cookies enforce CSRF', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const file = path.join(directory, 'devices.json')
  const seen: { url?: string; headers: import('node:http').IncomingHttpHeaders }[] = []
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.setHeader('set-cookie', ['opencode_session=master-secret', 'opencode_session_123=other-secret', 'app=safe'])
    res.end('ok')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  let endpoint = { url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, headers: { authorization: 'Basic master-first' } }
  let host = new PairingHost(() => endpoint, new PairingDeviceStore(file))
  const settings = { enabled: true, port: 0, publicURL: 'https://tunnel.example.com:8443', keepScreenActive: false }
  try {
    await host.configure(settings)
    let base = `http://127.0.0.1:${host.status().port}`
    const unauthorized = await fetch(`${base}/api/info`)
    assert.equal(unauthorized.status, 401)
    assert.match(unauthorized.headers.get('content-type')!, /application\/json/)
    assert.deepEqual(await unauthorized.json(), { message: 'Authentication required' })
    assert.equal(seen.length, 0)
    const blocked = await fetch(`${base}/api/pair`, { method: 'POST' })
    assert.equal(blocked.status, 403)
    assert.deepEqual(await blocked.json(), { message: 'Remote pairing code creation is disabled' })
    const code = await host.issue()
    assert.match(JSON.parse(code.qr).code, /^[A-Za-z0-9_-]{32}$/)
    const connectPath = new URL(code.url).pathname
    const response = await fetch(base + connectPath, { headers: { 'user-agent': 'OpenCode Android' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { token } = await response.json() as { token: string }
    const replay = await fetch(base + connectPath)
    assert.equal(replay.status, 401)
    assert.match(replay.headers.get('content-type')!, /application\/json/)
    assert.deepEqual(await replay.json(), { message: 'Pairing link expired or already used' })
    const htmlReplay = await fetch(base + connectPath, { headers: { accept: 'text/html' } })
    assert.equal(htmlReplay.status, 401)
    assert.equal(htmlReplay.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(await htmlReplay.text(), 'Liên kết ghép nối đã hết hạn hoặc đã được sử dụng.')
    assert.equal(host.status().devices?.[0].label, 'OpenCode Android')
    const auth = `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`
    let result = await fetch(`${base}/echo?auth_token=${encodeURIComponent(auth.slice(6))}&keep=1`, { headers: { authorization: 'Basic bad', cookie: 'opencode_session=old; opencode_session_8443=bad; app=keep' } })
    assert.equal(result.status, 200)
    assert.equal(seen.at(-1)?.url, '/echo?keep=1')
    assert.equal(seen.at(-1)?.headers.authorization, 'Basic master-first')
    assert.equal(seen.at(-1)?.headers.cookie, 'app=keep')
    assert.equal(result.headers.get('set-cookie'), 'app=safe')
    const browserCode = await host.issue()
    result = await fetch(base + new URL(browserCode.url).pathname, { headers: { accept: 'text/html' }, redirect: 'manual' })
    assert.equal(result.status, 302)
    assert.equal(result.headers.get('location'), '/')
    const cookie = result.headers.get('set-cookie')!
    assert.ok(cookie.startsWith(`opencode_session_${host.status().port}=`))
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=']) assert.ok(cookie.includes(flag))
    const cookieHeader = cookie.split(';')[0]
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader } })).status, 200)
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader, origin: base } })).status, 200)
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader, origin: settings.publicURL } })).status, 401)
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader, origin: '' } })).status, 401)
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader, origin: 'https://evil.example.com' } })).status, 401)
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader, origin: 'null' } })).status, 401)
    assert.equal((await fetch(`${base}/header`, { headers: { authorization: auth } })).status, 200)
    assert.equal((await fetch(`${base}/fallback?auth_token=invalid`, { headers: { authorization: auth } })).status, 200)
    assert.equal((await fetch(`${base}/fallback`, { headers: { authorization: 'Basic invalid', cookie: cookieHeader } })).status, 200)
    await host.stop()
    endpoint = { ...endpoint, headers: { authorization: 'Basic master-rotated' } }
    host = new PairingHost(() => endpoint, new PairingDeviceStore(file))
    await host.configure(settings)
    base = `http://127.0.0.1:${host.status().port}`
    assert.equal(host.status().devices?.length, 2)
    assert.equal((await fetch(`${base}/restart`, { headers: { authorization: auth, connection: 'close' } })).status, 200)
    assert.equal(seen.at(-1)?.headers.authorization, 'Basic master-rotated')
    await host.revokeDevice(host.status().devices!.find(device => device.label.includes('OpenCode'))!.id)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((await fetch(`${base}/restart`, { headers: { authorization: auth, connection: 'close' } })).status, 401)
    await host.revokeAll()
    assert.deepEqual(host.status().devices, [])
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((await fetch(`${base}/cookie`, { headers: { cookie: cookieHeader } })).status, 401)
  } finally { await host.stop(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})

test('gateway codes are bounded, expire, and are invalidated by revokeAll and stop', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const host = new PairingHost(() => ({ url: 'http://127.0.0.1:12345', headers: {} }), new PairingDeviceStore(path.join(directory, 'devices.json')))
  const realNow = Date.now
  try {
    await host.configure({ enabled: true, port: 0, publicURL: 'https://tunnel.example.com', keepScreenActive: false })
    const base = `http://127.0.0.1:${host.status().port}`
    const first = await host.issue()
    for (let i = 0; i < 20; i++) await host.issue()
    assert.equal((await fetch(base + new URL(first.url).pathname)).status, 401)
    const expired = await host.issue()
    Date.now = () => expired.expiresAt
    assert.equal((await fetch(base + new URL(expired.url).pathname)).status, 401)
    Date.now = realNow
    const revoked = await host.issue()
    await host.revokeAll()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((await fetch(base + new URL(revoked.url).pathname)).status, 401)
    const stopped = await host.issue()
    await host.stop()
    await host.configure({ enabled: true, port: 0, publicURL: 'https://tunnel.example.com', keepScreenActive: false })
    assert.equal((await fetch(`http://127.0.0.1:${host.status().port}` + new URL(stopped.url).pathname)).status, 401)
  } finally { Date.now = realNow; await host.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('device and global revocation close HTTP streams and both sides of authenticated websocket upgrades', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const file = path.join(directory, 'devices.json')
  const remoteSockets = new Set<import('node:net').Socket>()
  const upstream = createServer((req, res) => { res.writeHead(200); res.write('stream') })
  upstream.on('connection', socket => { remoteSockets.add(socket); socket.on('error', () => {}); socket.on('close', () => remoteSockets.delete(socket)) })
  upstream.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/socket')
    assert.equal(req.headers.authorization, 'Basic master')
    assert.equal(req.headers.cookie, 'app=keep')
    socket.on('error', () => {}); socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\nSet-Cookie: opencode_session=secret\r\n\r\n'); socket.pipe(socket)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const store = new PairingDeviceStore(file)
  const host = new PairingHost(() => ({ url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, headers: { authorization: 'Basic master' } }), store)
  try {
    await host.configure({ enabled: true, port: 0, publicURL: 'https://tunnel.example.com', keepScreenActive: false })
    const base = `http://127.0.0.1:${host.status().port}`
    const first = await store.create('First'), second = await store.create('Second')
    assert.equal(await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/socket`, { headers: { connection: 'Upgrade', upgrade: 'test' } })
      req.on('response', res => { resolve(res.statusCode!); res.resume() }); req.on('error', reject); req.end()
    }), 401)
    const auth = (token: string) => `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`
    const open = (token: string) => new Promise<import('node:net').Socket>((resolve, reject) => {
      const req = request(`${base}/socket?auth_token=${encodeURIComponent(auth(token).slice(6))}`, { headers: { connection: 'Upgrade', upgrade: 'test', authorization: 'Basic client-secret', cookie: 'opencode_session=private; opencode_session_123=private; app=keep' } })
      req.on('error', reject)
      req.on('upgrade', (res, socket) => { assert.equal(res.headers['set-cookie'], undefined); socket.on('error', () => {}); resolve(socket) })
      req.end()
    })
    const firstSocket = await open(first.token), secondSocket = await open(second.token)
    const stream = await fetch(`${base}/stream`, { headers: { authorization: auth(first.token) } })
    const reader = stream.body!.getReader(); await reader.read()
    const firstClosed = once(firstSocket, 'close')
    await host.revokeDevice(first.device.id)
    await firstClosed
    await assert.rejects(reader.read())
    assert.equal(secondSocket.destroyed, false)
    const secondClosed = once(secondSocket, 'close')
    await host.revokeAll(); await secondClosed
    assert.deepEqual(store.list(), [])
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(remoteSockets.size, 0)
  } finally { await host.stop(); for (const socket of remoteSockets) socket.destroy(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})

test('in-flight code exchanges cannot leave credentials behind after stop or global revocation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-pairing-'))
  const file = path.join(directory, 'devices.json')
  const store = new PairingDeviceStore(file)
  const host = new PairingHost(() => ({ url: 'http://127.0.0.1:12345', headers: {} }), store)
  const create = store.create.bind(store)
  try {
    for (const operation of ['stop', 'revokeAll'] as const) {
      await host.configure({ enabled: true, port: 0, publicURL: 'https://tunnel.example.com', keepScreenActive: false })
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { entered = resolve })
      store.create = async userAgent => { entered(); await gate; return create(userAgent) }
      const code = await host.issue()
      const exchange = fetch(`http://127.0.0.1:${host.status().port}${new URL(code.url).pathname}`).catch(() => undefined)
      await started
      const stopping = host[operation]()
      release()
      await stopping; await exchange
      assert.deepEqual(store.list(), [])
      const restored = new PairingDeviceStore(file); await restored.ready()
      assert.deepEqual(restored.list(), [])
    }
  } finally { await host.stop(); await rm(directory, { recursive: true, force: true }) }
})
