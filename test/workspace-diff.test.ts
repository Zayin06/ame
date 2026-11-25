import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { z } from 'zod'

test('diff IPC validates discriminated targets and forwards legacy and scoped requests', async () => {
  const source = await readFile('apps/desktop/src/main/index.ts', 'utf8')
  const calls: unknown[][] = []
  const dispatch = runInNewContext(ts.transpileModule(source.slice(source.indexOf('const text ='), source.indexOf('let authority:')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\ncall', {
    z, pairingSchema: z.object({ enabled: z.boolean(), keepScreenActive: z.boolean() }),
    workspace: { diff: (...args: unknown[]) => { calls.push(args); return { original: '', modified: '' } } }
  }) as (method: string, args: unknown[]) => Promise<unknown>
  for (const target of [undefined, { kind: 'staged' }, { kind: 'working' }, { kind: 'commit', commit: 'ABCDEF1' }]) {
    await dispatch('diff', target ? ['p', 'file', target] : ['p', 'file'])
    assert.deepEqual(calls.at(-1), ['p', 'file', target])
  }
  for (const target of [{ kind: 'commit' }, { kind: 'commit', commit: 'HEAD' }, { kind: 'commit', commit: 'a'.repeat(41) }, { kind: 'staged', commit: 'abcdef1' }, { kind: 'other' }, 'staged']) await assert.rejects(dispatch('diff', ['p', 'file', target]))
  assert.equal(calls.length, 4)
})

test('diff scopes isolate partial staging and read historical snapshots including root and deletion', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.ame-diff-test-'))
  const workspaces = new Workspaces(path.join(directory, 'unused.json'))
  t.after(async () => { workspaces.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const project = await workspaces.add(directory, undefined, false)
  workspaces.dispose()
  const git = simpleGit(directory)
  await git.init()
  for (const [key, value] of Object.entries({ 'user.name': 'Ame Test', 'user.email': 'test@example.invalid', 'commit.gpgSign': 'false', 'core.autocrlf': 'false', 'core.hooksPath': '' })) await git.addConfig(key, value)
  const file = 'literal [file] space.txt', disk = path.join(directory, file)
  const base = 'first\nunchanged\nlast\n', index = 'FIRST\nunchanged\nlast\n', working = 'FIRST\nunchanged\nLAST\n'
  const diff = (kind: 'staged' | 'working') => workspaces.diff(project.id, file, { kind })
  await writeFile(disk, base)
  assert.deepEqual(await diff('working'), { original: '', modified: base })
  await workspaces.stage(project.id, file, true)
  assert.deepEqual(await diff('staged'), { original: '', modified: base })
  await git.commit('root')
  const root = (await git.revparse(['HEAD'])).trim()
  // Stage exactly the first change, then leave the second change only on disk.
  await writeFile(disk, index); await workspaces.stage(project.id, file, true)
  await writeFile(disk, working)
  assert.deepEqual(await diff('staged'), { original: base, modified: index })
  assert.deepEqual(await diff('working'), { original: index, modified: working })
  assert.deepEqual(await workspaces.diff(project.id, file), { original: base, modified: working })
  await workspaces.stage(project.id, file, true); await git.commit('second')
  const second = (await git.revparse(['HEAD'])).trim()
  assert.equal((await git.status()).isClean(), true)
  assert.deepEqual(await workspaces.diff(project.id, file, { kind: 'commit', commit: root.slice(0, 7) }), { original: '', modified: base })
  assert.deepEqual(await workspaces.diff(project.id, file, { kind: 'commit', commit: second }), { original: base, modified: working })
  await rm(disk)
  assert.deepEqual(await diff('working'), { original: working, modified: '' })
  await workspaces.stage(project.id, file, true)
  assert.deepEqual(await diff('staged'), { original: working, modified: '' })
  assert.deepEqual(await diff('working'), { original: '', modified: '' })
  await git.commit('delete')
  const deleted = (await git.revparse(['HEAD'])).trim()
  assert.deepEqual(await workspaces.diff(project.id, file, { kind: 'commit', commit: deleted }), { original: working, modified: '' })
  assert.deepEqual(await workspaces.diff(project.id, file, { kind: 'commit', commit: root }), { original: '', modified: base })
  for (const commit of ['HEAD', '123456', 'a'.repeat(41), '1234567^']) await assert.rejects(workspaces.diff(project.id, file, { kind: 'commit', commit }), /INVALID_DIFF_TARGET/)
  await assert.rejects(workspaces.diff(project.id, file, { kind: 'commit', commit: '0'.repeat(40) }))
  await assert.rejects(workspaces.diff(project.id, '../outside', { kind: 'staged' }), /PATH_OUTSIDE_WORKSPACE/)
})
