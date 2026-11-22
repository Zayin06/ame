// Adapted from opencode-amekit/src/installer.ts; see ../docs/amekit.md for provenance.
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { Release } from "./api"
import { sha256 } from "./bundle/manifest"
import { MAX_PAYLOAD_FILES } from "./bundle/limits"
import { preview, safePath, verifiedFiles, type InputFile } from "./bundle/package"
import type { Discover } from "./runtime"

type State = { schema: 1; releaseId: string; version: string; sha256: string; origin: string; files: { path: string; sha256: string }[]; agents: string[]; skills: string[]; compatibilityMode?: "native" | "raw" }
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
      if (++count > 4096) throw new Error("PERSONAL_CONFIG_TOO_LARGE")
      const target = path.join(directory, entry.name), name = prefix + entry.name
      const stat = await lstat(target)
      if (stat.isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("REPARSE_CONFIG_REJECTED")
      if (stat.isDirectory()) { files.directories.push(name); await walk(target, name + "/") }
      else {
        if (!stat.isFile() || stat.size > 8*1024*1024 || (size += stat.size) > 64*1024*1024) throw new Error("PERSONAL_CONFIG_TOO_LARGE")
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
async function discovered(project: string, state: State, discover: Discover, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (state.compatibilityMode === "raw") return
  const catalog = await discover(project, signal, state)
  if (!state.agents.every(id => catalog.agents.some(a => a.id === id)) || !state.skills.every(id => catalog.skills.some(s => s.name === id && path.resolve(s.path).toLowerCase() === path.join(project, ".opencode", "skills", id, "SKILL.md").toLowerCase()))) throw new Error("DISCOVERY_MISMATCH")
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
    if (await exists(config)) { await rename(config, backup); moved = true }
    await rename(stage, config); activated = true
    await verify()
    if (next.state) await checkOwned(await tree(config), next.state)
    if (await fingerprint(await tree(config)) !== stagedFingerprint) throw new Error("CONFIG_CHANGED_AFTER_ACTIVATION")
    settled = true
    return true
  } catch (error) {
    if (activated) {
      retainStage = true
      await rename(config, stage)
    }
    if (moved) await rename(backup, config)
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
    state = { schema: 1, releaseId: release.releaseId, version: release.version, sha256: release.sha256, origin, files: await inventory(verified.files), agents: content.agents, skills: content.skills, ...(compatibilityMode === "raw" ? { compatibilityMode } : {}) }
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
