import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { PairingHost } from '../packages/opencode-adapter/src/pairing'
import { PairingDeviceStore } from '../packages/opencode-adapter/src/pairing-store'
import { loadOrCreateRoute, RemotePairing, type TunnelConnector } from '../packages/opencode-adapter/src/remote-pairing'

const endpoint = () => ({ url: 'http://127.0.0.1:12345', headers: {} })
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('automatic Pairing selects a loopback port, preserves the route on screen changes and closes it on disable', async () => {
  let target = '', calls = 0, closed = 0
  const remote = new RemotePairing(new PairingHost(endpoint), async value => {
    target = value; calls++
    return { urls: { ame: 'https://ame.example.com' }, closed: new Promise(() => {}), close: async () => { closed++ } }
  })
  try {
    const starting = await remote.configure({ enabled: true, keepScreenActive: false })
    assert.equal(starting.connecting, true)
    while (remote.status().connecting) await tick()
    assert.match(target, /^127\.0\.0\.1:\d+$/)
    assert.equal(remote.status().publicURL, 'https://ame.example.com')
    assert.ok(remote.status().port > 0)
    await remote.configure({ enabled: true, keepScreenActive: true })
    assert.equal(calls, 1)
    assert.equal(remote.status().keepScreenActive, true)
    await remote.configure({ enabled: false, keepScreenActive: true })
    assert.equal(closed, 1)
    assert.equal(remote.status().publicURL, '')
    await assert.rejects(fetch(`http://${target}/api/info`))
  } finally { await remote.stop() }
})

test('disable cancels pending provisioning and a late tunnel cannot resurrect access', async () => {
  let connecting!: () => void
  const started = new Promise<void>(resolve => { connecting = resolve })
  let complete!: (value: Awaited<ReturnType<TunnelConnector>>) => void
  let signal!: AbortSignal, closed = 0
  const remote = new RemotePairing(new PairingHost(endpoint), async (_, input) => {
    signal = input; connecting()
    return new Promise(resolve => { complete = resolve })
  })
  await remote.configure({ enabled: true, keepScreenActive: false })
  await started
  const stopping = remote.stop()
  assert.equal(signal.aborted, true)
  complete({ urls: { ame: 'https://late.example.com' }, closed: new Promise(() => {}), close: async () => { closed++ } })
  await stopping
  assert.equal(closed, 1)
  assert.equal(remote.status().enabled, false)
  await assert.rejects(remote.issue(), /NOT_READY/)
})

test('fatal connection failure and later tunnel closure both fail closed with retry available', async () => {
  let fail = true, end!: () => void
  const remote = new RemotePairing(new PairingHost(endpoint), async () => {
    if (fail) throw new Error('secret transport details')
    return { urls: { ame: 'https://ame.example.com' }, closed: new Promise<void>(resolve => { end = resolve }), close: async () => {} }
  })
  try {
    await remote.configure({ enabled: true, keepScreenActive: false })
    await assert.rejects(remote.issue(), /TUNNEL_FAILED/)
    assert.equal(remote.status().enabled, false)
    assert.ok(!remote.status().error?.includes('secret'))
    fail = false
    await remote.configure({ enabled: true, keepScreenActive: false })
    while (remote.status().connecting) await tick()
    const port = remote.status().port
    end()
    while (remote.status().enabled) await tick()
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/info`))
  } finally { await remote.stop() }
})

test('ephemeral gateway port remains stable when its public URL becomes available', async () => {
  const backend = createServer((_, res) => res.end('ready'))
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const host = new PairingHost(() => ({ url: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, headers: {} }))
  try {
    const initial = await host.configure({ enabled: true, publicURL: 'https://pending.invalid', port: 0, keepScreenActive: false })
    const ready = await host.configure({ ...initial, publicURL: 'https://ame.example.com' })
    assert.equal(initial.port, ready.port)
    assert.equal(await (await fetch(`http://127.0.0.1:${ready.port}`)).text(), 'ready')
  } finally { await host.stop(); await new Promise<void>(resolve => backend.close(() => resolve())) }
})

test('automatic route persists across calls and creates private files in a new directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ame-route-'))
  const directory = path.join(root, 'pairing')
  try {
    const route = await loadOrCreateRoute(directory)
    assert.match(route, /^ame-[a-f0-9]{24}$/)
    assert.equal(await loadOrCreateRoute(directory), route)
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'route.json'), 'utf8')), { version: 1, route })
    assert.deepEqual(await readdir(directory), ['route.json'])
    if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'route.json'))).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('automatic route recovers corrupt and unsupported saved routes without accepting unsafe names', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-route-'))
  try {
    for (const invalid of ['{', 'null', '{}', JSON.stringify({ version: 2, route: `ame-${'a'.repeat(24)}` }), JSON.stringify({ version: 1, route: '../unsafe' }), JSON.stringify({ version: 1, route: `ame-${'A'.repeat(24)}` })]) {
      await writeFile(path.join(directory, 'route.json'), invalid)
      const route = await loadOrCreateRoute(directory)
      assert.match(route, /^ame-[a-f0-9]{24}$/)
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'route.json'), 'utf8')), { version: 1, route })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('simultaneous normalized directory calls all observe one persisted route', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-route-'))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await writeFile(path.join(directory, 'route.json'), 'corrupt')
      const routes = await Promise.all(Array.from({ length: 32 }, (_, index) => loadOrCreateRoute(index % 2 ? path.join(directory, 'nested', '..') : directory)))
      assert.equal(new Set(routes).size, 1)
      assert.match(routes[0], /^ame-[a-f0-9]{24}$/)
      assert.equal(JSON.parse(await readFile(path.join(directory, 'route.json'), 'utf8')).route, routes[0])
      assert.deepEqual(await readdir(directory), ['route.json'])
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('disabled remote access still lists persisted devices and reflects store changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-remote-devices-'))
  const file = path.join(directory, 'devices.json')
  let remote: RemotePairing | undefined
  try {
    const original = new PairingDeviceStore(file)
    await original.ready()
    const paired = await original.create('Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0')
    const store = new PairingDeviceStore(file)
    await store.ready()
    remote = new RemotePairing(new PairingHost(endpoint, store), async () => { throw new Error('must not connect while disabled') })
    assert.equal(remote.status().enabled, false)
    assert.deepEqual(remote.status().devices, [paired.device])
    assert.deepEqual((await remote.configure({ enabled: false, keepScreenActive: true })).devices, [paired.device])
    await store.revoke(paired.device.id)
    assert.deepEqual(remote.status().devices, [])
  } finally { await remote?.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('remote device revocation delegates to the host and returns fresh settings while disabled', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-remote-devices-'))
  const file = path.join(directory, 'devices.json')
  let remote: RemotePairing | undefined
  try {
    const store = new PairingDeviceStore(file)
    await store.ready()
    const first = await store.create('OpenCode Android')
    const second = await store.create('Mozilla/5.0 (iPhone) Version/18.0 Safari/604.1')
    remote = new RemotePairing(new PairingHost(endpoint, store), async () => { throw new Error('must not connect while disabled') })
    const revoked = await remote.revokeDevice(first.device.id)
    assert.equal(revoked.enabled, false)
    assert.deepEqual(revoked.devices, [second.device])
    assert.equal(store.authenticate(first.token), undefined)
    const authenticated = store.authenticate(second.token)
    assert.equal(authenticated?.id, second.device.id)
    assert.ok(authenticated && authenticated.lastUsedAt >= second.device.lastUsedAt)
    assert.deepEqual((await remote.revokeDevice(first.device.id)).devices, [authenticated])
    const cleared = await remote.revokeAll()
    assert.equal(cleared.enabled, false)
    assert.deepEqual(cleared.devices, [])
    assert.equal(store.authenticate(second.token), undefined)
    const reloaded = new PairingDeviceStore(file)
    await reloaded.ready()
    assert.deepEqual(reloaded.list(), [])
  } finally { await remote?.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('route and paired credential survive Remote access toggles and a new remote host', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ame-remote-restart-'))
  const backend = createServer((_, res) => res.end('ready'))
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const endpoint = () => ({ url: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, headers: {} })
  const connector: TunnelConnector = async () => ({
    urls: { ame: `https://${await loadOrCreateRoute(directory)}.example.com` },
    closed: new Promise(() => {}), close: async () => {},
  })
  const file = path.join(directory, 'devices.json')
  let remote: RemotePairing | undefined
  try {
    const store = new PairingDeviceStore(file)
    const { token } = await store.create('OpenCode Android')
    const authorization = `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`
    remote = new RemotePairing(new PairingHost(endpoint, store), connector)
    let publicURL = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      await remote.configure({ enabled: true, keepScreenActive: false })
      await remote.issue()
      if (!publicURL) publicURL = remote.status().publicURL
      assert.equal(remote.status().publicURL, publicURL)
      assert.equal((await fetch(`http://127.0.0.1:${remote.status().port}/api/info`, { headers: { authorization } })).status, 200)
      await remote.configure({ enabled: false, keepScreenActive: false })
      assert.equal(remote.status().devices?.length, 1)
      if (attempt === 1) {
        const restored = new PairingDeviceStore(file)
        await restored.ready()
        remote = new RemotePairing(new PairingHost(endpoint, restored), connector)
      }
    }
  } finally {
    await remote?.stop()
    await new Promise<void>(resolve => backend.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
