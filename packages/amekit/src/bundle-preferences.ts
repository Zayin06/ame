import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { safeDirectory } from "./installer"

export type BundleAccount = { origin: string; accountId: string }
// Opting out applies to the stable bundle, not just its current release: publishing
// an update must not silently undo the user's choice to remove the bundle.
const bundle = "opencode/stable"

export function bundlePreferences(userData: string) {
  const directory = path.join(userData, "amekit", "bundle-preferences")
  const target = (account: BundleAccount) => path.join(directory, `${createHash("sha256").update(JSON.stringify([account.origin, account.accountId, bundle])).digest("hex")}.json`)
  const check = async (file: string) => {
    await safeDirectory(directory)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("INVALID_BUNDLE_PREFERENCES")
  }
  return {
    async optedOut(account: BundleAccount): Promise<boolean> {
      const file = target(account)
      try {
        await check(file)
        const value = JSON.parse(await readFile(file, "utf8"))
        if (value.origin !== account.origin || value.accountId !== account.accountId || value.bundle !== bundle || value.autoSync !== false) throw new Error("INVALID_BUNDLE_PREFERENCES")
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error // Fail closed: unreadable preferences must never authorize installation.
      }
    },
    async disable(account: BundleAccount, releaseId?: string) {
      await mkdir(directory, { recursive: true })
      await safeDirectory(directory)
      const file = target(account), pending = path.join(directory, `${randomUUID()}.pending`)
      try {
        await writeFile(pending, JSON.stringify({ ...account, bundle, releaseId: releaseId ?? null, autoSync: false }), { flag: "wx", mode: 0o600 })
        await rename(pending, file)
      } finally { await rm(pending, { force: true }) }
    },
    async enable(account: BundleAccount) {
      try { await check(target(account)); await rm(target(account)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    },
  }
}
