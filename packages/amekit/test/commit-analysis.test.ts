import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildCommitAnalysisPrompt, createPinnedSessionModelStore } from '../src/commit-analysis'

test('model pins survive restart, isolate workspaces, serialize writes and reject repinning', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-model-pins-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'pins.json')
  const store = createPinnedSessionModelStore(file)
  assert.throws(() => store.models('repo'), /NOT_LOADED/)
  await store.load()
  await Promise.all([store.pin('repo', 'one', 'fast'), store.pin('repo', 'two', 'deep')])
  await assert.rejects(store.pin('repo', 'one', 'other'), /ALREADY_PINNED/)
  const reloaded = createPinnedSessionModelStore(file); await reloaded.load()
  assert.deepEqual({ ...reloaded.models('repo') }, { one: 'fast', two: 'deep' })
  assert.deepEqual({ ...reloaded.models('other') }, {})
  const copy = reloaded.models('repo'); copy.one = 'tampered'
  assert.equal(reloaded.models('repo').one, 'fast')
})

test('pinning preserves null prototypes and never treats inherited keys as session pins', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-model-pins-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'pins.json')
  const store = createPinnedSessionModelStore(file)
  await store.load()
  await store.pin('repo', 'one', 'fast')
  for (const scope of ['repo', 'constructor', 'toString', '__proto__']) {
    const models = store.models(scope)
    assert.equal(Object.getPrototypeOf(models), null)
    for (const key of ['constructor', 'toString', '__proto__']) assert.equal(models[key], undefined)
  }
  await store.pin('repo', 'constructor', 'deep')
  await store.pin('__proto__', 'toString', 'fast')
  assert.equal(store.models('repo').constructor, 'deep')
  assert.equal(store.models('__proto__').toString, 'fast')
  const reloaded = createPinnedSessionModelStore(file); await reloaded.load()
  assert.equal(Object.getPrototypeOf(reloaded.models('repo')), null)
  assert.equal(reloaded.models('repo').toString, undefined)
  assert.equal(reloaded.models('__proto__').toString, 'fast')
})

test('analysis prompt stays compact, prioritizes staged and permits later explicit user requests', () => {
  const prompt = buildCommitAnalysisPrompt({ branch: 'main', stagedFiles: ['staged.ts'], workingFiles: ['working.ts'] })
  assert.match(prompt, /"scope":"staged"/)
  assert.match(prompt, /staged.ts/)
  assert.doesNotMatch(prompt, /working.ts|commit-plan|backend thực thi|readonly/)
  assert.match(prompt, /code block/)
  assert.match(prompt, /người dùng yêu cầu tiếp rõ ràng/)
  assert.match(buildCommitAnalysisPrompt({ branch: 'main', stagedFiles: [], workingFiles: ['new.ts'] }), /"scope":"working"/)
})
