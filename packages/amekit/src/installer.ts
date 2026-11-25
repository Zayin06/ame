// Adapted from opencode-amekit/src/installer.ts; see ../docs/amekit.md for provenance.
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { BundleFeatures, Release } from "./api"
import { Features, sha256 } from "./bundle/manifest"
import { MAX_EXPANDED, MAX_FILE, MAX_PAYLOAD_FILES, MAX_SCAN_ENTRIES } from "./bundle/limits"
import { preview, safePath, verifiedFiles, type InputFile } from "./bundle/package"
import type { Discover } from "./runtime"

type State = { schema: 1; releaseId: string; version: string; sha256: string; origin: string; files: { path: string; sha256: string }[]; agents: string[]; skills: string[]; features?: BundleFeatures; compatibilityMode?: "native" | "raw" }
function verification(state: State, files: InputFile[], runtimeReady = false) {
  const content = preview(files, [], { compatibilityMode: state.compatibilityMode })
  if (content.issues.some(i => i.severity === "error" || i.severity === "excluded")) throw new Error("INSTALL_COMPATIBILITY_BLOCKED")
  return { compatibilityMode: state.compatibilityMode ?? "native", verification: state.compatibilityMode === "raw" || !runtimeReady ? "verified-bytes" as const : "runtime-ready" as const, compatibilityWarnings: content.issues.filter(i => i.severity === "warning") }
}
const stateName = ".amekit-release.json"
async function exists(file: string) { try { await lstat(file); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e } }
export async function safeDirectory(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error("ABSOLUTE_PROJECT_REQUIRED")
  let current = path.resolve(directory)
  for (;;) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error("REPARSE_DIRECTORY_REJECTED")
    const parent = path.dirname(current); if (parent === current) break; current = parent
  }
}
async function tree(root: string) {
  const files = Object.assign([] as InputFile[], { directories: [] as string[] }); let size = 0, count = 0
  if (!await exists(root)) return files
  await safeDirectory(root)
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > MAX_SCAN_ENTRIES) throw new Error("PERSONAL_CONFIG_TOO_LARGE")
      const target = path.join(directory, entry.name), name = prefix + entry.name
      const stat = await lstat(target)
      if (stat.isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("REPARSE_CONFIG_REJECTED")
      if (stat.isDirectory()) { files.directories.push(name); await walk(target, name + "/") }
      else {
        if (!stat.isFile() || stat.size > MAX_FILE * 2 || (size += stat.size) > MAX_EXPANDED + 64 * 1024 * 1024) throw new Error("PERSONAL_CONFIG_TOO_LARGE")
        files.push({ path: name, data: new Uint8Array(await readFile(target)) })
      }
    }
  }
  await walk(root, ""); return files
}
async function inventory(files: InputFile[]) { return Promise.all(files.map(async f => ({ path: f.path, sha256: await sha256(f.data) }))) }
async function fingerprint(files: InputFile[] & { directories?: string[] }) { return JSON.stringify({ files: (await inventory(files)).sort((a,b) => a.path.localeCompare(b.path)), directories: [...(files.directories ?? [])].sort() }) }
function stateOf(files: InputFile[]) {
  const item = files.find(f => f.path === stateName)
  if (!item) return undefined
  const state = JSON.parse(new TextDecoder().decode(item.data)) as State
  if (!state || state.schema !== 1 || typeof state.releaseId !== "string" || typeof state.version !== "string" || typeof state.origin !== "string" || !/^[a-f0-9]{64}$/.test(state.sha256) || !Array.isArray(state.files) || !Array.isArray(state.agents) || !Array.isArray(state.skills) || state.files.length > MAX_PAYLOAD_FILES || !state.files.every(f => f && typeof f.path === "string" && /^(agents|skills)\//.test(f.path) && /^[a-f0-9]{64}$/.test(f.sha256))) throw new Error("INVALID_OWNERSHIP_STATE")
  if (state.compatibilityMode !== undefined && state.compatibilityMode !== "native" && state.compatibilityMode !== "raw") throw new Error("INVALID_OWNERSHIP_STATE")
  if (state.features !== undefined) {
    const parsed = Features.safeParse(state.features)
    if (!parsed.success || [parsed.data.commitEnhanceSkill, parsed.data.androidTranslationSkill, parsed.data.buildNotesSkill].some(name => name !== undefined && !state.skills.includes(name))) throw new Error("INVALID_OWNERSHIP_STATE")
  }
  const paths = new Set<string>()
  for (const file of state.files) { safePath(file.path); const key = file.path.toLowerCase(); if (paths.has(key)) throw new Error("INVALID_OWNERSHIP_STATE"); paths.add(key) }
  if (![...state.agents, ...state.skills].every(id => typeof id === "string") || state.agents.some(id => !paths.has(`agents/${id}.md`.toLowerCase())) || state.skills.some(id => !paths.has(`skills/${id}/SKILL.md`.toLowerCase()))) throw new Error("INVALID_OWNERSHIP_STATE")
  return state
}
async function checkOwned(files: InputFile[], state: State) {
  for (const owned of state.files) {
    const file = files.find(f => f.path === owned.path)
    if (!file || await sha256(file.data) !== owned.sha256) throw new Error("OWNED_FILE_CHANGED")
  }
}
async function discovered(targetDir: string, state: State, discover: Discover, signal?: AbortSignal, scope: "project" | "global" = "project") {
  signal?.throwIfAborted()
  if (state.compatibilityMode === "raw") return
  const catalog = await discover(targetDir, signal, state, { scope })
  const configDir = scope === "global" ? targetDir : path.join(targetDir, ".opencode")
  if (!state.agents.every(id => catalog.agents.some(a => a.id === id)) || !state.skills.every(id => catalog.skills.some(s => s.name === id && path.resolve(s.path).toLowerCase() === path.join(configDir, "skills", id, "SKILL.md").toLowerCase()))) throw new Error("DISCOVERY_MISMATCH")
}
export async function installed(project: string) {
  await safeDirectory(project)
  const managed = path.join(project, ".amekit")
  if (await exists(managed)) {
    await safeDirectory(managed)
    if (await exists(path.join(managed, "transaction.json")) || await exists(path.join(managed, "lock"))) throw new Error("RECOVERY_REQUIRED")
  }
  const files = await tree(path.join(project, ".opencode")), state = stateOf(files)
  if (state) {
    await checkOwned(files, state)
    return { ...state, ...verification(state, files.filter(f => state.files.some(o => o.path === f.path))) }
  }
  return undefined
}
async function readVerifiedFeatureSkill(project: string, name: string | undefined, state: Awaited<ReturnType<typeof installed>>, limit: number, scope: "project" | "global" = "project") {
  if (!name || !state) return null
  const owned = state.files.find(file => file.path === `skills/${name}/SKILL.md`)
  if (!owned) return null
  const target = path.join(scope === "global" ? project : path.join(project, ".opencode"), "skills", name, "SKILL.md")
  await safeDirectory(path.dirname(target))
  const stat = await lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("REPARSE_CONFIG_REJECTED")
  const bytes = await readFile(target)
  if (await sha256(bytes) !== owned.sha256) throw new Error("OWNED_FILE_CHANGED")
  const instructions = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    .replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim().slice(0, limit)
  return instructions ? { name, instructions, directory: path.dirname(target) } : null
}
export async function readCommitEnhanceSkill(project: string): Promise<{ name: string; instructions: string } | null> {
  const state = await installed(project)
  const skill = await readVerifiedFeatureSkill(project, state?.features?.commitEnhanceSkill, state, 16_000)
  return skill ? { name: skill.name, instructions: skill.instructions } : null
}
export async function readBundleFeatures(project: string): Promise<BundleFeatures | undefined> {
  return (await installed(project))?.features
}
export async function readAndroidTranslationFeature(project: string): Promise<{ skill: { name: string; instructions: string; directory: string } | null; model?: string; rawSkillName?: string }> {
  const state = await installed(project), features = state?.features
  const skill = await readVerifiedFeatureSkill(project, features?.androidTranslationSkill, state, 32_000)
  return { skill, ...(features?.androidTranslationModel ? { model: features.androidTranslationModel } : {}), ...(features?.androidTranslationSkill ? { rawSkillName: features.androidTranslationSkill } : {}) }
}
export async function readBuildNotesFeature(project: string): Promise<{ skill: { name: string; instructions: string } | null; model?: string; rawSkillName?: string }> {
  const state = await installed(project), features = state?.features
  const skill = await readVerifiedFeatureSkill(project, features?.buildNotesSkill, state, 16_000)
  return { skill: skill ? { name: skill.name, instructions: skill.instructions } : null, ...(features?.buildNotesModel ? { model: features.buildNotesModel } : {}), ...(features?.buildNotesSkill ? { rawSkillName: features.buildNotesSkill } : {}) }
}
async function managedDirectory(project: string) {
  await safeDirectory(project)
  const managed = path.join(project, ".amekit")
  if (!await exists(managed)) { await mkdir(managed); await writeFile(path.join(managed, "owner"), "amekit-poc04\n", { flag: "wx" }) }
  await safeDirectory(managed)
  const marker = path.join(managed, "owner"), markerStat = await lstat(marker)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (await realpath(marker)).toLowerCase() !== marker.toLowerCase() || await readFile(marker, "utf8") !== "amekit-poc04\n") throw new Error("MANAGED_DIRECTORY_COLLISION")
  return managed
}
async function journal(managed: string, value: unknown) {
  const file = await open(path.join(managed, "transaction.json"), "wx")
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
}
async function transaction(project: string, prepare: (before: Awaited<ReturnType<typeof tree>>) => Promise<{ files: InputFile[]; state?: State } | undefined>, verify: () => Promise<void>, signal?: AbortSignal) {
  const config = path.join(project, ".opencode"), managed = await managedDirectory(project)
  const lock = path.join(managed, "lock")
  await mkdir(lock)
  const stage = path.join(managed, "stage-" + randomUUID()), backup = path.join(managed, "previous-" + randomUUID())
  let moved = false, activated = false, retainStage = false, journaled = false, settled = false
  try {
    if (await exists(path.join(managed, "transaction.json"))) throw new Error("RECOVERY_REQUIRED")
    signal?.throwIfAborted()
    const before = await tree(config), next = await prepare(before)
    if (!next) return false
    await mkdir(stage)
    for (const directory of before.directories) await mkdir(path.join(stage, ...directory.split("/")), { recursive: true })
    for (const f of next.files) {
      signal?.throwIfAborted()
      const target = path.join(stage, ...f.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, f.data, { flag: "wx" })
    }
    if (next.state) await writeFile(path.join(stage, stateName), JSON.stringify(next.state), { flag: "wx" })
    const stagedFingerprint = await fingerprint(await tree(stage))
    if (await fingerprint(before) !== await fingerprint(await tree(config))) throw new Error("CONFIG_CHANGED_DURING_SYNC")
    signal?.throwIfAborted()
    await journal(managed, { schema: 1, stage: path.basename(stage), backup: path.basename(backup), hadConfig: await exists(config) }); journaled = true
    if (await exists(config)) { await retryFs(() => rename(config, backup)); moved = true }
    await retryFs(() => rename(stage, config)); activated = true
    await verify()
    if (next.state) await checkOwned(await tree(config), next.state)
    if (await fingerprint(await tree(config)) !== stagedFingerprint) throw new Error("CONFIG_CHANGED_AFTER_ACTIVATION")
    settled = true
    return true
  } catch (error) {
    if (activated) {
      retainStage = true
      await retryFs(() => rename(config, stage))
    }
    if (moved) await retryFs(() => rename(backup, config))
    settled = true
    throw error
  } finally {
    // Keep evidence and both trees if rollback itself failed; never erase concurrent edits.
    if (settled || !journaled) {
      if (!retainStage) await rm(stage, { recursive: true, force: true })
      if (journaled) await rm(path.join(managed, "transaction.json"))
      await rm(lock, { recursive: true, force: true })
    }
  }
}
export async function install(project: string, origin: string, release: Release, bytes: Uint8Array, discover: Discover, signal?: AbortSignal, options: { allowRaw?: boolean } = {}) {
  await safeDirectory(project)
  const verified = await verifiedFiles(bytes, release.version, release.sha256)
  const compatibilityMode = verified.summary.compatibility.mode ?? "native"
  if (compatibilityMode === "raw" && options.allowRaw !== true) throw new Error("RAW_INSTALL_CONFIRMATION_REQUIRED")
  const content = preview(verified.files, [], { compatibilityMode })
  if (content.issues.some(i => i.severity === "error" || i.severity === "excluded")) throw new Error("INSTALL_COMPATIBILITY_BLOCKED")
  let state: State
  const changed = await transaction(project, async before => {
    const old = stateOf(before)
    if (old) { if (old.origin !== origin) throw new Error("SERVER_OWNERSHIP_MISMATCH"); await checkOwned(before, old) }
    if (old?.sha256 === release.sha256 && old.releaseId === release.releaseId) { state = old; await discovered(project, old, discover, signal); return undefined }
    const personal = before.filter(f => f.path !== stateName && !old?.files.some(o => o.path === f.path))
    // Raw payloads may intentionally be undiscoverable. File/directory collision checks remain mandatory.
    const catalog = compatibilityMode === "raw" ? { agents: [], skills: [] } : await discover(project, signal)
    for (const id of content.agents) if (!old?.agents.includes(id) && catalog.agents.some(a => a.id.toLowerCase() === id.toLowerCase())) throw new Error("PERSONAL_AGENT_COLLISION")
    for (const id of content.skills) if (!old?.skills.includes(id) && catalog.skills.some(s => s.name.toLowerCase() === id.toLowerCase())) throw new Error("PERSONAL_SKILL_COLLISION")
    for (const f of verified.files) {
      const key = f.path.toLowerCase()
      if (personal.some(p => { const name = p.path.toLowerCase(); return name === key || name.startsWith(key + "/") || key.startsWith(name + "/") })) throw new Error("PERSONAL_FILE_COLLISION")
      if (before.directories.some(p => p.toLowerCase() === key || p.toLowerCase().startsWith(key + "/"))) throw new Error("PERSONAL_DIRECTORY_COLLISION")
    }
    state = { schema: 1, releaseId: release.releaseId, version: release.version, sha256: release.sha256, origin, files: await inventory(verified.files), agents: content.agents, skills: content.skills, ...(verified.summary.features ? { features: verified.summary.features } : {}), ...(compatibilityMode === "raw" ? { compatibilityMode } : {}) }
    return { files: [...personal, ...verified.files], state }
  }, () => discovered(project, state!, discover, signal), signal)
  return { state: { ...state!, ...verification(state!, verified.files, true) }, changed }
}
export async function uninstall(project: string, signal?: AbortSignal) {
  return transaction(project, async before => {
    const old = stateOf(before)
    if (!old) return undefined
    await checkOwned(before, old)
    return { files: before.filter(f => f.path !== stateName && !old.files.some(o => o.path === f.path)) }
  }, async () => {}, signal)
}

export async function offline(project: string, discover: Discover, signal?: AbortSignal) {
  const state = await installed(project)
  if (!state) throw new Error("NO_LAST_KNOWN_GOOD")
  await discovered(project, state, discover, signal)
  return { ...state, verification: state.compatibilityMode === "raw" ? "verified-bytes" as const : "runtime-ready" as const }
}

async function retryFs<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() } catch (error) {
      if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}
async function managedDirectoryAt(managedDir: string) {
  await mkdir(managedDir, { recursive: true })
  await safeDirectory(managedDir)
  const marker = path.join(managedDir, "owner")
  try { await writeFile(marker, "amekit-poc04\n", { flag: "wx" }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stat = await lstat(marker)
  if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(marker)).toLowerCase() !== marker.toLowerCase() || await readFile(marker, "utf8") !== "amekit-poc04\n") throw new Error("MANAGED_DIRECTORY_COLLISION")
}
function ownedParentDirs(relPaths: Iterable<string>) {
  const dirs = new Set<string>()
  for (const name of relPaths) {
    if (!/^(agents|skills)\//.test(name)) continue
    safePath(name)
    const parts = name.split("/")
    while (parts.length > 1) { parts.pop(); dirs.add(parts.join("/")) }
  }
  return dirs
}
async function removeEmptyDirectory(directory: string) {
  // fs.rm({ recursive: false }) rejects directories on Node, including empty ones.
  await retryFs(() => rmdir(directory))
}
async function pruneEmptyOwnedDirs(configDir: string, relPaths: Iterable<string>, preserve = new Set<string>()) {
  const dirs = [...ownedParentDirs(relPaths)].sort((a, b) => b.split("/").length - a.split("/").length)
  for (const dir of dirs) {
    if (preserve.has(dir)) continue
    const target = path.join(configDir, ...dir.split("/"))
    try { await safeDirectory(target); await removeEmptyDirectory(target) } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    }
  }
}
function isManagedRelativePath(relPath: string) { return relPath === stateName || /^(agents|skills)\//.test(relPath) }
async function managedFingerprint(files: InputFile[] & { directories?: string[] }) {
  return fingerprint(Object.assign(files.filter(file => isManagedRelativePath(file.path)), { directories: files.directories?.filter(isManagedRelativePath) ?? [] }))
}
type InPlaceNext = { ownedFiles: InputFile[]; state?: State }
async function transactionInPlace(configDir: string, managedDir: string, prepare: (before: Awaited<ReturnType<typeof tree>>) => Promise<InPlaceNext | undefined>, verify: () => Promise<void>, signal?: AbortSignal) {
  if (!path.isAbsolute(configDir) || !path.isAbsolute(managedDir)) throw new Error("ABSOLUTE_PROJECT_REQUIRED")
  const relativeManaged = path.relative(configDir, managedDir), relativeConfig = path.relative(managedDir, configDir)
  if (!relativeManaged || (!relativeManaged.startsWith(".." + path.sep) && relativeManaged !== ".." && !path.isAbsolute(relativeManaged)) || (!relativeConfig.startsWith(".." + path.sep) && relativeConfig !== ".." && !path.isAbsolute(relativeConfig))) throw new Error("MANAGED_DIRECTORY_COLLISION")
  await mkdir(configDir, { recursive: true }); await safeDirectory(configDir)
  await managedDirectoryAt(managedDir)
  const lock = path.join(managedDir, "lock"), backup = path.join(managedDir, "previous-" + randomUUID())
  await mkdir(lock)
  let journaled = false, settled = false, backupCreated = false
  let before: Awaited<ReturnType<typeof tree>> | undefined
  const backupEntries: InputFile[] = [], touched = new Set<string>()
  let nextOwned: InputFile[] = []
  try {
    if (await exists(path.join(managedDir, "transaction.json"))) throw new Error("RECOVERY_REQUIRED")
    signal?.throwIfAborted()
    before = await tree(configDir)
    const next = await prepare(before)
    if (!next) return false
    const old = stateOf(before), oldOwnedPaths = [...(old?.files.map(file => file.path) ?? []), ...(old ? [stateName] : [])]
    const oldPathSet = new Set(oldOwnedPaths)
    backupEntries.push(...before.filter(file => oldPathSet.has(file.path)))
    if (backupEntries.length) {
      await mkdir(backup); backupCreated = true
      for (const file of backupEntries) {
        const target = path.join(backup, ...file.path.split("/"))
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data, { flag: "wx" })
      }
    }
    nextOwned = next.ownedFiles
    const nextFiles = [...nextOwned, ...(next.state ? [{ path: stateName, data: new TextEncoder().encode(JSON.stringify(next.state)) }] : [])]
    const nextPathSet = new Set(nextFiles.map(file => file.path))
    const obsoleteDirs = ownedParentDirs(oldOwnedPaths)
    const preservedDirs = new Set(before.directories.filter(dir => !obsoleteDirs.has(dir)))
    const expectedFiles = [...before.filter(file => !oldPathSet.has(file.path)), ...nextFiles]
    const expectedDirs = new Set(preservedDirs)
    // Personal files and empty personal directories remain part of the expected tree.
    for (const name of [...expectedFiles.map(file => file.path), ...[...preservedDirs].map(dir => dir + "/entry")]) {
      const parts = name.split("/")
      while (parts.length > 1) { parts.pop(); expectedDirs.add(parts.join("/")) }
    }
    const expectedFingerprint = await managedFingerprint(Object.assign(expectedFiles, { directories: [...expectedDirs] }))
    if (await managedFingerprint(before) !== await managedFingerprint(await tree(configDir))) throw new Error("CONFIG_CHANGED_DURING_SYNC")
    signal?.throwIfAborted()
    await journal(managedDir, { schema: 1, mode: "in-place", backup: path.basename(backup) }); journaled = true
    for (const oldPath of oldOwnedPaths) {
      if (nextPathSet.has(oldPath)) continue
      signal?.throwIfAborted()
      touched.add(oldPath)
      await retryFs(() => rm(path.join(configDir, ...oldPath.split("/")), { force: true }))
    }
    for (const file of nextFiles) {
      signal?.throwIfAborted()
      const target = path.join(configDir, ...file.path.split("/"))
      await retryFs(() => mkdir(path.dirname(target), { recursive: true })); await safeDirectory(path.dirname(target))
      touched.add(file.path)
      await retryFs(() => writeFile(target, file.data))
    }
    await pruneEmptyOwnedDirs(configDir, [...oldOwnedPaths, ...nextOwned.map(file => file.path)], preservedDirs)
    await verify()
    signal?.throwIfAborted()
    const afterTree = await tree(configDir)
    if (next.state) await checkOwned(afterTree, next.state)
    if (await managedFingerprint(afterTree) !== expectedFingerprint) throw new Error("CONFIG_CHANGED_AFTER_ACTIVATION")
    settled = true
    return true
  } catch (error) {
    if (journaled && before) {
      const failures: unknown[] = []
      const restore = async (fn: () => Promise<unknown>) => { try { await fn() } catch (failure) { failures.push(failure) } }
      const backupPaths = new Set(backupEntries.map(file => file.path))
      for (const name of touched) if (!backupPaths.has(name)) await restore(() => retryFs(() => rm(path.join(configDir, ...name.split("/")), { force: true })))
      await restore(() => pruneEmptyOwnedDirs(configDir, nextOwned.map(file => file.path), new Set(before!.directories)))
      const affectedDirs = ownedParentDirs([...backupPaths, ...nextOwned.map(file => file.path)])
      for (const dir of before.directories) if (affectedDirs.has(dir)) await restore(() => retryFs(() => mkdir(path.join(configDir, ...dir.split("/")), { recursive: true })))
      for (const file of [...backupEntries.filter(file => file.path !== stateName), ...backupEntries.filter(file => file.path === stateName)]) await restore(async () => {
        const target = path.join(configDir, ...file.path.split("/"))
        await retryFs(() => mkdir(path.dirname(target), { recursive: true })); await safeDirectory(path.dirname(target))
        await retryFs(() => writeFile(target, file.data))
      })
      await restore(async () => {
        const restored = await tree(configDir)
        const restoredFiles = new Map(restored.map(file => [file.path, file]))
        for (const file of backupEntries) {
          const actual = restoredFiles.get(file.path)
          if (!actual || await sha256(actual.data) !== await sha256(file.data)) throw new Error("ROLLBACK_INCOMPLETE")
        }
        for (const name of touched) if (!backupPaths.has(name) && restoredFiles.has(name)) throw new Error("ROLLBACK_INCOMPLETE")
      })
      if (failures.length) throw new AggregateError([error, ...failures], "ROLLBACK_FAILED", { cause: error })
      settled = true
    }
    throw error
  } finally {
    // Failed restoration retains the journal, lock and backup for explicit recovery.
    if (settled || !journaled) {
      if (backupCreated) await retryFs(() => rm(backup, { recursive: true, force: true }))
      if (journaled) await retryFs(() => rm(path.join(managedDir, "transaction.json"), { force: true }))
      await retryFs(() => rm(lock, { recursive: true, force: true }))
    }
  }
}

export async function installedGlobal(configDir: string, managedDir: string) {
  if (!path.isAbsolute(configDir) || !path.isAbsolute(managedDir)) throw new Error("ABSOLUTE_PROJECT_REQUIRED")
  if (await exists(managedDir)) {
    await safeDirectory(managedDir)
    if (await exists(path.join(managedDir, "transaction.json")) || await exists(path.join(managedDir, "lock"))) throw new Error("RECOVERY_REQUIRED")
  }
  const files = await tree(configDir), state = stateOf(files)
  if (!state) return undefined
  await checkOwned(files, state)
  return { ...state, ...verification(state, files.filter(file => state.files.some(owned => owned.path === file.path))) }
}
export async function installGlobal(configDir: string, managedDir: string, origin: string, release: Release, bytes: Uint8Array, discover: Discover, signal?: AbortSignal, options: { allowRaw?: boolean } = {}) {
  const verified = await verifiedFiles(bytes, release.version, release.sha256)
  const compatibilityMode = verified.summary.compatibility.mode ?? "native"
  if (compatibilityMode === "raw" && options.allowRaw !== true) throw new Error("RAW_INSTALL_CONFIRMATION_REQUIRED")
  const content = preview(verified.files, [], { compatibilityMode })
  if (content.issues.some(issue => issue.severity === "error" || issue.severity === "excluded")) throw new Error("INSTALL_COMPATIBILITY_BLOCKED")
  let state: State
  const changed = await transactionInPlace(configDir, managedDir, async before => {
    const old = stateOf(before)
    if (old) { if (old.origin !== origin) throw new Error("SERVER_OWNERSHIP_MISMATCH"); await checkOwned(before, old) }
    if (old?.sha256 === release.sha256 && old.releaseId === release.releaseId) { state = old; await discovered(configDir, old, discover, signal, "global"); return undefined }
    const oldPaths = new Set(old?.files.map(file => file.path)), personal = before.filter(file => file.path !== stateName && !oldPaths.has(file.path))
    const catalog = compatibilityMode === "raw" ? { agents: [], skills: [] } : await discover(configDir, signal, undefined, { scope: "global" })
    for (const id of content.agents) if (!old?.agents.includes(id) && catalog.agents.some(agent => agent.id.toLowerCase() === id.toLowerCase())) throw new Error("PERSONAL_AGENT_COLLISION")
    for (const id of content.skills) if (!old?.skills.includes(id) && catalog.skills.some(skill => skill.name.toLowerCase() === id.toLowerCase())) throw new Error("PERSONAL_SKILL_COLLISION")
    for (const file of verified.files) {
      const key = file.path.toLowerCase()
      if (personal.some(personalFile => { const name = personalFile.path.toLowerCase(); return name === key || name.startsWith(key + "/") || key.startsWith(name + "/") })) throw new Error("PERSONAL_FILE_COLLISION")
      if (before.directories.some(dir => dir.toLowerCase() === key || dir.toLowerCase().startsWith(key + "/"))) throw new Error("PERSONAL_DIRECTORY_COLLISION")
    }
    state = { schema: 1, releaseId: release.releaseId, version: release.version, sha256: release.sha256, origin, files: await inventory(verified.files), agents: content.agents, skills: content.skills, ...(verified.summary.features ? { features: verified.summary.features } : {}), ...(compatibilityMode === "raw" ? { compatibilityMode } : {}) }
    return { ownedFiles: verified.files, state }
  }, () => discovered(configDir, state!, discover, signal, "global"), signal)
  return { state: { ...state!, ...verification(state!, verified.files, true) }, changed }
}
export async function uninstallGlobal(configDir: string, managedDir: string, signal?: AbortSignal) {
  return transactionInPlace(configDir, managedDir, async before => {
    const old = stateOf(before)
    if (!old) return undefined
    await checkOwned(before, old)
    return { ownedFiles: [] }
  }, async () => {}, signal)
}
export async function offlineGlobal(configDir: string, managedDir: string, discover: Discover, signal?: AbortSignal) {
  const state = await installedGlobal(configDir, managedDir)
  if (!state) throw new Error("NO_LAST_KNOWN_GOOD")
  await discovered(configDir, state, discover, signal, "global")
  return { ...state, verification: state.compatibilityMode === "raw" ? "verified-bytes" as const : "runtime-ready" as const }
}
export async function readGlobalCommitEnhanceSkill(configDir: string, managedDir: string): Promise<{ name: string; instructions: string } | null> {
  const state = await installedGlobal(configDir, managedDir)
  const skill = await readVerifiedFeatureSkill(configDir, state?.features?.commitEnhanceSkill, state, 16_000, "global")
  return skill ? { name: skill.name, instructions: skill.instructions } : null
}
export async function readGlobalBundleFeatures(configDir: string, managedDir: string): Promise<BundleFeatures | undefined> {
  return (await installedGlobal(configDir, managedDir))?.features
}
export async function readGlobalAndroidTranslationFeature(configDir: string, managedDir: string): Promise<{ skill: { name: string; instructions: string; directory: string } | null; model?: string; rawSkillName?: string }> {
  const state = await installedGlobal(configDir, managedDir), features = state?.features
  const skill = await readVerifiedFeatureSkill(configDir, features?.androidTranslationSkill, state, 32_000, "global")
  return { skill, ...(features?.androidTranslationModel ? { model: features.androidTranslationModel } : {}), ...(features?.androidTranslationSkill ? { rawSkillName: features.androidTranslationSkill } : {}) }
}

export async function readGlobalBuildNotesFeature(configDir: string, managedDir: string): Promise<{ skill: { name: string; instructions: string } | null; model?: string; rawSkillName?: string }> {
  const state = await installedGlobal(configDir, managedDir), features = state?.features
  const skill = await readVerifiedFeatureSkill(configDir, features?.buildNotesSkill, state, 16_000, "global")
  return { skill: skill ? { name: skill.name, instructions: skill.instructions } : null, ...(features?.buildNotesModel ? { model: features.buildNotesModel } : {}), ...(features?.buildNotesSkill ? { rawSkillName: features.buildNotesSkill } : {}) }
}

export type LegacyProjectBundle = { version?: string; releaseId?: string; fileCount: number; hasConfigDir: boolean; hasManagedDir: boolean; modified?: boolean; error?: string }
async function hasManagedOwner(managedDir: string) {
  await safeDirectory(managedDir)
  const marker = path.join(managedDir, "owner"), stat = await lstat(marker)
  return stat.isFile() && !stat.isSymbolicLink() && (await realpath(marker)).toLowerCase() === marker.toLowerCase() && await readFile(marker, "utf8") === "amekit-poc04\n"
}
export async function legacyProjectInstalled(project: string): Promise<LegacyProjectBundle | null> {
  await safeDirectory(project)
  const configDir = path.join(project, ".opencode"), managedDir = path.join(project, ".amekit")
  const hasState = await exists(path.join(configDir, stateName))
  const hasManagedDir = await exists(path.join(managedDir, "owner")) && await hasManagedOwner(managedDir).catch(() => false)
  if (!hasState && !hasManagedDir) return null
  let state: State | undefined
  try {
    if (hasState) {
      const files = await tree(configDir)
      state = stateOf(files)
      if (!state) throw new Error("INVALID_OWNERSHIP_STATE")
      await checkOwned(files, state)
    }
    if (await exists(managedDir)) {
      await safeDirectory(managedDir)
      if (await exists(path.join(managedDir, "transaction.json")) || await exists(path.join(managedDir, "lock"))) throw new Error("RECOVERY_REQUIRED")
    }
    return { ...(state ? { version: state.version, releaseId: state.releaseId } : {}), fileCount: state?.files.length ?? 0, hasConfigDir: hasState, hasManagedDir }
  } catch (error) {
    return { ...(state ? { version: state.version, releaseId: state.releaseId } : {}), fileCount: state?.files.length ?? 0, hasConfigDir: hasState, hasManagedDir, modified: true, error: error instanceof Error ? error.message : "LEGACY_INSPECTION_FAILED" }
  }
}
async function validateLegacyManaged(managedDir: string) {
  if (!await hasManagedOwner(managedDir)) throw new Error("MANAGED_DIRECTORY_COLLISION")
  if (await exists(path.join(managedDir, "transaction.json")) || await exists(path.join(managedDir, "lock"))) throw new Error("RECOVERY_REQUIRED")
  if ((await readdir(managedDir)).some(name => name !== "owner" && !/^(previous|stage)-[0-9a-f-]+$/.test(name))) throw new Error("MANAGED_DIRECTORY_COLLISION")
  // Reject reparse points in old backups before recursively deleting the managed tree.
  await tree(managedDir)
}
export async function cleanLegacyProject(project: string, signal?: AbortSignal): Promise<{ removedFiles: number; removedOpencodeDir: boolean; removedManagedDir: boolean }> {
  await safeDirectory(project)
  const configDir = path.join(project, ".opencode"), managedDir = path.join(project, ".amekit")
  let removedFiles = 0, removedOpencodeDir = false, removedManagedDir = false
  if (await exists(managedDir)) await validateLegacyManaged(managedDir)
  if (await exists(path.join(configDir, stateName))) {
    const before = await tree(configDir), old = stateOf(before)
    signal?.throwIfAborted()
    await transactionInPlace(configDir, managedDir, async before => {
      const oldState = stateOf(before)
      if (!oldState) return undefined
      await checkOwned(before, oldState)
      return { ownedFiles: [] }
    }, async () => {}, signal)
    if (old) removedFiles = old.files.length + 1
    const ownedDirs = ownedParentDirs(old?.files.map(file => file.path) ?? [])
    await pruneEmptyOwnedDirs(configDir, old?.files.map(file => file.path) ?? [], new Set(before.directories.filter(dir => !ownedDirs.has(dir))))
    if (await exists(configDir) && (await readdir(configDir)).length === 0) { await removeEmptyDirectory(configDir); removedOpencodeDir = true }
  }
  signal?.throwIfAborted()
  if (await exists(managedDir)) {
    await validateLegacyManaged(managedDir)
    await retryFs(() => rm(managedDir, { recursive: true, force: true })); removedManagedDir = true
  }
  return { removedFiles, removedOpencodeDir, removedManagedDir }
}
