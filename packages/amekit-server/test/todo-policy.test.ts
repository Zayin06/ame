import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AME_TODO_POLICY_MARKER, createRootTodoGuard, ORCHESTRATOR_AGENT_ID, AME_TODO_SYSTEM_NOTE, AME_TODO_TOOL_DESCRIPTION, TODO_TOOL_NAME } from '../src/todo-policy'

const forbidden = { message: 'TODOWRITE_FORBIDDEN: Chỉ ame-orchestrator ở phiên gốc mới được cập nhật todo.' }
const identity = { sessionID: 'root', agent: ORCHESTRATOR_AGENT_ID }
const context = (agent = ORCHESTRATOR_AGENT_ID, sessionID = 'root') => ({
  agent, sessionID,
  tools: { todowrite: {}, ' ToDoWrItE ': {}, shell: {} },
  system: [{ type: 'text' as const, text: '[amecode-model-levels]\nExisting policy' }],
})

test('root orchestrator retains tools and gets one policy note without replacing existing system notes', async () => {
  let lookups = 0
  const guard = createRootTodoGuard(async () => { lookups++; return {} })
  const input = context()
  await guard.filterContext(input)
  await guard.filterContext(input)
  await guard.assertBeforeExecute({ ...identity, tool: TODO_TOOL_NAME })
  assert.equal(await guard.isAllowed(identity.agent, identity.sessionID), true)
  assert.equal(lookups, 1)
  assert.deepEqual(Object.keys(input.tools), ['todowrite', ' ToDoWrItE ', 'shell'])
  assert.deepEqual(input.system.map(part => part.text), ['[amecode-model-levels]\nExisting policy', AME_TODO_SYSTEM_NOTE])
  assert.equal(input.system.filter(part => part.text.includes(AME_TODO_POLICY_MARKER)).length, 1)
})

test('children including child orchestrators lose normalized todo tools and cannot execute them', async () => {
  const guard = createRootTodoGuard(async () => ({ parentID: 'root' }))
  for (const agent of [ORCHESTRATOR_AGENT_ID, 'specialist']) {
    const input = context(agent, 'child')
    await guard.filterContext(input)
    assert.deepEqual(Object.keys(input.tools), ['shell'])
    assert.equal(input.system.length, 1)
    await assert.rejects(guard.assertBeforeExecute({ ...input, tool: ' ToDoWrItE ' }), forbidden)
  }
})

test('non-orchestrators and inexact agent names are denied even in root sessions without lookups', async () => {
  let lookups = 0
  const guard = createRootTodoGuard(async () => { lookups++; return {} })
  for (const agent of ['build', 'AME-ORCHESTRATOR', ' ame-orchestrator ']) {
    const input = context(agent)
    await guard.filterContext(input)
    assert.deepEqual(Object.keys(input.tools), ['shell'])
    await assert.rejects(guard.assertBeforeExecute({ ...input, tool: 'todowrite' }), forbidden)
  }
  assert.equal(lookups, 0)
})

test('missing and failed session lookups fail closed and cache denial', async () => {
  for (const lookup of [async () => undefined, async () => { throw new Error('lookup failed') }]) {
    let lookups = 0
    const guard = createRootTodoGuard(async () => { lookups++; return lookup() })
    const input = context()
    await guard.filterContext(input)
    assert.deepEqual(Object.keys(input.tools), ['shell'])
    assert.equal(await guard.isAllowed(identity.agent, identity.sessionID), false)
    await assert.rejects(guard.assertBeforeExecute({ ...identity, tool: 'todowrite' }), forbidden)
    assert.equal(lookups, 1)
  }
})

test('other tools are no-ops, without looking up sessions or matching substrings', async () => {
  const guard = createRootTodoGuard(async () => { assert.fail('other tools need no session lookup') })
  for (const tool of ['shell', 'todo', 'namespace.todowrite', 'todowrite_extra']) {
    await guard.assertBeforeExecute({ ...identity, tool })
  }
})

test('root cache is bounded to 500 sessions and evicted sessions are looked up again', async () => {
  const lookups: string[] = []
  const guard = createRootTodoGuard(async sessionID => { lookups.push(sessionID); return {} })
  for (let index = 0; index < 501; index++) {
    assert.equal(await guard.isAllowed(identity.agent, String(index)), true)
  }
  await guard.isAllowed(identity.agent, '500')
  assert.equal(lookups.length, 501)
  await guard.isAllowed(identity.agent, '0')
  assert.equal(lookups.length, 502)
  assert.equal(lookups.at(-1), '0')
})

test('tool description and system note both carry the complete V1 policy', () => {
  assert.equal(TODO_TOOL_NAME, 'todowrite')
  assert.equal(ORCHESTRATOR_AGENT_ID, 'ame-orchestrator')
  assert.equal(AME_TODO_POLICY_MARKER, '[ame-todo-policy]')
  for (const text of [AME_TODO_TOOL_DESCRIPTION, AME_TODO_SYSTEM_NOTE]) {
    for (const rule of [/level 0/, /parentID absent/, /Child sessions and subagents report/, /never write the master todo/, />=3 distinct deliverables \(separate outcomes\)/, /explicit checklist/, /not files, tools, or response length/, /immediately.*mid-run/, /pending, in_progress, completed, and cancelled/, /Multiple in_progress.*explicitly allowed/, /dependencies, file scope, and shared resources/, /avoid assigning subagents to the same file/, /only after actual checks/, /scope changes/, /Never mark work completed on errors, failures, or stops/, /one list per execution/, /follow-up user messages while running update the current execution's list/, /new user task after the execution starts a fresh list/]) {
      assert.match(text, rule)
    }
  }
})
