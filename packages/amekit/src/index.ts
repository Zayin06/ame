import path from "node:path"
import { AmeApi, isTransientError } from "./api"
import { assertModel, managedProvider, modelPolicy, providerURL } from "./model-policy"
import { openSessionVault, type Encryption } from "./session-vault"
import { pack, type Preview } from "./bundle/package"
import { scan } from "./bundle/scan"
import * as installer from "./installer"
import { runtimeDiscovery, type Discover } from "./runtime"
import { readUsagePrices } from "./usage-pricing"
import { generatePetDialogue as generateDialogue } from "./pet-generation"
import type { DialogueSet } from "./pet-dialogue"

export type AmeKitOptions = {
  userData: string
  endpoint: () => { url: string; headers: Record<string, string> } | undefined
  project: (id: string) => Promise<string>
  pickImport: () => Promise<string | null>
  cli?: string
}
export type AmeKit = {
  call(operation: string, payload: Record<string, string>): Promise<unknown>
  /** Main-process only; retain categorized dialogue for createPetHost. */
  generatePetDialogue(model: string, signal: AbortSignal): Promise<DialogueSet>
  dispose(): Promise<void>
}
type ElectronMain = { safeStorage: Encryption; dialog: Pick<typeof import("electron")["dialog"], "showMessageBox"> }
/** Main-process test seams; never accept these dependencies over renderer IPC. */
export type AmeKitDependencies = { fetch?: typeof fetch; electron?: () => Promise<ElectronMain>; discover?: Discover; refreshIntervalMs?: number }

export function createAmeKit(options: AmeKitOptions, dependencies: AmeKitDependencies = {}): AmeKit {
  const fetcher = dependencies.fetch ?? fetch
  const electron = dependencies.electron ?? (() => import("electron"))
  const lifetime = new AbortController()
  const signal = lifetime.signal
  let api: AmeApi | undefined, source: Preview | undefined, packed: Awaited<ReturnType<typeof pack>> | undefined
  let vault: Awaited<ReturnType<typeof openSessionVault>> | undefined
  let storageError: string | undefined, blocker: string | undefined, policyReady = false, disposed = false, busy = false
  let inFlight: Promise<unknown> | undefined, disposal: Promise<void> | undefined
  let transientFailures = 0
  const code = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "AMEKIT_OPERATION_FAILED"
  const resetImport = () => { source = undefined; packed = undefined }
  const rpc = async (input: unknown, cleanup = false) => {
    const endpoint = options.endpoint()
    if (!endpoint) throw new Error("MODEL_POLICY_PLUGIN_REQUIRED")
    let url: URL
    try {
      url = new URL(endpoint.url)
      if (url.username || url.password || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) throw new Error()
    } catch { throw new Error("LOCAL_SERVER_REQUIRED") }
    let response: Response
    try {
      response = await fetcher(new URL("/api/rpc/amekit-models/update", url), {
        method: "POST", headers: { ...endpoint.headers, "content-type": "application/json" },
        body: JSON.stringify({ input }), redirect: "error",
        signal: cleanup ? AbortSignal.timeout(1500) : AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
    } catch { throw new Error("MODEL_POLICY_UNAVAILABLE") }
    if ([400, 404, 503].includes(response.status)) { await response.body?.cancel(); throw new Error("MODEL_POLICY_PLUGIN_REQUIRED") }
    if (!response.ok) { await response.body?.cancel(); throw new Error("MODEL_POLICY_UNAVAILABLE") }
    const result = await response.json().catch(() => null) as { output?: unknown } | null
    if (result?.output !== true) throw new Error("MODEL_POLICY_UNAVAILABLE")
  }
  const revoke = async (cleanup = false) => { policyReady = false; await rpc(null, cleanup).catch(() => {}) }
  const persist = async () => {
    try { if (!vault) throw new Error(); await vault.save(api?.credential) }
    catch { storageError = "SESSION_STORAGE_UNAVAILABLE"; api?.suspend(); await revoke(); throw new Error(storageError) }
  }
  const synchronize = async () => {
    policyReady = false
    try {
      if (!api?.account) { await rpc(null); return }
      modelPolicy(api.account.role, api.provider?.catalog)
      providerURL(api.provider!.provider.base_url)
      if (api.expires <= Date.now()) throw new Error("AMECODE_LOGIN_REQUIRED")
      await persist()
      await rpc({ role: api.account.role, catalog: api.provider!.catalog, provider: api.provider!.provider, expires: api.expires })
      policyReady = true; blocker = undefined; transientFailures = 0
    } catch (error) {
      blocker = code(error); api?.suspend(); resetImport(); await revoke()
      throw error
    }
  }
  const view = () => {
    if (api?.account && api.expires <= Date.now()) { api.suspend(); policyReady = false; blocker = "AMECODE_LOGIN_REQUIRED" }
    if (api?.account) {
      const models = modelPolicy(api.account.role, api.provider?.catalog)
      return { origin: api.origin, account: { ...api.account }, models: { ...models, small_model: api.account.role === "user" ? models.default_model : models.small_model }, ready: policyReady, ...(blocker ? { blocker } : {}) }
    }
    return api?.credential ? { origin: api.origin, reconnecting: true, ready: false, blocker: storageError ?? blocker ?? "ACCOUNT_REFRESH_REQUIRED" } : null
  }
  const ready = (async () => {
    try {
      vault = await openSessionVault(options.userData, (await electron()).safeStorage)
      const credential = await vault.load()
      if (credential && !disposed) {
        api = new AmeApi(credential.origin, fetcher)
        await api.resume(credential.token, signal)
        await synchronize()
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
  const installView = (state: NonNullable<Awaited<ReturnType<typeof installer.installed>>>) => ({ version: state.version, releaseId: state.releaseId, compatibilityMode: state.compatibilityMode, verification: state.verification, compatibilityWarnings: state.compatibilityWarnings })
  const execute = async (operation: string, payload: Record<string, string>): Promise<unknown> => {
    await ready
    if (disposed) throw new Error("AMEKIT_DISPOSED")
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.values(payload).some(value => typeof value !== "string")) throw new Error("INVALID_PAYLOAD")
    if (operation === "status") return { ...viewOrEmpty(), ...(storageError ? { ready: false, blocker: storageError } : {}) }
    if (operation === "usage-prices") return { origin: api?.account ? api.origin : null, prices: readUsagePrices(api?.provider?.catalog) }
    if (operation === "logout") {
      api?.suspend(); resetImport(); await revoke()
      try { if (!vault) throw new Error(); await vault.save(undefined); storageError = undefined }
      catch { api?.clear(); api = undefined; storageError = "SESSION_STORAGE_UNAVAILABLE"; throw new Error(storageError) }
      try { await api?.logout(AbortSignal.any([signal, AbortSignal.timeout(3000)])) }
      catch { /* Local credentials and model access have already been removed. */ }
      finally { api?.clear(); api = undefined; blocker = undefined }
      return null
    }
    if (["installed", "offline", "uninstall"].includes(operation)) {
      const directory = await project(payload.project)
      if (operation === "installed") { const state = await installer.installed(directory); return state ? installView(state) : null }
      if (operation === "offline") { const state = await installer.offline(directory, discover, signal); return { ...installView(state), changed: false } }
      await confirm("Uninstall managed AmeKit bundle?", `Remove only unmodified AmeKit-owned files from ${directory}. Personal files are preserved.`)
      return { changed: await installer.uninstall(directory, signal) }
    }
    if (storageError) throw new Error(storageError)
    if (operation === "login") {
      api?.clear(); resetImport(); await persist(); await rpc(null)
      api = new AmeApi(payload.server || undefined, fetcher)
      await api.login(payload.username, payload.password, signal)
      await synchronize()
      return view()
    }
    if (!api) throw new Error("SIGNED_OUT")
    switch (operation) {
      case "refresh": await api.refresh(signal); await synchronize(); return view()
      case "assert-ready":
      case "assert-model": {
        await api.refresh(signal); await synchronize()
        const modelID = payload.modelID || modelPolicy(api.account?.role, api.provider?.catalog).default_model
        const providerID = payload.providerID || managedProvider
        assertModel(modelPolicy(api.account?.role, api.provider?.catalog), { providerID, id: modelID })
        return { providerID, modelID }
      }
      case "latest": return api.latest(signal)
      case "history": return api.history(payload.cursor || undefined, signal)
      case "activate": {
        if (!/^[0-9a-f-]{36}$/i.test(payload.id) || !/^\d+$/.test(payload.revision) || !Number.isSafeInteger(Number(payload.revision))) throw new Error("INVALID_ACTIVATION")
        await api.guard(true, signal); await synchronize()
        await confirm("Activate AmeKit release?", `Release ${payload.id} becomes the stable bundle for the team. Expected revision: ${payload.revision}.`)
        return api.activate(payload.id, Number(payload.revision), signal)
      }
      case "import": {
        await api.guard(true, signal)
        resetImport()
        if (payload.compatibilityMode && !["native", "raw"].includes(payload.compatibilityMode)) throw new Error("INVALID_COMPATIBILITY_MODE")
        const root = await options.pickImport()
        if (!root) return null
        await installer.safeDirectory(root)
        source = await scan(root, signal, { compatibilityMode: payload.compatibilityMode === "raw" ? "raw" : "native" })
        return { issues: source.issues, agents: source.agents, skills: source.skills, compatibilityMode: source.compatibilityMode ?? "native", files: source.files.map(file => ({ path: file.path, size: file.data.length })) }
      }
      case "package": {
        await api.guard(true, signal)
        if (!source) throw new Error("IMPORT_REQUIRED")
        packed = undefined
        packed = await pack(source, payload.version, signal)
        const { bytes, ...summary } = packed
        return { ...summary, size: bytes.length }
      }
      case "publish": {
        await api.guard(true, signal); await synchronize()
        if (!packed) throw new Error("PACKAGE_REQUIRED")
        await confirm("Publish AmeKit bundle?", `Upload version ${packed.summary.version}, ${packed.bytes.length} bytes, SHA-256 ${packed.sha256}. Publishing does not activate the release.`)
        return api.publish(packed.bytes, packed.summary.version, packed.sha256, () => {}, signal)
      }
      case "sync": {
        const directory = await project(payload.project)
        const latest = await api.latest(signal); await synchronize()
        const raw = latest.release.manifest.compatibility.mode === "raw"
        if (raw && payload.allowRaw !== "true") throw new Error("RAW_INSTALL_CONFIRMATION_REQUIRED")
        await confirm("Install AmeKit bundle?", `Install ${latest.release.version} into ${directory}. ${raw ? "RAW: exact bytes only; runtime compatibility is NOT verified." : "Native agent and skill discovery must pass or the install rolls back."}`)
        const bytes = await api.download(latest.release, signal)
        const result = await installer.install(directory, api.origin, latest.release, bytes, discover, signal, { allowRaw: raw })
        return { ...installView(result.state), changed: result.changed }
      }
      default: throw new Error("UNKNOWN_OPERATION")
    }
  }
  const viewOrEmpty = () => view() ?? { ready: false, ...(blocker ? { blocker } : {}) }
  const call: AmeKit["call"] = (operation, payload) => {
    if (disposed) return Promise.reject(new Error("AMEKIT_DISPOSED"))
    if (busy) return Promise.reject(new Error("OPERATION_BUSY"))
    busy = true
    const task = (async () => {
      let result: unknown, failure: unknown
      try { result = await execute(operation, payload) }
      catch (error) { failure = error }
      if (!["status", "usage-prices", "installed", "offline", "uninstall", "logout"].includes(operation)) {
        if (failure && (["login", "refresh", "assert-ready", "assert-model"].includes(operation) || !api?.account)) {
          api?.suspend(); resetImport(); blocker = code(failure); await revoke()
        } else if (!["login", "refresh", "assert-ready", "assert-model"].includes(operation)) {
          try { await synchronize() } catch (error) { failure ??= error }
        }
        try { await persist() } catch (error) { failure ??= error }
      }
      if (failure) throw new Error(code(failure))
      return result
    })().finally(() => { busy = false; if (inFlight === task) inFlight = undefined })
    inFlight = task
    return task
  }
  const backgroundRefresh = () => {
    if (disposed || busy || storageError || !api?.credential) return
    busy = true
    const task = (async () => {
      await ready
      if (disposed) return
      try {
        await api!.refresh(signal, { preserveOnTransient: true })
        await synchronize()
        await persist()
      } catch (error) {
        blocker = code(error)
        if (isTransientError(error) && api?.account && api.expires > Date.now() && transientFailures < 2) {
          // Preserve the existing lease only; a missed heartbeat must never renew it.
          transientFailures++
          return
        }
        api?.suspend(); resetImport(); transientFailures = 0; await revoke()
      }
    })().finally(() => { busy = false; if (inFlight === task) inFlight = undefined })
    inFlight = task
    void task.catch(() => {})
  }
  const timer = setInterval(backgroundRefresh, dependencies.refreshIntervalMs ?? 30_000)
  timer.unref?.()
  return {
    call,
    async generatePetDialogue(model, callerSignal) {
      await ready
      if (disposed) throw new Error("AMEKIT_DISPOSED")
      const generationSignal = AbortSignal.any([signal, callerSignal])
      generationSignal.throwIfAborted()
      if (!api?.account || !api.provider) throw new Error("AMECODE_LOGIN_REQUIRED")
      if (!policyReady) throw new Error(blocker ?? "MODEL_POLICY_UNAVAILABLE")
      assertModel(modelPolicy(api.account.role, api.provider.catalog), { providerID: managedProvider, id: model })
      providerURL(api.provider.provider.base_url)
      return generateDialogue(api, model, generationSignal, fetcher)
    },
    dispose() {
      return disposal ??= (async () => {
        disposed = true; clearInterval(timer); lifetime.abort()
        await ready; await inFlight?.catch(() => {})
        api?.clear(); resetImport(); await revoke(true)
      })()
    },
  }
}
