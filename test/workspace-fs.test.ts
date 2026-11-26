import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyEntry, copyExternalEntries, copyExternalPaths, createDirectory, createFile, deletePath, MAX_COPY_BYTES, MAX_COPY_ENTRIES, moveEntry, renameOrMove, uniqueChildName, validateWorkspacePath } from '../packages/ide-core/src/workspace-fs'

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

test('unique names preserve extensions and dotfiles, treat directory dots literally and validate a single child', async t => {
  const { root } = await fixture(t)
  assert.equal(await uniqueChildName(root, 'new.txt'), 'new.txt')
  assert.equal(await uniqueChildName(root, '.env', { forceCopySuffix: true }), '.env copy')
  assert.equal(await uniqueChildName(root, 'archive.tar.gz', { forceCopySuffix: true }), 'archive.tar copy.gz')
  await createFile(root, 'file.txt'); await createFile(root, 'file copy.txt')
  assert.equal(await uniqueChildName(root, 'file.txt'), 'file copy 2.txt')
  await createDirectory(root, 'folder.ext')
  assert.equal(await uniqueChildName(root, 'folder.ext'), 'folder.ext copy')
  for (const value of ['', '.', '..', '../bad', 'a/b', 'a\\b', '.git', 'bad:stream', 'bad\0name', 'bad.']) {
    await assert.rejects(uniqueChildName(root, value), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/)
  }
})

test('copy handles recursive binary files, normalized paths, collisions and dotted directories without overwriting', async t => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other'); await mkdir(other)
  await createDirectory(root, 'folder.ext/deep')
  const bytes = Buffer.from([0, 255, 128, 10, 13, 1])
  await writeFile(path.join(root, 'folder.ext', 'deep', 'binary.dat'), bytes)
  assert.deepEqual(await copyEntry(root, 'folder.ext', root, ''), { path: 'folder.ext copy', directory: true })
  assert.deepEqual(await copyEntry(root, 'folder.ext', root, '.'), { path: 'folder.ext copy 2', directory: true })
  assert.deepEqual(await readFile(path.join(root, 'folder.ext copy', 'deep', 'binary.dat')), bytes)
  await createFile(other, 'binary.dat', 'preserved')
  assert.deepEqual(await copyEntry(root, 'folder.ext\\deep\\binary.dat', other, ''), { path: 'binary copy.dat', directory: false })
  assert.equal(await readFile(path.join(other, 'binary.dat'), 'utf8'), 'preserved')
  assert.deepEqual(await readFile(path.join(other, 'binary copy.dat')), bytes)
  await assert.rejects(copyEntry(root, 'missing', other, ''), { code: 'NOT_FOUND' })
  await assert.rejects(copyEntry(root, 'folder.ext', other, 'missing'), { code: 'NOT_FOUND' })
  await assert.rejects(copyEntry(root, 'folder.ext', other, 'binary.dat'), { code: 'NOT_A_DIRECTORY' })
})

test('copy and move reject self/descendant targets across nested project roots', async t => {
  const { root } = await fixture(t)
  await createDirectory(root, 'source/child')
  for (const [targetRoot, targetDir] of [[root, 'source'], [root, 'source/child'], [path.join(root, 'source'), 'child']]) {
    await assert.rejects(copyEntry(root, 'source', targetRoot, targetDir), { code: 'INVALID_COPY' })
    await assert.rejects(moveEntry(root, 'source', targetRoot, targetDir), { code: 'INVALID_MOVE' })
  }
  await assert.rejects(copyExternalPaths(root, 'source/child', [path.join(root, 'source')]), { code: 'INVALID_COPY' })
  assert.deepEqual(await readdir(path.join(root, 'source')), ['child'])
})

test('moves are no-ops in the same parent, rename within a root and safely copy/delete across roots', async t => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other'); await mkdir(other)
  await createFile(root, 'seed.bin', 'seed'); await createDirectory(root, 'dest')
  assert.deepEqual(await moveEntry(root, './seed.bin', root, '.'), { from: 'seed.bin', to: 'seed.bin', directory: false, sameRoot: true, moved: false })
  assert.deepEqual(await moveEntry(root, 'seed.bin', root, 'dest'), { from: 'seed.bin', to: 'dest/seed.bin', directory: false, sameRoot: true, moved: true })
  await createFile(root, 'seed.bin', 'second')
  await assert.rejects(moveEntry(root, 'seed.bin', root, 'dest'), /ALREADY_EXISTS/)
  await createFile(other, 'seed.bin', 'keep')
  assert.deepEqual(await moveEntry(root, 'dest/seed.bin', other, ''), { from: 'dest/seed.bin', to: 'seed copy.bin', directory: false, sameRoot: false, moved: true })
  await assert.rejects(readFile(path.join(root, 'dest', 'seed.bin')), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(other, 'seed copy.bin'), 'utf8'), 'seed')
  assert.equal(await readFile(path.join(other, 'seed.bin'), 'utf8'), 'keep')
})

test('nested-root moves with the same physical parent still copy to a noncolliding name', async t => {
  const { root } = await fixture(t)
  await createDirectory(root, 'nested')
  await createFile(root, 'nested/file.txt', 'kept')
  assert.deepEqual(await moveEntry(root, 'nested/file.txt', path.join(root, 'nested'), ''), {
    from: 'nested/file.txt', to: 'file copy.txt', directory: false, sameRoot: false, moved: true,
  })
  assert.equal(await readFile(path.join(root, 'nested', 'file copy.txt'), 'utf8'), 'kept')
  await assert.rejects(readFile(path.join(root, 'nested', 'file.txt')), { code: 'ENOENT' })
})

test('recursive links and metadata fail before writes and failed cross-root moves retain sources', async t => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other'); await mkdir(other)
  await createDirectory(root, 'source/deep'); await createFile(root, 'source/keep', 'keep')
  await symlink(other, path.join(root, 'source', 'deep', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const action of [() => copyEntry(root, 'source', other, ''), () => moveEntry(root, 'source', other, ''), () => copyExternalPaths(other, '', [path.join(root, 'source')])]) {
    await assert.rejects(action(), /SYMLINK_NOT_ALLOWED/)
    assert.deepEqual(await readdir(other), [])
    assert.equal(await readFile(path.join(root, 'source', 'keep'), 'utf8'), 'keep')
  }
  await rm(path.join(root, 'source', 'deep', 'link'))
  await mkdir(path.join(root, 'source', 'deep', '.git'))
  await assert.rejects(copyEntry(root, 'source', other, ''), /PATH_OUTSIDE_WORKSPACE/)
  await assert.rejects(moveEntry(root, 'source', other, ''), /PATH_OUTSIDE_WORKSPACE/)
  await assert.rejects(copyExternalPaths(other, '', [path.join(root, 'source', 'deep', '.git')]), /PATH_OUTSIDE_WORKSPACE/)
  assert.deepEqual(await readdir(other), [])
})

test('external paste is read-only, handles duplicate basenames and rejects missing, relative and ancestor links atomically', async t => {
  const { root, temporary } = await fixture(t)
  const external = path.join(temporary, 'external'); await mkdir(external)
  const source = path.join(external, '.env'); await writeFile(source, Buffer.from([0, 255, 4]))
  assert.deepEqual(await copyExternalEntries([source, source], root, ''), { paths: ['.env', '.env copy'] })
  assert.deepEqual(await readFile(source), Buffer.from([0, 255, 4]))
  assert.deepEqual(await readFile(path.join(root, '.env copy')), Buffer.from([0, 255, 4]))
  await assert.rejects(copyExternalPaths(root, '', [source, path.join(external, 'missing')]), { code: 'NOT_FOUND' })
  await assert.rejects(copyExternalPaths(root, '', ['relative']), { code: 'INVALID_PATH' })
  const alias = path.join(temporary, 'alias')
  await symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(copyExternalPaths(root, '', [path.join(alias, '.env')]), { code: 'SYMLINK_NOT_ALLOWED' })
  assert.deepEqual((await readdir(root)).sort(), ['.env', '.env copy'])
  assert.deepEqual(await copyExternalPaths(root, '', []), { paths: [] })
})

test('byte limits use sparse file size and aggregate external sources before any writes or source deletion', async t => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other'); await mkdir(other)
  const sparse = async (name: string, size: number) => {
    const file = await open(path.join(root, name), 'wx')
    try { await file.truncate(size) } finally { await file.close() }
  }
  await sparse('oversized', MAX_COPY_BYTES + 1)
  await assert.rejects(copyEntry(root, 'oversized', other, ''), { code: 'COPY_TOO_LARGE' })
  await assert.rejects(moveEntry(root, 'oversized', other, ''), { code: 'COPY_TOO_LARGE' })
  await sparse('half', MAX_COPY_BYTES / 2 + 1)
  await assert.rejects(copyExternalPaths(other, '', [path.join(root, 'half'), path.join(root, 'half')]), { code: 'COPY_TOO_LARGE' })
  assert.deepEqual(await readdir(other), [])
  assert.ok((await readdir(root)).includes('oversized'))
  await createDirectory(root, 'dest')
  assert.deepEqual(await moveEntry(root, 'oversized', root, 'dest'), {
    from: 'oversized', to: 'dest/oversized', directory: false, sameRoot: true, moved: true,
  })
})

test('entry limits count directories and files recursively and aggregate repeated external inputs', async t => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other'); await mkdir(other)
  await createDirectory(root, 'tree')
  // Empty directories are fast to create and must count toward the limit too.
  for (let start = 0; start < MAX_COPY_ENTRIES; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, MAX_COPY_ENTRIES - start) }, (_, offset) => mkdir(path.join(root, 'tree', String(start + offset)))))
  }
  await assert.rejects(copyEntry(root, 'tree', other, ''), { code: 'COPY_TOO_LARGE' })
  await assert.rejects(moveEntry(root, 'tree', other, ''), { code: 'COPY_TOO_LARGE' })
  await createFile(root, 'empty')
  await assert.rejects(copyExternalPaths(other, '', Array(MAX_COPY_ENTRIES + 1).fill(path.join(root, 'empty'))), { code: 'COPY_TOO_LARGE' })
  assert.deepEqual(await readdir(other), [])
})
