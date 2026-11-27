import path from "node:path"
import { lstat, open, realpath, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { AmeApi, ClientError, isTransientError } from "./api"
import { assertModel, assertChatModel, resolveModelLevel, managedProvider, modelPolicy, providerURL } from "./model-policy"
import { openSessionVault, type Encryption } from "./session-vault"
import { bundlePreferences, type BundleAccount } from "./bundle-preferences"
import { dailySyncStore } from "./daily-sync"
import { pack, preview, safePath, verifiedFiles, type ImportOptions, type InputFile, type Issue, type Preview } from "./bundle/package"
import { scanWithSource } from "./bundle/scan"
import { AiFixError, fixImportFileWithLlm, isFixableTextFile } from "./bundle/ai-fix"
import * as installer from "./installer"
import { runtimeDiscovery, type Discover } from "./runtime"
import type { OrchestratorConfig } from "./orchestrator"
import { readUsagePrices, type UsagePrices } from "./usage-pricing"
import { generatePetDialogue as generateDialogue } from "./pet-generation"
import type { DialogueSet } from "./pet-dialogue"
export type { BundleFeatures } from "./api"
export { detectAndroidProject, buildAndroidTranslationPrompt, createTranslationLockStore, canonicalWorkspaceScope } from "./android-translation"

export type AmeKitBundleEvent = { version: string; releaseId: string; auto: boolean; action: "synced" | "uninstalled" }
export type AmeKitOptions = {
  userData: string
  endpoint: () => { url: string; headers: Record<string, string> } | undefined
  project: (id: string) => Promise<string>
  pickImport: () => Promise<string | null>
  cli?: string
  globalConfigDir?: string
  autoSync?: boolean
  reloadRuntime?: () => Promise<void>
  onBundleChanged?: (event: AmeKitBundleEvent) => void
}
export type AmeKit = {
  call(operation: string, payload: Record<string, string>): Promise<unknown>
  /** Main-process only; reads cached account/model snapshot without taking the account mutex. */
  readStatus?(): Promise<unknown>
  /** Main-only; only a successfully synchronized, unexpired policy can select the root agent. */
  readOrchestrator?(): Promise<OrchestratorConfig | undefined>
  /** Main-process only; reads cached usage pricing map without taking the account mutex. */
  readUsagePrices?(): Promise<{ origin: string | null; prices: UsagePrices }>
  /** Main-process only; reads verified installed instructions without taking the account mutex. */
  readCommitEnhanceSkill?(projectID?: string): Promise<{ name: string; instructions: string } | null>
  /** Main-process only; reads verified feature configuration independently of account locking. */
  readCommitEnhanceFeature?(projectID?: string): Promise<{ skill: { name: string; instructions: string } | null; model?: string }>
  readBuildNotesFeature?(projectID?: string): Promise<{ skill: { name: string; instructions: string } | null; model?: string; rawSkillName?: string }>
  readAndroidTranslationFeature?(projectID?: string): Promise<{ skill: { name: string; instructions: string; directory: string } | null; model?: string; rawSkillName?: string }>
  /** Main-process only; enables an active concrete model for an explicit feature, never regular Chat or Pet. */
  authorizeFeatureModel?(modelID: string): Promise<string | null>
  /** Main-process only; retain categorized dialogue for createPetHost. */
  generatePetDialogue(model: string, signal: AbortSignal): Promise<DialogueSet>
  dispose(): Promise<void>
}
type ImportSession = {
  root: string
  folderName: string
  options: ImportOptions
  adaptClaudeAgents: boolean
  originalInheritedIssues: Issue[]
  inheritedIssues: Issue[]
  originalFiles: Map<string, Uint8Array>
  workingFiles: Map<string, Uint8Array>
  savedToDisk: Set<string>
  aiFixedPaths: Set<string>
  reviewedAiFixes: Set<string>
}
type ElectronMain = { safeStorage: Encryption; dialog: Pick<typeof import("electron")["dialog"], "showMessageBox"> }
const MAX_POLICY_LEASE_MS = 24 * 60 * 60_000
const LEASE_RENEW_LEAD_MS = 15 * 60_000
const LEASE_RETRY_MS = 5 * 60_000
const DEFAULT_RPC_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2000] as const
/** Main-process test seams; never accept these dependencies over renderer IPC. */
export type AmeKitDependencies = { fetch?: typeof fetch; electron?: () => Promise<ElectronMain>; discover?: Discover; refreshIntervalMs?: number; now?: () => number; rpcRetryDelaysMs?: readonly number[] }

export function createAmeKit(options: AmeKitOptions, dependencies: AmeKitDependencies = {}): AmeKit {
  const globalConfigDir = options.globalConfigDir ?? path.join(options.userData, "backend", "config", "opencode")
  const globalManagedDir = path.join(options.userData, "amekit", "global")
  const preferences = bundlePreferences(options.userData)
  const dailySync = dailySyncStore(options.userData)
  const now = dependencies.now ?? Date.now
  let lastBundleAccount: BundleAccount | undefined
  const bundleAccount = (): BundleAccount | undefined => api?.account ? { origin: api.origin, accountId: api.account.id } : lastBundleAccount
  const fetcher = dependencies.fetch ?? fetch
  const electron = dependencies.electron ?? (() => import("electron"))
  const lifetime = new AbortController()
  const signal = lifetime.signal
  let api: AmeApi | undefined, source: Preview | undefined, packed: Awaited<ReturnType<typeof pack>> | undefined
  let vault: Awaited<ReturnType<typeof openSessionVault>> | undefined
  let storageError: string | undefined, blocker: string | undefined, policyReady = false, disposed = false, busy = false
  let inFlight: Promise<unknown> | undefined, backgroundInFlight: Promise<void> | undefined, disposal: Promise<void> | undefined
  let localBundleWriteInFlight: Promise<unknown> | undefined, autoSyncInFlight: Promise<void> | undefined
  let lastAutoSyncError: string | undefined, lastAutoSyncFailedReleaseId: string | undefined
  let refreshedAt: number | undefined
  let bundleSnapshot: { installedVersion?: string; installedReleaseId?: string; installedFeatures?: import("./api").BundleFeatures; latestVersion?: string; latestReleaseId?: string; checkedAt?: number } | undefined
  const snapshotInstalledBundle = async () => {
    const state = await installer.installedGlobal(globalConfigDir, globalManagedDir).catch(() => undefined)
    if (state || bundleSnapshot) bundleSnapshot = { ...bundleSnapshot, installedVersion: state?.version, installedReleaseId: state?.releaseId, installedFeatures: state?.features }
  }
  const readManagedCatalog = async () => {
    const state = await installer.installedGlobal(globalConfigDir, globalManagedDir).catch(() => undefined)
    return { agents: state ? [...state.agents] : [], skills: state ? [...state.skills] : [] }
  }
  const checkLatestBundle = async (accountApi: AmeApi) => {
    bundleSnapshot = { ...bundleSnapshot, checkedAt: Date.now() }
    try {
      const latest = await accountApi.latest(signal)
      bundleSnapshot = { ...bundleSnapshot, latestVersion: latest.release.version, latestReleaseId: latest.release.releaseId }
      return latest
    } catch (error) {
      if (error instanceof ClientError && error.code === "NO_ACTIVE_RELEASE") bundleSnapshot = { ...bundleSnapshot, latestVersion: undefined, latestReleaseId: undefined }
      throw error
    }
  }
  const trackLocalWrite = async <T>(write: () => Promise<T>): Promise<T> => {
    while (localBundleWriteInFlight) await localBundleWriteInFlight.catch(() => {})
    const task = write()
    localBundleWriteInFlight = task
    try { return await task } finally { if (localBundleWriteInFlight === task) localBundleWriteInFlight = undefined }
  }
  const clearAutoSyncError = () => { lastAutoSyncError = undefined; lastAutoSyncFailedReleaseId = undefined }
  let transientFailures = 0
  const authorizedFeatureModels = new Set<string>()
  const code = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "AMEKIT_OPERATION_FAILED"
  type CachedServerArchive = {
    origin: string
    releaseId: string
    sha256: string
    compatibilityMode: "native" | "raw"
    files: InputFile[]
    agents: string[]
    skills: string[]
  }
  let activeArchiveCache: CachedServerArchive | undefined
  let importSession: ImportSession | undefined
  const aiFixWarning = () => {
    if (!importSession?.aiFixedPaths.size) return ""
    const paths = [...importSession.aiFixedPaths].sort().map(file => `${file} [${importSession!.reviewedAiFixes.has(file) ? "đã duyệt" : "CHƯA DUYỆT"}]${file.startsWith("agents/") ? " [agent: kiểm tra quyền và prompt]" : ""}`)
    return "\n\nCảnh báo: AI Auto-Fix đã chỉnh sửa các tệp sau (kiểm tra kỹ quyền và prompt trước khi phát hành): " + paths.join(", ")
  }
  const resetImport = () => { source = undefined; packed = undefined; importSession = undefined; activeArchiveCache = undefined }
  const loadActiveServerArchive = async (needFiles: boolean) => {
    const latest = await api!.latest(signal)
    if (!needFiles) {
      const installed = await installer.installedGlobal(globalConfigDir, globalManagedDir).catch(() => undefined)
      if (installed && installed.origin === api!.origin && installed.releaseId === latest.release.releaseId && installed.sha256 === latest.release.sha256) {
        return { latest, skills: [...installed.skills].sort(), agents: [...installed.agents].sort(), compatibilityMode: (installed.compatibilityMode === "raw" ? "raw" : "native") as "native" | "raw", files: undefined }
      }
    }
    if (activeArchiveCache && activeArchiveCache.origin === api!.origin && activeArchiveCache.releaseId === latest.release.releaseId && activeArchiveCache.sha256 === latest.release.sha256) {
      return { latest, ...activeArchiveCache }
    }
    const bytes = await api!.download(latest.release, signal)
    const { summary, files } = await verifiedFiles(bytes, latest.release.version, latest.release.sha256)
    const paths = files.map(file => file.path)
    const agents = paths.flatMap(filePath => /^agents\/(.+)\.md$/.exec(filePath)?.[1] ?? []).sort()
    const skills = paths.flatMap(filePath => /^skills\/([^/]+)\/SKILL\.md$/.exec(filePath)?.[1] ?? []).sort()
    const compatibilityMode = summary.compatibility.mode === "raw" ? "raw" : "native"
    activeArchiveCache = { origin: api!.origin, releaseId: latest.release.releaseId, sha256: latest.release.sha256, compatibilityMode, files: files.map(file => ({ path: file.path, data: file.data.slice() })), agents, skills }
    return { latest, ...activeArchiveCache }
  }
  const importFiles = (session: ImportSession, replacement?: InputFile): InputFile[] => [...session.workingFiles]
    .map(([filePath, data]) => ({ path: filePath, data: (replacement?.path === filePath ? replacement.data : data).slice() }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const importView = () => {
    if (!source || !importSession) throw new Error("IMPORT_REQUIRED")
    const session = importSession
    const fixablePaths = [...new Set(source.issues.filter(issue => issue.severity === "error" && issue.path && session.workingFiles.has(issue.path) && isFixableTextFile(issue.path, session.workingFiles.get(issue.path)!)).map(issue => issue.path))].sort()
    return { folderName: session.folderName, issues: source.issues, agents: source.agents, skills: source.skills, compatibilityMode: source.compatibilityMode ?? "native", adaptClaudeAgents: session.adaptClaudeAgents, files: source.files.map(file => ({ path: file.path, size: file.data.length })), fixablePaths }
  }
  const recomputeImportPreview = () => {
    if (!importSession) throw new Error("IMPORT_REQUIRED")
    source = preview(importFiles(importSession), importSession.inheritedIssues, importSession.options)
    packed = undefined
    return importView()
  }
  const fixImportFile = async (targetPath: string) => {
    if (!importSession || !source) throw new Error("IMPORT_REQUIRED")
    const session = importSession, fileBytes = session.workingFiles.get(targetPath)
    if (!fileBytes) throw new Error("IMPORT_FILE_NOT_FOUND")
    const fixed = await fixImportFileWithLlm({
      api, filePath: targetPath, fileBytes,
      issues: source.issues.filter(issue => issue.path === targetPath),
      compatibilityMode: session.options.compatibilityMode ?? "native", adaptClaudeAgents: session.adaptClaudeAgents,
      availablePaths: [...session.workingFiles.keys()], signal, fetcher,
      validateCandidate: candidateBytes => {
        const candidate = preview(importFiles(session, { path: targetPath, data: candidateBytes }), session.inheritedIssues, session.options)
        return { preview: candidate, remainingErrors: candidate.issues.filter(issue => issue.severity === "error" && (issue.path === targetPath || !source!.issues.some(existing => existing.severity === "error" && existing.path === issue.path && existing.reason === issue.reason))) }
      },
    })
    session.workingFiles.set(targetPath, fixed.contentBytes.slice())
    session.aiFixedPaths.add(targetPath)
    session.reviewedAiFixes.delete(targetPath)
    session.savedToDisk.delete(targetPath)
    const currentPreview = recomputeImportPreview()
    return { preview: currentPreview, fix: { path: targetPath, summary: fixed.summary, diff: fixed.diff, model: fixed.model, redactionCount: fixed.redactionCount, securityChanges: fixed.securityChanges } }
  }
  const rpc = async (input: unknown, cleanup = false) => {
    const endpoint = options.endpoint()
    if (!endpoint) throw new Error("MODEL_POLICY_PLUGIN_REQUIRED")
    let url: URL
    try {
      url = new URL(endpoint.url)
      if (url.username || url.password || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) throw new Error()
    } catch { throw new Error("LOCAL_SERVER_REQUIRED") }
    const retryDelays = dependencies.rpcRetryDelaysMs ?? DEFAULT_RPC_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
      let response: Response
    try {
      response = await fetcher(new URL("/api/rpc/amekit-models/update", url), {
        method: "POST", headers: { ...endpoint.headers, "content-type": "application/json" },
        body: JSON.stringify({ input }), redirect: "error",
        signal: cleanup ? AbortSignal.timeout(1500) : AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
    } catch { throw new Error("MODEL_POLICY_UNAVAILABLE") }
      if ([400, 404, 503].includes(response.status)) {
        await response.body?.cancel()
        if (!cleanup && input !== null && attempt < retryDelays.length) {
          try { await delay(retryDelays[attempt], undefined, { signal }) }
          catch { throw new Error("MODEL_POLICY_UNAVAILABLE") }
          continue
        }
        throw new Error("MODEL_POLICY_PLUGIN_REQUIRED")
      }
    if (!response.ok) { await response.body?.cancel(); throw new Error("MODEL_POLICY_UNAVAILABLE") }
    const result = await response.json().catch(() => null) as { output?: unknown } | null
      if (result?.output !== true) throw new Error("MODEL_POLICY_UNAVAILABLE")
      return
    }
  }
  let leaseTimer: ReturnType<typeof setTimeout> | undefined
  const clearLeaseTimer = () => { if (leaseTimer) { clearTimeout(leaseTimer); leaseTimer = undefined } }
  const scheduleLeaseRenewal = (delayOverrideMs?: number) => {
    clearLeaseTimer()
    if (timer || disposed || !api?.account || !policyReady) return
    const currentNow = now()
    const leaseExpiresAt = Math.min(api.expires, currentNow + MAX_POLICY_LEASE_MS)
    const remaining = leaseExpiresAt - currentNow
    if (remaining <= 0) return
    const lead = Math.min(LEASE_RENEW_LEAD_MS, Math.floor(remaining / 4))
    const defaultDelay = Math.max(1_000, remaining - lead)
    const maxRetryDelay = Math.max(1_000, Math.floor(remaining / 2))
    const delay = delayOverrideMs !== undefined ? Math.max(1_000, Math.min(delayOverrideMs, maxRetryDelay)) : defaultDelay
    leaseTimer = setTimeout(() => { leaseTimer = undefined; backgroundRefresh("lease") }, delay)
    leaseTimer.unref?.()
  }
  const revoke = async (cleanup = false) => { clearLeaseTimer(); policyReady = false; if (!api?.credential) authorizedFeatureModels.clear(); await rpc(null, cleanup).catch(() => {}) }
  const persist = async () => {
    try { if (!api?.credential) authorizedFeatureModels.clear(); if (!vault) throw new Error(); await vault.save(api?.credential) }
    catch { storageError = "SESSION_STORAGE_UNAVAILABLE"; api?.suspend(); resetImport(); await revoke(); throw new Error(storageError) }
  }
  const synchronize = async () => {
    policyReady = false
    try {
      if (!api?.account) { await rpc(null); return }
      modelPolicy(api.account.role, api.provider?.catalog, { featureModels: [...authorizedFeatureModels] })
      providerURL(api.provider!.provider.base_url)
      if (api.expires <= now()) throw new Error("AMECODE_LOGIN_REQUIRED")
      await persist()
      const managedCatalog = await readManagedCatalog()
      await rpc({ role: api.account.role, catalog: api.provider!.catalog, provider: api.provider!.provider, expires: api.expires, featureModels: [...authorizedFeatureModels], managedCatalog, ...(api.orchestrator ? { orchestrator: api.orchestrator } : {}) })
      lastBundleAccount = { origin: api.origin, accountId: api.account.id }
      policyReady = true; blocker = undefined; transientFailures = 0
      await snapshotInstalledBundle()
      scheduleLeaseRenewal()
    } catch (error) {
      blocker = code(error); api?.suspend(); resetImport(); await revoke()
      throw error
    }
  }
  const reloadAndRestorePolicy = async () => {
    if (!options.reloadRuntime) return
    await options.reloadRuntime().catch(() => {})
    // Reload clears plugin memory; use current account state, never a pre-reload auth snapshot.
    if (!disposed && api?.account) await synchronize()
  }
  const bundleWarning = () => lastAutoSyncError ? { bundleAutoSyncError: lastAutoSyncError } : {}
  const view = () => {
    if (api?.account && api.expires <= Date.now()) { api.suspend(); resetImport(); policyReady = false; blocker = "AMECODE_LOGIN_REQUIRED" }
    if (api?.account) {
      const models = modelPolicy(api.account.role, api.provider?.catalog, { featureModels: [...authorizedFeatureModels] })
      return { origin: api.origin, account: { ...api.account }, models: { ...models, small_model: models.small_model }, refreshedAt, ...(api.orchestrator ? { orchestrator: { id: api.orchestrator.id, version: api.orchestrator.version } } : {}), ...(bundleSnapshot ? { bundle: { ...bundleSnapshot, autoSyncError: lastAutoSyncError } } : {}), ready: policyReady, ...bundleWarning(), ...(blocker ? { blocker } : {}) }
    }
    return api?.credential ? { origin: api.origin, reconnecting: true, ready: false, ...bundleWarning(), blocker: storageError ?? blocker ?? "ACCOUNT_REFRESH_REQUIRED" } : null
  }
  const ready = (async () => {
    try {
      vault = await openSessionVault(options.userData, (await electron()).safeStorage)
      const credential = await vault.load()
      if (credential && !disposed) {
        api = new AmeApi(credential.origin, fetcher)
        await api.resume(credential.token, signal)
        await synchronize()
        refreshedAt = Date.now()
        scheduleAutoSync("ready")
      } else if (!disposed) await rpc(null)
    } catch (error) {
      blocker = code(error)
      if (!vault || ["SESSION_STORAGE_UNAVAILABLE", "INVALID_SESSION_STORAGE", "INVALID_SESSION"].includes(blocker)) storageError = "SESSION_STORAGE_UNAVAILABLE"
      api?.suspend(); await revoke()
      if (!storageError && api) await persist().catch(() => {})
    }
  })()
  const confirm = async (message: string, detail: string) => {
    signal.throwIfAborted()
    const result = await (await electron()).dialog.showMessageBox({ type: "warning", title: "AmeKit", message, detail, buttons: ["Cancel", "Continue"], defaultId: 0, cancelId: 0, noLink: true })
    signal.throwIfAborted()
    if (result.response !== 1) throw new Error("CANCELLED")
  }
  const project = async (id: string) => {
    if (!id) throw new Error("PROJECT_REQUIRED")
    const directory = await options.project(id)
    await installer.safeDirectory(directory)
    return directory
  }
  const discover = dependencies.discover ?? runtimeDiscovery(options.cli, path.join(options.userData, "amekit-runtime"))
  const installView = (state: NonNullable<Awaited<ReturnType<typeof installer.installed>>>) => ({
    version: state.version,
    releaseId: state.releaseId,
    compatibilityMode: state.compatibilityMode,
    verification: state.verification,
    compatibilityWarnings: state.compatibilityWarnings,
    agents: state.agents,
    skills: state.skills,
    fileCount: state.files.length,
    ...(state.features ? { features: state.features } : {}),
  })
  const execute = async (operation: string, payload: Record<string, string>): Promise<unknown> => {
    await ready
    if (disposed) throw new Error("AMEKIT_DISPOSED")
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.values(payload).some(value => typeof value !== "string")) throw new Error("INVALID_PAYLOAD")
    if (operation === "status") return { ...viewOrEmpty(), ...(storageError ? { ready: false, blocker: storageError } : {}) }
    if (operation === "usage-prices") return { origin: api?.account ? api.origin : null, prices: readUsagePrices(api?.provider?.catalog) }
    if (operation === "logout") {
      clearLeaseTimer()
      refreshedAt = undefined; bundleSnapshot = undefined
      activeArchiveCache = undefined
      clearAutoSyncError()
      authorizedFeatureModels.clear()
      api?.suspend(); resetImport(); await revoke()
      try { if (!vault) throw new Error(); await vault.save(undefined); storageError = undefined }
      catch { api?.clear(); api = undefined; storageError = "SESSION_STORAGE_UNAVAILABLE"; throw new Error(storageError) }
      try { await api?.logout(AbortSignal.any([signal, AbortSignal.timeout(3000)])) }
      catch { /* Local credentials and model access have already been removed. */ }
      finally { api?.clear(); api = undefined; blocker = undefined }
      return null
    }
    if (operation === "legacy-installed" || operation === "clean-legacy") {
      const directory = await project(payload.project)
      if (operation === "legacy-installed") {
        const legacy = await installer.legacyProjectInstalled(directory)
        return legacy ? { ...legacy, projectName: path.basename(directory) } : null
      }
      await confirm("Dọn bundle AmeKit cũ khỏi dự án?", `Xóa các tệp agent và skill do AmeKit cài trước đây trong ${path.join(directory, ".opencode")} và ${path.join(directory, ".amekit")}. Các tệp cá nhân và tệp của dự án được giữ nguyên.`)
      return installer.cleanLegacyProject(directory, signal)
    }
    if (operation === "recover") {
      const directory = payload.project ? await project(payload.project) : undefined
      await confirm("Khôi phục trạng thái AmeKit?", "Khôi phục bản sao lưu giao dịch bị gián đoạn và dọn dữ liệu giao dịch cũ.")
      await trackLocalWrite(() => installer.recoverManagedState(directory ? path.join(directory, ".opencode") : globalConfigDir, directory ? path.join(directory, ".amekit") : globalManagedDir))
      await snapshotInstalledBundle()
      await reloadAndRestorePolicy()
      return { recovered: true }
    }
    if (["installed", "offline", "uninstall"].includes(operation)) {
      if (operation === "installed") { const state = await installer.installedGlobal(globalConfigDir, globalManagedDir); return state ? installView(state) : null }
      if (operation === "offline") { const state = await installer.offlineGlobal(globalConfigDir, globalManagedDir, discover, signal); return { ...installView(state), changed: false } }
      await confirm("Gỡ AmeKit bundle khỏi ứng dụng?", "Xóa các tệp agent và skill do AmeKit cài đặt trong cấu hình toàn cục của ứng dụng và tắt tự đồng bộ bundle cho tài khoản/máy chủ này. Đồng bộ thủ công để bật lại. Tệp cá nhân và cấu hình dự án được giữ nguyên.")
      const changed = await trackLocalWrite(async () => {
        const account = bundleAccount()
        const current = await installer.installedGlobal(globalConfigDir, globalManagedDir)
        // Persist before removal so a restart or a queued heartbeat cannot undo it.
        if (account) await preferences.disable(account, current?.releaseId)
        return installer.uninstallGlobal(globalConfigDir, globalManagedDir, signal)
      })
      clearAutoSyncError()
      await snapshotInstalledBundle()
      if (changed) {
        await reloadAndRestorePolicy()
        options.onBundleChanged?.({ version: "", releaseId: "", auto: false, action: "uninstalled" })
      }
      return { changed }
    }
    if (storageError) throw new Error(storageError)
    if (operation === "login") {
      refreshedAt = undefined; bundleSnapshot = undefined; clearAutoSyncError()
      authorizedFeatureModels.clear()
      api?.clear(); resetImport(); await persist(); await rpc(null)
      api = new AmeApi(payload.server || undefined, fetcher)
      await api.login(payload.username, payload.password, signal)
      await synchronize()
      refreshedAt = Date.now()
      scheduleAutoSync("login")
      return view()
    }
    if (!api) throw new Error("SIGNED_OUT")
    switch (operation) {
      case "refresh": {
        await api.refresh(signal); await synchronize()
        refreshedAt = Date.now()
        await synchronizeBundle("refresh")
        await snapshotInstalledBundle()
        return view()
      }
      case "assert-ready":
      case "assert-model": {
        await api.refresh(signal); await synchronize()
        const modelID = payload.modelID || modelPolicy(api.account?.role, api.provider?.catalog).default_model
        const providerID = payload.providerID || managedProvider
        assertChatModel(modelPolicy(api.account?.role, api.provider?.catalog), { providerID, id: modelID })
        return { providerID, modelID }
      }
      case "latest": return checkLatestBundle(api)
      case "active-features": {
        await api.guard(true, signal)
        const active = await loadActiveServerArchive(false)
        return { release: active.latest.release, revision: active.latest.revision, skills: active.skills, features: active.latest.release.manifest.features ?? {} }
      }
      case "update-features": {
        await api.guard(true, signal); await synchronize()
        if (payload.activate !== undefined && !["true", "false"].includes(payload.activate)) throw new Error("INVALID_PAYLOAD")
        const activateNow = payload.activate === "true"
        const active = await loadActiveServerArchive(true)
        const features = Object.fromEntries(["commitEnhanceSkill", "commitEnhanceModel", "androidTranslationSkill", "androidTranslationModel", "buildNotesSkill", "buildNotesModel"]
          .filter(key => typeof payload[key] === "string" && payload[key].trim())
          .map(key => [key, payload[key].trim()]))
        const serverSource: Preview = { files: active.files!.map(file => ({ path: file.path, data: file.data.slice() })), issues: [], agents: active.agents, skills: active.skills, compatibilityMode: active.compatibilityMode }
        const nextPacked = await pack(serverSource, payload.version, signal, features)
        if (activateNow) {
          await confirm("Cập nhật cấu hình Skill & Model?", `Đóng gói v${nextPacked.summary.version} từ bản máy chủ v${active.latest.release.version} (giữ nguyên ${nextPacked.summary.agents} agents & ${nextPacked.summary.skills} skills), xuất bản và kích hoạt ngay cho toàn bộ team.`)
        } else {
          await confirm("Xuất bản nháp cấu hình Skill & Model?", `Đóng gói v${nextPacked.summary.version} từ bản máy chủ v${active.latest.release.version} (giữ nguyên ${nextPacked.summary.agents} agents & ${nextPacked.summary.skills} skills) chưa kích hoạt.`)
        }
        const release = await api.publish(nextPacked.bytes, nextPacked.summary.version, nextPacked.sha256, () => {}, signal)
        activeArchiveCache = { origin: api.origin, releaseId: release.releaseId, sha256: release.sha256, compatibilityMode: active.compatibilityMode, files: serverSource.files, agents: active.agents, skills: active.skills }
        const packaged = { summary: nextPacked.summary, size: nextPacked.bytes.length, entries: nextPacked.entries, sha256: nextPacked.sha256 }
        if (!activateNow) return { packaged, release, activated: null }
        try {
          let history = await api.history(undefined, signal)
          let activated
          try { activated = await api.activate(release.releaseId, history.active.revision, signal) }
          catch (error) {
            if (!(error instanceof ClientError) || error.code !== "ACTIVATION_CONFLICT") throw error
            history = await api.history(undefined, signal)
            activated = await api.activate(release.releaseId, history.active.revision, signal)
          }
          scheduleAutoSync("release")
          return { packaged, release, activated, revision: activated.revision }
        } catch (error) {
          if (signal.aborted || !api?.account || error instanceof ClientError && (error.status === 401 || error.status === 403)) throw error
          return { packaged, release, activated: null, activationError: code(error) }
        }
      }
      case "history": return api.history(payload.cursor || undefined, signal)
      case "activate": {
        if (!/^[0-9a-f-]{36}$/i.test(payload.id) || !/^\d+$/.test(payload.revision) || !Number.isSafeInteger(Number(payload.revision))) throw new Error("INVALID_ACTIVATION")
        await api.guard(true, signal); await synchronize()
        await confirm("Activate AmeKit release?", `Release ${payload.id} becomes the stable bundle for the team. Expected revision: ${payload.revision}.`)
        const activated = await api.activate(payload.id, Number(payload.revision), signal)
        scheduleAutoSync("activate")
        return activated
      }
      case "import": {
        if (payload.compatibilityMode && !["native", "raw"].includes(payload.compatibilityMode)) throw new Error("INVALID_COMPATIBILITY_MODE")
        if (payload.adaptClaudeAgents !== undefined && !["true", "false"].includes(payload.adaptClaudeAgents)) throw new Error("INVALID_PAYLOAD")
        if (payload.adaptClaudeAgents === "true" && payload.compatibilityMode !== "raw") throw new Error("INVALID_COMPATIBILITY_MODE")
        const adaptClaudeAgents = payload.compatibilityMode === "raw" && payload.adaptClaudeAgents === "true"
        await api.guard(true, signal)
        const root = await options.pickImport()
        if (!root) return null
        await installer.safeDirectory(root)
        const importOptions: ImportOptions = { compatibilityMode: payload.compatibilityMode === "raw" ? "raw" : "native", adaptClaudeAgents }
        const nextScanned = await scanWithSource(root, signal, importOptions)
        const nextSession: ImportSession = {
          root, folderName: path.basename(path.resolve(root)) || root, options: importOptions, adaptClaudeAgents,
          originalInheritedIssues: nextScanned.inheritedIssues.map(issue => ({ ...issue })), inheritedIssues: nextScanned.inheritedIssues.map(issue => ({ ...issue })),
          originalFiles: new Map(nextScanned.files.map(file => [file.path, file.data.slice()])),
          workingFiles: new Map(nextScanned.files.map(file => [file.path, file.data.slice()])), savedToDisk: new Set(), aiFixedPaths: new Set(), reviewedAiFixes: new Set(),
        }
        signal.throwIfAborted()
        resetImport(); source = nextScanned.preview; importSession = nextSession
        return importView()
      }
      case "fix-import":
      case "fix-import-all":
      case "exclude-import-file":
      case "revert-import-fix":
      case "accept-import-fix":
      case "save-import-fix": {
        await api.guard(true, signal)
        if (!importSession || !source) throw new Error("IMPORT_REQUIRED")
        const session = importSession, targetPath = payload.path
        if (operation === "accept-import-fix") {
          if (!session.aiFixedPaths.has(targetPath)) throw new Error("IMPORT_FILE_NOT_FOUND")
          session.reviewedAiFixes.add(targetPath)
          return { accepted: targetPath }
        }
        if (operation === "fix-import") return fixImportFile(targetPath)
        if (operation === "fix-import-all") {
          const targets = importView().fixablePaths.slice(0, 10)
          if (!targets.length) throw new Error("AI_FIX_NO_FIXABLE_ERRORS")
          const fixes: Awaited<ReturnType<typeof fixImportFile>>["fix"][] = [], failed: { path: string; code: string; detail?: string }[] = []
          for (const target of targets) {
            signal.throwIfAborted()
            try { fixes.push((await fixImportFile(target)).fix) }
            catch (error) {
              if (signal.aborted || !api?.account || api.account.role !== "admin") throw error
              failed.push({ path: target, code: code(error), ...(error instanceof AiFixError && error.detail ? { detail: error.detail } : {}) })
            }
          }
          return { preview: recomputeImportPreview(), fixes, failed }
        }
        if (operation === "exclude-import-file") {
          if (!session.workingFiles.has(targetPath) && !session.inheritedIssues.some(issue => issue.path === targetPath)) throw new Error("IMPORT_FILE_NOT_FOUND")
          session.workingFiles.delete(targetPath)
          session.aiFixedPaths.delete(targetPath)
          session.reviewedAiFixes.delete(targetPath)
          session.inheritedIssues = session.inheritedIssues.filter(issue => issue.path !== targetPath)
          session.savedToDisk.delete(targetPath)
          return { preview: recomputeImportPreview(), excluded: targetPath }
        }
        if (operation === "revert-import-fix") {
          if (!session.originalFiles.has(targetPath) && !session.originalInheritedIssues.some(issue => issue.path === targetPath)) throw new Error("IMPORT_FILE_NOT_FOUND")
          const original = session.originalFiles.get(targetPath)
          if (original) session.workingFiles.set(targetPath, original.slice())
          session.aiFixedPaths.delete(targetPath)
          session.reviewedAiFixes.delete(targetPath)
          session.inheritedIssues = [...session.inheritedIssues.filter(issue => issue.path !== targetPath), ...session.originalInheritedIssues.filter(issue => issue.path === targetPath).map(issue => ({ ...issue }))]
          session.savedToDisk.delete(targetPath)
          return { preview: recomputeImportPreview(), reverted: targetPath }
        }
        if (!session.workingFiles.has(targetPath) || !session.originalFiles.has(targetPath)) throw new Error("IMPORT_FILE_NOT_FOUND")
        await confirm("Lưu tệp đã sửa về thư mục gốc?", `Ghi đè ${targetPath} trong ${session.root}. Hành động này sẽ cập nhật tệp nguồn trên đĩa.`)
        try {
          safePath(targetPath)
          const root = await installer.safeDirectory(session.root), segments = targetPath.split("/")
          let current = root
          const check = async () => {
            current = root
            for (let i = 0; i < segments.length; i++) {
              current = path.join(current, segments[i])
              const stat = await lstat(current), resolved = await realpath(current), relative = path.relative(root, resolved)
              if (stat.isSymbolicLink() || resolved.toLowerCase() !== current.toLowerCase() || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || (i === segments.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error("SAVE_PATH_UNSAFE")
            }
            return lstat(current)
          }
          const before = await check()
          const target = current, temporary = path.join(path.dirname(target), `.amekit-fix-${randomUUID()}.tmp`)
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, before.mode)
          let saveFailure: unknown
          try {
            signal.throwIfAborted()
            await handle.writeFile(session.workingFiles.get(targetPath)!)
            await handle.sync()
            await handle.close()
            for (let attempt = 0; ; attempt++) {
              const checked = await check()
              if (checked.nlink !== 1 || checked.dev !== before.dev || checked.ino !== before.ino) throw new Error("SAVE_PATH_UNSAFE")
              try { await rename(temporary, target); break } catch (error) {
                if (attempt >= 4 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
                await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
              }
            }
          } catch (error) { saveFailure = error; throw error }
          finally { await handle.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== "ENOENT" && !saveFailure) throw error }) }
        } catch (error) {
          if ((error as Error).message === "REPARSE_DIRECTORY_REJECTED") throw new Error("SAVE_PATH_UNSAFE")
          throw error
        }
        session.savedToDisk.add(targetPath)
        return { saved: targetPath }
      }
      case "package": {
        await api.guard(true, signal)
        if (!source) throw new Error("IMPORT_REQUIRED")
        packed = undefined
        const features = Object.fromEntries(["commitEnhanceSkill", "commitEnhanceModel", "androidTranslationSkill", "androidTranslationModel", "buildNotesSkill", "buildNotesModel"]
          .filter(key => typeof payload[key] === "string" && payload[key].trim())
          .map(key => [key, payload[key]]))
        packed = await pack(source, payload.version, signal, features)
        const { bytes, ...summary } = packed
        return { ...summary, size: bytes.length }
      }
      case "publish": {
        await api.guard(true, signal); await synchronize()
        if (!packed) throw new Error("PACKAGE_REQUIRED")
        await confirm("Publish AmeKit bundle?", `Upload version ${packed.summary.version}, ${packed.bytes.length} bytes, SHA-256 ${packed.sha256}. Publishing does not activate the release.` + aiFixWarning())
        return api.publish(packed.bytes, packed.summary.version, packed.sha256, () => {}, signal)
      }
      case "release": {
        await api.guard(true, signal); await synchronize()
        if (!source) throw new Error("IMPORT_REQUIRED")
        if (payload.activate !== undefined && !["true", "false"].includes(payload.activate)) throw new Error("INVALID_PAYLOAD")
        const activateNow = payload.activate === "true"
        const features = Object.fromEntries(["commitEnhanceSkill", "commitEnhanceModel", "androidTranslationSkill", "androidTranslationModel", "buildNotesSkill", "buildNotesModel"]
          .filter(key => typeof payload[key] === "string" && payload[key].trim())
          .map(key => [key, payload[key]]))
        const nextPacked = await pack(source, payload.version, signal, features)
        if (activateNow) {
          await confirm("Phát hành & kích hoạt AmeKit?", `Đóng gói v${nextPacked.summary.version} (${nextPacked.bytes.length} bytes, ${nextPacked.summary.fileCount} tệp, SHA-256 ${nextPacked.sha256.slice(0, 12)}…), xuất bản lên máy chủ và kích hoạt ngay cho toàn bộ team.` + aiFixWarning())
        } else {
          await confirm("Xuất bản bản nháp AmeKit?", `Đóng gói v${nextPacked.summary.version} (${nextPacked.bytes.length} bytes, ${nextPacked.summary.fileCount} tệp, SHA-256 ${nextPacked.sha256.slice(0, 12)}…) và xuất bản lên máy chủ (chưa kích hoạt cho team).` + aiFixWarning())
        }
        const release = await api.publish(nextPacked.bytes, nextPacked.summary.version, nextPacked.sha256, () => {}, signal)
        packed = undefined
        const packaged = { summary: nextPacked.summary, size: nextPacked.bytes.length, entries: nextPacked.entries, sha256: nextPacked.sha256 }
        if (!activateNow) return { packaged, release, activated: null }
        try {
          let history = await api.history(undefined, signal)
          let activated
          try { activated = await api.activate(release.releaseId, history.active.revision, signal) }
          catch (error) {
            if (!(error instanceof ClientError) || error.code !== "ACTIVATION_CONFLICT") throw error
            history = await api.history(undefined, signal)
            activated = await api.activate(release.releaseId, history.active.revision, signal)
          }
          scheduleAutoSync("release")
          return { packaged, release, activated, revision: activated.revision }
        } catch (error) {
          if (signal.aborted || !api?.account || error instanceof ClientError && (error.status === 401 || error.status === 403)) throw error
          return { packaged, release, activated: null, activationError: code(error) }
        }
      }
      case "install":
      case "sync": {
        const latest = await checkLatestBundle(api); await synchronize()
        const bytes = await api.download(latest.release, signal)
        const result = await trackLocalWrite(() => installer.installGlobal(globalConfigDir, globalManagedDir, api!.origin, latest.release, bytes, discover, signal, { allowRaw: true }))
        await preferences.enable({ origin: api.origin, accountId: api.account!.id })
        const account = bundleAccount()
        if (account) await dailySync.markChecked(account, now()).catch(() => {})
        clearAutoSyncError()
        await snapshotInstalledBundle()
        if (result.changed) {
          await reloadAndRestorePolicy()
          options.onBundleChanged?.({ version: result.state.version, releaseId: result.state.releaseId, auto: false, action: "synced" })
        }
        return { ...installView(result.state), changed: result.changed }
      }
      default: throw new Error("UNKNOWN_OPERATION")
    }
  }
  const viewOrEmpty = () => view() ?? { ready: false, ...bundleWarning(), ...(blocker ? { blocker } : {}) }
  function scheduleAutoSync(reason: string) {
    if (options.autoSync !== true || disposed || storageError || !api?.account || !policyReady || autoSyncInFlight) return
    const initiatingCall = ["ready", "heartbeat", "lease"].includes(reason) ? undefined : inFlight
    const task = (async () => {
      await ready
      await initiatingCall?.catch(() => {})
      await synchronizeBundle(reason)
    })().finally(() => { if (autoSyncInFlight === task) autoSyncInFlight = undefined })
    autoSyncInFlight = task
    void task.catch(() => {})
  }
  async function synchronizeBundle(reason: string) {
    if (options.autoSync !== true || disposed || storageError || !api?.account || !policyReady) return
    const accountApi = api
    const active = () => !disposed && api === accountApi && !!accountApi.account && policyReady
    const stopOnAuthFailure = async (error: unknown) => {
      if (!(error instanceof ClientError) || error.status !== 401 && error.status !== 403) return false
      if (api === accountApi && !disposed) {
        accountApi.suspend(); resetImport(); blocker = code(error)
        await revoke(); await persist().catch(() => {})
      }
      return true
    }
    try {
      if (!active()) return
      const account = { origin: accountApi.origin, accountId: accountApi.account!.id }
      if (await preferences.optedOut(account) || !active()) return
      const current = await installer.installedGlobal(globalConfigDir, globalManagedDir).catch(() => undefined)
      if ((reason === "ready" || reason === "lease") && current && await dailySync.checkedToday(account, now())) return
      let latest: Awaited<ReturnType<AmeApi["latest"]>>
      try { latest = await checkLatestBundle(accountApi) }
      catch (error) {
        if (!await stopOnAuthFailure(error) && active() && !signal.aborted && (reason === "refresh" || !isTransientError(error) && !(error instanceof ClientError && error.code === "NO_ACTIVE_RELEASE"))) lastAutoSyncError = code(error)
        return
      }
      if (!active()) return
      if (current?.releaseId === latest.release.releaseId && current.sha256 === latest.release.sha256) {
        await dailySync.markChecked(account, now()).catch(() => {})
        clearAutoSyncError(); return
      }
      if (lastAutoSyncFailedReleaseId === latest.release.releaseId && reason === "heartbeat") return
      try {
        const bytes = await accountApi.download(latest.release, signal)
        if (!active()) return
        const result = await trackLocalWrite(async () => {
          if (!active() || await preferences.optedOut(account)) return undefined
          return installer.installGlobal(globalConfigDir, globalManagedDir, accountApi.origin, latest.release, bytes, discover, signal, { allowRaw: true })
        })
        if (!result) return
        await dailySync.markChecked(account, now()).catch(() => {})
        clearAutoSyncError()
        await snapshotInstalledBundle()
        if (result.changed) {
          await reloadAndRestorePolicy()
          options.onBundleChanged?.({ version: result.state.version, releaseId: result.state.releaseId, auto: true, action: "synced" })
        }
      } catch (error) {
        if (await stopOnAuthFailure(error) || !active() || signal.aborted || reason !== "refresh" && isTransientError(error)) return
        lastAutoSyncError = code(error); lastAutoSyncFailedReleaseId = latest.release.releaseId
      }
    } catch (error) {
      if (!await stopOnAuthFailure(error) && active() && !signal.aborted) lastAutoSyncError = code(error)
    }
  }
  const call: AmeKit["call"] = (operation, payload) => {
    if (disposed) return Promise.reject(new Error("AMEKIT_DISPOSED"))
    if (busy) return Promise.reject(new Error("OPERATION_BUSY"))
    busy = true
    const task = (async () => {
      let result: unknown, failure: unknown
      try {
        if (backgroundInFlight) await backgroundInFlight.catch(() => {})
        await ready
        if (["refresh", "installed", "offline", "sync", "install", "uninstall", "recover"].includes(operation) && autoSyncInFlight) await autoSyncInFlight.catch(() => {})
        result = await execute(operation, payload)
      }
      catch (error) { failure = error }
      if (!["status", "usage-prices", "installed", "offline", "uninstall", "recover", "logout", "legacy-installed", "clean-legacy"].includes(operation)) {
        if (failure && (["login", "refresh", "assert-ready", "assert-model"].includes(operation) || !api?.account)) {
          api?.suspend(); resetImport(); blocker = code(failure); await revoke()
        } else if (!["login", "refresh", "assert-ready", "assert-model"].includes(operation)) {
          try { await synchronize() } catch (error) { failure ??= error }
        }
        try { await persist() } catch (error) { failure ??= error }
      }
      if (failure) {
        if (operation === "save-import-fix" && failure instanceof Error && (failure as NodeJS.ErrnoException).code) throw failure
        throw new Error(`${code(failure)}${failure instanceof AiFixError && failure.detail ? `: ${failure.detail}` : ""}`)
      }
      return result
    })().finally(() => { busy = false; if (inFlight === task) inFlight = undefined })
    inFlight = task
    return task
  }
  const backgroundRefresh = (reason: "heartbeat" | "lease" = "heartbeat") => {
    if (disposed || storageError || !api?.credential) return
    if (busy || backgroundInFlight) { if (reason === "lease") scheduleLeaseRenewal(LEASE_RETRY_MS); return }
    const task = (async () => {
      await ready
      if (disposed) return
      try {
        await api!.refresh(signal, { preserveOnTransient: true })
        await synchronize()
        refreshedAt = now()
        await persist()
        scheduleAutoSync(reason)
      } catch (error) {
        blocker = code(error)
        if (isTransientError(error) && api?.account && api.expires > Date.now() && transientFailures < 2) {
          // Preserve the existing lease only; a missed heartbeat must never renew it.
          transientFailures++
          if (!timer) scheduleLeaseRenewal(LEASE_RETRY_MS)
          return
        }
        api?.suspend(); resetImport(); transientFailures = 0; await revoke()
      }
    })().finally(() => { if (backgroundInFlight === task) backgroundInFlight = undefined })
    backgroundInFlight = task
    void task.catch(() => {})
  }
  const timer = dependencies.refreshIntervalMs && dependencies.refreshIntervalMs > 0
    ? setInterval(() => backgroundRefresh("heartbeat"), dependencies.refreshIntervalMs)
    : undefined
  timer?.unref?.()
  return {
    call,
    async readStatus() {
      await ready
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      return view()
    },
    async readOrchestrator() {
      await ready
      // A new Chat must not fall back to build while login/refresh is updating the policy.
      await inFlight?.catch(() => {})
      await backgroundInFlight?.catch(() => {})
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      if (api?.credential && (!policyReady || !api.account || api.expires <= Date.now())) throw new Error(blocker ?? "ACCOUNT_REFRESH_REQUIRED")
      return api?.orchestrator
    },
    async readUsagePrices() {
      await ready
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      return { origin: api?.account ? api.origin : null, prices: readUsagePrices(api?.provider?.catalog) }
    },
    async readCommitEnhanceSkill(projectID) {
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      try {
        await localBundleWriteInFlight?.catch(() => {})
        if (await installer.installedGlobal(globalConfigDir, globalManagedDir)) return await installer.readGlobalCommitEnhanceSkill(globalConfigDir, globalManagedDir)
        return projectID ? await installer.readCommitEnhanceSkill(await project(projectID)) : null
      } catch (error) { throw new Error(code(error)) }
    },
    async readCommitEnhanceFeature(projectID) {
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      try {
        await localBundleWriteInFlight?.catch(() => {})
        const globalInstalled = await installer.installedGlobal(globalConfigDir, globalManagedDir)
        if (!globalInstalled && !projectID) return { skill: null }
        const directory = globalInstalled ? undefined : await project(projectID!)
        const features = globalInstalled ? await installer.readGlobalBundleFeatures(globalConfigDir, globalManagedDir) : await installer.readBundleFeatures(directory!)
        const skill = globalInstalled ? await installer.readGlobalCommitEnhanceSkill(globalConfigDir, globalManagedDir) : await installer.readCommitEnhanceSkill(directory!)
        return { skill, ...(features?.commitEnhanceModel ? { model: features.commitEnhanceModel } : {}) }
      } catch (error) { throw new Error(code(error)) }
    },
    async readBuildNotesFeature(projectID) {
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      try {
        await localBundleWriteInFlight?.catch(() => {})
        if (await installer.installedGlobal(globalConfigDir, globalManagedDir)) return await installer.readGlobalBuildNotesFeature(globalConfigDir, globalManagedDir)
        return projectID ? await installer.readBuildNotesFeature(await project(projectID)) : { skill: null }
      } catch (error) { throw new Error(code(error)) }
    },
    async readAndroidTranslationFeature(projectID) {
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      try {
        await localBundleWriteInFlight?.catch(() => {})
        if (await installer.installedGlobal(globalConfigDir, globalManagedDir)) return await installer.readGlobalAndroidTranslationFeature(globalConfigDir, globalManagedDir)
        return projectID ? await installer.readAndroidTranslationFeature(await project(projectID)) : { skill: null }
      } catch (error) { throw new Error(code(error)) }
    },
    async authorizeFeatureModel(modelID) {
      await ready
      while (busy) await inFlight?.catch(() => {})
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      if (!api?.account || !api.provider || api.expires <= Date.now() || !policyReady) return null
      const policy = modelPolicy(api.account.role, api.provider.catalog, { featureModels: [...authorizedFeatureModels] })
      const resolvedID = resolveModelLevel(policy, modelID)
      if (policy.models.some(model => model.id === resolvedID)) return resolvedID
      if (!policy.active_models.some(model => model.id === resolvedID)) return null
      if (authorizedFeatureModels.size >= 20) return null
      busy = true
      const task = (async () => {
        authorizedFeatureModels.add(resolvedID)
        try { await synchronize(); return resolvedID }
        catch { authorizedFeatureModels.delete(resolvedID); return null }
      })().finally(() => { busy = false; if (inFlight === task) inFlight = undefined })
      inFlight = task
      return task
    },
    async generatePetDialogue(model, callerSignal) {
      await ready
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      const generationSignal = AbortSignal.any([signal, callerSignal])
      generationSignal.throwIfAborted()
      if (!api?.account || !api.provider) throw new Error("AMECODE_LOGIN_REQUIRED")
      if (!policyReady) throw new Error(blocker ?? "MODEL_POLICY_UNAVAILABLE")
      assertChatModel(modelPolicy(api.account.role, api.provider.catalog), { providerID: managedProvider, id: model })
      providerURL(api.provider.provider.base_url)
      // The generator refreshes authentication itself. Recheck chat scope at the
      // provider boundary as well, so a demotion during that refresh cannot use
      // the broader agent/feature model policy in the shared generator.
      return generateDialogue(api, model, generationSignal, (request, init) => {
        assertChatModel(modelPolicy(api?.account?.role, api?.provider?.catalog), { providerID: managedProvider, id: model })
        return fetcher(request, init)
      })
    },
    dispose() {
      return disposal ??= (async () => {
        disposed = true; activeArchiveCache = undefined; clearLeaseTimer(); if (timer) clearInterval(timer); lifetime.abort()
        await ready; await Promise.all([inFlight?.catch(() => {}), backgroundInFlight?.catch(() => {}), autoSyncInFlight?.catch(() => {})])
        authorizedFeatureModels.clear(); api?.clear(); resetImport(); await revoke(true)
      })()
    },
  }
}
