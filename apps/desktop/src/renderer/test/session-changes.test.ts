import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IdeEvent, SessionDiff } from '../../../../../packages/protocol/src/index'
import { watchSessionChanges, type SessionChangesState } from '../session-changes'
import { normalize, completePatchContents } from '../opencode-session-diff'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const diff = (file: string): SessionDiff[] => [{ file, patch: '', additions: 1, deletions: 0, status: 'added' }]

test('session switches dispose listeners and ignore late snapshots', async () => {
  const listeners = new Set<(event: IdeEvent) => void>()
  const requests: { session: string; resolve: (files: SessionDiff[]) => void }[] = []
  const api = {
    onEvent(listener: (event: IdeEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    sessionDiff(_project: string, session: string) { return new Promise<SessionDiff[]>(resolve => requests.push({ session, resolve })) },
  }
  const old: SessionChangesState[] = [], current: SessionChangesState[] = []
  const stopOld = watchSessionChanges(api, 'p', 'old', state => old.push(state))
  stopOld()
  const stop = watchSessionChanges(api, 'p', 'current', state => current.push(state))
  requests[1].resolve(diff('current.ts')); requests[0].resolve(diff('old.ts'))
  await settle()
  assert.deepEqual(old.map(state => state.status), ['loading'])
  assert.equal(current.at(-1)?.files[0].file, 'current.ts')
  for (const listener of listeners) listener({ type: 'opencode', projectID: 'p', sessionID: 'other' })
  await new Promise(resolve => setTimeout(resolve, 220))
  assert.equal(requests.length, 2)
  for (const listener of listeners) listener({ type: 'opencode', projectID: 'p' })
  await new Promise(resolve => setTimeout(resolve, 220))
  assert.equal(requests[2].session, 'current', 'reconnect invalidates selected session')
  stop(); requests[2].resolve([]); await settle()
  assert.equal(listeners.size, 0)
  assert.equal(current.at(-1)?.files[0].file, 'current.ts')
})

test('API errors remain errors and matching events retry without Git fallback', async () => {
  let emit: (event: IdeEvent) => void = () => {}, calls = 0
  const states: SessionChangesState[] = []
  const stop = watchSessionChanges({
    onEvent(listener) { emit = listener; return () => {} },
    async sessionDiff() { if (++calls === 1) throw new Error('TurnRangeError'); return [] },
  }, 'p', 's', state => states.push(state))
  await settle()
  assert.equal(states.at(-1)?.status, 'error')
  assert.equal(states.at(-1)?.error, 'TurnRangeError')
  emit({ type: 'opencode', projectID: 'p', sessionID: 's' })
  await new Promise(resolve => setTimeout(resolve, 220))
  assert.equal(states.at(-1)?.status, 'ready')
  assert.deepEqual(states.at(-1)?.files, [])
  stop()
})

test('ported OpenCode parser handles full/partial patches, additions and no-newline markers', () => {
  const full = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n'
  assert.deepEqual(completePatchContents(full), { before: 'keep\nold\n', after: 'keep\nnew\n' })
  const parsed = normalize({ file: 'a.ts', patch: full, additions: 1, deletions: 1, status: 'modified' })
  assert.equal(parsed.fileDiff.deletionLines.join(''), 'keep\nold\n')
  assert.equal(parsed.fileDiff.additionLines.join(''), 'keep\nnew\n')
  const partial = normalize({ file: 'a.ts', patch: '--- a/a.ts\n+++ b/a.ts\n@@ -40 +40 @@\n-old\n+new\n', additions: 1, deletions: 1 })
  assert.equal(partial.fileDiff.hunks.length, 1)
  assert.deepEqual(completePatchContents('diff --git a/new file.ts b/new file.ts\n--- /dev/null\n+++ b/new file.ts\n@@ -0,0 +1 @@\n+new\n\\ No newline at end of file\n'), { before: '', after: 'new' })
})
