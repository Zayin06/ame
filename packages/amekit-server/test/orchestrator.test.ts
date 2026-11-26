import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent } from '@opencode/schema/agent'
import type { AgentEditor } from '@opencode/plugin/promise/agent'
import { OrchestratorConfig } from '../../amekit/src/orchestrator'
import { applyOrchestrator } from '../src/orchestrator'

const config = OrchestratorConfig.parse({ id: 'ame-orchestrator', version: '1.0.0', description: 'Coordinate all teams', prompt: 'Choose installed leads by capability.', subagentDepth: 3 })

test('root registration retains platform catalog and effective tool permissions without choosing the native default', () => {
  const build: NonNullable<ReturnType<AgentEditor['get']>> = structuredClone(Agent.Info.default(Agent.ID.make('build')))
  build.permissions.push({ action: 'shell', resource: '*', effect: 'deny' })
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
  assert.match(root.system!, /version=1.0.0/)
  assert.deepEqual(root.permissions, build.permissions)
  assert.notEqual(root.permissions, build.permissions)
  assert.equal(agents.get('ios-lead'), lead)
  assert.equal(lead.mode, 'all')
  applyOrchestrator(editor, { ...config, version: '1.0.1', prompt: 'Updated routing guidance.' })
  assert.equal(agents.size, 3)
  assert.match(root.system!, /version=1.0.1/)
  assert.match(root.system!, /Updated routing guidance/)
})

test('orchestrator contract rejects unsupported IDs, depth, empty prompts and oversized configuration', () => {
  for (const change of [{ id: 'android-dev' }, { subagentDepth: 4 }, { prompt: ' ' }, { prompt: 'x'.repeat(16001) }, { version: 'latest' }, { permissions: [] }]) {
    assert.equal(OrchestratorConfig.safeParse({ ...config, ...change }).success, false)
  }
})
