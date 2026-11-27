import { randomUUID } from 'node:crypto'
import { open, rename, unlink, readdir, lstat, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

export async function renameWithRetry(from: string, to: string, verify?: () => Promise<void>): Promise<void> {
  const delays = [15, 30, 60, 120]
  for (let attempt = 0; ; attempt++) {
    try { await verify?.(); await rename(from, to); return }
    catch (error) {
      if (attempt === delays.length || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}

/** Best-effort crash recovery housekeeping; never follow links into other trees. */
export async function cleanupStaleSaveTemps(dir: string): Promise<void> {
  const cutoff = Date.now() - 10 * 60 * 1000
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name.toLowerCase() !== '.git') await walk(target)
      else if (entry.isFile() && /^\.ame-save-.*\.(?:tmp|bak)$/.test(entry.name)) {
        try { if ((await lstat(target)).mtimeMs < cutoff) await unlink(target) } catch { /* Best effort. */ }
      }
    }
  }
  await walk(dir)
}

async function writeAtStart(handle: FileHandle, bytes: Buffer) {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (!bytesWritten) throw new Error('FILE_SAVE_WRITE_FAILED')
    offset += bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

/** Prepare and flush bytes before publishing; never truncate the only original copy. */
export async function saveFileSafely(target: string, bytes: Buffer, original: Buffer, verify: () => Promise<void>) {
  await cleanupStaleSaveTemps(path.dirname(target)).catch(() => {})
  // Opening without truncation also preserves the permission check of an ordinary save.
  const source = await open(target, 'r+')
  const temporary = path.join(path.dirname(target), `.ame-save-${randomUUID()}.tmp`)
  let staged: FileHandle | undefined, backup: string | undefined
  try {
    const info = await source.stat()
    const identity = await source.stat({ bigint: true })
    const verifySource = async () => {
      await verify()
      const current = await stat(target, { bigint: true })
      if (identity.dev !== current.dev || identity.ino !== current.ino) throw Object.assign(new Error('FILE_CONFLICT'), { code: 'FILE_CONFLICT' })
    }
    staged = await open(temporary, 'wx', info.mode & 0o777)
    await staged.chmod(info.mode & 0o777)
    await staged.writeFile(bytes)
    await staged.sync()
    await staged.close(); staged = undefined
    await verifySource()
    if ((await source.stat()).nlink > 1) {
      // Replacing a hard link would detach its aliases. Keep a flushed original
      // beside it before an in-place write, including across an unexpected exit.
      backup = path.join(path.dirname(target), `.ame-recovery-${randomUUID()}.bak`)
      const recovery = await open(backup, 'wx', info.mode & 0o777)
      try { await recovery.writeFile(original); await recovery.sync() }
      finally { await recovery.close() }
      await verifySource()
      try { await writeAtStart(source, bytes) }
      catch (cause) {
        try { await writeAtStart(source, original) }
        catch {
          // Recovery evidence is not an orphan: never let stale-temp cleanup delete it.
          const recoveryPath = backup
          backup = undefined // Keep evidence when rollback cannot restore the linked inode.
          throw new Error(`FILE_SAVE_RECOVERY_REQUIRED: Bản gốc được giữ tại ${recoveryPath}`, { cause })
        }
        throw cause
      }
    } else {
      await source.close()
      // Same-directory rename is atomic. A failed rename leaves the old file in place.
      await renameWithRetry(temporary, target, verifySource)
    }
  } finally {
    await staged?.close().catch(() => {})
    await source.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    if (backup) await unlink(backup).catch(() => {})
  }
}
