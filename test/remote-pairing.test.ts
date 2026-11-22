import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { PairingHost } from '../packages/opencode-adapter/src/pairing'
import { RemotePairing, type TunnelConnector } from '../packages/opencode-adapter/src/remote-pairing'

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
