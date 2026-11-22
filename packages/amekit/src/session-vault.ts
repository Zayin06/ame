import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { serverURL } from "./api"
import { safeDirectory } from "./installer"

export type Credential = { origin: string; token: string }
export type Encryption = Pick<typeof import("electron")["safeStorage"], "isEncryptionAvailable" | "encryptString" | "decryptString"> & {
  getSelectedStorageBackend?: () => string
}
export async function openSessionVault(userData: string, encryption: Encryption) {
  if (!path.isAbsolute(userData)) throw new Error("ABSOLUTE_USER_DATA_REQUIRED")
  await mkdir(userData, { recursive: true })
  await safeDirectory(userData)
  const file = path.join(userData, "amekit-session.enc")
  const available = () => {
    if (!encryption.isEncryptionAvailable() || encryption.getSelectedStorageBackend?.() === "basic_text") throw new Error("SESSION_STORAGE_UNAVAILABLE")
  }
  const check = async () => {
    await safeDirectory(userData)
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("INVALID_SESSION_STORAGE")
      return true
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
  }
  return {
    async load(): Promise<Credential | undefined> {
      if (!await check()) return
      available()
      try {
        const value: unknown = JSON.parse(encryption.decryptString(await readFile(file)))
        if (!value || typeof value !== "object") throw new Error()
        const { origin, token } = value as Credential
        if (typeof origin !== "string" || serverURL(origin) !== origin || typeof token !== "string" || !token || token.length > 8192) throw new Error()
        return { origin, token }
      } catch { throw new Error("INVALID_SESSION_STORAGE") }
    },
    async save(value: Credential | undefined) {
      await check()
      if (!value) { await rm(file, { force: true }); return }
      available()
      const encrypted = encryption.encryptString(JSON.stringify(value))
      const pending = path.join(userData, `amekit-session-${randomUUID()}.pending`)
      try {
        await writeFile(pending, encrypted, { mode: 0o600, flag: "wx" })
        await rename(pending, file)
      } finally { await rm(pending, { force: true }) }
    },
  }
}
