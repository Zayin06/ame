import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-status-performance-'))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  const notifications: string[] = []
  const workspaces = new Workspaces(path.join(root, 'projects.json'), id => notifications.push(id))
  const git = simpleGit(repo)
  t.after(async () => {
    workspaces.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await git.raw(['init', '-b', 'main'])
  await git.addConfig('user.name', 'Performance Test')
  await git.addConfig('user.email', 'performance@example.invalid')
  await git.addConfig('commit.gpgSign', 'false')
  await git.addConfig('core.autocrlf', 'false')
  await writeFile(path.join(repo, 'a.txt'), 'initial\n')
  await git.add('a.txt')
  await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'initial'])
  return { root, repo, git, workspaces, notifications }
}

async function traceGit(t: TestContext, root: string) {
  const previous = process.env.GIT_TRACE2_EVENT
  const trace = path.join(root, 'git-trace.jsonl')
  process.env.GIT_TRACE2_EVENT = trace.replace(/\\/g, '/')
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previous
  })
  return async () => (await readFile(trace, 'utf8')).trim().split(/\r?\n/)
    .map(line => JSON.parse(line) as { event: string; argv?: string[] })
    .filter(event => event.event === 'start')
    .map(event => event.argv!)
}

test('background status neither rewrites the index nor emits a file invalidation', { timeout: 20000 }, async t => {
  const { repo, workspaces, notifications } = await fixture(t)
  // Change stat metadata without changing content, forcing Git to refresh its cache.
  const touched = new Date(Date.now() - 60_000)
  await utimes(path.join(repo, 'a.txt'), touched, touched)
  await workspaces.add(repo, 'p', false)
  const indexPath = path.join(repo, '.git', 'index')
  const before = await readFile(indexPath)
  assert.deepEqual((await workspaces.status('p')).changes, [])
  assert.equal((await readFile(indexPath)).equals(before), true, 'background status must not write .git/index')
  await delay(500)
  assert.deepEqual(notifications, [], 'status reads must not trigger another workspace refresh')
})

test('concurrent status consumers share one Git snapshot and one safety audit', { timeout: 20000 }, async t => {
  const { root, repo, workspaces } = await fixture(t)
  await workspaces.add(repo, 'p', false)
  const commands = await traceGit(t, root)
  const states = await Promise.all(Array.from({ length: 8 }, () => workspaces.status('p')))
  assert.ok(states.every(state => state.branch === 'main' && state.changes.length === 0 && !state.hasRemote))
  const calls = await commands()
  t.diagnostic(`Git processes for 8 concurrent consumers: ${calls.length}`)
  assert.equal(calls.filter(args => args.includes('status')).length, 1, 'only one status process for concurrent callers')
  assert.equal(calls.filter(args => args.includes('--get-regexp')).length, 2, 'audit local and effective config only once')
  assert.equal(calls.length, 5, 'two config queries, status, git-dir and remote')
})

test('completed snapshots are not cached across source or remote changes', { timeout: 20000 }, async t => {
  const { repo, git, workspaces } = await fixture(t)
  await workspaces.add(repo, 'p', false)
  assert.deepEqual((await workspaces.status('p')).changes, [])
  await writeFile(path.join(repo, 'a.txt'), 'changed\n')
  const changed = await workspaces.status('p')
  assert.equal(changed.changes.find(file => file.path === 'a.txt')?.working, 'M')
  await git.add('a.txt')
  await git.addRemote('origin', 'https://example.invalid/test.git')
  const staged = await workspaces.status('p')
  assert.equal(staged.changes.find(file => file.path === 'a.txt')?.index, 'M')
  assert.equal(staged.hasRemote, true)
})

test('a failed status read can be retried after Git is initialized', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-status-retry-'))
  const workspaces = new Workspaces(path.join(root, 'projects.json'))
  t.after(async () => { workspaces.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  await workspaces.add(root, 'p', false)
  await Promise.all(Array.from({ length: 3 }, () => assert.rejects(workspaces.status('p'), /GIT_ROOT_REQUIRED/)))
  await simpleGit(root).raw(['init', '-b', 'main'])
  assert.equal((await workspaces.status('p')).branch, 'main')
})

test('a mutation invalidates an in-flight snapshot without letting its completion evict the newer read', { timeout: 20000 }, async t => {
  const { repo, workspaces } = await fixture(t)
  await writeFile(path.join(repo, 'a.txt'), 'changed\n')
  await workspaces.add(repo, 'p', false)
  const internal = workspaces as unknown as { readStatus: Workspaces['status'] }
  const readStatus = internal.readStatus.bind(workspaces)
  const releases: (() => void)[] = [], started: Promise<void>[] = [], announce: (() => void)[] = []
  const gates = Array.from({ length: 2 }, (_, index) => {
    started[index] = new Promise(resolve => { announce[index] = resolve })
    return new Promise<void>(resolve => { releases[index] = resolve })
  })
  t.after(() => releases.forEach(release => release()))
  let reads = 0
  t.mock.method(internal, 'readStatus', async (id: string) => {
    const index = reads++
    const result = await readStatus(id)
    if (index < gates.length) { announce[index](); await gates[index] }
    return result
  })
  const old = workspaces.status('p')
  await started[0]
  await workspaces.stage('p', 'a.txt', true)
  const fresh = workspaces.status('p')
  await started[1]
  // Drain the mutation's debounced notification before testing old-read cleanup.
  await delay(350)
  // The debounce correctly invalidates reads too; start the shared read after it.
  releases[1]()
  await fresh
  const current = workspaces.status('p')
  releases[0]()
  const oldState = await old
  const joined = workspaces.status('p')
  const [currentState, joinedState] = await Promise.all([current, joined])
  assert.equal(oldState.changes[0].working, 'M')
  assert.equal(currentState.changes[0].index, 'M')
  assert.equal(currentState.changes[0].working, ' ')
  assert.deepEqual(joinedState, currentState)
  assert.equal(reads, 3)
})
