import assert from 'node:assert/strict'
import { test } from 'node:test'
import { removeProjectSafely } from '../project-removal'
import { dirty, documentID, withoutProjectDocuments, type Buffer } from '../state'

function harness(choice: 'save' | 'discard' | 'cancel', fail?: string) {
  let buffers: Record<string, Buffer> = {}
  for (const [projectID, path] of [['p', 'visible.txt'], ['p', 'hidden.txt'], ['q', 'other.txt']]) {
    buffers[documentID(projectID, path)] = { projectID, path, content: 'original', text: `edited ${path}`, revision: 'v1', conflict: false }
  }
  const calls: string[] = []
  let open = true
  const options = {
    buffers: () => buffers, saving: new Set<string>(),
    update: (key: string, update: (buffer: Buffer) => Buffer) => { buffers = { ...buffers, [key]: update(buffers[key]) } },
    api: {
      confirmProjectRemoval: async (_id: string, paths: string[]) => {
        calls.push('confirm'); assert.deepEqual(paths, ['visible.txt', 'hidden.txt'])
        return choice === 'cancel' ? null : { choice, token: 'approval' }
      },
      save: async (_id: string, path: string, content: string, revision: string) => {
        calls.push(`save:${path}`); assert.equal(revision, 'v1')
        if (path === 'hidden.txt' && fail) throw new Error(fail)
        return { path, content, revision: 'v2', language: 'plaintext' }
      },
      removeProject: async (_id: string, token?: string) => { calls.push(`remove:${token ?? 'standard'}`); open = false },
    },
  }
  return { options, calls, buffers: () => buffers, open: () => open,
    run: async () => { const removed = await removeProjectSafely('p', options); if (removed) buffers = withoutProjectDocuments(buffers, 'p'); return removed } }
}

for (const choice of ['cancel', 'discard', 'save'] as const) test(`two dirty buffers including an inactive tab: ${choice}`, async () => {
  const h = harness(choice)
  assert.equal(await h.run(), choice !== 'cancel')
  assert.equal(h.open(), choice === 'cancel')
  assert.deepEqual(h.calls, choice === 'cancel' ? ['confirm'] : choice === 'discard' ? ['confirm', 'remove:approval'] : ['confirm', 'save:visible.txt', 'save:hidden.txt', 'remove:approval'])
  assert.equal(Object.values(h.buffers()).filter(buffer => buffer.projectID === 'p').length, choice === 'cancel' ? 2 : 0)
  assert.ok(dirty(h.buffers()[documentID('q', 'other.txt')]))
  if (choice === 'cancel') assert.ok(Object.values(h.buffers()).every(dirty))
})

for (const failure of ['FILE_CONFLICT', 'EACCES']) test(`failed hidden-file save retains project and all buffers: ${failure}`, async () => {
  const h = harness('save', failure)
  await assert.rejects(h.run(), new RegExp(`hidden.txt.*${failure}`))
  assert.equal(h.open(), true)
  assert.equal(Object.keys(h.buffers()).length, 3)
  const hidden = h.buffers()[documentID('p', 'hidden.txt')]
  assert.equal(hidden.text, 'edited hidden.txt'); assert.ok(dirty(hidden))
  assert.equal(hidden.conflict, failure === 'FILE_CONFLICT')
  assert.ok(!h.calls.some(call => call.startsWith('remove:')))
})

test('known conflict aborts before writing and names the file', async () => {
  const h = harness('save')
  h.options.update(documentID('p', 'visible.txt'), buffer => ({ ...buffer, conflict: true }))
  await assert.rejects(h.run(), /visible.txt.*FILE_CONFLICT/)
  assert.deepEqual(h.calls, ['confirm']); assert.equal(h.open(), true)
  assert.ok(Object.values(h.buffers()).every(dirty))
})

test('clean project uses standard native removal confirmation', async () => {
  const h = harness('save')
  for (const path of ['visible.txt', 'hidden.txt']) h.options.update(documentID('p', path), buffer => ({ ...buffer, text: buffer.content }))
  await h.run()
  assert.deepEqual(h.calls, ['remove:standard']); assert.equal(h.open(), false)
})

test('edits arriving during save stop removal instead of losing newer text', async () => {
  const h = harness('save'), save = h.options.api.save
  h.options.api.save = async (...args) => {
    const saved = await save(...args)
    h.options.update(documentID('p', args[1]), buffer => ({ ...buffer, text: 'newer edit' }))
    return saved
  }
  await assert.rejects(h.run(), /visible.txt, hidden.txt/)
  assert.equal(h.open(), true)
  assert.equal(h.buffers()[documentID('p', 'hidden.txt')].text, 'newer edit')
})
