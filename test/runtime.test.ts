import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
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
  assert.equal(env.XDG_CONFIG_HOME, path.join('C:\\private', 'config'))
  assert.equal(env.PATH, 'tools')
  assert.equal(env.HOME, 'original')
})

test('missing bundled executable fails closed and stop during preparation cannot launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-runtime-missing-'))
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
const prepared = await access(executable).then(() => true, () => false)
test('bundled backend auto-starts once, authenticates, loads policy, persists sessions and stops only its child', { skip: !prepared, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-runtime-test-'))
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
    const entries = await client.config.get({ location: { directory: project } })
    assert.equal(entries.flatMap(entry => entry.type === 'document' && entry.info.experimental ? [entry.info.experimental] : []).at(-1)?.subagent_depth, 3, 'native backend receives the three-generation limit')
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
