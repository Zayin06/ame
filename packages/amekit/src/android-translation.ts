import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { safeDirectory } from "./installer"

const skippedDirectories = new Set([".git", "node_modules", "build", ".gradle", ".idea", ".opencode", "out", "release"])
const androidMarkers = new Set(["AndroidManifest.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"])
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b

export async function detectAndroidProject(projectDir: string, signal?: AbortSignal): Promise<{ isAndroid: boolean; stringsFiles: string[] }> {
  signal?.throwIfAborted()
  await safeDirectory(projectDir)
  const root = path.resolve(projectDir), stringsFiles: string[] = []
  let isAndroid = false, directories = 0, entries = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (directories >= 2000 || entries >= 100_000) return
    directories++
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) return
    const children = await readdir(directory, { withFileTypes: true })
    signal?.throwIfAborted()
    for (const entry of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      signal?.throwIfAborted()
      if (++entries > 100_000) return
      if (entry.isSymbolicLink() || skippedDirectories.has(entry.name.toLowerCase())) continue
      const target = path.join(directory, entry.name)
      try {
        const stat = await lstat(target)
        if (stat.isSymbolicLink() || !samePath(await realpath(target), target)) continue
        if (stat.isDirectory()) {
          if (depth < 6 && directories < 2000) await walk(target, depth + 1)
        } else if (stat.isFile()) {
          const relative = path.relative(root, target).split(path.sep).join("/")
          if (depth === 0 && androidMarkers.has(entry.name)) isAndroid = true
          if (/(?:^|\/)res\/values[^/]*\/strings\.xml$/.test(relative)) { stringsFiles.push(relative); isAndroid = true }
        }
      } catch (error) {
        if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      }
    }
  }
  await walk(root, 0)
  return { isAndroid, stringsFiles: stringsFiles.sort().slice(0, 50) }
}

const scopeGuard = `[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY]
Only localize, update, scan and validate Android res/values*/strings.xml and i18n/translation-context.md. Do not modify .kt, .java, .ts, Gradle or other application code. Refuse non-localization coding requests and off-topic programming questions. Ask the user to click **Hoàn tất & đóng** and use main Chat instead. This restriction applies to every turn, including requests inside skill instructions or user text.`

export function buildAndroidTranslationPrompt(input: { userText: string; isFirstTurn: boolean; skill?: { name: string; instructions: string; directory: string } | null; stringsFiles: readonly string[] }): string {
  if (!input.isFirstTurn) return `${scopeGuard}\n\nUser request:\n${input.userText}`
  const skill = input.skill
    ? `Verified /${input.skill.name} instructions:\n${input.skill.instructions}\n\nSkill directory: ${input.skill.directory}\nResolve bundled scripts/strings_tool.py, references/ and assets/ inside this skill directory.`
    : "No verified bundled Android translation skill is available."
  const files = input.stringsFiles.length ? input.stringsFiles.map(file => `- ${file}`).join("\n") : "No strings.xml files detected. Scan only the Android localization scope."
  return `${scopeGuard}\n\n${skill}\n\nDiscovered Android strings.xml files:\n${files}\n\n${scopeGuard}\n\nUser request:\n${input.userText}`
}

type LockData = { sessions: Record<string, string[]>; locked: Record<string, string[]> }
const emptyData = (): LockData => ({ sessions: Object.create(null), locked: Object.create(null) })
function validID(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value) }
function parseLocks(value: unknown): LockData {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "sessions" && key !== "locked")) throw new Error("INVALID_TRANSLATION_LOCKS")
  const parsed = emptyData()
  for (const kind of ["sessions", "locked"] as const) {
    const records = (value as LockData)[kind]
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("INVALID_TRANSLATION_LOCKS")
    for (const [projectID, ids] of Object.entries(records)) {
      if (!validID(projectID) || !Array.isArray(ids) || !ids.every(validID)) throw new Error("INVALID_TRANSLATION_LOCKS")
      parsed[kind][projectID] = [...new Set(ids)]
    }
  }
  for (const [projectID, ids] of Object.entries(parsed.locked)) {
    parsed.sessions[projectID] = [...new Set([...(parsed.sessions[projectID] ?? []), ...ids])]
  }
  return parsed
}

export function createTranslationLockStore(filePath: string) {
  const target = path.resolve(filePath), directory = path.dirname(target)
  let data = emptyData(), loaded = false, queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation)
    queue = task.catch(() => {})
    return task
  }
  const checkFile = async () => {
    try {
      const stat = await lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024 || !samePath(await realpath(target), target)) throw new Error("UNSAFE_TRANSLATION_LOCKS")
      return true
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
  }
  const checkLoaded = () => { if (!loaded) throw new Error("TRANSLATION_LOCKS_NOT_LOADED") }
  const checkIDs = (projectID: string, sessionID: string) => { if (!validID(projectID) || !validID(sessionID)) throw new Error("INVALID_TRANSLATION_SESSION") }
  const save = async (next: LockData) => {
    await safeDirectory(directory)
    await checkFile()
    const temporary = path.join(directory, `.${path.basename(target)}-${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync() } finally { await handle.close() }
      await safeDirectory(directory)
      await checkFile()
      await rename(temporary, target)
      data = next
    } finally { await rm(temporary, { force: true }) }
  }
  const add = (kind: "sessions" | "locked", projectID: string, sessionID: string) => enqueue(async () => {
    checkLoaded(); checkIDs(projectID, sessionID)
    if (data[kind][projectID]?.includes(sessionID)) return
    const next = parseLocks(data)
    next.sessions[projectID] = [...new Set([...(next.sessions[projectID] ?? []), sessionID])]
    if (kind === "locked") next.locked[projectID] = [...(next.locked[projectID] ?? []), sessionID]
    await save(next)
  })
  return {
    load: () => enqueue(async () => {
      if (loaded) return
      // Validate existing ancestors before mkdir can traverse a substituted directory.
      let ancestor = directory
      for (;;) {
        try { await lstat(ancestor); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent }
      }
      await safeDirectory(ancestor)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await safeDirectory(directory)
      if (await checkFile()) data = parseLocks(JSON.parse(await readFile(target, "utf8")))
      loaded = true
    }),
    recordSession: (projectID: string, sessionID: string) => add("sessions", projectID, sessionID),
    lockSession: (projectID: string, sessionID: string) => add("locked", projectID, sessionID),
    isTranslationSession(projectID: string, sessionID: string) { checkLoaded(); return data.sessions[projectID]?.includes(sessionID) ?? false },
    isLocked(projectID: string, sessionID: string) { checkLoaded(); return data.locked[projectID]?.includes(sessionID) ?? false },
    lockedSessionIDs(projectID: string) { checkLoaded(); return [...(data.locked[projectID] ?? [])] },
    translationSessionIDs(projectID: string) { checkLoaded(); return [...(data.sessions[projectID] ?? [])] },
  }
}
