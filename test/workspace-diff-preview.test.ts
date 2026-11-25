import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'
import { readDiffSide, diffPreviewLimit } from '../packages/ide-core/src/diff-content'

test('oversized diff sides never invoke the content reader; invalid UTF-8 is binary', async () => {
  let reads = 0
  assert.deepEqual(await readDiffSide(diffPreviewLimit + 1, async () => { reads++; throw new Error('must not read') }), { content: '', size: diffPreviewLimit + 1, tooLarge: true })
  assert.equal(reads, 0)
  assert.equal((await readDiffSide(2, async () => Buffer.from([0xc3, 0x28]))).binary, true)
  assert.equal((await readDiffSide(diffPreviewLimit, async () => Buffer.alloc(diffPreviewLimit, 97))).content.length, diffPreviewLimit)
})

test('Git oversized blobs are sized before loading for HEAD, index, commit and parent refs', async () => {
  const calls: string[][] = [], hash = 'a'.repeat(40)
  // No Git process/content reader may run: every ref exceeds the preview limit.
  const fake = {
    gitPath: async () => 'large.dat',
    git: () => ({ raw: async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'cat-file' && args[1] === '-s') return String(diffPreviewLimit + 1)
      if (args[0] === 'cat-file' && args[1] === '-t') return 'blob'
      if (args[0] === 'rev-parse') return hash
      if (args[0] === 'rev-list') return `${hash} ${'b'.repeat(40)}`
      throw new Error(`Unexpected content read: ${args.join(' ')}`)
    } }),
  }
  const invoke = Workspaces.prototype.diff.bind(fake as unknown as Workspaces)
  assert.equal((await invoke('p', 'large.dat', { kind: 'staged' })).tooLarge, true)
  assert.equal((await invoke('p', 'large.dat', { kind: 'commit', commit: hash })).tooLarge, true)
  assert.deepEqual(calls.filter(args => args[0] === 'cat-file'), ['HEAD', '', `${hash}^`, hash].flatMap(ref => [
    ['cat-file', '-t', `${ref}:./large.dat`], ['cat-file', '-s', `${ref}:./large.dat`],
  ]))
})

for (const [label, bytes, flag] of [
  ['NUL', Buffer.from([65, 0, 66]), 'binary'],
  ['invalid UTF-8', Buffer.from([0xff, 0xfe]), 'binary'],
  ['oversized', Buffer.alloc(diffPreviewLimit + 1, 97), 'tooLarge'],
] as const) test(`${label} is blocked on both sides of staged, commit and working diffs`, async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.ame-diff-preview-'))
  const workspaces = new Workspaces(path.join(directory, 'projects.json'))
  t.after(async () => { workspaces.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const project = await workspaces.add(directory, undefined, false)
  const git = simpleGit(directory)
  await git.init()
  await git.addConfig('user.name', 'Test'); await git.addConfig('user.email', 'test@example.invalid')
  await git.addConfig('core.autocrlf', 'false'); await git.addConfig('commit.gpgSign', 'false')
  const file = path.join(directory, 'data.bin')
  const commit = async (content: string | Buffer) => {
    await writeFile(file, content); await git.add('data.bin')
    await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'fixture'])
    return (await git.revparse(['HEAD'])).trim()
  }
  await commit('text')
  await writeFile(file, bytes); await git.add('data.bin')
  const check = (result: Awaited<ReturnType<Workspaces['diff']>>, side: 'originalSize' | 'modifiedSize') => {
    assert.equal(result[flag], true)
    assert.equal(result[side], bytes.length)
    assert.equal(result.sizeBytes, Math.max(result.originalSize!, result.modifiedSize!))
    assert.equal(result.original, ''); assert.equal(result.modified, '')
    assert.ok(result.reason)
  }
  check(await workspaces.diff(project.id, 'data.bin', { kind: 'staged' }), 'modifiedSize')
  check(await workspaces.diff(project.id, 'data.bin', { kind: 'working' }), 'originalSize')
  check(await workspaces.diff(project.id, 'data.bin'), 'modifiedSize')
  const binaryCommit = await commit(bytes)
  check(await workspaces.diff(project.id, 'data.bin', { kind: 'commit', commit: binaryCommit }), 'modifiedSize')
  await writeFile(file, 'text'); await git.add('data.bin')
  check(await workspaces.diff(project.id, 'data.bin', { kind: 'staged' }), 'originalSize')
  check(await workspaces.diff(project.id, 'data.bin'), 'originalSize')
  const textCommit = await commit('text')
  check(await workspaces.diff(project.id, 'data.bin', { kind: 'commit', commit: textCommit }), 'originalSize')
  await writeFile(file, bytes)
  check(await workspaces.diff(project.id, 'data.bin', { kind: 'working' }), 'modifiedSize')
})
