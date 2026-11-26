import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await delay(25)
  assert.ok(predicate(), 'expected a Git metadata change notification')
}

for (const linked of [false, true]) test(`external Git changes update workspace watchers (${linked ? 'linked worktree' : 'checkout initialized after opening'})`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-git-watch-'))
  const repo = path.join(root, 'repo'); await mkdir(repo)
  const events: string[] = []
  const ws = new Workspaces(path.join(root, 'projects.json'), id => events.push(id))
  t.after(async () => { ws.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const git = simpleGit(repo)
  if (!linked) await ws.add(repo, 'p', false)
  await git.raw(['init', '-b', 'main'])
  for (const [key, value] of Object.entries({ 'user.name': 'Review', 'user.email': 'review@example.invalid', 'commit.gpgSign': 'false', 'core.autocrlf': 'false' })) await git.addConfig(key, value)
  await writeFile(path.join(repo, 'a.txt'), 'initial\n')
  await git.add('.'); await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'initial'])
  let directory = repo
  if (linked) {
    directory = path.join(root, 'linked')
    await git.raw(['worktree', 'add', '-b', 'work', directory])
    await ws.add(directory, 'p', false)
  }
  const workingGit = simpleGit(directory)
  await writeFile(path.join(directory, 'a.txt'), 'changed\n')
  await delay(600); events.length = 0
  await workingGit.add('a.txt')
  await waitFor(() => events.includes('p'))
  assert.equal((await ws.status('p')).changes[0].index, 'M')
  await delay(350); events.length = 0
  // Shared refs live outside the linked worktree directory.
  await git.raw(['branch', 'external-branch'])
  await waitFor(() => events.includes('p'))
  assert.ok((await ws.gitBranches('p')).branches.some(branch => branch.name === 'external-branch'))
  await ws.remove('p'); await delay(350); events.length = 0
  await git.raw(['branch', 'after-removal'])
  await delay(400)
  assert.equal(events.length, 0, 'removal must close both local and common Git watchers')
})

test('superseded searches, removed projects and disposal cancel their in-flight workers', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-search-lifecycle-'))
  const ws = new Workspaces(path.join(root, 'projects.json'))
  t.after(async () => { ws.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  await writeFile(path.join(root, 'a.txt'), 'a'.repeat(40) + '!')
  await ws.add(root, 'p', false)
  const slow = { query: '(a+)+$', regex: true, include: ['a.txt'] }
  const first = assert.rejects(ws.searchProject('p', slow), { name: 'AbortError' })
  await delay(250)
  assert.equal((await ws.searchProject('p', { query: '!', include: ['a.txt'] })).totalMatches, 1)
  await first
  const removed = assert.rejects(ws.searchProject('p', slow), { name: 'AbortError' })
  await delay(250); await ws.remove('p'); await removed
  await ws.add(root, 'p', false)
  const disposed = assert.rejects(ws.searchProject('p', slow), { name: 'AbortError' })
  await delay(250); ws.dispose(); await disposed
})
