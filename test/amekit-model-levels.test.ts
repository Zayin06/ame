import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { Model } from '@opencode/schema/model'
import { assertChatModel, assertModel, managedProvider, modelPolicy } from '../packages/amekit/src/model-policy'
import plugin, { applyAgentModelTransform, formatModelLevelsSystemNote, orderPolicyModels, resolveHookModel, resolveSubagentInputModel } from '../packages/amekit-server/src/server'
import { modelGateway } from '../packages/amekit-server/src/model-gateway'
import { AME_TODO_POLICY_MARKER, ORCHESTRATOR_AGENT_ID, AME_TODO_SYSTEM_NOTE, AME_TODO_TOOL_DESCRIPTION } from '../packages/amekit-server/src/todo-policy'

const levels = { default: 'workspace-model', haiku: 'fast-model', sonnet: 'balanced-model', opus: 'reasoning-model' }
const catalog = {
  version: 'fixture',
  default_model: levels.default, small_model: levels.haiku, model_levels: levels,
  models: [levels.opus, levels.default, levels.haiku, levels.sonnet].map(id => ({
    id, name: id, context: 128000, output: 8192, tool_call: true, vision: true,
  })),
}
const ref = (id: string, providerID = managedProvider): Model.Ref => ({ providerID: providerID as Model.Info['providerID'], id: id as Model.ID })
const extendedCatalog = { ...catalog, models: [...catalog.models, ...['feature-model', 'non-tier-model'].map(id => ({ ...catalog.models[0], id, name: id }))] }

test('both roles retain API tiers while user Chat remains restricted to the default', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, extendedCatalog)
    assert.deepEqual(policy.model_levels, levels)
    assert.deepEqual(policy.chat_models.map(model => model.id), role === 'user' ? [levels.default] : extendedCatalog.models.map(model => model.id))
    for (const id of Object.values(levels)) {
      assert.doesNotThrow(() => assertModel(policy, ref(id)))
      if (role === 'user' && id !== levels.default) assert.throws(() => assertChatModel(policy, ref(id)), /AMECODE_MODEL_NOT_ALLOWED/)
      else assert.doesNotThrow(() => assertChatModel(policy, ref(id)))
    }
    assert.throws(() => assertModel(policy, ref('unlisted-model')), /AMECODE_MODEL_NOT_ALLOWED/)
    assert.throws(() => assertChatModel(policy, ref(levels.default, 'other')), /AMECODE_MODEL_NOT_ALLOWED/)
    const fallback = modelPolicy(role, { ...catalog, model_levels: undefined })
    assert.deepEqual(fallback.model_levels, { default: levels.default, haiku: levels.haiku, sonnet: levels.default, opus: levels.default })
  }
  const user = modelPolicy('user', extendedCatalog, { featureModels: ['feature-model', 'inactive'] })
  assert.doesNotThrow(() => assertModel(user, ref('feature-model')))
  assert.throws(() => assertChatModel(user, ref('feature-model')), /AMECODE_MODEL_NOT_ALLOWED/)
  for (const id of ['non-tier-model', 'inactive']) assert.throws(() => assertModel(user, ref(id)), /AMECODE_MODEL_NOT_ALLOWED/)
  assert.throws(() => assertModel(undefined, ref(levels.default)), /AMECODE_LOGIN_REQUIRED/)
  assert.throws(() => assertChatModel(undefined, ref(levels.default)), /AMECODE_LOGIN_REQUIRED/)
})

test('policy ordering puts the API default first without mutating the catalog or remaining order', () => {
  const policy = modelPolicy('admin', catalog)
  const before = [...policy.models]
  const ordered = orderPolicyModels(policy)
  assert.deepEqual(ordered.map(model => model.id), [levels.default, levels.opus, levels.haiku, levels.sonnet])
  assert.deepEqual(policy.models, before)
  assert.equal(ordered[0], policy.models[1])
})

test('agent transforms resolve all managed tiers for both admin and user', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    const agents = Object.keys(levels).map(level => ({ id: level, model: ref(level) }))
    const updated: string[] = []
    applyAgentModelTransform({
      list: () => agents,
      update(id, update) { updated.push(id); update(agents.find(agent => agent.id === id)!) },
    }, policy)
    assert.deepEqual(updated, Object.keys(levels))
    for (const agent of agents) assert.deepEqual(agent.model, ref(levels[agent.id as keyof typeof levels]))
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

test('subagent input resolves string and object tiers before model validation for both roles', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    for (const [alias, level] of [
      ['amecode/haiku', 'haiku'], ['haiku', 'haiku'], ['amecode/Sonnet', 'sonnet'],
      ['sonnet', 'sonnet'], ['amecode/opus', 'opus'], ['amecode/default', 'default'],
    ] as const) {
      const input = { tool: ' SuBaGeNt ', input: { model: alias } }
      resolveSubagentInputModel(input, policy)
      assert.equal(input.input.model, `${managedProvider}/${levels[level]}`)
    }
    for (const model of [{ providerID: managedProvider, id: 'sonnet', variant: 'high' }, { id: 'haiku' }]) {
      const input = { tool: 'subagent', input: { model } }
      resolveSubagentInputModel(input, policy)
      assert.deepEqual(input.input.model, { ...model, providerID: managedProvider, id: levels[model.id as 'sonnet' | 'haiku'] })
    }
  }
})

test('subagent input preserves concrete, foreign, invalid and inactive inputs and unrelated tools', () => {
  const policy = modelPolicy('admin', catalog)
  const inputs = [
    { tool: 'subagent', input: { model: `amecode/${levels.sonnet}` } },
    { tool: 'subagent', input: { model: levels.haiku } },
    { tool: 'subagent', input: { model: 'other/haiku' } },
    { tool: 'subagent', input: { model: { providerID: 'other', id: 'haiku' } } },
    { tool: 'subagent', input: { model: { providerID: managedProvider, id: levels.sonnet } } },
    { tool: 'subagent', input: { model: { id: 1 } } },
    { tool: 'subagent', input: { model: ['haiku'] } },
    { tool: 'subagent', input: {} },
    { tool: 'subagent', input: null },
    { tool: 'subagent', input: 'haiku' },
    { tool: 'subagent', input: [{ model: 'haiku' }] },
    { tool: 'subagent' },
    { tool: 'shell', input: { model: 'amecode/haiku' } },
  ]
  for (const input of inputs) {
    const before = structuredClone(input)
    resolveSubagentInputModel(input, policy)
    assert.deepEqual(input, before)
  }
  for (const model of ['amecode/haiku', { id: 'sonnet' }]) {
    const input = { tool: 'subagent', input: { model } }
    const before = structuredClone(input)
    resolveSubagentInputModel(input, undefined)
    assert.deepEqual(input, before)
  }
})

test('model resolution maps tiers before title routing for both roles despite a single Chat model', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      for (const kind of ['primary', 'title']) {
        const input = { kind, model: ref(`amecode/${level}`) }
        resolveHookModel(input, policy)
        assert.deepEqual(input.model, ref(levels[level]))
      }
    }
    const title = { kind: 'title', model: ref(levels.opus) }
    resolveHookModel(title, policy)
    assert.deepEqual(title.model, ref(policy.model_levels.haiku))
    const primary = { kind: 'primary', model: ref(levels.opus) }
    resolveHookModel(primary, policy)
    assert.deepEqual(primary.model, ref(levels.opus))
  }
})

test('authorized non-tier feature models pass through user requests without replacing title or tier routing', () => {
  const policy = modelPolicy('user', extendedCatalog, { featureModels: ['feature-model'] })
  for (const kind of ['primary', 'commit', 'translation']) {
    const feature = { kind, model: ref('feature-model') }
    resolveHookModel(feature, policy)
    assert.deepEqual(feature.model, ref('feature-model'))
    const regular = { kind, model: ref('non-tier-model') }
    resolveHookModel(regular, policy)
    assert.deepEqual(regular.model, ref(levels.default))
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      const input = { kind, model: ref(`amecode/${level}`) }
      resolveHookModel(input, policy)
      assert.deepEqual(input.model, ref(levels[level]))
    }
  }
  for (const id of ['feature-model', levels.opus, levels.haiku]) {
    const title = { kind: 'title', model: ref(id) }
    resolveHookModel(title, policy)
    assert.deepEqual(title.model, ref(levels.haiku))
  }
  const legacyPolicy = { models: [{ ...catalog.models[1], reasoning: false }], default_model: levels.default, model_levels: policy.model_levels }
  const legacy = { kind: 'primary', model: ref(levels.opus) }
  resolveHookModel(legacy, legacyPolicy)
  assert.deepEqual(legacy.model, ref(levels.default))
})

test('hook resolution leaves inactive and foreign models unchanged and defaults unavailable title models', () => {
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
  assert.deepEqual(title.model, ref(levels.default))
})

test('system note explains each active tier, its concrete ID and intended task', () => {
  for (const role of ['admin', 'user'] as const) {
    const policy = modelPolicy(role, catalog)
    const note = formatModelLevelsSystemNote(policy)
    assert.ok(note.includes('[amecode-model-levels]'))
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      assert.ok(note.includes(`${level} = amecode/${levels[level]}`))
    }
    for (const purpose of ['workspace default', 'fast/light tasks', 'balanced coding', 'deep reasoning']) assert.ok(note.includes(purpose))
  }
})

test('plugin reloads agents and skills after providers/models and adds one policy context note while enforcing hook checks', async () => {
  type Context = Parameters<typeof plugin.setup>[0]
  type ProviderTransform = Parameters<Context['provider']['transform']>[0]
  type ModelTransform = Parameters<Context['model']['transform']>[0]
  type AgentTransform = Parameters<Context['agent']['transform']>[0]
  type ToolTransform = Parameters<Context['tool']['transform']>[0]
  type HookInput = { system: { type: 'text'; text: string }[]; kind: string; model: Model.Ref; agent: string; sessionID: string; tools: Record<string, unknown> }
  let providerTransform: ProviderTransform | undefined
  let agentTransform: AgentTransform | undefined
  const agentTransforms = new Map<number | 'markdown', AgentTransform>()
  const disposedAgents: number[] = []
  let agentRegistrations = 0
  let reloadedAgents: { id: string; model: Model.Ref }[] = []
  let modelTransform: ModelTransform | undefined
  let toolTransform: ToolTransform | undefined
  let beforeExecute: ((input: { tool: string; agent: string; sessionID: string; input?: unknown }) => Promise<void>) | undefined
  const disposedTools: string[] = []
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
      transform: async (callback: AgentTransform) => {
        const id = ++agentRegistrations
        agentTransform = callback
        agentTransforms.set(id, callback)
        return { dispose: async () => {
          assert.ok(agentTransforms.delete(id), 'agent registration must be disposed exactly once')
          disposedAgents.push(id)
          if (agentTransform === callback && ![...agentTransforms.values()].includes(callback)) agentTransform = undefined
        } }
      },
      reload: async () => {
        reloads.push('agent')
        reloadedAgents = []
        const editor = {
          list: () => reloadedAgents,
          update(id: string, transform: (draft: typeof reloadedAgents[number]) => void) { transform(reloadedAgents.find(agent => agent.id === id)!) },
        } as unknown as Parameters<AgentTransform>[0]
        for (const transform of agentTransforms.values()) await transform(editor)
      },
      list: async () => ({ data: [{ id: 'custom-lead', mode: 'all' }, { id: 'explore', mode: 'all' }] }),
    },
    skill: { reload: async () => { reloads.push('skill') } },
    tool: {
      transform: async (callback: ToolTransform) => { toolTransform = callback; return { dispose: async () => { disposedTools.push('transform') } } },
      hook: async (name: string, callback: typeof beforeExecute) => {
        assert.ok(name === 'execute.before' || name === 'execute.after', `unexpected tool hook: ${name}`)
        if (name === 'execute.before') beforeExecute = callback
        return { dispose: async () => { disposedTools.push(name) } }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionID === 'root' ? { agent: ORCHESTRATOR_AGENT_ID } : sessionID === 'standalone' ? { agent: 'build' } : { parentID: 'root' },
      hook: async (name: string, callback: (input: HookInput) => Promise<void>) => { hooks.set(name, callback); return registration },
    },
    rpc: { register: async (_schema: unknown, handlers: { update: typeof update }) => { update = handlers.update; return registration } },
  } as unknown as Context
  const cleanup = await plugin.setup(context)
  // OpenCode registers its Markdown loader after external plugin setup.
  agentTransforms.set('markdown', () => {
    reloadedAgents.push({ id: 'ame-explorer', model: ref('haiku') }, { id: 'ame-reviewer', model: ref('sonnet') })
  })
  const input: HookInput = { system: [{ type: 'text', text: 'Existing instructions' }], kind: 'primary', model: ref('opus'), agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', tools: { todowrite: {}, shell: {} } }
  try {
    assert.ok(update && providerTransform && modelTransform && agentTransform)
    assert.ok(toolTransform && beforeExecute)
    const todoTool = { description: 'Native todo description' }
    toolTransform({ update(id: string, transform: (draft: typeof todoTool) => void) { assert.equal(id, 'todowrite'); transform(todoTool) } } as unknown as Parameters<ToolTransform>[0])
    assert.equal(todoTool.description, AME_TODO_TOOL_DESCRIPTION)
    await beforeExecute({ tool: 'todowrite', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root' })
    await assert.rejects(beforeExecute({ tool: ' ToDoWrItE ', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'child' }), /TODOWRITE_FORBIDDEN/)
    const child = { ...input, sessionID: 'child', system: [], tools: { todowrite: {}, shell: {} } }
    await hooks.get('context')!(child)
    assert.deepEqual(child.tools, { shell: {} })
    await hooks.get('context')!(input)
    assert.equal(input.system.length, 2)
    assert.equal(input.system[1].text, AME_TODO_SYSTEM_NOTE)
    await update({ role: 'admin', catalog: extendedCatalog, managedCatalog: { agents: [' custom-lead '], skills: ['custom-skill'] }, provider: { base_url: 'https://api.example.com/v1', api_key: 'test-key' }, expires: Date.now() + 60000 })
    assert.deepEqual(reloads, ['provider', 'model', 'agent', 'skill'])
    assert.equal(agentRegistrations, 2)
    assert.deepEqual(disposedAgents, [1])
    assert.deepEqual(reloadedAgents, [
      { id: 'ame-explorer', model: ref(levels.haiku) },
      { id: 'ame-reviewer', model: ref(levels.sonnet) },
    ])
    const subagentInput = { tool: 'subagent', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { agent: 'custom-lead', model: 'amecode/sonnet' } }
    await beforeExecute(subagentInput)
    assert.equal(subagentInput.input.model, `amecode/${levels.sonnet}`)
    await beforeExecute({ tool: 'subagent', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { agent: 'custom-lead' } })
    await beforeExecute({ tool: 'skill', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { id: 'custom-skill' } })
    await assert.rejects(beforeExecute({ tool: 'subagent', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { agent: 'explore' } }), /MANAGED_SUBAGENT_FORBIDDEN/)
    await assert.rejects(beforeExecute({ tool: 'skill', agent: 'custom-lead', sessionID: 'child', input: { id: 'unmanaged' } }), /MANAGED_SKILL_FORBIDDEN/)
    await beforeExecute({ tool: 'subagent', agent: 'build', sessionID: 'standalone', input: { agent: 'explore' } })
    for (const agent of ['compaction', 'title', 'summary']) {
      await beforeExecute({ tool: 'subagent', agent, sessionID: 'root', input: { agent: 'explore' } })
    }
    const managedContext = { ...input, system: [{ type: 'text' as const, text: '<available_skills><skill><id>custom-skill</id></skill><skill><id>unmanaged</id></skill></available_skills>' }], tools: { subagent: { description: 'Delegate.\n\nAvailable subagents:\n- explore: Native', input: {} } } }
    await hooks.get('context')!(managedContext)
    assert.match(managedContext.tools.subagent.description, /custom-lead/)
    assert.doesNotMatch(managedContext.tools.subagent.description, /- explore:/)
    assert.doesNotMatch(managedContext.system[0].text, /unmanaged/)
    let offered: readonly Model.Info[] = []
    providerTransform({ list: () => [], remove() {}, add(record: { models: readonly Model.Info[] }) { offered = record.models } } as unknown as Parameters<ProviderTransform>[0])
    assert.deepEqual(offered.map(model => model.id), [levels.default, levels.opus, levels.haiku, levels.sonnet, 'feature-model', 'non-tier-model'])
    const agent = { id: 'subagent', model: ref('haiku') }
    agentTransform({ list: () => [agent], update(_id: string, transform: (draft: typeof agent) => void) { transform(agent) } } as unknown as Parameters<AgentTransform>[0])
    assert.deepEqual(agent.model, ref(levels.haiku))
    await hooks.get('context')!(input)
    await hooks.get('context')!(input)
    assert.equal(input.system.length, 3)
    assert.equal(input.system[0].text, 'Existing instructions')
    assert.equal(input.system[2].text, formatModelLevelsSystemNote(modelPolicy('admin', catalog)))
    assert.equal(input.system.filter(part => part.text.includes(AME_TODO_POLICY_MARKER)).length, 1)
    assert.equal(input.system.filter(part => part.text.includes('[amecode-model-levels]')).length, 1)
    assert.ok('todowrite' in input.tools)
    await hooks.get('experimental.model.resolve')!(input)
    assert.deepEqual(input.model, ref(levels.opus))
    await assert.rejects(hooks.get('experimental.model.resolve')!({ ...input, model: ref('not-allowed') }), /AMECODE_MODEL_NOT_ALLOWED/)
    await assert.rejects(hooks.get('experimental.model.resolve')!({ ...input, model: ref('haiku', 'other') }), /AMECODE_MODEL_NOT_ALLOWED/)
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      const tier = { ...input, model: ref(level) }
      await hooks.get('experimental.model.resolve')!(tier)
      assert.deepEqual(tier.model, ref(levels[level]))
    }
    await update({ role: 'user', catalog: extendedCatalog, featureModels: ['feature-model', 'inactive'], provider: { base_url: 'https://api.example.com/v1', api_key: 'test-key' }, expires: Date.now() + 60000 })
    await assert.rejects(beforeExecute({ tool: 'subagent', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { agent: 'custom-lead' } }), /MANAGED_SUBAGENT_FORBIDDEN/)
    await assert.rejects(beforeExecute({ tool: 'skill', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { id: 'custom-skill' } }), /MANAGED_SKILL_FORBIDDEN/)
    providerTransform({ list: () => [], remove() {}, add(record: { models: readonly Model.Info[] }) { offered = record.models } } as unknown as Parameters<ProviderTransform>[0])
    assert.deepEqual(offered.map(model => model.id), [levels.default, levels.opus, levels.haiku, levels.sonnet, 'feature-model'])
    for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
      const agent = { id: `subagent-${level}`, model: ref(level) }
      agentTransform({ list: () => [agent], update(_id: string, transform: (draft: typeof agent) => void) { transform(agent) } } as unknown as Parameters<AgentTransform>[0])
      assert.deepEqual(agent.model, ref(levels[level]))
      for (const kind of ['primary', 'title']) {
        const tier = { ...input, kind, model: ref(level) }
        await hooks.get('experimental.model.resolve')!(tier)
        assert.deepEqual(tier.model, ref(levels[level]))
      }
    }
    for (const id of ['non-tier-model', 'unlisted-model']) {
      await assert.rejects(hooks.get('model.request')!({ ...input, model: ref(id) }), /AMECODE_MODEL_NOT_ALLOWED/)
    }
    const feature = { ...input, model: ref('feature-model') }
    await hooks.get('experimental.model.resolve')!(feature)
    assert.deepEqual(feature.model, ref('feature-model'))
    const title = { ...feature, kind: 'title' }
    await hooks.get('experimental.model.resolve')!(title)
    assert.deepEqual(title.model, ref(levels.haiku))
    await update(null)
    const inactiveSubagentInput = { tool: 'subagent', agent: 'build', sessionID: 'standalone', input: { agent: 'explore', model: 'amecode/sonnet' } }
    await beforeExecute(inactiveSubagentInput)
    assert.equal(inactiveSubagentInput.input.model, 'amecode/sonnet')
    assert.equal(agentRegistrations, 4)
    assert.deepEqual(disposedAgents, [1, 2, 3])
    assert.deepEqual(reloads, ['provider', 'model', 'agent', 'skill', 'provider', 'model', 'agent', 'skill', 'provider', 'model', 'agent', 'skill'])
    await assert.rejects(beforeExecute({ tool: 'skill', agent: ORCHESTRATOR_AGENT_ID, sessionID: 'root', input: { id: 'custom-skill' } }), /MANAGED_SKILL_FORBIDDEN/)
    const emptyContext = { ...input, system: [{ type: 'text' as const, text: '<available_skills><skill><id>custom-skill</id></skill></available_skills>' }], tools: { subagent: { description: 'Delegate.', input: {} } } }
    await hooks.get('context')!(emptyContext)
    assert.match(emptyContext.tools.subagent.description, /No managed subagents are currently active/)
    assert.equal(emptyContext.system[0].text, 'No managed skills are currently active.')
    await assert.rejects(hooks.get('experimental.model.resolve')!(input), /AMECODE_LOGIN_REQUIRED/)
  } finally {
    try { await update?.(null) }
    finally { await cleanup?.() }
  }
  assert.deepEqual(disposedAgents, [1, 2, 3, 4, 5])
  assert.equal(agentTransform, undefined)
  assert.deepEqual([...agentTransforms.keys()], ['markdown'])
  assert.deepEqual(disposedTools, ['execute.after', 'execute.before', 'transform'])
})

async function modelLocation() {
  type Context = Parameters<typeof plugin.setup>[0]
  type ProviderTransform = Parameters<Context['provider']['transform']>[0]
  type AgentTransform = Parameters<Context['agent']['transform']>[0]
  type Agent = NonNullable<ReturnType<Parameters<AgentTransform>[0]['get']>>
  let providerTransform!: ProviderTransform
  let agentTransform!: AgentTransform
  let rpc!: { update(value: unknown): Promise<boolean>; status(): Promise<{ authenticated: boolean; models: string[] }> }
  const hooks = new Map<string, (input: any) => Promise<void>>()
  const registration = { dispose: async () => {} }
  const cleanup = await plugin.setup({
    provider: { transform: async (fn: ProviderTransform) => { providerTransform = fn; return registration }, reload: async () => {} },
    model: { transform: async () => registration, reload: async () => {} },
    agent: { transform: async (fn: AgentTransform) => { agentTransform = fn; return registration }, reload: async () => {} },
    skill: { reload: async () => {} },
    tool: { transform: async () => registration, hook: async () => registration },
    session: { hook: async (name: string, fn: (input: any) => Promise<void>) => { hooks.set(name, fn); return registration } },
    rpc: { register: async (_schema: unknown, handlers: typeof rpc) => { rpc = handlers; return registration } },
  } as unknown as Context)
  return {
    rpc, hooks, cleanup,
    providers() {
      const records: Parameters<Parameters<ProviderTransform>[0]['add']>[0][] = []
      providerTransform({ list: () => [], remove() {}, add: (record: typeof records[number]) => { records.push(record) } } as unknown as Parameters<ProviderTransform>[0])
      return records
    },
    agents() {
      const agents = new Map<string, Agent>()
      agentTransform({ list: () => [...agents.values()], update(id: string, transform: (agent: Agent) => void) {
        const agent = agents.get(id) ?? { id } as Agent
        agents.set(id, agent); transform(agent)
      } } as unknown as Parameters<AgentTransform>[0])
      return agents
    },
  }
}

const locationPolicy = () => ({
  role: 'admin', catalog,
  orchestrator: { id: ORCHESTRATOR_AGENT_ID, version: '1.0.0', description: 'Coordinator', prompt: 'Preserved orchestration', subagentDepth: 3 },
  managedCatalog: { agents: ['custom-lead'], skills: ['custom-skill'] },
  provider: { base_url: 'https://api.example.com/v1', api_key: 'test-key' }, expires: Date.now() + 60_000,
})

test('idle location eviction preserves authenticated models, provider credentials, orchestrator and managed catalog', async () => {
  const upstream = createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer test-key')
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  let location = await modelLocation()
  try {
    assert.deepEqual(await location.rpc.status(), { authenticated: false, models: [] })
    const policy = locationPolicy()
    policy.provider.base_url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
    await location.rpc.update(policy)
    await location.cleanup?.()
    location = await modelLocation()
    assert.deepEqual(await location.rpc.status(), { authenticated: true, models: catalog.models.map(model => model.id) })
    const [provider] = location.providers()
    assert.equal(provider.info.id, 'amecode')
    assert.deepEqual(provider.models?.map(model => model.id), [levels.default, levels.opus, levels.haiku, levels.sonnet])
    const agent = location.agents().get(ORCHESTRATOR_AGENT_ID)!
    assert.equal(agent.system, '[ame-orchestrator version=1.0.0]\nPreserved orchestration')
    for (const [action, resource] of [['subagent', 'custom-lead'], ['skill', 'custom-skill']]) {
      assert.ok(agent.permissions.some(rule => rule.action === action && rule.resource === resource && rule.effect === 'allow'))
    }
    const response = await fetch(`${provider.info.settings?.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: levels.default, messages: [] }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    try { await location.rpc.update(null) }
    finally {
      await location.cleanup?.()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  }
})

for (const reason of ['logout', 'idle revocation', 'idle expiry', 'expired update'] as const) {
  test(`location setup stays fail-closed after ${reason}`, async t => {
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    let location = await modelLocation()
    try {
      const policy = locationPolicy()
      await location.rpc.update(policy)
      if (reason === 'logout') await location.rpc.update(null)
      await location.cleanup?.()
      if (reason === 'idle revocation') await location.rpc.update(null)
      if (reason === 'idle expiry') now = policy.expires
      location = await modelLocation()
      if (reason === 'expired update') {
        await assert.rejects(location.rpc.update({ ...policy, expires: now }), /AMECODE_LOGIN_REQUIRED/)
        await location.cleanup?.()
        location = await modelLocation()
      }
      assert.deepEqual(await location.rpc.status(), { authenticated: false, models: [] })
      assert.deepEqual(location.providers(), [])
      assert.equal(location.agents().size, 0)
      await assert.rejects(location.hooks.get('model.request')!({ model: ref(levels.default) }), /AMECODE_LOGIN_REQUIRED/)
    } finally {
      try { await location.rpc.update(null) }
      finally { await location.cleanup?.() }
    }
  })
}

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
    for (const role of ['admin', 'user'] as const) {
      policy = modelPolicy(role, extendedCatalog)
      for (const [level, expected] of Object.entries(levels)) {
        for (const tier of [level, `amecode/${level}`, expected]) {
          const response = await send(tier)
          assert.equal(response.status, 200)
          assert.deepEqual(await response.json(), { ok: true })
          assert.deepEqual(forwarded.at(-1), { model: expected, messages: [{ role: 'user', content: 'hello' }], stream: false })
        }
      }
    }
    const allowedCount = forwarded.length
    for (const denied of ['feature-model', 'non-tier-model', 'unlisted-model']) {
      const response = await send(denied)
      assert.equal(response.status, 403)
      const body = await response.json() as { error: { code: string } }
      assert.equal(body.error.code, 'AMECODE_MODEL_NOT_ALLOWED')
      assert.equal(forwarded.length, allowedCount)
    }
    policy = modelPolicy('user', extendedCatalog, { featureModels: ['feature-model'] })
    const featureResponse = await send('feature-model')
    assert.equal(featureResponse.status, 200)
    await featureResponse.json()
    assert.equal(forwarded.at(-1)!.model, 'feature-model')
    const tierResponse = await send('opus')
    assert.equal(tierResponse.status, 200)
    await tierResponse.json()
    assert.equal(forwarded.at(-1)!.model, levels.opus)
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
