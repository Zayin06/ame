import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { OpenCode } from '@opencode/client'
import { PrivateRuntime, privateEnvironment } from '../packages/opencode-adapter/src/runtime'

test('private profile ignores inherited OpenCode overrides and keeps tool environment', () => {
  const env = privateEnvironment('C:\\private', 'private-secret', { OPENCODE_CONFIG: 'global.json', OPENCODE_CONFIG_CONTENT: 'secret', OPENCODE_SERVER_PASSWORD: 'global', XDG_CONFIG_HOME: 'global', NODE_OPTIONS: '--inspect', PATH: 'tools', HOME: 'original' })
  assert.equal(env.OPENCODE_CONFIG, undefined)
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined)
  assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.OPENCODE_PASSWORD, 'private-secret')
  assert.equal(env.OPENCODE_DISABLE_FILEWATCHER, '1')
  assert.equal(env.XDG_CONFIG_HOME, path.join('C:\\private', 'config'))
  assert.equal(env.PATH, 'tools')
  assert.equal(env.HOME, 'original')
})

test('missing bundled executable fails closed and stop during preparation cannot launch', async () => {
  const root = await mkdtemp(path.resolve('.runtime-missing-'))
  const runtime = new PrivateRuntime({ resources: root, profile: path.join(root, 'profile') })
  try {
    const start = runtime.start()
    await runtime.stop()
    await assert.rejects(start, /BUNDLED_RUNTIME_INVALID/)
    await assert.rejects(runtime.start(), /RUNTIME_STOPPING/)
  } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }) }
})

const resources = path.resolve('resources')
const executable = path.join(resources, 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const prepared = await Promise.all([access(executable), access(path.join(resources, 'amekit-models', 'server.js'))]).then(() => true, () => false)

test('start waits for plugin setup to finish after its status RPC becomes callable', { skip: !prepared, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.resolve('.runtime-delayed-'))
  const runtimes: PrivateRuntime[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const isolatedResources = path.join(root, `resources-${index}`)
      await cp(resources, isolatedResources, { recursive: true })
      const server = path.join(isolatedResources, 'amekit-models', 'server.js')
      await cp(server, path.join(isolatedResources, 'amekit-models', 'policy.js'))
      await writeFile(server, `import plugin from './policy.js'
export default { ...plugin, async setup(context) {
  const cleanup = await plugin.setup(context)
  await new Promise(resolve => setTimeout(resolve, 2000))
  return cleanup
} }
`)
      runtimes.push(new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, `profile-${index}`) }))
    }
    const outcomes = await Promise.allSettled(runtimes.map(async runtime => {
      const endpoint = await runtime.start()
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` } })
      const plugins = await client.plugin.list()
      assert.ok(plugins.data.some(p => p.id === 'amekit-models' && p.state.status === 'active'), 'RPC registration alone does not mean plugin setup is complete')
    }))
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  } finally { await Promise.all(runtimes.map(runtime => runtime.stop())); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})
test('readiness retries transient failures but rejects failed, missing and stalled plugins', { skip: !prepared, timeout: 90000 }, async t => {
  const root = await mkdtemp(path.resolve('.runtime-readiness-'))
  const isolatedResources = path.join(root, 'resources')
  try {
    await cp(resources, isolatedResources, { recursive: true })
    const server = path.join(isolatedResources, 'amekit-models', 'server.js')
    const original = await readFile(server, 'utf8')
    await writeFile(path.join(isolatedResources, 'amekit-models', 'policy.js'), original)
    await t.test('retries transport failures and service-unavailable responses', async t => {
      const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, 'transient') })
      const fetch = globalThis.fetch
      let transportFailed = false, unavailable = false
      const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/plugin') && !transportFailed) { transportFailed = true; throw new TypeError('fetch failed') }
        if (String(input).endsWith('/status') && !unavailable) { unavailable = true; return new Response('', { status: 503 }) }
        return fetch(input, init)
      })
      try {
        const endpoint = await runtime.start()
        assert.equal(transportFailed, true)
        assert.equal(unavailable, true)
        const client = OpenCode.make({ baseUrl: endpoint.url, headers: { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` } })
        assert.ok((await client.plugin.list()).data.some(p => p.id === 'amekit-models' && p.state.status === 'active'))
      } finally { mock.mock.restore(); await runtime.stop() }
    })
    await t.test('invalid signed-out status and authorization failures fail closed', async t => {
      const fetch = globalThis.fetch
      for (const status of [200, 401]) {
        const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, `rejected-${status}`) })
        const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/status')) return Response.json({ output: { authenticated: true } }, { status })
          return fetch(input, init)
        })
        try { await assert.rejects(runtime.start(), /RUNTIME_PLUGIN_FAILED: invalid signed-out status/) }
        finally { mock.mock.restore(); await runtime.stop() }
      }
    })
    await t.test('a plugin that fails after registering RPC is rejected', async () => {
      await writeFile(server, `import plugin from './policy.js'
export default { ...plugin, async setup(context) {
  await plugin.setup(context)
  await new Promise(resolve => setTimeout(resolve, 250))
  throw new Error('intentional setup failure')
} }
`)
      const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, 'failed') })
      try { await assert.rejects(runtime.start(), /RUNTIME_PLUGIN_FAILED/) }
      finally { await runtime.stop() }
    })
    await t.test('missing plugin fails closed', async () => {
      await rm(server)
      const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, 'missing'), readinessTimeoutMs: 2000 })
      try { await assert.rejects(runtime.start(), /RUNTIME_PLUGIN_(FAILED|NOT_READY)/) }
      finally { await runtime.stop() }
    })
    await t.test('unfinished plugin setup has an explicit readiness deadline', async () => {
      await writeFile(server, `import plugin from './policy.js'
export default { ...plugin, async setup(context) {
  await plugin.setup(context)
  await new Promise(() => {})
} }
`)
      const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, 'stalled'), readinessTimeoutMs: 1000 })
      try { await assert.rejects(runtime.start(), /RUNTIME_PLUGIN_NOT_READY: readiness timeout/) }
      finally { await runtime.stop() }
    })
    await writeFile(server, original)
    await t.test('deadline also covers a response body that never finishes', async t => {
      const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, 'body'), readinessTimeoutMs: 500 })
      let url = ''
      const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        url = String(input).replace('/api/info', '')
        return { status: 200, text: () => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })) } as Response
      })
      try {
        await assert.rejects(runtime.start(), /RUNTIME_PLUGIN_NOT_READY: readiness timeout/)
        mock.mock.restore()
        await assert.rejects(fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1000) }), 'failed startup must terminate its child')
      } finally { mock.mock.restore(); await runtime.stop() }
    })
    await t.test('stop interrupts a pending readiness request', async t => {
      const runtime = new PrivateRuntime({ resources: isolatedResources, profile: path.join(root, 'stopped') })
      let entered!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      const mock = t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        entered()
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
      })
      try {
        const start = runtime.start()
        const rejected = assert.rejects(start, /RUNTIME_STOPPED/)
        await ready
        await runtime.stop()
        await rejected
      } finally { mock.mock.restore(); await runtime.stop() }
    })
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

test('bundled backend auto-starts once, authenticates, loads policy, persists sessions and stops only its child', { skip: !prepared, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.resolve('.runtime-test-'))
  const profile = path.join(root, 'profile'), project = path.join(root, 'project')
  const isolatedResources = path.join(root, 'resources')
  await cp(resources, isolatedResources, { recursive: true })
  await mkdir(project)
  await mkdir(path.join(project, '.opencode', 'agents'), { recursive: true })
  await writeFile(path.join(project, '.opencode', 'agents', 'private-test.md'), '---\ndescription: Private discovery test\nmode: subagent\n---\nOnly inspect this test project.\n')
  let unexpected = 0
  let runtime = new PrivateRuntime({ resources: isolatedResources, profile, onExit: () => unexpected++ })
  let url = ''
  try {
    const starts = [runtime.start(), runtime.start()]
    assert.equal(starts[0], starts[1], 'concurrent callers must share startup')
    const endpoint = await starts[0]; url = endpoint.url
    assert.equal((await fetch(`${url}/api/info`)).status, 401)
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: url, headers })
    const pairing = await client.server.pair()
    assert.equal(pairing.expires_in, 300)
    const anonymous = OpenCode.make({ baseUrl: url })
    const paired = await anonymous.server.connect({ code: pairing.code })
    await assert.rejects(anonymous.server.connect({ code: pairing.code }), 'a code is single-use')
    await assert.rejects(anonymous.server.connect({ code: 'invalid-code' }))
    const pairedHeaders = { authorization: `Basic ${Buffer.from(`opencode:${paired.token}`).toString('base64')}` }
    assert.equal((await fetch(`${url}/api/info`, { headers: pairedHeaders })).status, 200)
    const plugins = await client.plugin.list()
    assert.ok(plugins.data.some(p => p.id === 'amekit-models' && p.state.status === 'active'))
    const external = plugins.data.filter(p => p.source.type !== 'builtin')
    assert.deepEqual(external.map(p => p.id), ['amekit-models'], 'global profile must not load external user plugins')
    const session = await client.session.create({ location: { directory: project } })
    let agents: string[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      agents = (await client.agent.list({ location: { directory: project } })).data.map(a => a.id)
      if (agents.includes('private-test')) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(agents.includes('private-test'), 'project agents remain available with isolated global config')
    const models = await client.model.list({ location: { directory: project }, types: ['chat'] })
    assert.deepEqual(models.data, [], 'signed-out model policy fails closed')
    const config = JSON.parse(await readFile(path.join(profile, 'config', 'opencode', 'opencode.json'), 'utf8'))
    assert.equal(config.plugins.length, 1)
    assert.equal(config.experimental.subagent_depth, 3)
    assert.equal(config.experimental.artifacts, true)
    const entries = await client.config.get({ location: { directory: project } })
    const experimental = entries.flatMap(entry => entry.type === 'document' && entry.info.experimental ? [entry.info.experimental] : []).at(-1)
    assert.equal(experimental?.subagent_depth, 3, 'native backend receives the three-generation limit')
    assert.equal(experimental?.artifacts, true, 'native backend enables artifacts in the private profile')
    let parentID = session.id
    for (let depth = 1; depth <= 3; depth++) {
      const child = await client.session.create({ parentID, title: `Native depth ${depth}`, agent: 'private-test', location: { directory: project } })
      assert.equal(child.parentID, parentID)
      parentID = child.id
    }
    assert.equal((await client.session.list({ directory: project, archived: false })).data.filter(s => s.parentID).length, 3)
    await runtime.stop()
    await assert.rejects(fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2000) }))
    assert.equal(unexpected, 0)
    runtime = new PrivateRuntime({ resources: isolatedResources, profile })
    const restored = await runtime.start()
    assert.notEqual(restored.password, endpoint.password)
    assert.equal((await fetch(`${restored.url}/api/info`, { headers: pairedHeaders })).status, 401, 'backend password rotation revokes paired devices')
    const next = OpenCode.make({ baseUrl: restored.url, headers: { authorization: `Basic ${Buffer.from(`${restored.username}:${restored.password}`).toString('base64')}` } })
    assert.equal((await next.session.get({ sessionID: session.id })).id, session.id)
  } finally { await runtime.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})
