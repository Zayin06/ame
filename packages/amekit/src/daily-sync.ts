import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { safeDirectory } from "./installer"
import type { BundleAccount } from "./bundle-preferences"

export function localDayKey(epochMs = Date.now()): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_SYNC_DATE")
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return }
    catch (error) {
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      await delay(30 * (attempt + 1))
    }
  }
}

export function dailySyncStore(userData: string) {
  const directory = path.join(userData, "amekit", "daily-sync")
  const target = (account: BundleAccount) => path.join(directory, `${createHash("sha256").update(JSON.stringify([account.origin, account.accountId, "opencode/stable"])).digest("hex")}.json`)
  return {
    async checkedToday(account: BundleAccount, now = Date.now()): Promise<boolean> {
      try {
        await safeDirectory(directory)
        const file = target(account), stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) return false
        const value = JSON.parse(await readFile(file, "utf8"))
        return value.origin === account.origin && value.accountId === account.accountId && typeof value.lastCheckedDay === "string" && value.lastCheckedDay === localDayKey(now)
      } catch { return false } // Corrupt or unsafe state must never block syncing.
    },
    async markChecked(account: BundleAccount, now = Date.now()): Promise<void> {
      await mkdir(directory, { recursive: true })
      await safeDirectory(directory)
      const file = target(account), pending = path.join(directory, `${randomUUID()}.pending`)
      try {
        await writeFile(pending, JSON.stringify({ ...account, lastCheckedDay: localDayKey(now) }), { flag: "wx", mode: 0o600 })
        await renameWithRetry(pending, file)
      } finally { await rm(pending, { force: true }) }
    },
  }
}
