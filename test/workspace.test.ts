import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { z } from 'zod'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'

async function fixture(t: { after(fn: () => Promise<void>): void }, changed?: (projectID: string) => void) {
  const root = await mkdtemp(path.join(process.cwd(), '.ame-workspace-test-'))
  const directory = path.join(root, 'project'); await mkdir(directory)
  const workspaces = new Workspaces(path.join(root, 'projects.json'), changed)
  const project = await workspaces.add(directory)
  t.after(async () => { workspaces.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, directory, workspaces, project }
}
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

test('removeProject IPC validates its tuple, requires native confirmation and propagates cancellation or persistence failure', async () => {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'index.ts'), 'utf8')
  const start = source.indexOf('const text ='), end = source.indexOf('let authority:')
  assert.ok(start >= 0 && end > start)
  const calls: string[] = []
  let response = 0, persistFailure = false
  const window = {}
  const context = {
    z, window, pairingSchema: z.object({ enabled: z.boolean(), keepScreenActive: z.boolean() }),
    workspace: {
      get: (id: string) => { calls.push('get'); if (id !== 'p') throw new Error('UNKNOWN_PROJECT'); return { name: 'Example' } },
      remove: async (id: string) => { assert.equal(id, 'p'); calls.push('remove'); if (persistFailure) throw new Error('SAVE_FAILED') }
    },
    terminals: { closeProject: (id: string) => { assert.equal(id, 'p'); calls.push('closeProject') } },
    adapter: { detach: (id: string) => { assert.equal(id, 'p'); calls.push('detach') } },
    dialog: { showMessageBox: async (parent: unknown, options: any) => {
      assert.equal(parent, window)
      assert.deepEqual(Array.from(options.buttons), ['Hủy', 'Xác nhận'])
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
      assert.equal(options.message, 'Gỡ dự án Example khỏi danh sách? Tệp trên ổ đĩa sẽ KHÔNG bị xóa.')
      calls.push('confirm'); return { response }
    } }
  }
  const dispatch = runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\ncall', context) as (method: string, args: unknown[]) => Promise<unknown>
  for (const args of [[], [''], [1], ['p', 'extra'], ['x'.repeat(513)]]) await assert.rejects(dispatch('removeProject', args))
  assert.deepEqual(calls, [])
  await assert.rejects(dispatch('removeProject', ['missing']), /UNKNOWN_PROJECT/)
  assert.deepEqual(calls, ['get']); calls.length = 0
  await assert.rejects(dispatch('removeProject', ['p']), /CANCELLED/)
  assert.deepEqual(calls, ['get', 'confirm']); calls.length = 0
  response = 1
  assert.equal(await dispatch('removeProject', ['p']), undefined)
  assert.deepEqual(calls, ['get', 'confirm', 'closeProject', 'remove', 'detach']); calls.length = 0
  persistFailure = true
  await assert.rejects(dispatch('removeProject', ['p']), /SAVE_FAILED/)
  assert.deepEqual(calls, ['get', 'confirm', 'closeProject', 'remove'])
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
  assert.deepEqual(replaced, preview)
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
