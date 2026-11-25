import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(process.cwd(), '.ame-workspace-test-'))
  const directory = path.join(root, 'project')
  await mkdir(directory)
  const workspaces = new Workspaces(path.join(root, 'projects.json'))
  const project = await workspaces.add(directory)
  t.after(async () => { workspaces.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { directory, workspaces, id: project.id }
}

for (const committed of [false, true]) {
  test(`stage/unstage treats bracket filenames literally (${committed ? 'HEAD' : 'unborn'})`, async t => {
    const { directory, workspaces, id } = await fixture(t)
    const git = simpleGit(directory)
    await git.init()
    await git.addConfig('user.name', 'Ame Test')
    await git.addConfig('user.email', 'test@example.invalid')
    await git.addConfig('commit.gpgSign', 'false')
    await git.addConfig('core.autocrlf', 'false')
    const files = ['[ab].ts', 'a.ts', 'b.ts']
    for (const file of files) await writeFile(path.join(directory, file), 'before\n')
    if (committed) {
      await git.raw(['add', '-A'])
      await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'initial'])
    }
    for (const file of files) await writeFile(path.join(directory, file), 'after\n')
    const indexed = async () => (await git.raw(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort()
    assert.deepEqual(await indexed(), [])
    await workspaces.stage(id, '[ab].ts', true)
    assert.deepEqual(await indexed(), ['[ab].ts'])
    await workspaces.stage(id, '[ab].ts', false)
    assert.deepEqual(await indexed(), [])
    // Removing one entry must also preserve unrelated staged entries.
    for (const file of files) await workspaces.stage(id, file, true)
    assert.deepEqual(await indexed(), files)
    await workspaces.stage(id, '[ab].ts', false)
    assert.deepEqual(await indexed(), ['a.ts', 'b.ts'])
    for (const file of files) assert.equal(await readFile(path.join(directory, file), 'utf8'), 'after\n')
  })
}

test('UTF-8 saves preserve BOM bytes without duplication and detect external byte changes', async t => {
  const { directory, workspaces, id } = await fixture(t)
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  for (const hasBom of [true, false]) {
    const file = hasBom ? 'bom.txt' : 'plain.txt'
    const target = path.join(directory, file)
    const encode = (content: string) => Buffer.concat([hasBom ? bom : Buffer.alloc(0), Buffer.from(content)])
    await writeFile(target, encode('chào\n'))
    const doc = await workspaces.read(id, file)
    assert.equal(doc.content, 'chào\n')
    const saved = await workspaces.save(id, file, doc.content.replace('o', 'x'), doc.revision)
    assert.deepEqual(await readFile(target), encode('chàx\n'))
    const again = await workspaces.save(id, file, (hasBom ? '\uFEFF' : '') + saved.content, saved.revision)
    assert.deepEqual(await readFile(target), encode('chàx\n'))
    // A BOM-only external change must still invalidate the byte-based revision.
    const external = Buffer.concat([hasBom ? Buffer.alloc(0) : bom, Buffer.from(again.content)])
    await writeFile(target, external)
    await assert.rejects(workspaces.save(id, file, 'overwrite', again.revision), /FILE_CONFLICT/)
    assert.deepEqual(await readFile(target), external)
    const reloaded = await workspaces.read(id, file)
    await workspaces.save(id, file, reloaded.content + '!', reloaded.revision)
    assert.deepEqual(await readFile(target), Buffer.concat([external, Buffer.from('!')]))
  }
})
