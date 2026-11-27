import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename, link } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import os from 'node:os'
import { z } from 'zod'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'
import { GIT_COMMIT_HASH_PATTERN } from '../packages/protocol/src/index'

async function fixture(t: { after(fn: () => Promise<void>): void }, changed?: (projectID: string) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-workspace-test-'))
  const directory = path.join(root, 'project'); await mkdir(directory)
  const workspaces = new Workspaces(path.join(root, 'projects.json'), changed)
  const project = await workspaces.add(directory)
  // Windows can briefly retain watcher/Git handles after disposal.
  t.after(async () => { workspaces.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { root, directory, workspaces, project }
}
test('replace-all and save share file locks across atomic inode replacement', async t => {
  const { directory, workspaces, project } = await fixture(t)
  workspaces.dispose()
  await writeFile(path.join(directory, 'a.txt'), 'cat')
  const doc = await workspaces.read(project.id, 'a.txt')
  const options = { query: 'cat', replacement: 'dog' }
  const preview = await workspaces.replaceInProject(project.id, { ...options, dryRun: true })
  const results = await Promise.allSettled([
    workspaces.save(project.id, 'a.txt', 'saved', doc.revision),
    workspaces.replaceInProject(project.id, options, preview.previews),
    workspaces.replaceInProject(project.id, options, preview.previews),
  ])
  const disk = await readFile(path.join(directory, 'a.txt'), 'utf8')
  assert.ok(disk === 'saved' || disk === 'dog')
  const saves = results[0].status === 'fulfilled' ? 1 : 0
  const replacements = results.slice(1).reduce((sum, result) => sum + (result.status === 'fulfilled' ? (result.value as { filesChanged: number }).filesChanged : 0), 0)
  assert.equal(saves + replacements, 1)
})

test('build notes workspace delegate is read-only and emits no change notifications', async t => {
  const notifications: string[] = []
  const { directory, workspaces, project } = await fixture(t, id => notifications.push(id))
  workspaces.dispose()
  const git = simpleGit(directory)
  await git.raw(['init', '--initial-branch=main'])
  await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid')
  await git.addConfig('commit.gpgSign', 'false'); await git.addConfig('core.autocrlf', 'false')
  await writeFile(path.join(directory, 'tracked.txt'), 'initial\n')
  await git.raw(['add', '--', 'tracked.txt']); await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'initial'])
  await writeFile(path.join(directory, 'tracked.txt'), 'working\n')
  const before = notifications.length
  const summary = await workspaces.buildNotesSummary(project.id, { mode: 'commits', includeWorking: true })
  assert.equal(summary.branch, 'main'); assert.equal(summary.workingFileCount, 1)
  assert.match(summary.diff, /\+working/)
  const limited = await workspaces.buildNotesSummary(project.id, { mode: 'range', includeWorking: true }, 12)
  assert.ok(Buffer.byteLength(limited.diff) <= 12); assert.equal(limited.truncated, true)
  assert.equal(notifications.length, before)
  await assert.rejects(workspaces.buildNotesSummary('missing', { mode: 'range', includeWorking: true }), /UNKNOWN_PROJECT/)
})

test('preload build notes methods forward scope requests and preserve IPC rejections', async () => {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'preload', 'index.ts'), 'utf8')
  const calls: { method: string; args: unknown[] }[] = []
  let api: Pick<import('../packages/protocol/src/index').DesktopApi, 'buildNotesPreview' | 'generateBuildNotes'> | undefined
  let fail = false
  const response = { notes: 'notes' }
  const context = {
    exports: {},
    require: (name: string) => {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld: (_: string, value: typeof api) => { api = value } },
        ipcRenderer: { invoke: async (channel: string, method: string, args: unknown[]) => {
          assert.equal(channel, 'ame:call'); calls.push({ method, args: Array.from(args) })
          if (fail) throw new Error('INVALID_BUILD_BASE_COMMIT')
          return response
        } }
      }
    }
  }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  assert.ok(api)
  const request = { mode: 'range' as const, baseCommit: '1234567', includeWorking: true, note: 'QC' }
  assert.equal(await api.buildNotesPreview('project', request), response)
  assert.equal(await api.generateBuildNotes('project', request), response)
  assert.deepEqual(calls, [{ method: 'buildNotesPreview', args: ['project', request] }, { method: 'generateBuildNotes', args: ['project', request] }])
  fail = true
  await assert.rejects(api.buildNotesPreview('project', request), /INVALID_BUILD_BASE_COMMIT/)
  await assert.rejects(api.generateBuildNotes('project', request), /INVALID_BUILD_BASE_COMMIT/)
})

test('project persistence, UTF-8 edit/save, stale buffer conflict and serialized saves', async t => {
  const { root, directory, workspaces, project } = await fixture(t)
  await writeFile(path.join(directory, 'hello.ts'), 'export const lời = "chào"\r\n')
  const doc = await workspaces.read(project.id, 'hello.ts')
  const saved = await workspaces.save(project.id, 'hello.ts', doc.content + '// edit\n', doc.revision)
  assert.notEqual(saved.revision, doc.revision)
  await writeFile(path.join(directory, 'hello.ts'), '// agent changed\n')
  await assert.rejects(workspaces.save(project.id, 'hello.ts', 'overwrite', saved.revision), /FILE_CONFLICT/)
  const external = await workspaces.read(project.id, 'hello.ts')
  const attempts = await Promise.allSettled([workspaces.save(project.id, 'hello.ts', 'first', external.revision), workspaces.save(project.id, 'hello.ts', 'second', external.revision)])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(await readFile(path.join(directory, 'hello.ts'), 'utf8'), 'first')
  const restored = new Workspaces(path.join(root, 'projects.json')); await restored.load()
  try { assert.equal(restored.list()[0].id, project.id) } finally { restored.dispose() }
})
for (const alias of ['./seed', ...(process.platform === 'win32' ? ['SEED'] : ['hardlink'])]) {
  test(`canonical saves serialize seed and ${alias} and preserve the winner and BOM`, async t => {
    const { directory, workspaces, project } = await fixture(t)
    await writeFile(path.join(directory, 'seed'), '\uFEFForiginal\n')
    if (alias === 'hardlink') await link(path.join(directory, 'seed'), path.join(directory, alias))
    const doc = await workspaces.read(project.id, 'seed')
    assert.equal(doc.content, 'original\n')
    const contents = ['first\n', 'second\n']
    const attempts = await Promise.allSettled([
      workspaces.save(project.id, 'seed', contents[0], doc.revision),
      workspaces.save(project.id, alias, contents[1], doc.revision),
    ])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    const loser = attempts.find(result => result.status === 'rejected')
    assert.ok(loser?.status === 'rejected'); assert.match(String(loser.reason), /FILE_CONFLICT/)
    const winner = attempts.findIndex(result => result.status === 'fulfilled')
    assert.equal(await readFile(path.join(directory, 'seed'), 'utf8'), '\uFEFF' + contents[winner])
    const saved = await workspaces.read(project.id, 'seed')
    await workspaces.save(project.id, alias, 'alias edit\n', saved.revision)
    assert.equal(await readFile(path.join(directory, 'seed'), 'utf8'), '\uFEFFalias edit\n')
  })
}

test('removing a project closes its watcher, persists remaining projects and never deletes project files', async t => {
  const { root, directory, workspaces, project } = await fixture(t)
  await writeFile(path.join(directory, 'keep.txt'), 'keep on disk')
  const otherDirectory = path.join(root, 'other'); await mkdir(otherDirectory)
  const other = await workspaces.add(otherDirectory)
  const watchers = (workspaces as unknown as { watchers: Map<string, { close(): void }> }).watchers
  const watcher = watchers.get(project.id)
  assert.ok(watcher, 'fixture filesystem must support recursive watch')
  const close = t.mock.method(watcher, 'close')
  await workspaces.remove(project.id)
  assert.equal(close.mock.callCount(), 1)
  assert.equal(watchers.has(project.id), false)
  assert.ok(watchers.has(other.id))
  assert.deepEqual(workspaces.list(), [other])
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8')), [other])
  assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'keep on disk')
  assert.throws(() => workspaces.get(project.id), /UNKNOWN_PROJECT/)
  await assert.rejects(workspaces.entries(project.id), /UNKNOWN_PROJECT/)
  await assert.rejects(workspaces.read(project.id, 'keep.txt'), /UNKNOWN_PROJECT/)
  await assert.rejects(workspaces.remove(project.id), /UNKNOWN_PROJECT/)
  const restored = new Workspaces(path.join(root, 'projects.json'))
  try { await restored.load(); assert.deepEqual(restored.list(), [other]) } finally { restored.dispose() }
})

test('removal creates missing persistence directories even without a watcher', async t => {
  const { root, directory } = await fixture(t)
  const storage = path.join(root, 'new', 'nested', 'projects.json')
  const workspaces = new Workspaces(storage)
  t.after(async () => workspaces.dispose())
  const project = await workspaces.add(directory, undefined, false)
  workspaces.dispose()
  await workspaces.remove(project.id)
  assert.deepEqual(JSON.parse(await readFile(storage, 'utf8')), [])
})

test('BOM metadata is bounded and removed with its project', async t => {
  const { directory, workspaces, project } = await fixture(t)
  await writeFile(path.join(directory, 'bom'), '\uFEFForiginal')
  const internals = workspaces as unknown as { setBom(id: string, key: string, hasBom: boolean): void; bom: Map<string, boolean> }
  for (let i = 0; i < 2100; i++) internals.setBom(project.id, String(i), true)
  assert.equal(internals.bom.size, 2000)
  assert.equal(internals.bom.has(project.id + '\0' + '0'), false)
  const document = await workspaces.read(project.id, 'bom')
  await workspaces.save(project.id, 'bom', 'saved', document.revision)
  assert.equal(await readFile(path.join(directory, 'bom'), 'utf8'), '\uFEFFsaved')
  await workspaces.remove(project.id)
  assert.equal([...internals.bom.keys()].some(key => key.startsWith(project.id + '\0')), false)
})

test('concurrent project removals persist the latest list and reload only the survivor', async t => {
  const { root, workspaces, project } = await fixture(t)
  const others = []
  for (const name of ['B', 'C']) {
    const directory = path.join(root, name); await mkdir(directory)
    others.push(await workspaces.add(directory))
  }
  await Promise.all([workspaces.remove(project.id), workspaces.remove(others[0].id)])
  assert.deepEqual(workspaces.list(), [others[1]])
  const restored = new Workspaces(path.join(root, 'projects.json'))
  try { await restored.load(); assert.deepEqual(restored.list(), [others[1]]) } finally { restored.dispose() }
})

test('adds and removes share a recovering persistence queue', async t => {
  const { root, workspaces, project } = await fixture(t)
  const b = path.join(root, 'B'), c = path.join(root, 'C')
  await mkdir(b); await mkdir(c)
  const [addedB, , addedC] = await Promise.all([
    workspaces.add(b), workspaces.remove(project.id), workspaces.add(c), workspaces.remove('missing').catch(error => {
      assert.match(String(error), /UNKNOWN_PROJECT/)
    }),
  ])
  const duplicate = await workspaces.add(b)
  assert.equal(duplicate, addedB)
  assert.deepEqual(workspaces.list(), [addedB, addedC])
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8')), [addedB, addedC])
  const restored = new Workspaces(path.join(root, 'projects.json'))
  try { await restored.load(); assert.deepEqual(restored.list(), [addedB, addedC]) } finally { restored.dispose() }
})

test('failed add publishes no project or watcher, cleans atomic temporary files and can retry durably', async t => {
  const { root, workspaces, project } = await fixture(t)
  const directory = path.join(root, 'new'); await mkdir(directory)
  const storage = path.join(root, 'projects.json'), backup = path.join(root, 'backup.json')
  await rename(storage, backup); await mkdir(storage)
  const watchers = (workspaces as unknown as { watchers: Map<string, unknown> }).watchers
  const before = [...watchers.keys()]
  await assert.rejects(workspaces.add(directory, 'retry'))
  assert.deepEqual(workspaces.list(), [project])
  assert.deepEqual([...watchers.keys()], before)
  assert.throws(() => workspaces.get('retry'), /UNKNOWN_PROJECT/)
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), [project])
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
  await rm(storage, { recursive: true }); await rename(backup, storage)
  const added = await workspaces.add(directory, 'retry')
  assert.deepEqual(JSON.parse(await readFile(storage, 'utf8')), [project, added])
  const restored = new Workspaces(storage)
  try { await restored.load(); assert.deepEqual(restored.list(), [project, added]) } finally { restored.dispose() }
})

test('failed atomic persistence keeps project readable, watcher and pending timer intact and cleans temporary files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-workspace-test-'))
  const directory = path.join(root, 'project'); await mkdir(directory)
  const workspaces = new Workspaces(path.join(root, 'projects.json'))
  t.after(async () => { workspaces.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  // Populate the directory before watching it so delayed Windows events cannot replace the timer.
  await writeFile(path.join(directory, 'keep.txt'), 'still readable')
  const project = await workspaces.add(directory)
  const internals = workspaces as unknown as { watchers: Map<string, { close(): void }>; watchTimers: Map<string, ReturnType<typeof setTimeout>> }
  const watcher = internals.watchers.get(project.id)!
  const close = t.mock.method(watcher, 'close')
  const timer = setTimeout(() => {}, 60000)
  t.after(() => clearTimeout(timer))
  clearTimeout(internals.watchTimers.get(project.id)); internals.watchTimers.set(project.id, timer)
  const storage = path.join(root, 'projects.json')
  // A directory at the destination deterministically fails rename, including on Windows.
  await rm(storage); await mkdir(storage)
  await assert.rejects(workspaces.remove(project.id))
  assert.equal(workspaces.get(project.id), project)
  assert.equal((await workspaces.read(project.id, 'keep.txt')).content, 'still readable')
  assert.equal(close.mock.callCount(), 0)
  assert.equal(internals.watchers.get(project.id), watcher)
  assert.equal(internals.watchTimers.get(project.id), timer)
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
  await rm(storage, { recursive: true }); await writeFile(storage, JSON.stringify([project]))
  await workspaces.remove(project.id)
})

test('rejects escapes, Git metadata, alternate streams, binary and oversized files', async t => {
  const { root, directory, workspaces, project } = await fixture(t)
  await writeFile(path.join(root, 'outside.txt'), 'private')
  await mkdir(path.join(directory, '.git')); await writeFile(path.join(directory, '.git', 'config'), 'private')
  for (const value of ['..\\outside.txt', '../outside.txt', '.git\\config', '.GIT\\config', 'C:\\Windows\\win.ini', 'file.txt:stream']) await assert.rejects(workspaces.read(project.id, value))
  await writeFile(path.join(directory, 'binary'), Buffer.from([0, 1, 2])); await assert.rejects(workspaces.read(project.id, 'binary'), /BINARY_FILE/)
  await writeFile(path.join(directory, 'large'), Buffer.alloc(4 * 1024 * 1024 + 1)); await assert.rejects(workspaces.read(project.id, 'large'), /FILE_TOO_LARGE/)
  const link = path.join(directory, 'escape')
  await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(workspaces.read(project.id, path.join('escape', 'outside.txt')), /PATH_OUTSIDE_WORKSPACE/)
  assert.ok(!(await workspaces.entries(project.id)).some(e => e.name === '.git' || e.name === 'escape'))
})
test('listFiles returns deterministic POSIX paths and skips generated directories, metadata and links', async t => {
  const { root, directory, workspaces, project } = await fixture(t)
  for (const folder of ['src/nested', '.git', 'node_modules', 'dist', 'out', '.next', '.plasmo', '.vite', '.parcel-cache', 'storybook-static', 'src/node_modules']) {
    await mkdir(path.join(directory, folder), { recursive: true })
    await writeFile(path.join(directory, folder, 'file.ts'), 'fixture')
  }
  await writeFile(path.join(directory, 'z.txt'), '')
  await writeFile(path.join(directory, 'a.txt'), '')
  await mkdir(path.join(root, 'outside'))
  await writeFile(path.join(root, 'outside', 'secret.txt'), 'outside')
  await symlink(path.join(root, 'outside'), path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(path.join(directory, 'src'), path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  if (process.platform !== 'win32') await symlink(path.join(root, 'outside', 'secret.txt'), path.join(directory, 'secret.txt'))
  await assert.rejects(workspaces.read(project.id, 'src'), /IS_DIRECTORY/)
  const expected = ['a.txt', 'src/nested/file.ts', 'z.txt']
  assert.deepEqual(await workspaces.listFiles(project.id), expected)
  assert.deepEqual(await workspaces.listFiles(project.id), expected)
  await assert.rejects(workspaces.listFiles('missing'), /UNKNOWN_PROJECT/)
})

test('preload removeProject forwards the project ID and preserves IPC rejections', async () => {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'preload', 'index.ts'), 'utf8')
  let api: { removeProject(id: string): Promise<void> } | undefined, rejected = false
  const context = {
    exports: {},
    require: (name: string) => {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld: (name: string, value: typeof api) => { assert.equal(name, 'ame'); api = value } },
        ipcRenderer: { invoke: async (channel: string, method: string, args: unknown[]) => {
          assert.equal(channel, 'ame:call'); assert.equal(method, 'removeProject'); assert.deepEqual(Array.from(args), ['p'])
          if (rejected) throw new Error('CANCELLED')
        } }
      }
    }
  }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  assert.ok(api)
  assert.equal(await api.removeProject('p'), undefined)
  rejected = true
  await assert.rejects(api.removeProject('p'), /CANCELLED/)
})

test('real Git HEAD diff, stage/unstage, commit and deleted file diff', async t => {
  const { directory, workspaces, project } = await fixture(t)
  const git = simpleGit(directory)
  await git.init()
  const subdirectory = path.join(directory, 'child'); await mkdir(subdirectory)
  const child = await workspaces.add(subdirectory)
  await assert.rejects(workspaces.status(child.id), /GIT_ROOT_REQUIRED/)
  await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid'); await git.addConfig('commit.gpgSign', 'false')
  await writeFile(path.join(directory, 'file with space.ts'), 'before\n')
  await workspaces.stage(project.id, 'file with space.ts', true)
  await workspaces.stage(project.id, 'file with space.ts', false)
  assert.equal((await workspaces.status(project.id)).changes[0].working, '?')
  await workspaces.stage(project.id, 'file with space.ts', true); await workspaces.commit(project.id, 'initial')
  await writeFile(path.join(directory, 'file with space.ts'), 'after\n')
  assert.deepEqual(await workspaces.diff(project.id, 'file with space.ts'), { original: 'before\n', modified: 'after\n' })
  await workspaces.stage(project.id, 'file with space.ts', true)
  assert.equal((await workspaces.status(project.id)).changes[0].index, 'M')
  await workspaces.stage(project.id, 'file with space.ts', false)
  assert.equal((await workspaces.status(project.id)).changes[0].working, 'M')
  await workspaces.stage(project.id, 'file with space.ts', true); await workspaces.commit(project.id, 'change')
  assert.equal((await workspaces.status(project.id)).changes.length, 0)
  await rm(path.join(directory, 'file with space.ts'))
  assert.deepEqual(await workspaces.diff(project.id, 'file with space.ts'), { original: 'after\n', modified: '' })
})

test('Git status, hooks, amend, history, undo and stash delegates report changes without read notifications', async t => {
  const changes: string[] = []
  const { root, directory, workspaces, project } = await fixture(t, id => changes.push(id))
  workspaces.dispose()
  const id = project.id, git = simpleGit(directory)
  await git.raw(['init', '--initial-branch=main'])
  await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid')
  await git.addConfig('commit.gpgSign', 'false'); await git.addConfig('core.autocrlf', 'false')
  const check = async <T>(operation: () => Promise<T>, count: number): Promise<T> => {
    const before = changes.length
    const result = await operation()
    assert.deepEqual(changes.slice(before), Array(count).fill(id))
    return result
  }
  const status = await check(() => workspaces.status(id), 0)
  assert.equal(status.hasRemote, false); assert.equal(status.ahead, 0); assert.equal(status.behind, 0)
  assert.equal(status.tracking, null); assert.equal(status.merging, false)
  await writeFile(path.join(directory, 'file.txt'), 'initial\n'); await workspaces.stageAll(id)
  const hooks = path.join(directory, '.git', 'test-hooks'); await mkdir(hooks)
  await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho hook-rejected >&2\nexit 1\n', { mode: 0o755 })
  await git.addConfig('core.hooksPath', hooks)
  const before = changes.length
  await assert.rejects(workspaces.commit(id, 'blocked'), /hook-rejected/)
  assert.equal(changes.length, before)
  await check(() => workspaces.commit(id, 'initial', { noVerify: true }), 1)
  await check(() => workspaces.commit(id, 'amended', { amend: true, noVerify: true }), 1)
  const log = await check(() => workspaces.gitLog(id), 0)
  assert.equal(log.length, 1); assert.equal(log[0].subject, 'amended')
  assert.equal((await check(() => workspaces.gitCommitDetail(id, log[0].hash), 0)).files[0].path, 'file.txt')
  for (const message of ['', ' ', 'bad\0message', 'x'.repeat(10001)]) await assert.rejects(workspaces.commit(id, message), /INVALID_COMMIT_MESSAGE/)
  await writeFile(path.join(directory, 'file.txt'), 'changed\n')
  await check(() => workspaces.gitStashPush(id, 'saved'), 1)
  assert.equal((await check(() => workspaces.gitStashList(id), 0))[0].message, 'saved')
  await check(() => workspaces.gitStashApply(id, 0), 1)
  await git.raw(['reset', '--hard'])
  await check(() => workspaces.gitStashApply(id, 0, true), 1)
  await check(() => workspaces.gitStashPush(id), 1)
  await check(() => workspaces.gitStashDrop(id, 0), 1)
  await workspaces.createBranch(id, 'delete-me', false)
  await check(() => workspaces.gitDeleteBranch(id, 'delete-me'), 1)
  await writeFile(path.join(directory, '.git', 'MERGE_HEAD'), log[0].hash + '\n')
  assert.equal((await workspaces.status(id)).merging, true)
  await rm(path.join(directory, '.git', 'MERGE_HEAD'))
  await writeFile(path.join(directory, '.git', 'REBASE_HEAD'), log[0].hash + '\n')
  assert.equal((await workspaces.status(id)).merging, true)
  await rm(path.join(directory, '.git', 'REBASE_HEAD'))
  const remote = path.join(root, 'remote.git'); await mkdir(remote)
  await simpleGit(remote).raw(['init', '--bare', '--initial-branch=main'])
  await git.raw(['remote', 'add', 'origin', remote])
  assert.equal((await workspaces.status(id)).hasRemote, true)
  await check(() => workspaces.gitPush(id), 1)
  assert.equal((await workspaces.status(id)).tracking, 'origin/main')
  await writeFile(path.join(directory, 'local.txt'), 'local\n'); await workspaces.stageAll(id)
  await workspaces.commit(id, 'local', { noVerify: true })
  assert.equal((await workspaces.status(id)).ahead, 1)
  await check(() => workspaces.gitPush(id), 1)
  assert.equal((await workspaces.status(id)).ahead, 0)
  const peerDirectory = path.join(root, 'peer'); await simpleGit().clone(remote, peerDirectory)
  const peer = simpleGit(peerDirectory)
  await peer.addConfig('user.name', 'Peer'); await peer.addConfig('user.email', 'peer@example.invalid'); await peer.addConfig('commit.gpgSign', 'false')
  await writeFile(path.join(peerDirectory, 'peer.txt'), 'peer\n'); await peer.add('.'); await peer.commit('peer'); await peer.push()
  await check(() => workspaces.gitFetch(id), 1)
  assert.equal((await workspaces.status(id)).behind, 1)
  await check(() => workspaces.gitPull(id), 1)
  assert.equal((await workspaces.status(id)).behind, 0)
  assert.deepEqual(await check(() => workspaces.gitUndoLastCommit(id), 1), { message: 'peer' })
  assert.ok((await workspaces.status(id)).changes.some(file => file.path === 'peer.txt' && file.index === 'A'))
  const failedBefore = changes.length
  await assert.rejects(workspaces.gitStashDrop(id, -1), /INVALID_STASH_INDEX/)
  await assert.rejects(workspaces.gitDeleteBranch(id, 'main'), /CANNOT_DELETE_CURRENT_BRANCH/)
  assert.equal(changes.length, failedBefore)
})

test('Explorer and search delegates persist mutations and notify only after actual writes', async t => {
  const changes: string[] = []
  const { workspaces, project, directory } = await fixture(t, id => changes.push(id))
  workspaces.dispose()
  const check = async <T>(operation: Promise<T>, expectedChanges: number): Promise<T> => {
    const before = changes.length
    const result = await operation
    assert.deepEqual(changes.slice(before), Array(expectedChanges).fill(project.id))
    return result
  }
  assert.deepEqual(await check(workspaces.createDirectory(project.id, 'src'), 1), { path: 'src' })
  assert.deepEqual(await check(workspaces.createFile(project.id, 'src/hello.txt', 'hello hello\n'), 1), { path: 'src/hello.txt' })
  await check(workspaces.createFile(project.id, 'empty.txt'), 1)
  assert.equal(await readFile(path.join(directory, 'empty.txt'), 'utf8'), '')
  assert.deepEqual(await check(workspaces.renamePath(project.id, 'src/hello.txt', 'src/renamed.txt'), 1), { from: 'src/hello.txt', to: 'src/renamed.txt' })
  const found = await check(workspaces.searchProject(project.id, { query: 'hello', include: ['src/**'] }), 0)
  assert.equal(found.totalMatches, 2)
  assert.equal(found.results[0].path, 'src/renamed.txt')
  const [entry] = await workspaces.entries(project.id, 'src')
  assert.equal(entry.path, found.results[0].path, 'Explorer and Search use the same path identity on Windows')
  assert.deepEqual(await check(workspaces.renamePath(project.id, entry.path, 'src/moved.txt'), 1), { from: entry.path, to: 'src/moved.txt' })
  await check(workspaces.renamePath(project.id, 'src/moved.txt', entry.path), 1)
  const preview = await check(workspaces.replaceInProject(project.id, { query: 'hello', replacement: 'bye', dryRun: true }), 0)
  assert.equal(preview.replacements, 2)
  assert.equal(await readFile(path.join(directory, 'src', 'renamed.txt'), 'utf8'), 'hello hello\n')
  const replaced = await check(workspaces.replaceInProject(project.id, { query: 'hello', replacement: 'bye' }), 1)
  assert.deepEqual(preview.writtenFiles, [])
  assert.deepEqual(replaced, { ...preview, writtenFiles: ['src/renamed.txt'] })
  assert.equal(await readFile(path.join(directory, 'src', 'renamed.txt'), 'utf8'), 'bye bye\n')
  await check(workspaces.replaceInProject(project.id, { query: 'missing', replacement: 'bye' }), 0)
  assert.deepEqual(await check(workspaces.deletePath(project.id, 'empty.txt'), 1), { path: 'empty.txt', directory: false })
  assert.deepEqual(await check(workspaces.deletePath(project.id, 'src'), 1), { path: 'src', directory: true })
  const before = changes.length
  await assert.rejects(workspaces.createFile(project.id, '../escape.txt'), /PATH_OUTSIDE_WORKSPACE/)
  await assert.rejects(workspaces.deletePath(project.id, ''), /INVALID_PATH/)
  await assert.rejects(workspaces.renamePath(project.id, 'missing', 'other'))
  await assert.rejects(workspaces.replaceInProject(project.id, { query: '[', regex: true, replacement: 'x' }), /INVALID_REGEX/)
  assert.equal(changes.length, before)
  await assert.rejects(workspaces.searchProject('missing', { query: 'hello' }), /UNKNOWN_PROJECT/)
})

test('rename status, staged and commit diffs retain the old path and unstaging preserves disk', async t => {
  const { directory, workspaces, project } = await fixture(t)
  workspaces.dispose()
  const git = simpleGit(directory), id = project.id
  await git.init()
  await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid')
  await git.addConfig('commit.gpgSign', 'false'); await git.addConfig('core.autocrlf', 'false')
  const from = 'old [name].txt', to = 'new [name].txt', content = 'rename contents\n'
  await writeFile(path.join(directory, from), content)
  await workspaces.stage(id, from, true); await workspaces.commit(id, 'initial')
  await rename(path.join(directory, from), path.join(directory, to))
  assert.deepEqual(await workspaces.diff(id, to, { kind: 'working', from }), { original: content, modified: content })
  // Validate both paths before making any index change.
  await assert.rejects(workspaces.stage(id, to, true, '../outside.txt'), /PATH_OUTSIDE_WORKSPACE/)
  assert.equal(await git.raw(['diff', '--cached', '--name-only']), '')
  await workspaces.stage(id, to, true, from)
  assert.deepEqual((await workspaces.status(id)).changes, [{ path: to, from, index: 'R', working: ' ' }])
  assert.deepEqual(await workspaces.diff(id, to, { kind: 'staged', from }), { original: content, modified: content })
  await assert.rejects(workspaces.diff(id, to, { kind: 'staged', from: '../outside.txt' }), /PATH_OUTSIDE_WORKSPACE/)
  await workspaces.stage(id, to, false, from)
  assert.equal(await git.raw(['diff', '--cached', '--name-only']), '')
  assert.equal(await readFile(path.join(directory, to), 'utf8'), content)
  await assert.rejects(readFile(path.join(directory, from)), { code: 'ENOENT' })
  await workspaces.stage(id, to, true, from); await workspaces.commit(id, 'rename')
  const hash = (await git.revparse(['HEAD'])).trim()
  assert.deepEqual(await workspaces.diff(id, to, { kind: 'commit', commit: hash, from }), { original: content, modified: content })
  assert.deepEqual((await workspaces.status(id)).changes, [])
})

test('SHA-256 workspace diffs support commits, ancestor ranges and selected commit patches', async t => {
  const { directory, workspaces, project } = await fixture(t)
  workspaces.dispose()
  const git = simpleGit(directory), id = project.id, file = 'file.txt'
  await git.raw(['init', '--object-format=sha256', '--initial-branch=main'])
  await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid')
  await git.addConfig('commit.gpgSign', 'false'); await git.addConfig('core.autocrlf', 'false')
  const hashes: string[] = []
  for (const content of ['initial\n', 'first\n', 'second\n']) {
    await writeFile(path.join(directory, file), content)
    await git.add(file); await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', content.trim()])
    hashes.push((await git.revparse(['HEAD'])).trim())
  }
  const [base, h1, h2] = hashes
  assert.ok(hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)))
  await writeFile(path.join(directory, file), 'working\n')
  assert.deepEqual(await workspaces.diff(id, file, { kind: 'commit', commit: h1 }), { original: 'initial\n', modified: 'first\n' })
  assert.deepEqual(await workspaces.diff(id, file, { kind: 'commit', commit: base }), { original: '', modified: 'initial\n' })
  assert.deepEqual(await workspaces.diff(id, file, { kind: 'commits', commits: [h2], includeWorking: false }), { original: 'first\n', modified: 'second\n' })
  for (const includeWorking of [false, true]) {
    const range = await workspaces.diff(id, file, { kind: 'range', baseCommit: base, includeWorking })
    if (includeWorking) {
      assert.match(range.patch!, /\+first/); assert.match(range.patch!, /\+second/); assert.match(range.patch!, /\+working/)
    } else assert.deepEqual(range, { original: 'initial\n', modified: 'second\n' })
    const result = await workspaces.diff(id, file, { kind: 'commits', commits: [h1, h2], includeWorking })
    assert.equal(result.original, ''); assert.equal(result.modified, '')
    assert.match(result.patch!, /\+first/); assert.match(result.patch!, /\+second/)
    assert.equal(result.patch!.includes('+working'), includeWorking)
  }
  const singleWithWorking = await workspaces.diff(id, file, { kind: 'commits', commits: [h2], includeWorking: true })
  assert.match(singleWithWorking.patch!, /\+working/)
  for (const target of [
    { kind: 'commit' as const, commit: 'HEAD' },
    { kind: 'range' as const, baseCommit: '--all' },
    { kind: 'commits' as const, commits: [] },
    { kind: 'commits' as const, commits: Array(51).fill(h1) },
    { kind: 'commits' as const, commits: ['HEAD'] },
  ]) await assert.rejects(workspaces.diff(id, file, target), /INVALID_DIFF_TARGET/)
  await git.raw(['checkout', '--orphan', 'unrelated'])
  await git.raw(['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'unrelated'])
  await assert.rejects(workspaces.diff(id, file, { kind: 'range', baseCommit: base }), /INVALID_DIFF_TARGET/)
})

test('#7 restaging an edited staged rename succeeds with and without its vanished source', async t => {
  for (const from of [undefined, 'a']) {
    const { directory, workspaces, project } = await fixture(t)
    workspaces.dispose()
    const git = simpleGit(directory)
    await git.raw(['init', '--initial-branch=main'])
    await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid')
    await git.addConfig('commit.gpgSign', 'false'); await git.addConfig('core.autocrlf', 'false')
    await writeFile(path.join(directory, 'a'), 'original\n')
    await git.raw(['add', '--', 'a']); await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'initial'])
    await rename(path.join(directory, 'a'), path.join(directory, 'new'))
    await workspaces.stage(project.id, 'new', true, 'a')
    assert.equal(await git.raw(['ls-files', '--stage', '-z', '--', 'a']), '')
    await writeFile(path.join(directory, 'new'), 'original\nnext edit\n')
    await workspaces.stage(project.id, 'new', true, from)
    assert.equal(await git.raw(['show', ':new']), 'original\nnext edit\n')
    assert.equal(await git.raw(['diff', '--name-only']), '')
    assert.equal(await git.raw(['ls-files', '--stage', '-z', '--', 'a']), '')
  }
})

test('advanced Git delegates preserve index, branch defaults and mutation notifications', async t => {
  const changes: string[] = []
  const { directory, workspaces, project } = await fixture(t, id => changes.push(id))
  workspaces.dispose()
  const git = simpleGit(directory)
  await git.init()
  await git.addConfig('user.name', 'Ame Test'); await git.addConfig('user.email', 'test@example.invalid'); await git.addConfig('commit.gpgSign', 'false')
  await git.addConfig('core.autocrlf', 'false')
  await writeFile(path.join(directory, 'file.txt'), 'before\n')
  const check = async <T>(operation: Promise<T>, expectedChanges: number): Promise<T> => {
    const before = changes.length
    const result = await operation
    assert.deepEqual(changes.slice(before), Array(expectedChanges).fill(project.id))
    return result
  }
  await check(workspaces.stageAll(project.id), 1)
  assert.equal((await workspaces.status(project.id)).changes[0].index, 'A')
  await check(workspaces.unstageAll(project.id), 1)
  assert.equal((await workspaces.status(project.id)).changes[0].working, '?')
  await workspaces.stageAll(project.id); await workspaces.commit(project.id, 'initial')
  const initial = await check(workspaces.gitBranches(project.id), 0)
  assert.equal(initial.branches.find(branch => branch.current)?.name, initial.current)
  await check(workspaces.createBranch(project.id, 'feature/no-checkout', false), 1)
  assert.equal((await workspaces.gitBranches(project.id)).current, initial.current)
  await check(workspaces.createBranch(project.id, 'feature/default'), 1)
  assert.equal((await workspaces.gitBranches(project.id)).current, 'feature/default')
  await check(workspaces.checkoutBranch(project.id, 'feature/no-checkout'), 1)
  assert.equal((await workspaces.gitBranches(project.id)).current, 'feature/no-checkout')
  await writeFile(path.join(directory, 'file.txt'), 'changed\n')
  await check(workspaces.discardFile(project.id, 'file.txt'), 1)
  assert.equal(await readFile(path.join(directory, 'file.txt'), 'utf8'), 'before\n')
  await writeFile(path.join(directory, 'file.txt'), 'staged\n')
  await check(workspaces.stageAll(project.id), 1)
  await check(workspaces.unstageAll(project.id), 1)
  assert.equal((await workspaces.status(project.id)).changes[0].working, 'M')
  const before = changes.length
  await assert.rejects(workspaces.createBranch(project.id, '--bad'), /INVALID_BRANCH_NAME/)
  await assert.rejects(workspaces.checkoutBranch(project.id, 'missing'))
  await assert.rejects(workspaces.discardFile(project.id, '../outside.txt'), /INVALID_PATH/)
  await assert.rejects(workspaces.stageAll('missing'), /UNKNOWN_PROJECT/)
  assert.equal(changes.length, before)
})

test('workspace copy/move/paste delegates report project identity and notify only actual affected projects', async t => {
  const changes: string[] = []
  const { root, directory, workspaces, project } = await fixture(t, id => changes.push(id))
  const otherDirectory = path.join(root, 'other'); await mkdir(otherDirectory)
  const other = await workspaces.add(otherDirectory)
  workspaces.dispose()
  await writeFile(path.join(directory, 'seed.bin'), Buffer.from([0, 255, 1]))
  await mkdir(path.join(directory, 'dest'))
  assert.deepEqual(await workspaces.copyPath(other.id, project.id, 'seed.bin', ''), { path: 'seed.bin', directory: false })
  assert.deepEqual(changes.splice(0), [other.id])
  assert.deepEqual(await workspaces.movePath(project.id, project.id, 'seed.bin', ''), { from: 'seed.bin', to: 'seed.bin', directory: false, sameProject: true, moved: false })
  assert.deepEqual(changes, [])
  assert.deepEqual(await workspaces.movePath(project.id, project.id, 'seed.bin', 'dest'), { from: 'seed.bin', to: 'dest/seed.bin', directory: false, sameProject: true, moved: true })
  assert.deepEqual(changes.splice(0), [project.id])
  assert.deepEqual(await workspaces.movePath(other.id, project.id, 'dest/seed.bin', ''), { from: 'dest/seed.bin', to: 'seed copy.bin', directory: false, sameProject: false, moved: true })
  assert.deepEqual(changes.splice(0), [other.id, project.id])
  const external = path.join(root, 'external.bin'); await writeFile(external, Buffer.from([0, 128]))
  assert.deepEqual(await workspaces.pasteExternalPaths(project.id, [external], ''), { paths: ['external.bin'] })
  assert.deepEqual(changes.splice(0), [project.id])
  assert.deepEqual(await workspaces.pasteExternalPaths(project.id, [], ''), { paths: [] })
  for (const operation of [
    () => workspaces.copyPath(other.id, project.id, 'missing', ''),
    () => workspaces.movePath(other.id, project.id, 'missing', ''),
    () => workspaces.pasteExternalPaths(project.id, [path.join(root, 'missing')], ''),
    () => workspaces.copyPath('missing', project.id, 'external.bin', ''),
    () => workspaces.movePath(other.id, 'missing', 'external.bin', ''),
    () => workspaces.pasteExternalPaths('missing', [external], ''),
  ]) await assert.rejects(operation())
  assert.deepEqual(changes, [])
})
