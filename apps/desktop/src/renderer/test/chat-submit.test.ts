import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatSubmit } from '../chat-submit'

const model = { id: 'test', providerID: 'amecode', name: 'Test' }
const sendDraft = (submit: ReturnType<typeof chatSubmit>, draftID: number, text: string, project = 'project') => submit(project, undefined, text, model, undefined, undefined, draftID)

test('New Chat creates independent sessions and histories after a successful send', async () => {
  const histories = new Map<string, string[]>()
  const created: [string, number][] = []
  const submit = chatSubmit({
    createSession: async () => { const id = `session-${histories.size + 1}`; histories.set(id, []); return { id, title: 'New' } },
    prompt: async (_project, id, text) => { histories.get(id)!.push(text) },
  }, (session, draftID) => { created.push([session.id, draftID]) })
  assert.equal(await sendDraft(submit, 1, 'chat A'), true)
  assert.equal(await sendDraft(submit, 2, 'chat B'), true)
  assert.deepEqual(created, [['session-1', 1], ['session-2', 2]])
  assert.deepEqual([...histories], [['session-1', ['chat A']], ['session-2', ['chat B']]])
})

test('retry on the same explicit draft reuses its session after prompt failure', async () => {
  let creates = 0
  const ids: string[] = []
  const submit = chatSubmit({
    createSession: async () => { creates++; return { id: 'session-C', title: 'C' } },
    prompt: async (_project, id) => { ids.push(id); if (ids.length === 1) throw new Error('offline') },
  }, () => {})
  await assert.rejects(sendDraft(submit, 3, 'chat C'), /offline/)
  assert.equal(await sendDraft(submit, 3, 'chat C'), true)
  assert.equal(creates, 1)
  assert.deepEqual(ids, ['session-C', 'session-C'])
})

test('New Chat can send while an older draft is still creating, regardless of completion order', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let creates = 0
  const prompts: [string, string][] = [], created: [string, number][] = []
  const submit = chatSubmit({
    createSession: async () => { const id = `session-${++creates}`; if (creates === 1) await gate; return { id, title: 'New' } },
    prompt: async (_project, id, text) => { prompts.push([id, text]) },
  }, (session, draftID) => { created.push([session.id, draftID]) })
  const old = sendDraft(submit, 1, 'old draft')
  assert.equal(await sendDraft(submit, 1, 'duplicate'), false)
  assert.equal(await sendDraft(submit, 2, 'new draft'), true)
  release()
  assert.equal(await old, true)
  assert.equal(creates, 2)
  assert.deepEqual(created, [['session-2', 2], ['session-1', 1]])
  assert.deepEqual(prompts, [['session-2', 'new draft'], ['session-1', 'old draft']])
})

test('draft identities are scoped to their project', async () => {
  const ids: string[] = []
  const submit = chatSubmit({
    createSession: async project => ({ id: project, title: project }),
    prompt: async (_project, id) => { ids.push(id) },
  }, () => {})
  await sendDraft(submit, 1, 'A', 'project-A')
  await sendDraft(submit, 1, 'B', 'project-B')
  assert.deepEqual(ids, ['project-A', 'project-B'])
})
test('first send creates a session once and sends the original text and model', async () => {
  const calls: unknown[] = []
  const submit = chatSubmit({
    createSession: async project => { calls.push(['create', project]); return { id: 'new', title: 'New' } },
    prompt: async (...args) => { calls.push(['prompt', ...args]) },
  }, session => calls.push(['created', session.id]))
  assert.equal(await submit('project', undefined, 'hello', model, 'build'), true)
  assert.deepEqual(calls, [['create', 'project'], ['created', 'new'], ['prompt', 'project', 'new', 'hello', model, 'build']])
})
test('concurrent submits do not create duplicate sessions and failed prompts reuse the draft', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let creates = 0, prompts = 0
  const submit = chatSubmit({
    createSession: async () => { creates++; await gate; return { id: 'draft', title: 'Draft' } },
    prompt: async () => { if (++prompts === 1) throw new Error('offline') },
  }, () => {})
  const first = submit('project', undefined, 'keep me', model)
  assert.equal(await submit('project', undefined, 'duplicate', model), false)
  release()
  await assert.rejects(first, /offline/)
  assert.equal(await submit('project', undefined, 'keep me', model), true)
  assert.equal(creates, 1)
  assert.equal(prompts, 2)
})
test('existing chats skip creation; failed creation is retryable and empty input does nothing', async () => {
  let creates = 0
  const ids: string[] = []
  const submit = chatSubmit({
    createSession: async () => { if (++creates === 1) throw new Error('offline'); return { id: 'new', title: 'New' } },
    prompt: async (_project, id) => { ids.push(id) },
  }, () => {})
  assert.equal(await submit('project', undefined, '  ', model), false)
  await submit('project', 'existing', 'hello', model)
  assert.equal(creates, 0)
  await assert.rejects(submit('project', undefined, 'hello', model), /offline/)
  await submit('project', undefined, 'hello', model)
  assert.deepEqual(ids, ['existing', 'new'])
})
