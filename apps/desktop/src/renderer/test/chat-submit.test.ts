import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatSubmit } from '../chat-submit'

const model = { id: 'test', providerID: 'amecode', name: 'Test' }
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
