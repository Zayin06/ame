import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent } from '@opencode/schema/agent'
import type { AgentEditor } from '@opencode/plugin/promise/agent'
import { OrchestratorConfig } from '../../amekit/src/orchestrator'
import { applyOrchestrator, orchestratorPermissions } from '../src/orchestrator'

const config = OrchestratorConfig.parse({ id: 'ame-orchestrator', version: '1.0.0', description: 'Coordinate all teams', prompt: 'Choose installed leads by capability.', subagentDepth: 3 })

test('root registration retains platform catalog with independent permissions without choosing the native default', () => {
  const build: NonNullable<ReturnType<AgentEditor['get']>> = structuredClone(Agent.Info.default(Agent.ID.make('build')))
  build.permissions.push({ action: 'shell', resource: '*', effect: 'deny' })
  const originalBuild = structuredClone(build)
  const lead = { ...structuredClone(build), id: Agent.ID.make('ios-lead'), mode: 'all' as const }
  const agents = new Map<string, typeof build>([['build', build], ['ios-lead', lead]])
  const editor: AgentEditor = {
    list: () => [...agents.values()], get: id => agents.get(id),
    update(id, change) {
      const draft = agents.get(id) ?? structuredClone(Agent.Info.default(Agent.ID.make(id)))
      change(draft); agents.set(id, draft)
    },
    remove(id) { agents.delete(id) },
    default() { assert.fail('special-purpose sessions must keep their native default') },
  }
  applyOrchestrator(editor, undefined)
  assert.equal(agents.size, 2)
  applyOrchestrator(editor, config)
  const root = agents.get(config.id)!
  assert.equal(root.mode, 'primary')
  assert.equal(root.model, undefined)
  assert.equal(root.hidden, false)
  assert.equal(root.description, config.description)
  assert.equal(root.system, `[ame-orchestrator version=${config.version}]\n${config.prompt}`)
  assert.deepEqual(root.permissions, orchestratorPermissions())
  assert.ok(root.permissions.some(rule => rule.action === 'shell' && rule.effect === 'allow'))
  assert.notEqual(root.permissions, build.permissions)
  assert.equal(agents.get('ios-lead'), lead)
  assert.equal(lead.mode, 'all')
  assert.deepEqual(build, originalBuild)
  build.permissions.push({ action: 'skill', resource: '*', effect: 'allow' })
  applyOrchestrator(editor, { ...config, version: '1.0.1', prompt: 'Updated routing guidance.' })
  assert.equal(agents.size, 3)
  assert.match(root.system!, /version=1.0.1/)
  assert.match(root.system!, /Updated routing guidance/)
  assert.deepEqual(root.permissions, orchestratorPermissions())
})

test('explicit permissions are self-contained without build and allow only normalized active catalog entries', () => {
  const root = structuredClone(Agent.Info.default(Agent.ID.make(config.id)))
  const editor: AgentEditor = {
    list: () => [], get() { assert.fail('permissions must not read native build') },
    update(_id, change) { change(root) }, remove() {},
    default() { assert.fail('must not change dedicated session defaults') },
  }
  applyOrchestrator(editor, config)
  assert.deepEqual(root.permissions, orchestratorPermissions())
  for (const action of ['subagent', 'skill']) {
    assert.deepEqual(root.permissions.filter(rule => rule.action === action), [{ action, resource: '*', effect: 'deny' }])
  }
  const catalog = { agents: [' lead-one ', 'lead-two', 'custom-third', 'lead-one', ' '], skills: [' skill-one ', 'custom-second', 'skill-one'] }
  applyOrchestrator(editor, config, catalog)
  assert.deepEqual(root.permissions.filter(rule => rule.action === 'subagent' && rule.effect === 'allow').map(rule => rule.resource), ['lead-one', 'lead-two', 'custom-third'])
  assert.deepEqual(root.permissions.filter(rule => rule.action === 'skill' && rule.effect === 'allow').map(rule => rule.resource), ['skill-one', 'custom-second'])
  assert.deepEqual(root.permissions.slice(0, 5), [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'ask' },
    { action: 'read', resource: '*.env.*', effect: 'ask' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
  ])
  for (const action of ['glob', 'grep', 'edit', 'shell', 'webfetch', 'websearch', 'question', 'todowrite']) {
    assert.ok(root.permissions.some(rule => rule.action === action && rule.resource === '*' && rule.effect === 'allow'))
  }
  assert.ok(root.permissions.some(rule => rule.action === 'external_directory' && rule.resource === '*' && rule.effect === 'ask'))
  applyOrchestrator(editor, config, { agents: [], skills: [] })
  assert.deepEqual(root.permissions, orchestratorPermissions())
})

test('orchestrator contract rejects unsupported IDs, depth, empty prompts and oversized configuration', () => {
  for (const change of [{ id: 'android-dev' }, { subagentDepth: 4 }, { prompt: ' ' }, { prompt: 'x'.repeat(16001) }, { version: 'latest' }, { permissions: [] }]) {
    assert.equal(OrchestratorConfig.safeParse({ ...config, ...change }).success, false)
  }
})
