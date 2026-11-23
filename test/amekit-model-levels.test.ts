import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { Model } from '@opencode/schema/model'
import { managedProvider, modelPolicy } from '../packages/amekit/src/model-policy'
import plugin, { applyAgentModelTransform, formatModelLevelsSystemNote, orderPolicyModels, resolveHookModel } from '../packages/amekit-server/src/server'
import { modelGateway } from '../packages/amekit-server/src/model-gateway'

const levels = { default: 'workspace-model', haiku: 'fast-model', sonnet: 'balanced-model', opus: 'reasoning-model' }
const catalog = {
  version: 'fixture',
  default_model: levels.default, small_model: levels.haiku, model_levels: levels,
  models: [levels.opus, levels.default, levels.haiku, levels.sonnet].map(id => ({
    id, name: id, context: 128000, output: 8192, tool_call: true, vision: true,
  })),
}
const ref = (id: string, providerID = managedProvider): Model.Ref => ({ providerID: providerID as Model.Info['providerID'], id: id as Model.ID })

test('policy ordering puts the API default first without mutating the catalog or remaining order', () => {
  const policy = modelPolicy('admin', catalog)
  const before = [...policy.models]
  const ordered = orderPolicyModels(policy)
  assert.deepEqual(ordered.map(model => model.id), [levels.default, levels.opus, levels.haiku, levels.sonnet])
  assert.deepEqual(policy.models, before)
  assert.equal(ordered[0], policy.models[1])
})

test('agent transforms resolve all managed tiers for admin and lock user tiers to the API default', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    const agents = Object.keys(levels).map(level => ({ id: level, model: ref(level) }))
    const updated: string[] = []
    applyAgentModelTransform({
      list: () => agents,
      update(id, update) { updated.push(id); update(agents.find(agent => agent.id === id)!) },
    }, policy)
    assert.deepEqual(updated, Object.keys(levels))
    for (const agent of agents) assert.deepEqual(agent.model, ref(policy.model_levels[agent.id as keyof typeof levels]))
  }
})

test('agent transforms preserve concrete, foreign and unspecified models and do nothing without policy', () => {
  type AgentModel = ReturnType<Parameters<typeof applyAgentModelTransform>[0]['list']>[number]
  const agents: AgentModel[] = [
    { id: 'concrete', model: ref(levels.sonnet) },
    { id: 'foreign', model: ref('haiku', 'other') },
    { id: 'inherited' },
  ]
  const before = structuredClone(agents)
  const editor = { list: () => agents, update() { assert.fail('unrelated agent must not be updated') } }
  applyAgentModelTransform(editor, modelPolicy('admin', catalog))
  applyAgentModelTransform({ ...editor, list: () => [{ id: 'inactive', model: ref('opus') }] }, undefined)
  assert.deepEqual(agents, before)
  const prefixed = [{ id: 'prefixed', model: ref('amecode/Opus') }]
  applyAgentModelTransform({ list: () => prefixed, update(_id, update) { update(prefixed[0]) } }, modelPolicy('admin', catalog))
  assert.deepEqual(prefixed[0].model, ref(levels.opus))
})

test('model resolution maps tiers before title routing and enforces the single-model user policy', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      for (const kind of ['primary', 'title']) {
        const input = { kind, model: ref(`amecode/${level}`) }
        resolveHookModel(input, policy)
        assert.deepEqual(input.model, ref(policy.model_levels[level]))
      }
    }
    const title = { kind: 'title', model: ref(levels.opus) }
    resolveHookModel(title, policy)
    assert.deepEqual(title.model, ref(policy.model_levels.haiku))
    const primary = { kind: 'primary', model: ref(levels.opus) }
    resolveHookModel(primary, policy)
    assert.deepEqual(primary.model, ref(role === 'user' ? levels.default : levels.opus))
  }
})

test('authorized feature models pass through concrete requests but never unlock user titles or tiers', () => {
  const policy = modelPolicy('user', catalog, { featureModels: [levels.opus] })
  for (const kind of ['primary', 'commit', 'translation']) {
    const feature = { kind, model: ref(levels.opus) }
    resolveHookModel(feature, policy)
    assert.deepEqual(feature.model, ref(levels.opus))
    const regular = { kind, model: ref(levels.sonnet) }
    resolveHookModel(regular, policy)
    assert.deepEqual(regular.model, ref(levels.default))
    for (const tier of ['opus', 'amecode/haiku', 'default']) {
      const input = { kind, model: ref(tier) }
      resolveHookModel(input, policy)
      assert.deepEqual(input.model, ref(levels.default))
    }
  }
  for (const id of [levels.opus, levels.haiku, 'opus']) {
    const title = { kind: 'title', model: ref(id) }
    resolveHookModel(title, policy)
    assert.deepEqual(title.model, ref(levels.default))
  }
  const legacyPolicy = { models: [{ ...catalog.models[1], reasoning: false }], default_model: levels.default, model_levels: policy.model_levels }
  const legacy = { kind: 'primary', model: ref(levels.opus) }
  resolveHookModel(legacy, legacyPolicy)
  assert.deepEqual(legacy.model, ref(levels.default))
})

test('hook resolution leaves inactive and foreign models unchanged and skips unavailable title models', () => {
  const admin = modelPolicy('admin', catalog)
  const foreign = { kind: 'title', model: ref('opus', 'other') }
  resolveHookModel(foreign, admin)
  assert.deepEqual(foreign.model, ref('opus', 'other'))
  const inactive = { kind: 'title', model: ref('opus') }
  resolveHookModel(inactive, undefined)
  assert.deepEqual(inactive.model, ref('opus'))
  const unavailable = { ...admin, model_levels: { ...admin.model_levels, haiku: 'unavailable' } }
  const title = { kind: 'title', model: ref(levels.opus) }
  resolveHookModel(title, unavailable)
  assert.deepEqual(title.model, ref(levels.opus))
})

test('system note explains each active tier, its concrete ID and intended task', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    const note = formatModelLevelsSystemNote(policy)
    assert.ok(note.includes('[amecode-model-levels]'))
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      assert.ok(note.includes(`${level} = amecode/${policy.model_levels[level]}`))
    }
    for (const purpose of ['workspace default', 'fast/light tasks', 'balanced coding', 'deep reasoning']) assert.ok(note.includes(purpose))
  }
})

test('plugin reloads agents after providers/models and adds one policy context note while enforcing hook checks', async () => {
  type Context = Parameters<typeof plugin.setup>[0]
  type ProviderTransform = Parameters<Context['provider']['transform']>[0]
  type ModelTransform = Parameters<Context['model']['transform']>[0]
  type AgentTransform = Parameters<Context['agent']['transform']>[0]
  type HookInput = { system: { type: 'text'; text: string }[]; kind: string; model: Model.Ref }
  let providerTransform: ProviderTransform | undefined
  let agentTransform: AgentTransform | undefined
  let modelTransform: ModelTransform | undefined
  let update: ((value: unknown) => Promise<boolean>) | undefined
  const hooks = new Map<string, (input: HookInput) => Promise<void>>()
  const reloads: string[] = []
  const registration = { dispose: async () => {} }
  const context = {
    provider: {
      transform: async (callback: ProviderTransform) => { providerTransform = callback; return registration },
      reload: async () => { reloads.push('provider') },
    },
    model: {
      transform: async (callback: ModelTransform) => { modelTransform = callback; return registration },
      reload: async () => { reloads.push('model') },
    },
    agent: {
      transform: async (callback: AgentTransform) => { agentTransform = callback; return registration },
      reload: async () => { reloads.push('agent') },
    },
    session: { hook: async (name: string, callback: (input: HookInput) => Promise<void>) => { hooks.set(name, callback); return registration } },
    rpc: { register: async (_schema: unknown, handlers: { update: typeof update }) => { update = handlers.update; return registration } },
  } as unknown as Context
  const cleanup = await plugin.setup(context)
  const input: HookInput = { system: [{ type: 'text', text: 'Existing instructions' }], kind: 'primary', model: ref('opus') }
  try {
    assert.ok(update && providerTransform && modelTransform && agentTransform)
    await hooks.get('context')!(input)
    assert.equal(input.system.length, 1)
    await update({ role: 'admin', catalog, provider: { base_url: 'https://api.example.com/v1', api_key: 'test-key' }, expires: Date.now() + 60000 })
    assert.deepEqual(reloads, ['provider', 'model', 'agent'])
    let offered: readonly Model.Info[] = []
    providerTransform({ list: () => [], remove() {}, add(record: { models: readonly Model.Info[] }) { offered = record.models } } as unknown as Parameters<ProviderTransform>[0])
    assert.deepEqual(offered.map(model => model.id), [levels.default, levels.opus, levels.haiku, levels.sonnet])
    const agent = { id: 'subagent', model: ref('haiku') }
    agentTransform({ list: () => [agent], update(_id: string, transform: (draft: typeof agent) => void) { transform(agent) } } as unknown as Parameters<AgentTransform>[0])
    assert.deepEqual(agent.model, ref(levels.haiku))
    await hooks.get('context')!(input)
    await hooks.get('context')!(input)
    assert.equal(input.system.length, 2)
    assert.equal(input.system[0].text, 'Existing instructions')
    assert.equal(input.system[1].text, formatModelLevelsSystemNote(modelPolicy('admin', catalog)))
    await hooks.get('experimental.model.resolve')!(input)
    assert.deepEqual(input.model, ref(levels.opus))
    await assert.rejects(hooks.get('experimental.model.resolve')!({ ...input, model: ref('not-allowed') }), /AMECODE_/)
    await assert.rejects(hooks.get('experimental.model.resolve')!({ ...input, model: ref('haiku', 'other') }), /AMECODE_MODEL_NOT_ALLOWED/)
    await update({ role: 'user', catalog, featureModels: [levels.opus, 'inactive'], provider: { base_url: 'https://api.example.com/v1', api_key: 'test-key' }, expires: Date.now() + 60000 })
    providerTransform({ list: () => [], remove() {}, add(record: { models: readonly Model.Info[] }) { offered = record.models } } as unknown as Parameters<ProviderTransform>[0])
    assert.deepEqual(offered.map(model => model.id), [levels.default, levels.opus])
    const feature = { ...input, model: ref(levels.opus) }
    await hooks.get('experimental.model.resolve')!(feature)
    assert.deepEqual(feature.model, ref(levels.opus))
    const title = { ...feature, kind: 'title' }
    await hooks.get('experimental.model.resolve')!(title)
    assert.deepEqual(title.model, ref(levels.default))
    await update(null)
    assert.deepEqual(reloads, ['provider', 'model', 'agent', 'provider', 'model', 'agent', 'provider', 'model', 'agent'])
    await assert.rejects(hooks.get('experimental.model.resolve')!(input), /AMECODE_LOGIN_REQUIRED/)
  } finally { await cleanup?.() }
})

test('gateway rewrites managed tier request bodies and rejects disallowed or unauthenticated requests before proxying', async () => {
  const forwarded: { model: string; messages: unknown; stream: boolean }[] = []
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer test-key')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const provider = { base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, api_key: 'test-key' }
  let policy: ReturnType<typeof modelPolicy> | undefined = modelPolicy('admin', catalog)
  const gateway = await modelGateway(() => policy ? { policy, provider } : undefined)
  const send = (model: string) => fetch(`${gateway.baseURL}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], stream: false }),
  })
  try {
    for (const [tier, expected] of [['haiku', levels.haiku], ['amecode/opus', levels.opus], ['sonnet', levels.sonnet], ['default', levels.default]]) {
      const response = await send(tier)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      assert.deepEqual(forwarded.at(-1), { model: expected, messages: [{ role: 'user', content: 'hello' }], stream: false })
    }
    policy = modelPolicy('user', catalog)
    for (const tier of ['haiku', 'amecode/opus', 'sonnet', 'default']) {
      const response = await send(tier)
      assert.equal(response.status, 200)
      await response.json()
      assert.equal(forwarded.at(-1)!.model, levels.default)
    }
    const allowedCount = forwarded.length
    for (const denied of [levels.haiku, levels.opus, 'unlisted-model']) {
      const response = await send(denied)
      assert.equal(response.status, 403)
      const body = await response.json() as { error: { code: string } }
      assert.equal(body.error.code, 'AMECODE_MODEL_NOT_ALLOWED')
      assert.equal(forwarded.length, allowedCount)
    }
    policy = modelPolicy('user', catalog, { featureModels: [levels.opus] })
    const featureResponse = await send(levels.opus)
    assert.equal(featureResponse.status, 200)
    await featureResponse.json()
    assert.equal(forwarded.at(-1)!.model, levels.opus)
    const tierResponse = await send('opus')
    assert.equal(tierResponse.status, 200)
    await tierResponse.json()
    assert.equal(forwarded.at(-1)!.model, levels.default)
    policy = undefined
    const response = await send('default')
    assert.equal(response.status, 403)
    const body = await response.json() as { error: { code: string } }
    assert.equal(body.error.code, 'AMECODE_LOGIN_REQUIRED')
    assert.equal(forwarded.length, allowedCount + 2)
  } finally {
    await gateway.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
