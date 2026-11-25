import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IdeEvent, SessionDiff } from '../../../../../packages/protocol/src/index'
import { watchSessionChanges, type SessionChangesState } from '../session-changes'
import { normalize, completePatchContents } from '../opencode-session-diff'
import { SessionChanges } from '../components/SessionChanges'

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

test('normalize collapses Windows CRLF vs LF inflation across full, mixed, partial, and EOL-only patches', () => {
  // 1. Full 100-line file where only line 99 changed in content and 99 unchanged lines flipped LF -> CRLF.
  const before100 = Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1}`)
  const after100 = before100.map((line, i) => (i === 98 ? 'const line99 = 999' : `${line}\r`))
  const fullCrlfPatch = [
    'diff --git a/pet.ts b/pet.ts',
    '--- a/pet.ts',
    '+++ b/pet.ts',
    '@@ -1,100 +1,100 @@',
    ...before100.map(line => `-${line}`),
    ...after100.map(line => `+${line}`),
    '',
  ].join('\n')
  const fullNormalized = normalize({ file: 'pet.ts', patch: fullCrlfPatch, additions: 100, deletions: 100, status: 'modified' })
  assert.equal(fullNormalized.additions, 1)
  assert.equal(fullNormalized.deletions, 1)
  assert.equal(fullNormalized.eolNormalized, true)
  assert.equal(fullNormalized.eolOnly, undefined)
  assert.equal(fullNormalized.fileDiff.hunks.length, 1)

  // 2. Full file with unchanged LF context lines splitting two real LF insertions among CRLF lines.
  const middleContext = Array.from({ length: 12 }, (_, i) => ` contextLine${i + 1}`)
  const mixedPatch = [
    'diff --git a/main.ts b/main.ts',
    '--- a/main.ts',
    '+++ b/main.ts',
    '@@ -1,15 +1,17 @@',
    '-line1',
    '-line2',
    '+line1\r',
    '+addedA',
    '+line2\r',
    ...middleContext,
    '-lineLast',
    '+addedB',
    '+lineLast\r',
    '',
  ].join('\n')
  const mixedNormalized = normalize({ file: 'main.ts', patch: mixedPatch, additions: 5, deletions: 3, status: 'modified' })
  assert.equal(mixedNormalized.additions, 2)
  assert.equal(mixedNormalized.deletions, 0)
  assert.equal(mixedNormalized.eolNormalized, true)
  assert.equal(mixedNormalized.fileDiff.hunks.length, 2)

  // 3. Pure EOL-only patch (CRLF <-> LF only, zero content changes).
  const eolOnlyPatch = [
    'diff --git a/eol.ts b/eol.ts',
    '--- a/eol.ts',
    '+++ b/eol.ts',
    '@@ -1,2 +1,2 @@',
    '-one',
    '-two',
    '+one\r',
    '+two\r',
    '',
  ].join('\n')
  const eolOnly = normalize({ file: 'eol.ts', patch: eolOnlyPatch, additions: 2, deletions: 2, status: 'modified' })
  assert.equal(eolOnly.eolOnly, true)
  assert.equal(eolOnly.eolNormalized, true)
  assert.equal(eolOnly.additions, 0)
  assert.equal(eolOnly.deletions, 0)

  // 4. Partial -U0 multi-hunk patch with one CRLF-only hunk and one real change hunk.
  const partialCrlfPatch = [
    'diff --git a/partial.ts b/partial.ts',
    '--- a/partial.ts',
    '+++ b/partial.ts',
    '@@ -10,2 +10,2 @@',
    '-sameA',
    '-sameB',
    '+sameA\r',
    '+sameB\r',
    '@@ -40,2 +40,3 @@',
    '-keep',
    '-oldVal',
    '+keep\r',
    '+newVal1',
    '+newVal2',
    '',
  ].join('\n')
  const partialNormalized = normalize({ file: 'partial.ts', patch: partialCrlfPatch, additions: 5, deletions: 4, status: 'modified' })
  assert.equal(partialNormalized.eolNormalized, true)
  assert.equal(partialNormalized.additions, 2)
  assert.equal(partialNormalized.deletions, 1)
  assert.equal(partialNormalized.fileDiff.hunks.length, 1)
  assert.equal(partialNormalized.fileDiff.hunks[0]?.deletionStart, 40)
  assert.equal(partialNormalized.fileDiff.hunks[0]?.additionStart, 40)
  assert.equal(partialNormalized.fileDiff.deletionLines.join(''), 'keep\noldVal\n')
})

for (const { name, value, context } of [
  { name: 'two trailing spaces', value: 'new  ', context: false },
  { name: 'a trailing tab', value: 'new\t', context: false },
  { name: 'a whitespace-only addition', value: '  \t ', context: false },
  { name: 'a whitespace-only context line', value: '  \t ', context: true },
]) {
  for (const separator of ['\n', '\n\n', '\r\n\r\n']) {
    test(`normalize preserves ${name} in concatenated patches separated by ${JSON.stringify(separator)}`, () => {
      const section = (start: number) => [
        'diff --git a/whitespace.ts b/whitespace.ts',
        '--- a/whitespace.ts',
        '+++ b/whitespace.ts',
        `@@ -${start},${context ? 2 : 1} +${start},${context ? 2 : 1} @@`,
        '-old',
        `+${context ? 'new' : value}`,
        ...(context ? [` ${value}`] : []),
      ].join('\n')
      const patch = section(5) + separator + section(20) + separator
      const normalized = normalize({ file: 'whitespace.ts', patch, additions: 2, deletions: 2, status: 'modified' })

      assert.equal(normalized.parseFailed, undefined)
      assert.equal(normalized.fileDiff.hunks.length, 2)
      assert.equal(normalized.fileDiff.additionLines.join(''), (context ? `new\n${value}\n` : `${value}\n`).repeat(2))
      assert.equal(normalized.fileDiff.deletionLines.join(''), (context ? `old\n${value}\n` : 'old\n').repeat(2))
    })
  }
}

test('normalize handles concatenated tool patches, flags unparseable patches, and SessionChanges lazy-mounts closed details', () => {
  const concatenated = [
    'diff --git a/multi.ts b/multi.ts',
    '--- a/multi.ts',
    '+++ b/multi.ts',
    '@@ -5,1 +5,1 @@',
    '-a',
    '+b',
    'diff --git a/multi.ts b/multi.ts',
    '--- a/multi.ts',
    '+++ b/multi.ts',
    '@@ -20,1 +20,1 @@',
    '-c',
    '+d',
    '',
  ].join('\n')
  const multi = normalize({ file: 'multi.ts', patch: concatenated, additions: 2, deletions: 2, status: 'modified' })
  assert.equal(multi.parseFailed, undefined)
  assert.equal(multi.fileDiff.hunks.length, 2)

  const malformed = normalize({ file: 'broken.ts', patch: '@@ -1,5 +1,5 @@\nCORRUPTED\n', additions: 1, deletions: 1, status: 'modified' })
  assert.equal(malformed.parseFailed, true)

  const crlfSingleChange = [
    'diff --git a/pet.ts b/pet.ts',
    '--- a/pet.ts',
    '+++ b/pet.ts',
    '@@ -1,3 +1,3 @@',
    '-a',
    '-b',
    '-c',
    '+a\r',
    '+B_EDIT',
    '+c\r',
    '',
  ].join('\n')
  const html = renderToStaticMarkup(createElement(SessionChanges, {
    theme: 'dark',
    turn: true,
    state: {
      status: 'ready',
      files: [{ file: 'pet.ts', patch: crlfSingleChange, additions: 3, deletions: 3, status: 'modified' }],
    },
  }))
  assert.match(html, /CRLF↔LF/)
  assert.match(html, /\+1/)
  assert.match(html, /−1/)
  assert.doesNotMatch(html, /<diffs-container/)
})
