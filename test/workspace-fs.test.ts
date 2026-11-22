import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDirectory, createFile, deletePath, renameOrMove, validateWorkspacePath } from '../packages/ide-core/src/workspace-fs'

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'ame-fs-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'workspace')
  await mkdir(root)
  return { root, temporary }
}

test('CRUD creates nested parents, normalizes paths, moves files and recursively deletes folders', async t => {
  const { root } = await fixture(t)
  assert.deepEqual(await createDirectory(root, 'src/nested'), { path: 'src/nested' })
  assert.deepEqual(await createFile(root, 'src\\nested\\hello.ts', 'chào\r\n'), { path: 'src/nested/hello.ts' })
  assert.equal(await readFile(path.join(root, 'src', 'nested', 'hello.ts'), 'utf8'), 'chào\r\n')
  assert.deepEqual(await renameOrMove(root, 'src/nested/hello.ts', 'new/deep/moved.ts'), { from: 'src/nested/hello.ts', to: 'new/deep/moved.ts' })
  assert.deepEqual(await deletePath(root, 'new/deep/moved.ts'), { path: 'new/deep/moved.ts', directory: false })
  await createFile(root, 'src/nested/another.txt')
  assert.deepEqual(await renameOrMove(root, 'src', 'moved/src'), { from: 'src', to: 'moved/src' })
  assert.deepEqual(await deletePath(root, 'moved'), { path: 'moved', directory: true })
  await assert.rejects(readFile(path.join(root, 'moved', 'src', 'nested', 'another.txt')), { code: 'ENOENT' })
})

test('validation rejects traversal, absolute/drive/ADS paths, Git metadata and root aliases', async t => {
  const { root, temporary } = await fixture(t)
  for (const relative of ['../outside', '..\\outside', path.join(temporary, 'outside'), 'C:\\Windows\\win.ini', 'C:relative', '\\\\server\\share', 'name:stream', 'bad\0name', '.git/config', 'nested/.GIT/config', '.git/../safe', '.git./config', 'dir. /file']) {
    await assert.rejects(validateWorkspacePath(root, relative), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(createFile(root, relative), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(createDirectory(root, relative), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(deletePath(root, relative), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(renameOrMove(root, relative, 'safe'), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(renameOrMove(root, 'safe', relative), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
  }
  for (const relative of ['', '.', 'child/..']) {
    await assert.rejects(deletePath(root, relative), /INVALID_PATH/)
    await assert.rejects(createDirectory(root, relative), /INVALID_PATH/)
    assert.equal((await validateWorkspacePath(root, relative, { allowRoot: true })).normalized, '')
  }
  await assert.rejects(validateWorkspacePath(root, 1 as unknown as string), /INVALID_PATH/)
  await writeFile(path.join(temporary, 'not-directory'), '')
  await assert.rejects(validateWorkspacePath(path.join(temporary, 'not-directory'), 'file'), /NOT_A_DIRECTORY/)
})

test('collisions never overwrite, missing sources fail and directories cannot move inside themselves', async t => {
  const { root } = await fixture(t)
  await createFile(root, 'existing', 'preserved')
  await createFile(root, 'source', 'source')
  await assert.rejects(createFile(root, 'existing', 'overwrite'), /ALREADY_EXISTS/)
  await assert.rejects(createDirectory(root, 'existing'), /ALREADY_EXISTS/)
  await assert.rejects(renameOrMove(root, 'source', 'existing'), /ALREADY_EXISTS/)
  assert.equal(await readFile(path.join(root, 'existing'), 'utf8'), 'preserved')
  assert.equal(await readFile(path.join(root, 'source'), 'utf8'), 'source')
  await assert.rejects(createFile(root, 'existing/child'), /NOT_A_DIRECTORY/)
  await assert.rejects(createDirectory(root, 'existing/child'), /NOT_A_DIRECTORY/)
  await assert.rejects(renameOrMove(root, 'missing', 'new'), { code: 'ENOENT' })
  await createDirectory(root, 'folder')
  await assert.rejects(createDirectory(root, 'folder'), /ALREADY_EXISTS/)
  await assert.rejects(renameOrMove(root, 'folder', 'folder'), /INVALID_MOVE/)
  await assert.rejects(renameOrMove(root, 'folder', 'folder/nested/child'), /INVALID_MOVE/)
  if (process.platform === 'win32') await assert.rejects(renameOrMove(root, 'folder', 'FOLDER/child'), /INVALID_MOVE/)
})

test('UTF-8 size limit accepts exactly 4 MiB and rejects oversized content before creating parents', async t => {
  const { root } = await fixture(t)
  await createFile(root, 'boundary', 'é'.repeat(2 * 1024 * 1024))
  await assert.rejects(createFile(root, 'new/large', 'é'.repeat(2 * 1024 * 1024) + 'a'), /FILE_TOO_LARGE/)
  await assert.rejects(readFile(path.join(root, 'new', 'large')), { code: 'ENOENT' })
})

test('junction/symlink policy blocks direct and ancestor links for every operation', async t => {
  const { root, temporary } = await fixture(t)
  const outside = path.join(temporary, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'keep.txt'), 'untouched')
  await createFile(root, 'source', 'source')
  await createDirectory(root, 'inside')
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(path.join(root, 'inside'), path.join(root, 'internal'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const relative of ['escape', 'escape/keep.txt', 'escape/missing/deep/file', 'internal', 'internal/new/file']) {
    await assert.rejects(validateWorkspacePath(root, relative), /SYMLINK_NOT_ALLOWED|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(createFile(root, relative), /SYMLINK_NOT_ALLOWED|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(createDirectory(root, relative), /SYMLINK_NOT_ALLOWED|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(renameOrMove(root, relative, 'destination'), /SYMLINK_NOT_ALLOWED|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(renameOrMove(root, 'source', relative), /SYMLINK_NOT_ALLOWED|PATH_OUTSIDE_WORKSPACE/)
    await assert.rejects(deletePath(root, relative), /SYMLINK_NOT_ALLOWED|PATH_OUTSIDE_WORKSPACE/)
  }
  await createDirectory(root, 'container')
  await symlink(outside, path.join(root, 'container', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await deletePath(root, 'container')
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'untouched')
})
