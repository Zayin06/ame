import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'ame-ide-test-'))
  const directory = path.join(root, 'project'); await mkdir(directory)
  const workspaces = new Workspaces(path.join(root, 'projects.json'))
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
