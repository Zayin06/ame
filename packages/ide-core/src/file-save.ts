import { randomUUID } from 'node:crypto'
import { open, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

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
  // Opening without truncation also preserves the permission check of an ordinary save.
  const source = await open(target, 'r+')
  const temporary = path.join(path.dirname(target), `.ame-save-${randomUUID()}.tmp`)
  let staged: FileHandle | undefined, backup: string | undefined
  try {
    const info = await source.stat()
    staged = await open(temporary, 'wx', info.mode & 0o777)
    await staged.chmod(info.mode & 0o777)
    await staged.writeFile(bytes)
    await staged.sync()
    await staged.close(); staged = undefined
    await verify()
    if ((await source.stat()).nlink > 1) {
      // Replacing a hard link would detach its aliases. Keep a flushed original
      // beside it before an in-place write, including across an unexpected exit.
      backup = `${target}.ame-save-${randomUUID()}.bak`
      const recovery = await open(backup, 'wx', info.mode & 0o777)
      try { await recovery.writeFile(original); await recovery.sync() }
      finally { await recovery.close() }
      await verify()
      try { await writeAtStart(source, bytes) }
      catch (cause) {
        try { await writeAtStart(source, original) }
        catch {
          const recoveryPath = backup
          backup = undefined // Keep evidence when rollback cannot restore the linked inode.
          throw new Error(`FILE_SAVE_RECOVERY_REQUIRED: Bản gốc được giữ tại ${recoveryPath}`, { cause })
        }
        throw cause
      }
    } else {
      await source.close()
      // Same-directory rename is atomic. A failed rename leaves the old file in place.
      await rename(temporary, target)
    }
  } finally {
    await staged?.close().catch(() => {})
    await source.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    if (backup) await unlink(backup).catch(() => {})
  }
}
