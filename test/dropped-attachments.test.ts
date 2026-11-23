import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hasNulByte, isTextCodeExtension, MAX_DROPPED_BATCH, MAX_EXTERNAL_TEXT_BYTES, MAX_MEDIA_BYTES, normalizeBase64DataUrl, resolveDroppedPaths } from '../packages/ide-core/src/dropped-attachments'

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'ame-drop-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'workspace')
  await mkdir(root)
  const file = async (name: string, content: string | Uint8Array, external = false) => {
    const target = path.join(external ? temporary : root, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
    return target
  }
  return { temporary, root, file }
}

function assertDataUrl(url: string, mime: string, bytes: Uint8Array) {
  assert.ok(url.startsWith(`data:${mime};base64,`))
  assert.doesNotMatch(url, /\s/)
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), Buffer.from(bytes))
}

test('normalizes raw/data base64 and rejects malformed or empty payloads', () => {
  for (const raw of ['Y W\tJ\r\nj\n', 'data:image/png;base64,Y W\r\nJj', ' \ndata:image/png;base64, YWJj\n']) {
    assert.equal(normalizeBase64DataUrl('image/webp', raw), 'data:image/webp;base64,YWJj')
  }
  assert.equal(normalizeBase64DataUrl('image/png', 'YQ=='), 'data:image/png;base64,YQ==')
  for (const raw of ['', ' \r\n', 'data:image/png;base64,', 'a===', 'abc', 'YW-J', 'AA=A', '!!!!', 'data:image/png,abcd']) {
    assert.throws(() => normalizeBase64DataUrl('image/png', raw), /base64/i)
  }
})

test('recognizes the specified text/code extensions and NUL bytes', () => {
  for (const ext of 'txt md mdx json jsonc yaml yml xml gradle kts kt java ts tsx js jsx mjs cjs css scss html py sh bat ps1 sql toml ini cfg conf csv log properties svg go rs c cpp h hpp swift rb php dart'.split(' ')) {
    assert.equal(isTextCodeExtension(`file.${ext.toUpperCase()}`), true)
  }
  assert.equal(isTextCodeExtension('settings.env.example'), true)
  assert.equal(isTextCodeExtension('file.bin'), false)
  assert.equal(hasNulByte(Uint8Array.of(1, 0, 2)), true)
  assert.equal(hasNulByte(Uint8Array.of(1, 2)), false)
})

test('workspace non-media files become POSIX mentions without reading binary contents', async t => {
  const { root, file } = await fixture(t)
  const source = await file(path.join('src', 'ảnh (1).ts'), 'export {}')
  const binary = await file('binary.bin', Uint8Array.of(0, 255))
  assert.deepEqual(await resolveDroppedPaths(root, [source, binary]), [
    { ok: true, kind: 'workspace-file', path: 'src/ảnh (1).ts', name: 'ảnh (1).ts' },
    { ok: true, kind: 'workspace-file', path: 'binary.bin', name: 'binary.bin' }
  ])
})

test('workspace and external image/PDF names and clean data URIs survive resolution', async t => {
  const { root, file } = await fixture(t)
  const bytes = Uint8Array.of(1, 2, 250, 0)
  for (const external of [false, true]) {
    for (const [name, mime] of [['image (1).png', 'image/png'], ['ảnh chụp.webp', 'image/webp'], ['ảnh chụp.png', 'image/png'], ['document.pdf', 'application/pdf']] as const) {
      const target = await file(name, bytes, external)
      const [result] = await resolveDroppedPaths(root, [target])
      assert.ok(result.ok && result.kind === 'media')
      assert.equal(result.name, name)
      assert.equal(result.mime, mime)
      assert.equal(result.size, bytes.length)
      assert.equal(result.workspacePath, external ? undefined : name)
      assertDataUrl(result.dataUrl, mime, bytes)
    }
  }
})

test('external UTF-8 text is inline, including unknown extensions, but binary and invalid UTF-8 are rejected', async t => {
  const { root, file } = await fixture(t)
  const content = Buffer.from('Chào thế giới\n# Markdown')
  for (const name of ['notes.txt', 'notes.md', 'notes.unknown', 'notes.constructor']) {
    const [result] = await resolveDroppedPaths(root, [await file(name, content, true)])
    assert.ok(result.ok && result.kind === 'external-text')
    assert.equal(result.mime, 'text/plain')
    assert.equal(result.size, content.length)
    assertDataUrl(result.dataUrl, 'text/plain', content)
  }
  for (const [name, bytes] of [['nul.txt', Uint8Array.of(65, 0)], ['invalid.md', Uint8Array.of(0xc3, 0x28)]] as const) {
    const [result] = await resolveDroppedPaths(root, [await file(name, bytes, true)])
    assert.ok(!result.ok)
    assert.match(result.reason, /nhị phân/)
  }
})

test('rejects malformed paths, folders, missing files and .git metadata including media', async t => {
  const { root, file } = await fixture(t)
  for (const target of ['', 'relative.ts', 'bad\0path']) {
    assert.deepEqual(await resolveDroppedPaths(root, [target]), [{ ok: false, name: path.basename(target), reason: 'Đường dẫn tệp không hợp lệ.' }])
  }
  const [directory, missing] = await resolveDroppedPaths(root, [root, path.join(root, 'missing')])
  assert.ok(!directory.ok); assert.match(directory.reason, /thư mục/)
  assert.ok(!missing.ok); assert.match(missing.reason, /Không thể đọc/)
  for (const name of [path.join('.git', 'config'), path.join('nested', '.GIT', 'image.png')]) {
    const [result] = await resolveDroppedPaths(root, [await file(name, 'secret')])
    assert.ok(!result.ok); assert.match(result.reason, /nội bộ .git/)
  }
  const [invalidRoot] = await resolveDroppedPaths(await file('not-a-directory', ''), [root])
  assert.ok(!invalidRoot.ok)
})

test('rejects junction/symlink paths, linked ancestors and linked project roots', async t => {
  const { root, temporary, file } = await fixture(t)
  await file(path.join('folder', 'file.txt'), 'text')
  const link = path.join(temporary, 'link')
  await symlink(path.join(root, 'folder'), link, process.platform === 'win32' ? 'junction' : 'dir')
  for (const target of [link, path.join(link, 'file.txt')]) {
    const [result] = await resolveDroppedPaths(root, [target])
    assert.ok(!result.ok); assert.match(result.reason, /liên kết tượng trưng/)
  }
  const [result] = await resolveDroppedPaths(link, [path.join(root, 'folder', 'file.txt')])
  assert.ok(!result.ok); assert.match(result.reason, /liên kết tượng trưng/)
})

test('enforces media/text size boundaries, empty media and the per-drop batch cap', async t => {
  const { root, file } = await fixture(t)
  for (const [name, size, external, reason] of [
    ['large.png', MAX_MEDIA_BYTES + 1, false, /10 MiB/],
    ['large.txt', MAX_EXTERNAL_TEXT_BYTES + 1, true, /512 KiB/],
    ['empty.pdf', 0, false, /rỗng/]
  ] as const) {
    const [result] = await resolveDroppedPaths(root, [await file(name, Buffer.alloc(size, 65), external)])
    assert.ok(!result.ok); assert.match(result.reason, reason)
  }
  for (const [name, size, external] of [['exact.png', MAX_MEDIA_BYTES, false], ['exact.txt', MAX_EXTERNAL_TEXT_BYTES, true]] as const) {
    const [result] = await resolveDroppedPaths(root, [await file(name, Buffer.alloc(size, 65), external)])
    assert.ok(result.ok && result.kind !== 'workspace-file')
    assert.equal(result.size, size)
  }
  const target = await file('source.ts', '')
  const results = await resolveDroppedPaths(root, Array(MAX_DROPPED_BATCH + 2).fill(target))
  assert.equal(results.length, MAX_DROPPED_BATCH + 1)
  assert.ok(results.slice(0, MAX_DROPPED_BATCH).every(result => result.ok))
  assert.deepEqual(results.at(-1), { ok: false, name: '...', reason: 'Chỉ xử lý tối đa 16 tệp mỗi lần kéo thả.' })
})
