import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { Workspaces } from '../packages/ide-core/src/workspace'

for (const failure of ['write', 'rename'] as const) {
  test(`failed ${failure} leaves the original document intact and removes save staging files`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ame-safe-save-'))
    const target = path.join(root, 'source.ts'), original = 'original source\n'
    const workspace = new Workspaces(path.join(root, 'projects.json'))
    await fs.writeFile(target, original)
    await workspace.add(root, 'p', false); workspace.dispose()
    t.after(async () => { workspace.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }) })
    const doc = await workspace.read('p', 'source.ts')
    const writeFile = fs.writeFile, open = fs.open, rename = fs.rename
    const failureCode = failure === 'write' ? 'ENOSPC' : 'EPERM'
    const diskError = () => Object.assign(new Error(failureCode), { code: failureCode })
    // The old path truncates the real file; safe saves must fail on a staged file instead.
    const writeMock = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (failure === 'write' && String(args[0]) === target) { await writeFile(target, 'partial'); throw diskError() }
      return writeFile(...args)
    })
    const openMock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (failure === 'write' && String(args[0]).includes('.ame-save-') && args[1] === 'wx') {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async () => { await write('partial'); throw diskError() }
      }
      return handle
    })
    const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (failure === 'rename' && String(args[1]) === target) throw diskError()
      return rename(...args)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(workspace.save('p', 'source.ts', 'updated source\n', doc.revision), { code: failureCode })
      assert.equal(await fs.readFile(target, 'utf8'), original)
      assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('.ame-save-')), [])
    } finally {
      writeMock.mock.restore(); openMock.mock.restore(); renameMock.mock.restore(); syncBuiltinESMExports()
    }
  })
}

for (const restoreFails of [false, true]) {
  test(`hard-linked saves preserve aliases and ${restoreFails ? 'retain a recovery copy if rollback fails' : 'restore the original after a partial write'}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ame-linked-save-'))
    const target = path.join(root, 'source.ts'), alias = path.join(root, 'alias.ts'), original = '\uFEFForiginal linked source\n'
    const workspace = new Workspaces(path.join(root, 'projects.json'))
    await fs.writeFile(target, original); await fs.link(target, alias)
    await workspace.add(root, 'p', false); workspace.dispose()
    t.after(async () => { workspace.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }) })
    const doc = await workspace.read('p', 'source.ts')
    const open = fs.open
    const openMock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]) === target && args[1] === 'r+') {
        const write = handle.write.bind(handle)
        let writes = 0
        handle.write = (async (...params: Parameters<typeof handle.write>) => {
          if (++writes === 1 || restoreFails) {
            await write(Buffer.from('partial'), 0, 7, 0)
            throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
          }
          return write(...params)
        }) as typeof handle.write
      }
      return handle
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(workspace.save('p', 'source.ts', 'new source', doc.revision), restoreFails ? /FILE_SAVE_RECOVERY_REQUIRED/ : /ENOSPC/)
      const backups = (await fs.readdir(root)).filter(name => name.endsWith('.bak'))
      if (restoreFails) {
        assert.equal(backups.length, 1)
        assert.equal(await fs.readFile(path.join(root, backups[0]), 'utf8'), original)
      } else {
        assert.equal(await fs.readFile(target, 'utf8'), original)
        assert.equal(await fs.readFile(alias, 'utf8'), original)
        assert.deepEqual(backups, [])
      }
    } finally { openMock.mock.restore(); syncBuiltinESMExports() }
    if (!restoreFails) {
      await workspace.save('p', 'source.ts', 'saved', doc.revision)
      assert.equal(await fs.readFile(alias, 'utf8'), '\uFEFFsaved')
    }
  })
}
