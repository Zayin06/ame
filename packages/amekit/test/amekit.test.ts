import test, { after } from "node:test"
import assert from "node:assert/strict"
import { link, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { createAmeKit, type AmeKitDependencies, type AmeKit, type AmeKitOptions } from "../src/index"
import { openSessionVault, type Encryption } from "../src/session-vault"
import { dailySyncStore, localDayKey } from "../src/daily-sync"
import { zipSync, unzipSync } from "fflate"
import { pack, preview, safePath, secretFindings } from "../src/bundle/package"
import { sha256, validate } from "../src/bundle/manifest"
import { MAX_ZIP } from "../src/bundle/limits"
import { scan, scanWithSource } from "../src/bundle/scan"
import { AiFixError, buildCompactDiff, fixImportFileWithLlm, isFixableTextFile, redactSecretsForLlm } from "../src/bundle/ai-fix"
import { AmeApi } from "../src/api"
import { assertModel, assertChatModel, catalogSchema, MODEL_LEVELS, modelPolicy, parseModelLevel, resolveModelLevel, type ModelLevels } from "../src/model-policy"
import { parse, stringify } from "yaml"
import { installed, install, installedGlobal, installGlobal, offlineGlobal, uninstallGlobal, legacyProjectInstalled, cleanLegacyProject, readGlobalCommitEnhanceSkill, readGlobalBundleFeatures, readGlobalAndroidTranslationFeature, readAndroidTranslationFeature, readBuildNotesFeature, readGlobalBuildNotesFeature, readBundleFeatures, readCommitEnhanceSkill, uninstall } from "../src/installer"
import { buildAndroidTranslationPrompt, createTranslationLockStore, detectAndroidProject } from "../src/android-translation"
import type { Release } from "../src/api"
import { dialoguePrompt, localDialogue } from "../src/pet-dialogue"
import type { PetHostOptions } from "../src/pet-host"

const root = path.resolve("packages", "amekit", "test", `.work-${randomUUID()}`)
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const catalog = { version: "fixture", default_model: "default", small_model: "other", models: ["default", "other"].map(id => ({ id, name: id, tool_call: true, vision: false, context: 8000, output: 1000 })) }
const encryption: Encryption = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`encrypted:${Buffer.from(text).toString("base64")}`),
  decryptString: bytes => { const value = bytes.toString(); if (!value.startsWith("encrypted:")) throw new Error(); return Buffer.from(value.slice(10), "base64").toString() },
}
const encode = (value: string) => new TextEncoder().encode(value)
const input = () => [
  { path: "agents/helper.md", data: encode("---\ndescription: Helpful fixture\nmode: subagent\n---\nAssist with development.\n") },
  { path: "skills/fixture/SKILL.md", data: encode("---\nname: fixture\ndescription: Fixture skill\n---\nRun checks.\n") },
]
async function area() { const folder = path.join(root, randomUUID()); await mkdir(folder, { recursive: true }); return folder }
async function bundle(mode: "native" | "raw" = "native", commitEnhanceSkill?: string) {
  const packed = await pack(preview(input(), [], { compatibilityMode: mode }), "1.2.3", undefined, { commitEnhanceSkill })
  const release: Release = { releaseId: "ef2b4502-3b3f-4ac7-a223-81fdb4b77557", version: "1.2.3", channel: "stable", sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"], publishedAt: 1, downloadUrl: "/ignored" }
  return { packed, release, latest: { release, revision: 1, activatedAt: 1 } }
}
async function fixture(settings: { orchestrator?: unknown; catalog?: unknown; role?: unknown; plugin?: boolean; confirm?: boolean; encryption?: Encryption; mode?: "native" | "raw"; commitEnhanceSkill?: string; discover?: AmeKitDependencies["discover"]; refreshIntervalMs?: number; autoSync?: boolean; reloadRuntime?: AmeKitOptions["reloadRuntime"]; onBundleChanged?: AmeKitOptions["onBundleChanged"] } = {}) {
  const folder = await area(), project = path.join(folder, "project"), imported = path.join(folder, "source"), data = path.join(folder, "data")
  await mkdir(project); await mkdir(imported)
  for (const file of input()) { const target = path.join(imported, ...file.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data) }
  const artifact = await bundle(settings.mode, settings.commitEnhanceSkill)
  const rpc: unknown[] = [], requests: string[] = [], dialogs: string[] = [], messages: string[] = [], events: string[] = []
  let apiResponse: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | undefined
  let role: unknown = settings.role ?? "user", plugin = settings.plugin !== false, accepted = settings.confirm !== false, failAuth = false, failStorage = false, pickerCount = 0
  let orchestrator = settings.orchestrator
  let sessionResponse: (() => Promise<Response | undefined>) | undefined, expiresAt: number | undefined
  let accountId = "1", username = "fixture"
  let pickResponse: (() => Promise<string | null>) | undefined
  let rpcResponse: (() => Promise<Response | undefined>) | undefined
  let dialogueResponse: ((signal: AbortSignal) => Promise<Response>) | undefined
  let fixResponse: ((body: Record<string, unknown>, init: RequestInit) => Promise<Response>) | undefined
  const fixRequests: Record<string, unknown>[] = []
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(String(request)); requests.push(url.pathname)
    if (url.origin === "http://127.0.0.1:3210") {
      assert.equal(url.pathname, "/api/rpc/amekit-models/update")
      assert.equal(new Headers(init?.headers).get("authorization"), "Basic fixture-owner")
      rpc.push(JSON.parse(String(init?.body)).input)
      const response = await rpcResponse?.(); if (response) return response
      return Response.json(plugin ? { output: true } : { type: "rpc.unavailable" }, { status: plugin ? 200 : 400 })
    }
    if (url.origin === "http://localhost:3212") {
      assert.equal(url.pathname, "/v1/chat/completions")
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-provider-key")
      const body = JSON.parse(String(init?.body))
      if (fixResponse) { fixRequests.push(body); return fixResponse(body, init!) }
      assert.deepEqual(body.messages, [{ role: "user", content: dialoguePrompt }])
      assert.equal(body.stream, false)
      assert.equal(init?.redirect, "error")
      assert.ok(init?.signal)
      init.signal.throwIfAborted()
      return dialogueResponse ? dialogueResponse(init.signal) : Response.json({ choices: [{ message: { content: JSON.stringify(localDialogue) } }] })
    }
    assert.equal(url.origin, "http://localhost:3211", "no real API calls")
    events.push(`${init?.method ?? "GET"} ${url.pathname}`)
    const response = await apiResponse?.(url, init); if (response) return response
    if (failAuth) return Response.json({ error: { code: "USER_DISABLED" } }, { status: 401 })
    if (url.pathname === "/v1/session") { const response = await sessionResponse?.(); if (response) return response }
    if (url.pathname === "/v1/amekit/releases/latest") return Response.json(artifact.latest)
    if (url.pathname.endsWith("/download")) return new Response(Uint8Array.from(artifact.packed.bytes))
    if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") return Response.json({ releases: [artifact.release], active: { release_id: artifact.release.releaseId, revision: 1, activated_at: 1 }, nextCursor: null })
    if (url.pathname.endsWith("/activate")) return Response.json(artifact.latest)
    if (url.pathname === "/v1/amekit/bundles/uploads") return Response.json({ uploadId: artifact.release.releaseId })
    if (url.pathname === "/v1/amekit/releases" && init?.method === "POST") return Response.json({ release: artifact.release })
    return Response.json({ session: { token: "fixture-session-token", expires_at: new Date(expiresAt ?? Date.now() + 3600_000).toISOString() }, user: { id: accountId, name: "Fixture", username, role }, provider: { base_url: "http://localhost:3212/v1", api_key: "fixture-provider-key" }, catalog: settings.catalog ?? catalog, registry: {}, ...(orchestrator === undefined ? {} : { orchestrator }) })
  }
  const dependencies: AmeKitDependencies = {
    fetch: fetcher, refreshIntervalMs: settings.refreshIntervalMs,
    electron: async () => ({ safeStorage: { ...(settings.encryption ?? encryption), encryptString(text: string) { if (failStorage) throw new Error("contains-sensitive-material"); return (settings.encryption ?? encryption).encryptString(text) } }, dialog: { showMessageBox: async (options: { message?: string; detail?: string }) => { dialogs.push(options.detail ?? options.message ?? ""); messages.push(options.message ?? ""); events.push("confirm"); return { response: accepted ? 1 : 0, checkboxChecked: false } } } as never }),
    discover: settings.discover ?? (async (directory, _signal, _expected, options) => {
      const config = options?.scope === "global" ? directory : path.join(directory, ".opencode")
      try { await readFile(path.join(config, "agents", "helper.md")) } catch { return { agents: [], skills: [] } }
      return { agents: [{ id: "helper" }], skills: [{ id: "fixture", name: "fixture", path: path.join(config, "skills", "fixture", "SKILL.md") }] }
    }),
  }
  const globalConfigDir = path.join(data, "backend", "config", "opencode"), globalManagedDir = path.join(data, "amekit", "global")
  const options = { userData: data, globalConfigDir, autoSync: settings.autoSync, reloadRuntime: settings.reloadRuntime, onBundleChanged: settings.onBundleChanged, endpoint: () => ({ url: "http://127.0.0.1:3210", headers: { authorization: "Basic fixture-owner" } }), project: async (id: string) => { assert.equal(id, "project-id"); return project }, pickImport: async () => { pickerCount++; return pickResponse ? pickResponse() : imported } }
  const service = createAmeKit(options, dependencies)
  return { service, folder, project, imported, data, globalConfigDir, globalManagedDir, rpc, requests, dialogs, messages, events, options, dependencies, artifact,
    apiResponse: (value: (url: URL, init?: RequestInit) => Promise<Response | undefined>) => { apiResponse = value },
    role: (value: unknown) => { role = value }, plugin: (value: boolean) => { plugin = value }, confirm: (value: boolean) => { accepted = value }, disable: () => { failAuth = true }, breakStorage: () => { failStorage = true }, pickerCount: () => pickerCount,
    sessionResponse: (value?: () => Promise<Response | undefined>) => { sessionResponse = value }, expiresAt: (value: number) => { expiresAt = value },
    account: (id: string, name = "fixture") => { accountId = id; username = name },
    orchestrator: (value: unknown) => { orchestrator = value },
    rpcResponse: (value?: () => Promise<Response | undefined>) => { rpcResponse = value },
    pickResponse: (value?: () => Promise<string | null>) => { pickResponse = value },
    dialogueResponse: (value: (signal: AbortSignal) => Promise<Response>) => { dialogueResponse = value },
    fixRequests, fixResponse: (value: (body: Record<string, unknown>, init: RequestInit) => Promise<Response>) => { fixResponse = value },
    cleanup: async () => { await service.dispose(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } }
}
const login = (service: AmeKit) => service.call("login", { server: "http://localhost:3211", username: "fixture", password: "fixture-password" })

test("API orchestrator reaches runtime policy and refreshes or revokes with the account", async () => {
  const config = { id: "ame-orchestrator", version: "1.0.0", description: "Global lead", prompt: "Route using installed agent descriptions.", subagentDepth: 3 }
  const f = await fixture({ orchestrator: config, autoSync: false })
  try {
    assert.equal(await f.service.readOrchestrator!(), undefined)
    const metadata = (value: unknown, version: string) => {
      const status = value as { orchestrator: unknown }
      assert.deepEqual(status.orchestrator, { id: "ame-orchestrator", version })
      assert.equal(JSON.stringify(status).includes(config.prompt), false)
      assert.equal(JSON.stringify(status).includes(config.description), false)
    }
    metadata(await login(f.service), "1.0.0")
    metadata(await f.service.call("status", {}), "1.0.0")
    metadata(await f.service.readStatus!(), "1.0.0")
    assert.deepEqual(await f.service.readOrchestrator!(), config)
    assert.deepEqual((f.rpc.at(-1) as { orchestrator: unknown }).orchestrator, config)
    const updated = { ...config, version: "1.0.1", prompt: "Updated guidance." }
    f.orchestrator(updated)
    metadata(await f.service.call("refresh", {}), "1.0.1")
    metadata(await f.service.call("status", {}), "1.0.1")
    assert.deepEqual(await f.service.readOrchestrator!(), updated)
    assert.deepEqual((f.rpc.at(-1) as { orchestrator: unknown }).orchestrator, updated)
    f.orchestrator(undefined)
    assert.equal("orchestrator" in (await f.service.call("refresh", {}) as object), false)
    assert.equal("orchestrator" in (await f.service.call("status", {}) as object), false)
    assert.equal(await f.service.readOrchestrator!(), undefined, "older API must not retain stale instructions")
    f.orchestrator(config)
    await f.service.call("refresh", {})
    await f.service.call("logout", {})
    assert.equal(await f.service.readOrchestrator!(), undefined)
    assert.equal(f.rpc.at(-1), null)
  } finally { await f.cleanup() }
})

test("runtime policy includes only the verified installed global managed catalog", async () => {
  const f = await fixture({ autoSync: false })
  const managedCatalog = () => (f.rpc.at(-1) as { managedCatalog: { agents: string[]; skills: string[] } }).managedCatalog
  try {
    await login(f.service)
    assert.deepEqual(managedCatalog(), { agents: [], skills: [] })
    await f.service.call("sync", {})
    assert.deepEqual(managedCatalog(), { agents: ["helper"], skills: ["fixture"] })
    for (const file of input()) {
      const target = path.join(f.globalConfigDir, ...file.path.split("/"))
      await writeFile(target, "Tampered installed instructions.")
      await f.service.call("refresh", {})
      assert.deepEqual(managedCatalog(), { agents: [], skills: [] })
      assert.equal((await f.service.call("status", {}) as { ready: boolean }).ready, true)
      await writeFile(target, file.data)
      await f.service.call("refresh", {})
      assert.deepEqual(managedCatalog(), { agents: ["helper"], skills: ["fixture"] })
    }
    await f.service.call("uninstall", {})
    await f.service.call("refresh", {})
    assert.deepEqual(managedCatalog(), { agents: [], skills: [] })
  } finally { await f.cleanup() }
})

test("invalid API orchestrator fails authentication instead of registering unvalidated instructions", async () => {
  const f = await fixture({ orchestrator: { id: "unknown", prompt: "Unvalidated" }, autoSync: false })
  try {
    await assert.rejects(login(f.service), /INVALID_AUTH_RESPONSE/)
    assert.equal(await f.service.readOrchestrator!(), undefined)
    assert.equal(f.rpc.some(value => value && typeof value === "object" && "orchestrator" in value), false)
  } finally { await f.cleanup() }
})

test("new Chat waits for orchestrator synchronization instead of falling back during refresh", async () => {
  const config = { id: "ame-orchestrator", version: "1.0.0", description: "Global lead", prompt: "Use installed agents.", subagentDepth: 3 }
  const f = await fixture({ orchestrator: config, autoSync: false })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await login(f.service)
    let syncing = false, returned = false
    f.rpcResponse(async () => { syncing = true; await gate; return undefined })
    const refresh = f.service.call("refresh", {})
    for (let i = 0; !syncing && i < 100; i++) await delay(1)
    assert.equal(syncing, true)
    const read = f.service.readOrchestrator!().then(value => { returned = true; return value })
    await delay(5)
    assert.equal(returned, false)
    release()
    await refresh
    assert.deepEqual(await read, config)
    f.rpcResponse(undefined)
  } finally { release(); await f.cleanup() }
})

test("model policy preserves API tiers for agents while locking user chat to the default", () => {
  const levels: ModelLevels = { default: "balanced-v2", haiku: "fast-v1", sonnet: "coding-v3", opus: "reasoning-v4" }
  const value = { ...catalog, default_model: levels.default, small_model: levels.haiku, model_levels: levels,
    models: Object.values(levels).map(id => ({ ...catalog.models[0], id, name: id })) }
  const admin = modelPolicy("admin", value)
  assert.deepEqual(admin.model_levels, levels)
  assert.deepEqual(admin.models.map(model => model.id), Object.values(levels))
  const user = modelPolicy("user", value)
  assert.deepEqual(user.models.map(model => model.id), Object.values(levels))
  assert.deepEqual(user.chat_models.map(model => model.id), [levels.default])
  assert.deepEqual(user.model_levels, levels)
  for (const level of MODEL_LEVELS) {
    assert.equal(resolveModelLevel(admin, `amecode/${level}`), levels[level])
    assert.equal(resolveModelLevel(user, level), levels[level])
  }
  assertModel(user, { providerID: "amecode", id: levels.default })
  assertChatModel(user, { providerID: "amecode", id: levels.default })
  for (const id of [levels.haiku, levels.sonnet, levels.opus]) assertModel(user, { providerID: "amecode", id })
  for (const id of [levels.haiku, levels.sonnet, levels.opus, "haiku", "amecode/opus"])
    assert.throws(() => assertChatModel(user, { providerID: "amecode", id }), /AMECODE_MODEL_NOT_ALLOWED/)
  assert.throws(() => assertModel(admin, { providerID: "other", id: levels.default }), /AMECODE_MODEL_NOT_ALLOWED/)
  assert.deepEqual(modelPolicy("admin", catalog).model_levels, { default: "default", haiku: "other", sonnet: "default", opus: "default" })
  assert.deepEqual(modelPolicy("user", catalog).model_levels, { default: "default", haiku: "other", sonnet: "default", opus: "default" })
})

test("active model catalog is complete while chat and explicitly authorized feature models stay separate", () => {
  const value = { ...catalog, models: [...catalog.models, { ...catalog.models[0], id: "gemini-active", name: "Gemini" }] }
  const user = modelPolicy("user", value, { featureModels: ["other", "missing", "other", "default"] })
  assert.deepEqual(user.active_models.map(model => model.id), ["default", "other", "gemini-active"])
  assert.deepEqual(user.chat_models.map(model => model.id), ["default"])
  assert.deepEqual(user.feature_models, ["other"])
  assert.deepEqual(user.models.map(model => model.id), ["default", "other"])
  assertModel(user, { providerID: "amecode", id: "other" })
  assert.throws(() => assertModel(user, { providerID: "amecode", id: "gemini-active" }), /AMECODE_MODEL_NOT_ALLOWED/)
  const admin = modelPolicy("admin", value)
  assert.deepEqual(admin.active_models, admin.chat_models)
  assert.deepEqual(admin.models, admin.active_models)
})

test("feature authorization reloads runtime policy without unlocking regular prompts or pet models", async () => {
  const f = await fixture({ catalog: { ...catalog, small_model: "default" } })
  try {
    assert.equal(await f.service.authorizeFeatureModel!("other"), null)
    await login(f.service)
    assert.equal(await f.service.authorizeFeatureModel!("missing"), null)
    assert.equal(await f.service.authorizeFeatureModel!("default"), "default")
    const before = f.rpc.length
    assert.deepEqual(await Promise.all([f.service.authorizeFeatureModel!("other"), f.service.authorizeFeatureModel!("other")]), ["other", "other"])
    assert.equal(f.rpc.length, before + 1)
    assert.deepEqual((f.rpc.at(-1) as { featureModels: string[] }).featureModels, ["other"])
    const status = await f.service.call("status", {}) as { models: ReturnType<typeof modelPolicy> }
    assert.deepEqual(status.models.active_models.map(model => model.id), ["default", "other"])
    assert.deepEqual(status.models.chat_models.map(model => model.id), ["default"])
    assert.deepEqual(status.models.feature_models, ["other"])
    assert.deepEqual(status.models.models.map(model => model.id), ["default", "other"])
    await assert.rejects(f.service.generatePetDialogue("other", new AbortController().signal), /AMECODE_MODEL_NOT_ALLOWED/)
    await assert.rejects(f.service.call("assert-model", { modelID: "other" }), /AMECODE_MODEL_NOT_ALLOWED/)
    await f.service.call("logout", {})
    await login(f.service)
    assert.deepEqual((f.rpc.at(-1) as { featureModels: string[] }).featureModels, [])
    assert.equal(await f.service.authorizeFeatureModel!("other"), "other")
    await login(f.service)
    assert.deepEqual((f.rpc.at(-1) as { featureModels: string[] }).featureModels, [])
  } finally { await f.cleanup() }
})

test("feature tier aliases and already-allowed models need no policy RPC", async () => {
  const levels = { default: "default", haiku: "other", sonnet: "other", opus: "other" }
  const f = await fixture({ catalog: { ...catalog, model_levels: levels } })
  try {
    await login(f.service)
    const before = f.rpc.length
    for (const id of ["haiku", "amecode/sonnet", "opus", "other"])
      assert.equal(await f.service.authorizeFeatureModel!(id), "other")
    assert.equal(await f.service.authorizeFeatureModel!("amecode/default"), "default")
    assert.equal(f.rpc.length, before)
    await assert.rejects(f.service.call("assert-ready", { modelID: "other" }), /AMECODE_MODEL_NOT_ALLOWED/)
    await login(f.service)
    await assert.rejects(f.service.generatePetDialogue("other", new AbortController().signal), /AMECODE_MODEL_NOT_ALLOWED/)
  } finally { await f.cleanup() }
})

test("refresh awaits the new global bundle and returns catalog, refresh time and bundle metadata", async () => {
  const f = await fixture({ autoSync: true, commitEnhanceSkill: "fixture" })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const loggedIn = await login(f.service) as { refreshedAt: number }
    assert.ok(loggedIn.refreshedAt > 0)
    await f.service.call("installed", {})
    const packed = await pack(preview(input()), "1.2.4", undefined, { commitEnhanceSkill: "fixture" })
    const next = { ...f.artifact.release, releaseId: randomUUID(), version: "1.2.4", sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] }
    let entered!: () => void
    const downloading = new Promise<void>(resolve => { entered = resolve })
    f.apiResponse(async url => {
      if (url.pathname.endsWith("/latest")) return Response.json({ ...f.artifact.latest, release: next })
      if (url.pathname.endsWith("/download")) { entered(); await gate; return new Response(Uint8Array.from(packed.bytes)) }
    })
    let settled = false
    const refreshing = f.service.call("refresh", {}).then(value => { settled = true; return value })
    await downloading
    assert.equal(settled, false, "refresh must not return before download/install")
    release()
    const result = await refreshing as { refreshedAt: number; models: { version: string }; bundle: Record<string, unknown> }
    assert.equal(result.models.version, "fixture")
    assert.ok(result.refreshedAt >= loggedIn.refreshedAt)
    assert.equal(result.bundle.installedVersion, "1.2.4")
    assert.equal(result.bundle.installedReleaseId, next.releaseId)
    assert.deepEqual(result.bundle.installedFeatures, { commitEnhanceSkill: "fixture" })
    assert.equal(result.bundle.latestVersion, "1.2.4")
    assert.equal(result.bundle.latestReleaseId, next.releaseId)
    assert.ok(Number(result.bundle.checkedAt) > 0)
    assert.equal(result.bundle.autoSyncError, undefined)
  } finally { release(); await f.cleanup() }
})

test("refresh bundle checks fail non-fatally and expose a sanitized warning", async t => {
  for (const failure of ["NO_ACTIVE_RELEASE", "NETWORK_ERROR"]) await t.test(failure, async () => {
    const f = await fixture({ autoSync: true })
    try {
      await login(f.service); await f.service.call("installed", {})
      f.apiResponse(async url => {
        if (!url.pathname.endsWith("/latest")) return undefined
        if (failure === "NETWORK_ERROR") throw new Error("private network details")
        return Response.json({ error: { code: failure } }, { status: 404 })
      })
      const result = await f.service.call("refresh", {}) as { ready: boolean; bundleAutoSyncError?: string; bundle: { installedVersion: string; autoSyncError?: string } }
      assert.equal(result.ready, true)
      assert.equal(result.bundleAutoSyncError, failure)
      assert.equal(result.bundle.autoSyncError, failure)
      assert.equal(result.bundle.installedVersion, "1.2.3")
    } finally { await f.cleanup() }
  })
})

test("model policy rejects invalid roles and incomplete or inconsistent tier catalogs", () => {
  for (const role of [undefined, null, "owner", "Admin"])
    assert.throws(() => modelPolicy(role as never, catalog), /INVALID_ROLE/)
  const levels: ModelLevels = { default: "default", haiku: "other", sonnet: "default", opus: "other" }
  const invalidLevels: unknown[] = [null, {}, { ...levels, default: "other" }]
  for (const level of MODEL_LEVELS) {
    const { [level]: _, ...missing } = levels
    invalidLevels.push(missing, { ...levels, [level]: "" }, { ...levels, [level]: "absent" })
    const parsed = catalogSchema.safeParse({ ...catalog, model_levels: { ...levels, [level]: "absent" } })
    assert.equal(parsed.success, false)
    if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.message === "INVALID_MODEL_DEFAULT"))
  }
  for (const model_levels of invalidLevels) for (const role of ["admin", "user"] as const)
    assert.throws(() => modelPolicy(role, { ...catalog, model_levels }), /INVALID_MODEL_CATALOG/)
})

test("model level parsing accepts only trimmed bare or managed tiers and preserves concrete IDs", () => {
  const policy = modelPolicy("admin", catalog)
  for (const level of MODEL_LEVELS) {
    for (const value of [level, `amecode/${level}`, ` ${level.toUpperCase()} `, ` AMECODE/${level.toUpperCase()} `])
      assert.equal(parseModelLevel(value), level)
  }
  for (const value of [undefined, "", "other/haiku", "amecode/haiku/extra", "amecode/ sonnet", "claude-3-7-sonnet", "haiku-extra"])
    assert.equal(parseModelLevel(value), undefined)
  for (const value of ["claude-3-7-sonnet", " Other-ID ", "other/haiku"])
    assert.equal(resolveModelLevel(policy, value), value)
})

test("AmeKit account role views, fresh prompt authorization, encryption and logout", async () => {
  const f = await fixture()
  try {
    const status = await login(f.service) as { ready: boolean; models: typeof catalog }
    assert.equal(status.ready, true)
    assert.deepEqual(status.models.models.map(model => model.id), ["default", "other"])
    assert.equal(status.models.small_model, "other")
    assert.doesNotMatch(JSON.stringify(status), /fixture-(session-token|provider-key|password)/)
    assert.equal((f.rpc.at(-1) as { role: string }).role, "user")
    assert.doesNotMatch((await readFile(path.join(f.data, "amekit-session.enc"))).toString(), /fixture-session-token/)
    assert.deepEqual(await f.service.call("assert-model", { modelID: "default", providerID: "amecode" }), { modelID: "default", providerID: "amecode" })
    await assert.rejects(f.service.call("assert-model", { modelID: "other" }), /AMECODE_MODEL_NOT_ALLOWED/)
    await assert.rejects(f.service.call("assert-model", { modelID: "default", providerID: "elsewhere" }), /AMECODE_MODEL_NOT_ALLOWED/)
    f.role("admin")
    assert.equal((await f.service.call("refresh", {}) as { models: typeof catalog }).models.models.length, 2)
    await f.service.call("logout", {})
    await assert.rejects(readFile(path.join(f.data, "amekit-session.enc")), { code: "ENOENT" })
    assert.equal(f.rpc.at(-1), null)
    await assert.rejects(f.service.call("assert-model", { modelID: "default" }), /SIGNED_OUT/)
  } finally { await f.cleanup() }
})

test("account login, status and refresh expose role-aware API model levels", async () => {
  const levels: ModelLevels = { default: "default", haiku: "other", sonnet: "other", opus: "other" }
  const f = await fixture({ role: "admin", catalog: { ...catalog, model_levels: levels } })
  try {
    const loggedIn = await login(f.service) as { models: { model_levels: ModelLevels } }
    assert.deepEqual(loggedIn.models.model_levels, levels)
    const status = await f.service.call("status", {}) as typeof loggedIn
    assert.deepEqual(status.models.model_levels, levels)
    f.role("user")
    const refreshed = await f.service.call("refresh", {}) as typeof loggedIn
    assert.deepEqual(refreshed.models.model_levels, levels)
  } finally { await f.cleanup() }
})

test("pet dialogue preserves categorized host contract and enforces admin/user model policy", async t => {
  for (const role of ["admin", "user"] as const) await t.test(role, async () => {
    const f = await fixture({ role })
    try {
      await login(f.service)
      const generate: NonNullable<PetHostOptions["generateDialogue"]> = f.service.generatePetDialogue
      const result = await generate(role === "admin" ? "other" : "default", new AbortController().signal)
      assert.deepEqual(result, localDialogue)
      assert.equal(Array.isArray(result), false, "host requires a DialogueSet, not flattened strings")
      assert.doesNotMatch(JSON.stringify(result), /fixture-(session-token|provider-key|password)/)
      assert.equal(f.requests.filter(request => request === "/v1/chat/completions").length, 1)
      const before = f.requests.length
      await assert.rejects(generate(role === "user" ? "other" : "missing", new AbortController().signal), /AMECODE_MODEL_NOT_ALLOWED/)
      assert.equal(f.requests.length, before, "denied models never refresh or call provider")
      await assert.rejects(f.service.call("generatePetDialogue", { model: "default" }), /UNKNOWN_OPERATION/, "main-only method is not an IPC operation")
    } finally { await f.cleanup() }
  })
})

test("pet dialogue rejects signed-out, unavailable policy and disposed services without provider calls", async t => {
  await t.test("signed-out and disposed", async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.service.generatePetDialogue("default", new AbortController().signal), /AMECODE_LOGIN_REQUIRED/)
      await login(f.service)
      await f.service.dispose()
      const before = f.requests.length
      await assert.rejects(f.service.generatePetDialogue("default", new AbortController().signal), /AMEKIT_DISPOSED/)
      assert.equal(f.requests.length, before)
      assert.equal(f.requests.includes("/v1/chat/completions"), false)
    } finally { await f.cleanup() }
  })
  await t.test("policy synchronization in progress", async () => {
    const f = await fixture()
    let release: (() => void) | undefined
    try {
      await login(f.service)
      const entered = new Promise<void>(resolve => {
        f.rpcResponse(() => new Promise(done => { release = () => done(undefined); resolve() }))
      })
      const refreshing = f.service.call("refresh", {})
      await entered
      try {
        await assert.rejects(f.service.generatePetDialogue("default", new AbortController().signal), /MODEL_POLICY_UNAVAILABLE/)
        assert.equal(f.requests.includes("/v1/chat/completions"), false)
      } finally { f.rpcResponse(); release?.(); await refreshing }
    } finally { release?.(); await f.cleanup() }
  })
  await t.test("missing plugin", async () => {
    const f = await fixture({ plugin: false })
    try {
      await assert.rejects(login(f.service), /MODEL_POLICY_PLUGIN_REQUIRED/)
      await assert.rejects(f.service.generatePetDialogue("default", new AbortController().signal), /AMECODE_LOGIN_REQUIRED/)
      assert.equal(f.requests.includes("/v1/chat/completions"), false)
    } finally { await f.cleanup() }
  })
})

test("pet dialogue waits for encrypted-session restoration and ready policy", async () => {
  const f = await fixture()
  let restored: AmeKit | undefined, release: (() => void) | undefined
  try {
    await login(f.service); await f.service.dispose()
    const entered = new Promise<void>(resolve => {
      f.rpcResponse(() => new Promise(done => { release = () => done(undefined); resolve() }))
    })
    restored = createAmeKit(f.options, f.dependencies)
    let settled = false
    const generating = restored.generatePetDialogue("default", new AbortController().signal).finally(() => { settled = true })
    await entered
    assert.equal(settled, false)
    assert.equal(f.requests.includes("/v1/chat/completions"), false)
    f.rpcResponse(); release?.()
    assert.deepEqual(await generating, localDialogue)
  } finally { f.rpcResponse(); release?.(); await restored?.dispose(); await f.cleanup() }
})

test("pet dialogue rechecks fresh account model policy before provider access", async () => {
  const f = await fixture({ role: "admin" })
  try {
    await login(f.service)
    f.role("user")
    await assert.rejects(f.service.generatePetDialogue("other", new AbortController().signal), /AMECODE_MODEL_NOT_ALLOWED/)
    assert.equal(f.requests.includes("/v1/chat/completions"), false)
    f.disable()
    await assert.rejects(f.service.generatePetDialogue("default", new AbortController().signal), /USER_DISABLED/)
    assert.equal(f.requests.includes("/v1/chat/completions"), false)
  } finally { await f.cleanup() }
})

test("pet dialogue combines caller and service lifetime cancellation", async t => {
  await t.test("already cancelled", async () => {
    const f = await fixture()
    try {
      await login(f.service)
      const caller = new AbortController(); caller.abort()
      const before = f.requests.length
      await assert.rejects(f.service.generatePetDialogue("default", caller.signal), { name: "AbortError" })
      assert.equal(f.requests.length, before)
    } finally { await f.cleanup() }
  })
  for (const cancellation of ["caller", "dispose"] as const) await t.test(cancellation, async () => {
    const f = await fixture()
    try {
      await login(f.service)
      let providerSignal: AbortSignal | undefined
      let started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      f.dialogueResponse(signal => new Promise((_, reject) => {
        providerSignal = signal
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        started()
      }))
      const caller = new AbortController()
      const generating = f.service.generatePetDialogue("default", caller.signal)
      const rejected = assert.rejects(generating, { name: "AbortError" })
      await entered
      if (cancellation === "caller") caller.abort()
      else await f.service.dispose()
      await rejected
      assert.equal(providerSignal?.aborted, true)
      if (cancellation === "caller") {
        f.dialogueResponse(async () => Response.json({ choices: [{ message: { content: JSON.stringify(localDialogue) } }] }))
        assert.deepEqual(await f.service.generatePetDialogue("default", new AbortController().signal), localDialogue)
      }
    } finally { await f.cleanup() }
  })
})

test("usage-prices is read-only, signed-out safe and exposes only validated pricing without credentials", async () => {
  const price = { model_id: "catalog-default", upstream_model_id: "default", provider_route: "amecode", status: "priced",
    price_kind: "catalog_estimate", currency: "USD", unit: "per_1m_tokens", source: { id: "catalog", source_model_id: "default" },
    profiles: { standard: { base: { input: "1", output: "2" }, overrides: [] } }, revision: 1 }
  const f = await fixture({ catalog: { ...catalog, token: "fixture-catalog-token", api_key: "fixture-catalog-key", models: [
    { ...catalog.models[0], pricing: price, api_key: "fixture-model-key" },
    { ...catalog.models[1], pricing: { ...price, upstream_model_id: "other", api_key: "fixture-price-key" } },
  ] } })
  const read = () => f.service.call("usage-prices", {}) as Promise<{ origin: string | null; prices: Record<string, unknown> }>
  try {
    const signedOut = await read()
    assert.equal(signedOut.origin, null)
    assert.deepEqual(Object.keys(signedOut.prices), [])
    await login(f.service)
    const requests = f.requests.length, policies = f.rpc.length
    const stored = await readFile(path.join(f.data, "amekit-session.enc"))
    f.breakStorage(); f.plugin(false); f.disable()
    const result = await read()
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { origin: "http://localhost:3211", prices: { default: price } })
    assert.doesNotMatch(JSON.stringify(result), /fixture-.*(?:token|key|password)|api_key|authorization|credential/)
    assert.equal(f.requests.length, requests, "no refresh or policy update")
    assert.equal(f.rpc.length, policies)
    assert.deepEqual(await readFile(path.join(f.data, "amekit-session.enc")), stored, "no credential persistence")
    await f.service.call("logout", {})
    const loggedOut = await read()
    assert.equal(loggedOut.origin, null)
    assert.deepEqual(Object.keys(loggedOut.prices), [])
  } finally { await f.cleanup() }
})

test("cached account and pricing reads bypass an active operation without unlocking call", async () => {
  const price = { model_id: "catalog-default", upstream_model_id: "default", provider_route: "amecode", status: "priced",
    price_kind: "catalog_estimate", currency: "USD", unit: "per_1m_tokens", source: { id: "catalog", source_model_id: "default" },
    profiles: { standard: { base: { input: "1", output: "2" }, overrides: [] } }, revision: 1 }
  const f = await fixture({ role: "admin", autoSync: false, catalog: { ...catalog, models: [{ ...catalog.models[0], pricing: price }, catalog.models[1]] } })
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const picking = new Promise<void>(resolve => { started = resolve })
  let importing: Promise<unknown> | undefined
  try {
    const loggedIn = await login(f.service)
    f.pickResponse(async () => { started(); await gate; return f.imported })
    importing = f.service.call("import", {})
    await picking
    await assert.rejects(f.service.call("status", {}), /OPERATION_BUSY/)
    await assert.rejects(f.service.call("usage-prices", {}), /OPERATION_BUSY/)
    const requests = f.requests.length, policies = f.rpc.length
    const [status, pricing] = await Promise.all([f.service.readStatus!(), f.service.readUsagePrices!()])
    assert.deepEqual(status, loggedIn, "account and role-aware model policy remain available")
    assert.deepEqual(JSON.parse(JSON.stringify(pricing)), { origin: "http://localhost:3211", prices: { default: price } })
    assert.doesNotMatch(JSON.stringify({ status, pricing }), /fixture-(session-token|provider-key|password)/)
    assert.equal(f.requests.length, requests, "cached reads do not make network requests")
    assert.equal(f.rpc.length, policies, "cached reads do not update policy")
    await assert.rejects(f.service.call("status", {}), /OPERATION_BUSY/, "reads do not release the active operation's mutex")
    release()
    await importing
    assert.deepEqual(await f.service.call("status", {}), loggedIn)
  } finally { release(); await importing?.catch(() => {}); await f.cleanup() }
})

test("cached account and pricing reads are signed-out safe and reject after disposal", async () => {
  const f = await fixture()
  try {
    assert.equal(await f.service.readStatus!(), null)
    const pricing = await f.service.readUsagePrices!()
    assert.equal(pricing.origin, null)
    assert.deepEqual(Object.keys(pricing.prices), [])
    await f.service.dispose()
    await assert.rejects(f.service.readStatus!(), /AMEKIT_DISPOSED/)
    await assert.rejects(f.service.readUsagePrices!(), /AMEKIT_DISPOSED/)
  } finally { await f.cleanup() }
})

test("usage-prices remains available when secure storage is unavailable", async () => {
  const f = await fixture({ encryption: { ...encryption, isEncryptionAvailable: () => false } })
  try {
    const result = await f.service.call("usage-prices", {}) as { origin: string | null; prices: Record<string, unknown> }
    assert.equal(result.origin, null)
    assert.deepEqual(Object.keys(result.prices), [])
  } finally { await f.cleanup() }
})

test("missing owner plugin, disabled account, unknown role and vault failure block prompts", async t => {
  await t.test("owner plugin RPC is never bypassed", async () => {
    const f = await fixture({ plugin: false })
    try {
      await assert.rejects(login(f.service), /MODEL_POLICY_PLUGIN_REQUIRED/)
      assert.equal((await f.service.call("status", {}) as { ready: boolean }).ready, false)
      f.plugin(true)
      await login(f.service)
      f.plugin(false)
      await assert.rejects(f.service.call("assert-model", { modelID: "default" }), /MODEL_POLICY_PLUGIN_REQUIRED/)
      assert.equal(f.requests.some(request => /config|restart/.test(request)), false)
    } finally { await f.cleanup() }
  })
  await t.test("account disabled at prompt-time refresh revokes policy", async () => {
    const f = await fixture()
    try { await login(f.service); f.disable(); await assert.rejects(f.service.call("assert-model", { modelID: "default" }), /USER_DISABLED/); assert.equal(f.rpc.at(-1), null) }
    finally { await f.cleanup() }
  })
  await t.test("unknown role is rejected", async () => {
    const f = await fixture({ role: "superuser" })
    try { await assert.rejects(login(f.service), /INVALID_ROLE/); assert.equal(f.rpc.at(-1), null) } finally { await f.cleanup() }
  })
  await t.test("unavailable encryption has no plaintext fallback", async () => {
    const f = await fixture({ encryption: { ...encryption, isEncryptionAvailable: () => false } })
    try { await assert.rejects(login(f.service), /SESSION_STORAGE_UNAVAILABLE/); assert.equal(f.rpc.at(-1), null); assert.deepEqual(await readdir(f.data), []) }
    finally { await f.cleanup() }
  })
  await t.test("storage failure is sanitized and revokes policy", async () => {
    const f = await fixture()
    try { await login(f.service); f.breakStorage(); await assert.rejects(f.service.call("refresh", {}), /^Error: SESSION_STORAGE_UNAVAILABLE$/); assert.equal(f.rpc.at(-1), null) }
    finally { await f.cleanup() }
  })
})

test("admin import/package/publish/activate require roles and native main confirmations", async () => {
  const f = await fixture()
  try {
    await login(f.service)
    await assert.rejects(f.service.call("import", { root: "C:\\untrusted-renderer-path" }), /FORBIDDEN/)
    assert.equal(f.pickerCount(), 0)
    f.role("admin"); await f.service.call("refresh", {})
    const imported = await f.service.call("import", { root: "C:\\ignored" }) as { folderName: string; files: { path: string; size: number }[] }
    assert.equal(f.pickerCount(), 1); assert.equal(imported.files.length, 2)
    assert.equal(imported.folderName, path.basename(f.imported))
    assert.equal(imported.folderName.includes(path.dirname(f.imported)), false)
    const packaged = await f.service.call("package", { version: "1.2.3" }) as { size: number; bytes?: unknown }
    assert.ok(packaged.size > 0); assert.equal(packaged.bytes, undefined)
    f.confirm(false)
    await assert.rejects(f.service.call("publish", {}), /CANCELLED/)
    assert.equal(f.requests.includes("/v1/amekit/bundles/uploads"), false)
    f.confirm(true)
    assert.equal((await f.service.call("publish", {}) as Release).releaseId, f.artifact.release.releaseId)
    assert.equal(f.requests.some(request => request.endsWith("/activate")), false)
    assert.ok(await f.service.call("history", {}))
    await assert.rejects(f.service.call("activate", { id: f.artifact.release.releaseId, revision: "NaN" }), /INVALID_ACTIVATION/)
    f.confirm(false)
    await assert.rejects(f.service.call("activate", { id: f.artifact.release.releaseId, revision: "1" }), /CANCELLED/)
    f.confirm(true)
    assert.ok(await f.service.call("activate", { id: f.artifact.release.releaseId, revision: "1" }))
    assert.ok(f.dialogs.length >= 4)
  } finally { await f.cleanup() }
})

test("pack deterministically uses level-6 DEFLATE for more than 8.5 MiB of markdown", async () => {
  let seed = 37
  const block = Array.from({ length: 6000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return `- Review documentation example ${seed.toString(16)} before publishing.\n`
  }).join("")
  const data = encode(block.repeat(Math.ceil(3 * 1024 * 1024 / block.length)).slice(0, 3 * 1024 * 1024))
  const source = preview([...input(), ...Array.from({ length: 3 }, (_, i) => ({ path: `skills/fixture/guide-${i}.md`, data }))])
  const first = await pack(source, "1.2.3"), second = await pack(source, "1.2.3")
  assert.ok(first.summary.expandedSize > 8.5 * 1024 * 1024)
  assert.ok(first.bytes.length < 4 * 1024 * 1024)
  assert.deepEqual(first.bytes, second.bytes)
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(await validate(first.bytes, "1.2.3"), first.summary)
  const entries = unzipSync(first.bytes)
  const expected = zipSync(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { level: 6, mtime: new Date(1980, 0, 1) }]])))
  assert.deepEqual(first.bytes, expected)
  assert.equal(new DataView(first.bytes.buffer, first.bytes.byteOffset).getUint16(8, true), 8)
})

test("validate accepts more than 1,023 payload files", async () => {
  const source = preview([...input(), ...Array.from({ length: 1023 }, (_, i) => ({ path: `skills/fixture/doc-${i}.md`, data: encode(`Documentation ${i}.\n`) }))])
  const packed = await pack(source, "1.2.3")
  assert.equal((await validate(packed.bytes, "1.2.3")).fileCount, 1025)
})

test("API release metadata and downloads accept compressed bundles above 8 MiB up to 32 MiB", async () => {
  const f = await fixture()
  try {
    let seed = 123
    const data = new Uint8Array(3 * 1024 * 1024)
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      data[i] = seed & 255
    }
    const packed = await pack(preview([...input(), ...Array.from({ length: 3 }, (_, i) => ({ path: `skills/fixture/data-${i}.bin`, data }))]), "1.2.3")
    assert.ok(packed.bytes.length > 8 * 1024 * 1024 && packed.bytes.length <= MAX_ZIP)
    const release = { ...f.artifact.release, size: packed.bytes.length, sha256: packed.sha256, manifest: packed.summary as Release["manifest"] }
    const api = new AmeApi("http://localhost:3211", async (request, init) => {
      const url = new URL(String(request))
      if (url.pathname.endsWith("/download")) return new Response(Uint8Array.from(packed.bytes))
      if (url.pathname.endsWith("/latest")) return Response.json({ ...f.artifact.latest, release })
      return f.dependencies.fetch!(request, init)
    })
    await api.login("fixture", "fixture-password")
    assert.deepEqual((await api.latest()).release, release)
    const downloaded = await api.download(release)
    assert.deepEqual(await validate(downloaded, release.version), packed.summary)
    assert.equal(await sha256(downloaded), packed.sha256)
    await assert.rejects(api.download({ ...release, size: MAX_ZIP + 1 }), /INVALID_RELEASE/)
  } finally { await f.cleanup() }
})

test("installed verifies managed bundles larger than 64 MiB", async () => {
  const f = await fixture()
  try {
    await login(f.service)
    await f.service.call("sync", { project: "project-id" })
    const statePath = path.join(f.globalConfigDir, ".amekit-release.json")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    const data = encode("Documentation.\n".repeat(Math.ceil(3 * 1024 * 1024 / 15)))
    const hash = await sha256(data)
    for (let i = 0; i < 22; i++) {
      const name = `skills/fixture/guide-${i}.md`
      await writeFile(path.join(f.globalConfigDir, ...name.split("/")), data)
      state.files.push({ path: name, sha256: hash })
    }
    assert.ok(data.length * 22 > 64 * 1024 * 1024)
    await writeFile(statePath, JSON.stringify(state))
    const result = await installedGlobal(f.globalConfigDir, f.globalManagedDir)
    assert.equal(result?.files.length, 24)
    assert.equal(result?.verification, "verified-bytes")
  } finally { await f.cleanup() }
})

test("active-features verifies server archives, reuses current global installs and caches only matching releases", async t => {
  for (const scenario of ["missing", "current", "stale-id", "stale-hash", "other-origin", "changed-file"]) await t.test(scenario, async () => {
    const f = await fixture({ role: "admin", commitEnhanceSkill: "fixture" })
    try {
      await login(f.service)
      if (scenario !== "missing") {
        await f.service.call("sync", {})
        const statePath = path.join(f.globalConfigDir, ".amekit-release.json")
        const state = JSON.parse(await readFile(statePath, "utf8"))
        if (scenario === "stale-id") state.releaseId = randomUUID()
        if (scenario === "stale-hash") state.sha256 = "0".repeat(64)
        if (scenario === "other-origin") state.origin = "http://localhost:9999"
        await writeFile(statePath, JSON.stringify(state))
        if (scenario === "changed-file") await writeFile(path.join(f.globalConfigDir, "skills", "fixture", "SKILL.md"), "Changed locally.")
      }
      f.requests.length = 0
      const expected = { release: f.artifact.release, revision: 1, skills: ["fixture"], features: { commitEnhanceSkill: "fixture" } }
      assert.deepEqual(await f.service.call("active-features", {}), expected)
      assert.deepEqual(await f.service.call("active-features", {}), expected)
      const downloads = () => f.requests.filter(request => request.endsWith("/download")).length
      assert.equal(downloads(), scenario === "current" ? 0 : 1)
      if (scenario === "missing") {
        await f.service.call("import", {})
        await f.service.call("active-features", {})
        assert.equal(downloads(), 2, "resetting the import clears the archive cache")
        await f.service.call("logout", {}); await login(f.service)
        await f.service.call("active-features", {})
        assert.equal(downloads(), 3, "logout clears the archive cache")
        const release = { ...f.artifact.release, releaseId: randomUUID() }
        f.apiResponse(async url => url.pathname.endsWith("/latest") ? Response.json({ ...f.artifact.latest, release }) : undefined)
        assert.deepEqual(await f.service.call("active-features", {}), { ...expected, release })
        assert.equal(downloads(), 4, "a changed active release invalidates the cache")
      }
      assert.equal(f.dialogs.length, 0)
    } finally { await f.cleanup() }
  })
})

test("active-features rejects non-admins, missing active releases and corrupt archives", async t => {
  for (const scenario of ["non-admin", "no-active", "corrupt"]) await t.test(scenario, async () => {
    const f = await fixture({ role: scenario === "non-admin" ? "user" : "admin" })
    try {
      await login(f.service)
      f.apiResponse(async url => {
        if (scenario === "no-active" && url.pathname.endsWith("/latest")) return Response.json({ error: { code: "NO_ACTIVE_RELEASE" } }, { status: 404 })
        if (scenario === "corrupt" && url.pathname.endsWith("/download")) return new Response(new Uint8Array(f.artifact.release.size))
      })
      await assert.rejects(f.service.call("active-features", {}), scenario === "non-admin" ? /FORBIDDEN/ : scenario === "no-active" ? /NO_ACTIVE_RELEASE/ : /HASH_MISMATCH/)
      assert.equal(f.requests.filter(request => request.endsWith("/download")).length, scenario === "corrupt" ? 1 : 0)
    } finally { await f.cleanup() }
  })
})

test("update-features publishes exact server payload bytes without importing, supports drafts and auto-syncs feature readers", async t => {
  for (const mode of ["native", "raw"] as const) for (const activate of ["true", "false"] as const) await t.test(`${mode} ${activate}`, async () => {
    const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
    const f = await fixture({ role: "admin", autoSync: true, onBundleChanged: event => changes.push(event), discover: async (directory, _signal, expected) => ({ agents: (expected?.agents ?? []).map(id => ({ id })), skills: (expected?.skills ?? []).map(id => ({ id, name: id, path: path.join(directory, "skills", id, "SKILL.md") })) }) })
    try {
      const files = [
        ...input(),
        { path: "agents/nested/remote.md", data: encode(mode === "raw" ? "Remote agent without native metadata.\r\n" : "---\r\ndescription: Remote agent\r\nmode: subagent\r\n---\r\nRemote instructions.\r\n") },
        { path: "skills/remote/SKILL.md", data: encode("---\r\nname: remote\r\ndescription: Remote skill\r\n---\r\nRemote checks.\r\n") },
        { path: "skills/remote/assets/data.bin", data: Uint8Array.of(0, 255, 128, 10, 13) },
      ]
      const source = preview(files, [], { compatibilityMode: mode })
      const original = await pack(source, "2.0.0", undefined, { buildNotesSkill: "fixture", buildNotesModel: "default" })
      const originalRelease: Release = { ...f.artifact.release, releaseId: randomUUID(), version: "2.0.0", sha256: original.sha256, size: original.bytes.length, manifest: original.summary as Release["manifest"] }
      const features = { commitEnhanceSkill: "remote", commitEnhanceModel: "other", androidTranslationSkill: "remote", androidTranslationModel: "other", buildNotesSkill: "remote", buildNotesModel: "other" }
      const expected = await pack(source, "2.0.1", undefined, features)
      const release: Release = { ...originalRelease, releaseId: randomUUID(), version: "2.0.1", sha256: expected.sha256, size: expected.bytes.length,       manifest: expected.summary as Release["manifest"] }
      let active = originalRelease, activations = 0
      f.apiResponse(async (url, init) => {
        if (url.pathname.endsWith("/latest")) return Response.json({ release: active, revision: activations ? 8 : 7, activatedAt: 1 })
        if (url.pathname.endsWith("/download")) return new Response(Uint8Array.from(url.pathname.includes(originalRelease.releaseId) ? original.bytes : expected.bytes))
        if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") return Response.json({ releases: [release, originalRelease], active: { release_id: active.releaseId, revision: 7, activated_at: 1 }, nextCursor: null })
        if (url.pathname.endsWith("/content")) {
          const uploaded = unzipSync(init!.body as Uint8Array)
          assert.deepEqual(Object.keys(uploaded).sort(), [...files.map(file => file.path), "manifest.json"].sort())
          for (const file of files) assert.deepEqual(uploaded[file.path], file.data, file.path)
          assert.deepEqual(JSON.parse(new TextDecoder().decode(uploaded["manifest.json"])).features, features)
          assert.deepEqual(init!.body, expected.bytes)
        }
        if (url.pathname === "/v1/amekit/releases" && init?.method === "POST") return Response.json({ release })
        if (url.pathname.endsWith("/activate")) {
          activations++; active = release
          assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 7 })
          return Response.json({ release, revision: 8, activatedAt: 1 })
        }
      })
      await login(f.service)
      await f.service.call("installed", {})
      changes.length = 0; f.events.length = 0
      const payload = Object.fromEntries(Object.entries(features).map(([key, value]) => [key, ` ${value} `]))
      const result = await f.service.call("update-features", { version: "2.0.1", activate, ...payload, ignored: "not-a-feature" }) as { packaged: unknown; release: Release; activated: unknown; revision?: number }
      assert.deepEqual(result.packaged, { summary: expected.summary, size: expected.bytes.length, entries: expected.entries, sha256: expected.sha256 })
      assert.deepEqual(result.release, release)
      assert.equal(f.pickerCount(), 0)
      assert.equal(f.dialogs.length, 1)
      assert.equal(f.messages[0], activate === "true" ? "Cập nhật cấu hình Skill & Model?" : "Xuất bản nháp cấu hình Skill & Model?")
      assert.ok(f.dialogs[0].includes("v2.0.1 từ bản máy chủ v2.0.0 (giữ nguyên 2 agents & 2 skills)"))
      assert.ok(f.events.indexOf("confirm") < f.events.indexOf("POST /v1/amekit/bundles/uploads"))
      assert.equal(activations, activate === "true" ? 1 : 0)
      if (activate === "true") {
        assert.deepEqual(result.activated, { release, revision: 8, activatedAt: 1 })
        assert.equal(result.revision, 8)
        await waitUntil(() => changes.length === 1, "updated features did not auto-sync")
        assert.deepEqual(changes, [{ version: "2.0.1", releaseId: release.releaseId, auto: true, action: "synced" }])
        const skill = { name: "remote", instructions: "Remote checks." }
        assert.deepEqual(await f.service.readCommitEnhanceFeature!(), { skill, model: "other" })
        assert.deepEqual(await f.service.readBuildNotesFeature!(), { skill, model: "other", rawSkillName: "remote" })
        assert.deepEqual(await f.service.readAndroidTranslationFeature!(), { skill: { ...skill, directory: path.join(f.globalConfigDir, "skills", "remote") }, model: "other", rawSkillName: "remote" })
        const downloads = f.requests.filter(request => request.endsWith("/download")).length
        await f.service.call("uninstall", {})
        const current = await f.service.call("active-features", {}) as { features: unknown; skills: string[] }
        assert.deepEqual(current.features, features)
        assert.deepEqual(current.skills, ["fixture", "remote"])
        assert.equal(f.requests.filter(request => request.endsWith("/download")).length, downloads, "published archive remains cached after activation")
      } else {
        assert.equal(result.activated, null)
        assert.equal(changes.length, 0)
        assert.equal((await installedGlobal(f.globalConfigDir, f.globalManagedDir))?.releaseId, originalRelease.releaseId)
        const current = await f.service.call("active-features", {}) as { release: Release; features: unknown }
        assert.equal(current.release.releaseId, originalRelease.releaseId)
        assert.deepEqual(current.features, { buildNotesSkill: "fixture", buildNotesModel: "default" })
      }
    } finally { await f.cleanup() }
  })
})

test("update-features rejects cancellation, invalid selections, non-admins and unverified archives before publishing", async t => {
  for (const scenario of ["cancel", "skill", "activate", "version", "non-admin", "corrupt", "no-active"]) await t.test(scenario, async () => {
    const f = await fixture({ role: scenario === "non-admin" ? "user" : "admin", confirm: scenario !== "cancel" })
    try {
      await login(f.service)
      f.apiResponse(async url => {
        if (scenario === "corrupt" && url.pathname.endsWith("/download")) return new Response(new Uint8Array(f.artifact.release.size))
        if (scenario === "no-active" && url.pathname.endsWith("/latest")) return Response.json({ error: { code: "NO_ACTIVE_RELEASE" } }, { status: 404 })
      })
      const errors = { cancel: /CANCELLED/, skill: /UNKNOWN_BUILD_NOTES_SKILL/, activate: /INVALID_PAYLOAD/, version: /AMEKIT_OPERATION_FAILED/, "non-admin": /FORBIDDEN/, corrupt: /HASH_MISMATCH/, "no-active": /NO_ACTIVE_RELEASE/ }
      await assert.rejects(f.service.call("update-features", { version: scenario === "version" ? "invalid" : "1.2.4", ...(scenario === "skill" ? { buildNotesSkill: "missing" } : {}), ...(scenario === "activate" ? { activate: "yes" } : {}) }), errors[scenario as keyof typeof errors])
      assert.equal(f.dialogs.length, scenario === "cancel" ? 1 : 0)
      assert.equal(f.requests.some(request => request.includes("/uploads") || request.endsWith("/activate")), false)
      assert.equal(f.pickerCount(), 0)
    } finally { await f.cleanup() }
  })
})

test("update-features retries activation conflicts once and preserves published releases on activation errors", async t => {
  for (const scenario of ["retry", "conflict", "failure", "history", "auth", "forbidden", "abort"]) await t.test(scenario, async () => {
    const f = await fixture({ role: "admin" })
    try {
      await login(f.service)
      let histories = 0, activations = 0
      f.apiResponse(async (url, init) => {
        if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") {
          histories++
          if (scenario === "history") return Response.json({ error: { code: "HISTORY_UNAVAILABLE" } }, { status: 500 })
          return Response.json({ releases: [f.artifact.release], active: { release_id: f.artifact.release.releaseId, revision: 10 + histories, activated_at: 1 }, nextCursor: null })
        }
        if (!url.pathname.endsWith("/activate")) return
        activations++
        assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 10 + histories })
        if (scenario === "abort") { void f.service.dispose(); throw new Error("aborted") }
        if (scenario === "auth" || scenario === "forbidden") return Response.json({ error: { code: scenario === "auth" ? "USER_DISABLED" : "FORBIDDEN" } }, { status: scenario === "auth" ? 401 : 403 })
        if (scenario === "failure") return Response.json({ error: { code: "ACTIVATION_UNAVAILABLE" } }, { status: 500 })
        if (activations === 1 || scenario === "conflict") return Response.json({ error: { code: "ACTIVATION_CONFLICT" } }, { status: 409 })
        return Response.json({ ...f.artifact.latest, revision: 13 })
      })
      if (["auth", "forbidden", "abort"].includes(scenario)) {
        await assert.rejects(f.service.call("update-features", { version: "1.2.4" }), scenario === "auth" ? /USER_DISABLED/ : scenario === "forbidden" ? /FORBIDDEN/ : /CANCELLED/)
      } else {
        const result = await f.service.call("update-features", { version: "1.2.4" }) as { release: Release; activated: unknown; revision?: number; activationError?: string }
        assert.deepEqual(result.release, f.artifact.release)
        if (scenario === "retry") { assert.equal(result.revision, 13); assert.ok(result.activated); assert.equal(result.activationError, undefined) }
        else { assert.equal(result.activated, null); assert.equal(result.activationError, scenario === "conflict" ? "ACTIVATION_CONFLICT" : scenario === "history" ? "HISTORY_UNAVAILABLE" : "ACTIVATION_UNAVAILABLE") }
      }
      assert.equal(histories, ["retry", "conflict"].includes(scenario) ? 2 : 1)
      assert.equal(activations, ["retry", "conflict"].includes(scenario) ? 2 : scenario === "history" ? 0 : 1)
      assert.equal(f.events.filter(event => event === "POST /v1/amekit/releases").length, 1)
      assert.equal(f.dialogs.length, 1)
    } finally { await f.cleanup() }
  })
})

test("release confirms once, publishes fresh feature overrides and optionally activates using history revision", async t => {
  for (const activate of ["true", undefined, "false"]) await t.test(activate ?? "default", async () => {
    const f = await fixture({ role: "admin" })
    try {
      await login(f.service); await f.service.call("import", {})
      await f.service.call("package", { version: "1.2.2" })
      const features = { commitEnhanceSkill: "fixture", commitEnhanceModel: "other", androidTranslationSkill: "fixture", androidTranslationModel: "default", buildNotesSkill: "fixture", buildNotesModel: "other" }
      const expected = await pack(preview(input()), "1.2.3", undefined, features)
      const release = { ...f.artifact.release, size: expected.bytes.length, sha256: expected.sha256, manifest: expected.summary as Release["manifest"] }
      let historyCalls = 0, activations = 0
      f.apiResponse(async (url, init) => {
        if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") {
          historyCalls++
          return Response.json({ releases: [release], active: { release_id: null, revision: 17, activated_at: null }, nextCursor: null })
        }
        if (url.pathname === "/v1/amekit/bundles/uploads") {
          assert.equal(JSON.parse(String(init?.body)).sha256, expected.sha256)
        }
        if (url.pathname.endsWith("/content")) assert.deepEqual(init?.body, expected.bytes)
        if (url.pathname === "/v1/amekit/releases" && init?.method === "POST") return Response.json({ release })
        if (url.pathname.endsWith("/activate")) {
          activations++
          assert.equal(url.pathname, `/v1/amekit/releases/${release.releaseId}/activate`)
          assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 17 })
          return Response.json({ release, revision: 18, activatedAt: 2 })
        }
      })
      f.events.length = 0
      const result = await f.service.call("release", { version: "1.2.3", ...features, ...(activate === undefined ? {} : { activate }) })
      const packaged = { summary: expected.summary, size: expected.bytes.length, entries: expected.entries, sha256: expected.sha256 }
      assert.deepEqual(result, activate === "false" ? { packaged, release, activated: null } : { packaged, release, activated: { release, revision: 18, activatedAt: 2 }, revision: 18 })
      assert.equal(f.dialogs.length, 1)
      assert.equal(f.messages[0], activate === "false" ? "Xuất bản bản nháp AmeKit?" : "Phát hành & kích hoạt AmeKit?")
      assert.ok(f.dialogs[0].includes(`v1.2.3 (${expected.bytes.length} bytes, 2 tệp, SHA-256 ${expected.sha256.slice(0, 12)}…)`))
      assert.equal(historyCalls, activate === "false" ? 0 : 1)
      assert.equal(activations, activate === "false" ? 0 : 1)
      assert.deepEqual(f.events.filter(event => event === "confirm" || event.includes("/amekit/")), [
        "confirm", "POST /v1/amekit/bundles/uploads", `PUT /v1/amekit/bundles/uploads/${release.releaseId}/content`,
        `POST /v1/amekit/bundles/uploads/${release.releaseId}/finalize`, "POST /v1/amekit/releases",
        ...(activate === "false" ? [] : ["GET /v1/amekit/releases", `POST /v1/amekit/releases/${release.releaseId}/activate`]),
      ])
      await assert.rejects(f.service.call("publish", {}), /PACKAGE_REQUIRED/)
    } finally { await f.cleanup() }
  })
})

test("release rejects cancellation, invalid input, blocked imports and non-admins before uploading", async t => {
  for (const scenario of ["cancel", "missing", "version", "activate", "features", "blocked", "non-admin"]) await t.test(scenario, async () => {
    const f = await fixture({ role: "admin", confirm: scenario !== "cancel" })
    try {
      await login(f.service)
      if (scenario === "blocked") await writeFile(path.join(f.imported, "agents", "helper.md"), "Missing frontmatter.\n")
      if (scenario !== "missing") await f.service.call("import", {})
      if (scenario === "non-admin") f.role("user")
      const payload = { version: scenario === "version" ? "not-semver" : "1.2.3", ...(scenario === "activate" ? { activate: "yes" } : {}), ...(scenario === "features" ? { commitEnhanceSkill: "missing" } : {}) }
      const error = { cancel: /CANCELLED/, missing: /IMPORT_REQUIRED/, version: /AMEKIT_OPERATION_FAILED/, activate: /INVALID_PAYLOAD/, features: /UNKNOWN_COMMIT_ENHANCE_SKILL/, blocked: /IMPORT_BLOCKED/, "non-admin": /FORBIDDEN/ }[scenario]!
      await assert.rejects(f.service.call("release", payload), error)
      assert.equal(f.dialogs.length, scenario === "cancel" ? 1 : 0)
      assert.equal(f.requests.some(request => request.includes("/uploads") || request.endsWith("/activate")), false)
    } finally { await f.cleanup() }
  })
})

test("release retries activation conflicts once and preserves published releases on activation failures", async t => {
  for (const scenario of ["retry", "conflict", "failure", "history", "auth", "forbidden", "abort"]) await t.test(scenario, async () => {
    const f = await fixture({ role: "admin" })
    try {
      await login(f.service); await f.service.call("import", {})
      let histories = 0, activations = 0
      f.apiResponse(async (url, init) => {
        if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") {
          histories++
          if (scenario === "history") return Response.json({ error: { code: "HISTORY_UNAVAILABLE" } }, { status: 500 })
          return Response.json({ releases: [f.artifact.release], active: { release_id: null, revision: 10 + histories, activated_at: null }, nextCursor: null })
        }
        if (!url.pathname.endsWith("/activate")) return
        activations++
        assert.deepEqual(JSON.parse(String(init?.body)), { expectedRevision: 10 + histories })
        if (scenario === "abort") {
          void f.service.dispose()
          throw new Error("aborted")
        }
        if (scenario === "auth" || scenario === "forbidden") return Response.json({ error: { code: scenario === "auth" ? "USER_DISABLED" : "FORBIDDEN" } }, { status: scenario === "auth" ? 401 : 403 })
        if (scenario === "failure") return Response.json({ error: { code: "ACTIVATION_UNAVAILABLE" } }, { status: 500 })
        if (activations === 1 || scenario === "conflict") return Response.json({ error: { code: "ACTIVATION_CONFLICT" } }, { status: 409 })
        return Response.json({ ...f.artifact.latest, revision: 13 })
      })
      if (["auth", "forbidden", "abort"].includes(scenario)) {
        await assert.rejects(f.service.call("release", { version: "1.2.3" }), scenario === "auth" ? /USER_DISABLED/ : scenario === "forbidden" ? /FORBIDDEN/ : /CANCELLED/)
      } else {
        const result = await f.service.call("release", { version: "1.2.3" }) as { release: Release; activated: unknown; revision?: number; activationError?: string }
        assert.deepEqual(result.release, f.artifact.release)
        if (scenario === "retry") { assert.equal(result.revision, 13); assert.ok(result.activated); assert.equal(result.activationError, undefined) }
        else { assert.equal(result.activated, null); assert.equal(result.activationError, scenario === "conflict" ? "ACTIVATION_CONFLICT" : scenario === "history" ? "HISTORY_UNAVAILABLE" : "ACTIVATION_UNAVAILABLE") }
        await assert.rejects(f.service.call("publish", {}), /PACKAGE_REQUIRED/)
      }
      assert.equal(histories, ["retry", "conflict"].includes(scenario) ? 2 : 1)
      assert.equal(activations, ["retry", "conflict"].includes(scenario) ? 2 : scenario === "history" ? 0 : 1)
      assert.equal(f.events.filter(event => event === "POST /v1/amekit/releases").length, 1)
      assert.equal(f.dialogs.length, 1)
    } finally { await f.cleanup() }
  })
})

test("commit Enhance packaging is opt-in, deterministic and validates manifest feature IDs", async () => {
  const source = preview(input())
  const baseline = await pack(source, "1.2.3")
  const empty = await pack(source, "1.2.3", undefined, { commitEnhanceSkill: " \r\n " })
  assert.deepEqual(empty.bytes, baseline.bytes)
  assert.equal(Object.hasOwn(baseline.summary, "features"), false)
  assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(unzipSync(baseline.bytes)["manifest.json"])), "features"), false)
  const configured = await pack(source, "1.2.3", undefined, { commitEnhanceSkill: " fixture\n" })
  assert.deepEqual(configured.summary.features, { commitEnhanceSkill: "fixture" })
  assert.deepEqual((await validate(configured.bytes, "1.2.3")).features, { commitEnhanceSkill: "fixture" })
  await assert.rejects(pack(source, "1.2.3", undefined, { commitEnhanceSkill: "missing" }), /UNKNOWN_COMMIT_ENHANCE_SKILL/)
  const rewrite = (features: unknown) => {
    const entries = unzipSync(baseline.bytes)
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]))
    entries["manifest.json"] = encode(JSON.stringify({ ...manifest, features }))
    return zipSync(entries)
  }
  await assert.rejects(validate(rewrite({ commitEnhanceSkill: "missing" }), "1.2.3"), /UNKNOWN_COMMIT_ENHANCE_SKILL/)
  for (const features of [null, [], "fixture", { unexpected: true }, { commitEnhanceSkill: "fixture", unexpected: true },
    ...["", ".", "..", "e\u0301", "a".repeat(121), "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\x00b", "a\x1fb", "a\x7fb", 1].map(commitEnhanceSkill => ({ commitEnhanceSkill }))]) {
    await assert.rejects(validate(rewrite(features), "1.2.3"), { name: "ZodError" }, JSON.stringify(features))
  }
  assert.equal(Object.hasOwn(await validate(rewrite({}), "1.2.3"), "features"), false)
  const unicode = input().map(file => ({ ...file, path: file.path.replace("fixture", "kỹ-năng") }))
  const raw = await pack(preview(unicode, [], { compatibilityMode: "raw" }), "1.2.3", undefined, { commitEnhanceSkill: "kỹ-năng" })
  assert.deepEqual(raw.summary.features, { commitEnhanceSkill: "kỹ-năng" })
})

test("commit Enhance facade packages, syncs and reads verified skills without account locking", async () => {
  const f = await fixture({ role: "admin", commitEnhanceSkill: "fixture" })
  let release: (() => void) | undefined
  try {
    const readSkill = f.service.readCommitEnhanceSkill!.bind(f.service)
    assert.equal(await readSkill("project-id"), null)
    assert.equal(await readSkill(""), null)
    assert.equal(await readSkill(), null)
    await assert.rejects(readSkill("not-a-project"), /^Error: AMEKIT_OPERATION_FAILED$/)
    await login(f.service)
    const latest = await f.service.call("latest", {}) as { release: Release }
    assert.deepEqual(latest.release.manifest.features, { commitEnhanceSkill: "fixture" })
    const history = await f.service.call("history", {}) as { releases: Release[] }
    assert.deepEqual(history.releases[0].manifest.features, { commitEnhanceSkill: "fixture" })
    await f.service.call("import", {})
    const packaged = await f.service.call("package", { version: "1.2.3", commitEnhanceSkill: " fixture " }) as { summary: Release["manifest"] }
    assert.deepEqual(packaged.summary.features, { commitEnhanceSkill: "fixture" })
    const published = await f.service.call("publish", {}) as Release
    assert.deepEqual(published.manifest.features, { commitEnhanceSkill: "fixture" })
    await assert.rejects(f.service.call("package", { version: "1.2.3", commitEnhanceSkill: "missing" }), /UNKNOWN_COMMIT_ENHANCE_SKILL/)
    await assert.rejects(f.service.call("publish", {}), /PACKAGE_REQUIRED/)
    const fallback = await f.service.call("package", { version: "1.2.3", commitEnhanceSkill: " " }) as typeof packaged
    assert.equal(Object.hasOwn(fallback.summary, "features"), false)
    for (const operation of ["sync", "installed", "offline"]) {
      const result = await f.service.call(operation, { project: "project-id" }) as { features: unknown }
      assert.deepEqual(result.features, { commitEnhanceSkill: "fixture" })
    }
    const state = JSON.parse(await readFile(path.join(f.globalConfigDir, ".amekit-release.json"), "utf8"))
    assert.deepEqual(state.features, { commitEnhanceSkill: "fixture" })
    const entered = new Promise<void>(resolve => {
      f.sessionResponse(() => new Promise(done => { release = () => done(undefined); resolve() }))
    })
    const refreshing = f.service.call("refresh", {})
    await entered
    try {
      const before = { requests: f.requests.length, rpc: f.rpc.length }
      assert.deepEqual(await readSkill("project-id"), { name: "fixture", instructions: "Run checks." })
      assert.equal(f.requests.length, before.requests)
      assert.equal(f.rpc.length, before.rpc)
    } finally { f.sessionResponse(); release?.(); await refreshing }
    await f.service.call("logout", {})
    const before = f.requests.length
    assert.deepEqual(await readSkill("project-id"), { name: "fixture", instructions: "Run checks." })
    assert.equal(f.requests.length, before)
    const baseline = await bundle()
    const replaced = await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", baseline.release, baseline.packed.bytes, f.dependencies.discover!)
    assert.equal(Object.hasOwn(replaced.state, "features"), false, "syncing an unconfigured bundle clears the old selection")
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(f.globalConfigDir, ".amekit-release.json"), "utf8")), "features"), false)
    assert.equal(await readSkill("project-id"), null)
    await f.service.dispose()
    await assert.rejects(readSkill("project-id"), /AMEKIT_DISPOSED/)
  } finally { f.sessionResponse(); release?.(); await f.cleanup() }
})

test("commit Enhance reader strips frontmatter, preserves markdown, bounds text and strictly decodes UTF-8", async t => {
  const instructions = Array.from({ length: 1000 }, (_, i) => `Review documentation section ${i} before publishing.\n`).join("")
  for (const [name, bytes, expected] of [
    ["CRLF and BOM", encode("\uFEFF---\r\nname: fixture\r\ndescription: Fixture skill\r\n---\r\n\r\n# Tiêu đề\r\nKeep  two spaces.\r\n---\r\nEnd\r\n"), "# Tiêu đề\r\nKeep  two spaces.\r\n---\r\nEnd"],
    ["plain markdown", encode("  # Instructions\n\nKeep markdown.  "), "# Instructions\n\nKeep markdown."],
    ["bounded", encode("---\nname: fixture\ndescription: Fixture skill\n---\n" + instructions.slice(0, 16_001)), instructions.slice(0, 16_000)],
    ["empty", encode("---\nname: fixture\ndescription: Fixture skill\n---\n \r\n"), null],
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28]), undefined],
  ] as const) await t.test(name, async () => {
    const project = await area()
    try {
      const files = input(); files[1].data = bytes
      const packed = await pack(preview(files, [], { compatibilityMode: "raw" }), "1.2.3", undefined, { commitEnhanceSkill: "fixture" })
      const { release } = await bundle("raw")
      await install(project, "http://localhost:3211", { ...release, sha256: packed.sha256, size: packed.bytes.length }, packed.bytes, async () => { throw new Error("MUST_NOT_DISCOVER_RAW") }, undefined, { allowRaw: true })
      if (expected === undefined) await assert.rejects(readCommitEnhanceSkill(project), { name: "TypeError" })
      else assert.deepEqual(await readCommitEnhanceSkill(project), expected ? { name: "fixture", instructions: expected } : null)
    } finally { await rm(project, { recursive: true, force: true }) }
  })
})

test("commit Enhance reader rejects malformed ownership, tampering and linked directories", async () => {
  const f = await fixture({ commitEnhanceSkill: "fixture" })
  try {
    await install(f.project, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    const statePath = path.join(f.project, ".opencode", ".amekit-release.json")
    const original = JSON.parse(await readFile(statePath, "utf8"))
    for (const features of [null, [], "fixture", true, { commitEnhanceSkill: 42 }, { commitEnhanceSkill: "missing" }]) {
      await writeFile(statePath, JSON.stringify({ ...original, features }))
      await assert.rejects(readCommitEnhanceSkill(f.project), /INVALID_OWNERSHIP_STATE/)
    }
    await writeFile(statePath, JSON.stringify({ ...original, features: {} }))
    assert.equal(await readCommitEnhanceSkill(f.project), null)
    const { features: _, ...legacy } = original
    await writeFile(statePath, JSON.stringify(legacy))
    assert.equal(await readCommitEnhanceSkill(f.project), null)
    await writeFile(statePath, JSON.stringify({ ...original, skills: ["Fixture"], features: { commitEnhanceSkill: "Fixture" } }))
    assert.equal(await readCommitEnhanceSkill(f.project), null, "only the exact owned entrypoint is eligible")
    const entrypoint = path.join(f.project, ".opencode", "skills", "fixture", "SKILL.md")
    await writeFile(statePath, JSON.stringify(original))
    await writeFile(entrypoint, "Changed instructions.")
    await assert.rejects(readCommitEnhanceSkill(f.project), /OWNED_FILE_CHANGED/)
    await writeFile(entrypoint, input()[1].data)
    const agent = path.join(f.project, ".opencode", "agents", "helper.md")
    await writeFile(agent, "Changed agent.")
    await assert.rejects(readCommitEnhanceSkill(f.project), /OWNED_FILE_CHANGED/, "all owned files are verified")
    await writeFile(agent, input()[0].data)
    const skillDirectory = path.dirname(entrypoint), linked = path.join(f.folder, "linked-skill")
    await rename(skillDirectory, linked)
    await symlink(linked, skillDirectory, "junction")
    await assert.rejects(readCommitEnhanceSkill(f.project), /REPARSE_CONFIG_REJECTED/)
    await assert.rejects(readCommitEnhanceSkill("relative-project"), /ABSOLUTE_PROJECT_REQUIRED/)
  } finally { await f.cleanup() }
})

test("four bundle features round-trip through API, packaging, install and verified readers", async () => {
  const f = await fixture({ role: "admin" })
  const features = { commitEnhanceSkill: "fixture", commitEnhanceModel: "other", androidTranslationSkill: "fixture", androidTranslationModel: "gemini-active" }
  try {
    await login(f.service)
    await f.service.call("import", {})
    const packaged = await f.service.call("package", { version: "1.2.3", ...Object.fromEntries(Object.entries(features).map(([key, value]) => [key, ` ${value} `])) }) as { summary: Release["manifest"] }
    assert.deepEqual(packaged.summary.features, features)
    const packed = await pack(preview(input()), "1.2.3", undefined, features)
    assert.deepEqual((await validate(packed.bytes, "1.2.3")).features, features)
    const release = { ...f.artifact.release, sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] }
    const authPayload = { session: { token: "token", expires_at: new Date(Date.now() + 60000).toISOString() }, user: { id: "1", username: "admin", name: "Admin", role: "admin" }, provider: { base_url: "http://localhost:3212", api_key: "key" }, catalog, registry: {} }
    let apiFeatures: unknown = features
    const api = new AmeApi("http://localhost:3211", async url => String(url).includes("/latest")
      ? Response.json({ release: { ...release, manifest: { ...release.manifest, features: apiFeatures } }, revision: 1, activatedAt: 1 })
      : Response.json(authPayload))
    await api.login("admin", "password")
    assert.deepEqual((await api.latest()).release.manifest.features, features)
    apiFeatures = { ...features, unexpected: "value" }
    await assert.rejects(api.latest(), /INVALID_API_RESPONSE/)
    const result = await install(f.project, "http://localhost:3211", release, packed.bytes, f.dependencies.discover!)
    assert.deepEqual(result.state.features, features)
    assert.deepEqual(await readBundleFeatures(f.project), features)
    assert.deepEqual(await f.service.readCommitEnhanceFeature!("project-id"), { skill: { name: "fixture", instructions: "Run checks." }, model: "other" })
    const expected = { skill: { name: "fixture", instructions: "Run checks.", directory: path.join(f.project, ".opencode", "skills", "fixture") }, model: "gemini-active", rawSkillName: "fixture" }
    assert.deepEqual(await readAndroidTranslationFeature(f.project), expected)
    assert.deepEqual(await f.service.readAndroidTranslationFeature!("project-id"), expected)
    const entries = unzipSync(packed.bytes), manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]))
    const rewrite = (value: unknown) => zipSync({ ...entries, "manifest.json": encode(JSON.stringify({ ...manifest, features: value })) })
    await assert.rejects(pack(preview(input()), "1.2.3", undefined, { androidTranslationSkill: "missing" }), /UNKNOWN_ANDROID_TRANSLATION_SKILL/)
    await assert.rejects(validate(rewrite({ androidTranslationSkill: "missing" }), "1.2.3"), /UNKNOWN_ANDROID_TRANSLATION_SKILL/)
    for (const key of ["commitEnhanceModel", "androidTranslationModel"] as const) {
      for (const value of ["", "a b", "a/b", "a\n", "a\x00b", "e\u0301", "a".repeat(201), 42])
        await assert.rejects(validate(rewrite({ [key]: value }), "1.2.3"), { name: "ZodError" })
    }
    const statePath = path.join(f.project, ".opencode", ".amekit-release.json"), original = JSON.parse(await readFile(statePath, "utf8"))
    for (const invalid of [{ unexpected: "fixture" }, { androidTranslationSkill: "missing" }, { androidTranslationModel: 1 }, { commitEnhanceModel: "a/b" }]) {
      await writeFile(statePath, JSON.stringify({ ...original, features: invalid }))
      await assert.rejects(readBundleFeatures(f.project), /INVALID_OWNERSHIP_STATE/)
    }
    await writeFile(statePath, JSON.stringify(original))
    await writeFile(path.join(f.project, ".opencode", "skills", "fixture", "SKILL.md"), "tampered")
    await assert.rejects(readAndroidTranslationFeature(f.project), /OWNED_FILE_CHANGED/)
  } finally { await f.cleanup() }
})

test("Build Notes features validate, preserve model-only configuration and reject unknown skills", async () => {
  const f = await fixture({ role: "admin" })
  try {
    await login(f.service); await f.service.call("import", {})
    for (const features of [{ buildNotesSkill: "fixture", buildNotesModel: "other" }, { buildNotesSkill: "fixture" }, { buildNotesModel: "other" }]) {
      const packed = await pack(preview(input()), "1.2.3", undefined, features)
      assert.deepEqual(packed.summary.features, features)
      assert.deepEqual((await validate(packed.bytes, "1.2.3")).features, features)
      const requestFeatures = Object.fromEntries(Object.entries(features).map(([key, value]) => [key, ` ${value} `]))
      const packaged = await f.service.call("package", { version: "1.2.3", ...requestFeatures }) as { summary: Release["manifest"] }
      assert.deepEqual(packaged.summary.features, features)
      const released = await f.service.call("release", { version: "1.2.3", activate: "false", ...requestFeatures }) as { packaged: { summary: Release["manifest"] } }
      assert.deepEqual(released.packaged.summary.features, features)
    }
    const packed = await pack(preview(input()), "1.2.3")
    const entries = unzipSync(packed.bytes), manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]))
    const rewrite = (features: unknown) => zipSync({ ...entries, "manifest.json": encode(JSON.stringify({ ...manifest, features })) })
    await assert.rejects(pack(preview(input()), "1.2.3", undefined, { buildNotesSkill: "missing" }), /UNKNOWN_BUILD_NOTES_SKILL/)
    await assert.rejects(validate(rewrite({ buildNotesSkill: "missing" }), "1.2.3"), /UNKNOWN_BUILD_NOTES_SKILL/)
    await assert.rejects(f.service.call("package", { version: "1.2.3", buildNotesSkill: "missing" }), /UNKNOWN_BUILD_NOTES_SKILL/)
    for (const buildNotesModel of ["", "a b", "a/b", "a\n", "a\x00b", "e\u0301", "a".repeat(201), 42]) {
      await assert.rejects(validate(rewrite({ buildNotesModel }), "1.2.3"), { name: "ZodError" })
    }
  } finally { await f.cleanup() }
})

test("Build Notes verified readers prefer global configuration, preserve model-only defaults and reject tampering", async () => {
  const f = await fixture()
  const expected = { skill: { name: "fixture", instructions: "Run checks." }, model: "other", rawSkillName: "fixture" }
  try {
    assert.deepEqual(await f.service.readBuildNotesFeature!(), { skill: null })
    assert.deepEqual(await readBuildNotesFeature(f.project), { skill: null })
    assert.deepEqual(await readGlobalBuildNotesFeature(f.globalConfigDir, f.globalManagedDir), { skill: null })
    const projectBundle = await pack(preview(input()), "1.2.3", undefined, { buildNotesSkill: "fixture", buildNotesModel: "other" })
    const releaseOf = (packed: typeof projectBundle) => ({ ...f.artifact.release, sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] })
    await install(f.project, "http://localhost:3211", releaseOf(projectBundle), projectBundle.bytes, f.dependencies.discover!)
    assert.deepEqual(await readBuildNotesFeature(f.project), expected)
    assert.deepEqual(await f.service.readBuildNotesFeature!("project-id"), expected)
    for (const features of [{ buildNotesSkill: "fixture", buildNotesModel: "default" }, { buildNotesModel: "default" }, {}]) {
      const packed = await pack(preview(input()), "1.2.3", undefined, features)
      await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", releaseOf(packed), packed.bytes, f.dependencies.discover!)
      const globalExpected = features.buildNotesSkill ? { ...expected, model: "default" } : features.buildNotesModel ? { skill: null, model: "default" } : { skill: null }
      assert.deepEqual(await readGlobalBuildNotesFeature(f.globalConfigDir, f.globalManagedDir), globalExpected)
      for (const projectID of [undefined, "", "project-id", "unknown-project"]) assert.deepEqual(await f.service.readBuildNotesFeature!(projectID), globalExpected)
    }
    await uninstallGlobal(f.globalConfigDir, f.globalManagedDir)
    assert.deepEqual(await f.service.readBuildNotesFeature!("project-id"), expected)
    const statePath = path.join(f.project, ".opencode", ".amekit-release.json"), original = JSON.parse(await readFile(statePath, "utf8"))
    await writeFile(statePath, JSON.stringify({ ...original, features: { buildNotesSkill: "missing" } }))
    await assert.rejects(readBuildNotesFeature(f.project), /INVALID_OWNERSHIP_STATE/)
    await writeFile(statePath, JSON.stringify(original))
    for (const file of input()) {
      const target = path.join(f.project, ".opencode", ...file.path.split("/")); await writeFile(target, "manual edit")
      await assert.rejects(f.service.readBuildNotesFeature!("project-id"), /OWNED_FILE_CHANGED/)
      await writeFile(target, file.data)
    }
    const modelOnly = await pack(preview(input()), "1.2.3", undefined, { buildNotesModel: "other" })
    await install(f.project, "http://localhost:3211", releaseOf(modelOnly), modelOnly.bytes, f.dependencies.discover!)
    assert.deepEqual(await readBuildNotesFeature(f.project), { skill: null, model: "other" })
    assert.deepEqual(await f.service.readBuildNotesFeature!("project-id"), { skill: null, model: "other" })
    await f.service.dispose()
    await assert.rejects(f.service.readBuildNotesFeature!(), /AMEKIT_DISPOSED/)
  } finally { await f.cleanup() }
})

test("Android reader bounds verified instructions separately from commit Enhance and Build Notes", async () => {
  const f = await fixture()
  try {
    const instructions = Array.from({ length: 1000 }, (_, i) => `Review documentation section ${i} before publishing.\n`).join("").slice(0, 33_000)
    const files = input(); files[1].data = encode("---\nname: fixture\ndescription: Fixture\n---\n" + instructions)
    const packed = await pack(preview(files), "1.2.3", undefined, { commitEnhanceSkill: "fixture", androidTranslationSkill: "fixture", buildNotesSkill: "fixture" })
    await install(f.project, "http://localhost:3211", { ...f.artifact.release, sha256: packed.sha256, size: packed.bytes.length }, packed.bytes, f.dependencies.discover!)
    assert.equal((await readCommitEnhanceSkill(f.project))!.instructions.length, 16_000)
    assert.equal((await readAndroidTranslationFeature(f.project)).skill!.instructions.length, 32_000)
    assert.equal((await readBuildNotesFeature(f.project)).skill!.instructions, instructions.slice(0, 16_000))
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", { ...f.artifact.release, sha256: packed.sha256, size: packed.bytes.length }, packed.bytes, f.dependencies.discover!)
    assert.equal((await readGlobalBuildNotesFeature(f.globalConfigDir, f.globalManagedDir)).skill!.instructions, instructions.slice(0, 16_000))
  } finally { await f.cleanup() }
})

test("Android detection is sorted, bounded, abortable and skips cache trees and junctions", async () => {
  const folder = await area(), project = path.join(folder, "project"), outside = path.join(folder, "outside")
  try {
    await mkdir(project); await mkdir(outside)
    assert.deepEqual(await detectAndroidProject(project), { isAndroid: false, stringsFiles: [] })
    for (const relative of ["app/src/main/res/values/strings.xml", "app/src/main/res/values-ja/strings.xml", "node_modules/res/values/strings.xml", "build/res/values/strings.xml", ".opencode/res/values/strings.xml", "one/two/three/four/five/six/res/values/strings.xml"]) {
      const file = path.join(project, ...relative.split("/")); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "<resources/>")
    }
    await mkdir(path.join(outside, "res", "values"), { recursive: true }); await writeFile(path.join(outside, "res", "values", "strings.xml"), "<resources/>")
    await symlink(outside, path.join(project, "linked"), "junction")
    assert.deepEqual(await detectAndroidProject(project), { isAndroid: true, stringsFiles: ["app/src/main/res/values-ja/strings.xml", "app/src/main/res/values/strings.xml"] })
    await rm(path.join(project, "app"), { recursive: true })
    assert.equal((await detectAndroidProject(project)).isAndroid, false)
    await writeFile(path.join(project, "settings.gradle.kts"), "")
    assert.deepEqual(await detectAndroidProject(project), { isAndroid: true, stringsFiles: [] })
    for (let i = 0; i < 55; i++) {
      const file = path.join(project, "res", `values-${String(i).padStart(2, "0")}`, "strings.xml")
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "<resources/>")
    }
    const detected = await detectAndroidProject(project)
    assert.equal(detected.stringsFiles.length, 50)
    assert.equal(detected.stringsFiles.at(-1), "res/values-49/strings.xml")
    const controller = new AbortController(); controller.abort()
    await assert.rejects(detectAndroidProject(project, controller.signal), { name: "AbortError" })
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test("Android prompt embeds verified skill assets and scope on initial and follow-up turns", () => {
  const skill = { name: "android-strings-translation", instructions: "Keep placeholders intact.", directory: "C:\\project\\.opencode\\skills\\android-strings-translation" }
  const initial = buildAndroidTranslationPrompt({ userText: "Translate to ja", isFirstTurn: true, skill, stringsFiles: ["app/res/values/strings.xml"] })
  for (const value of ["[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY]", "/android-strings-translation", skill.instructions, skill.directory, "scripts/strings_tool.py", "references/", "assets/", "app/res/values/strings.xml", "i18n/translation-context.md", ".kt", ".java", ".ts", "Gradle", "Hoàn tất & đóng", "main Chat", "Translate to ja"]) assert.ok(initial.includes(value), value)
  const followup = buildAndroidTranslationPrompt({ userText: "Now scan", isFirstTurn: false, skill, stringsFiles: [] })
  assert.ok(followup.startsWith("[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY]"))
  assert.ok(followup.endsWith("Now scan"))
  assert.ok(!followup.includes(skill.instructions))
})

test("translation lock store atomically persists isolated sessions and permanent locks", async () => {
  const folder = await area(), file = path.join(folder, "locks", "translation-locks.json")
  try {
    const store = createTranslationLockStore(file)
    assert.throws(() => store.isLocked("p", "s"), /TRANSLATION_LOCKS_NOT_LOADED/)
    await store.load()
    assert.equal(store.isLocked("p", "s"), false)
    await Promise.all([store.recordSession("p", "one"), store.recordSession("p", "two"), store.lockSession("p", "one"), store.recordSession("q", "one")])
    assert.equal(store.isTranslationSession("p", "one"), true)
    assert.equal(store.isLocked("q", "one"), false)
    assert.deepEqual(store.lockedSessionIDs("p"), ["one"])
    assert.deepEqual(store.translationSessionIDs("p"), ["one", "two"])
    const detached = store.lockedSessionIDs("p"); detached.length = 0
    assert.equal(store.isLocked("p", "one"), true)
    const reopened = createTranslationLockStore(file); await reopened.load()
    assert.equal(reopened.isLocked("p", "one"), true)
    await reopened.recordSession("p", "one")
    assert.equal(reopened.isLocked("p", "one"), true)
    await reopened.lockSession("p", "new")
    assert.equal(reopened.isTranslationSession("p", "new"), true)
    await reopened.lockSession("__proto__", "constructor")
    assert.equal(reopened.isLocked("__proto__", "constructor"), true)
    await rename(file, file + ".backup")
    await mkdir(file)
    await assert.rejects(reopened.lockSession("p", "failed"), /UNSAFE_TRANSLATION_LOCKS/)
    assert.equal(reopened.isLocked("p", "failed"), false, "failed persistence must not publish an in-memory lock")
    await rm(file, { recursive: true }); await rename(file + ".backup", file)
    await reopened.recordSession("p", "after-failure")
    assert.equal(reopened.isTranslationSession("p", "after-failure"), true, "failed writes must not poison the mutation queue")
    assert.deepEqual(await readdir(path.dirname(file)), ["translation-locks.json"])
    await assert.rejects(reopened.recordSession("", "bad"), /INVALID_TRANSLATION_SESSION/)
    await writeFile(file, JSON.stringify({ sessions: { p: ["one"] }, locked: { p: "one" } }))
    await assert.rejects(createTranslationLockStore(file).load(), /INVALID_TRANSLATION_LOCKS/)
    await rm(file)
    const outside = path.join(folder, "outside.json"); await writeFile(outside, "{}")
    await link(outside, file)
    await assert.rejects(createTranslationLockStore(file).load(), /UNSAFE_TRANSLATION_LOCKS/)
    assert.equal(await readFile(outside, "utf8"), "{}")
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test("raw Claude adaptation preserves body bytes through scan, pack and consented install", async () => {
  const folder = await area(), sourceRoot = path.join(folder, "source"), project = path.join(folder, "project")
  const body = "\r\n# Hỗ trợ Android 🤖\r\nKeep indentation:  two spaces  \r\n---\r\nFinal line without newline"
  const original = encode(`---\r\nname: Helper\r\ndescription: Helpful fixture\r\ntools: [Read, Write, Bash]\r\nmodel: inherit\r\ncolor: green\r\n---\r\n${body}`)
  const files = input(); files[0].data = original
  try {
    await mkdir(project)
    for (const file of files) {
      const target = path.join(sourceRoot, ...file.path.split("/"))
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data)
    }
    for (const options of [{ compatibilityMode: "raw" as const }, { compatibilityMode: "raw" as const, adaptClaudeAgents: false }]) {
      const unchanged = await scan(sourceRoot, undefined, options)
      assert.deepEqual(unchanged.files[0].data, original)
      assert.equal(unchanged.issues.some(issue => issue.severity === "change"), false)
    }
    const adapted = await scan(sourceRoot, undefined, { compatibilityMode: "raw", adaptClaudeAgents: true })
    const text = new TextDecoder().decode(adapted.files[0].data), end = text.indexOf("---\n", 4)
    assert.deepEqual(parse(text.slice(4, end)), { description: "Helpful fixture", mode: "all", color: "#22c55e" })
    assert.deepEqual(encode(text.slice(end + 4)), encode(body))
    assert.deepEqual(adapted.files[1].data, files[1].data, "skills are never adapted")
    assert.deepEqual(files[0].data, original, "preview does not mutate its input")
    assert.deepEqual(await readFile(path.join(sourceRoot, "agents", "helper.md")), Buffer.from(original), "source files are untouched")
    assert.equal(adapted.issues.filter(issue => issue.severity === "error").length, 0)
    assert.deepEqual(adapted.issues.filter(issue => issue.severity === "warning").map(issue => issue.path), [""], "only the existing bundle-level raw compatibility disclaimer remains")
    assert.ok(adapted.issues.some(issue => issue.severity === "change" && /removed name, removed tools, removed model: inherit, color green -> #22c55e, mode: all/.test(issue.reason)))
    const packed = await pack(adapted, "1.2.3")
    assert.deepEqual(packed.summary.compatibility, { mode: "raw", testedOpenCode: [] })
    const { release } = await bundle("raw")
    const result = await install(project, "http://localhost:3211", { ...release, sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] }, packed.bytes, async () => { throw new Error("MUST_NOT_DISCOVER_RAW") }, undefined, { allowRaw: true })
    assert.equal(result.state.verification, "verified-bytes")
    assert.deepEqual(await readFile(path.join(project, ".opencode", "agents", "helper.md")), Buffer.from(adapted.files[0].data))
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test("Claude adaptation handles colors, preserves OpenCode metadata and concrete model warnings", () => {
  const metadata = { description: "Helpful fixture", mode: "subagent", system: "system text", steps: 3, hidden: true, disabled: false,
    permissions: [{ action: "read", resource: "*", effect: "ask" }], request: { headers: { "x-example": "value" }, body: { temperature: 0.5 } } }
  const colors = { green: "#22c55e", blue: "#3b82f6", orange: "#f97316", purple: "#a855f7", red: "#ef4444", yellow: "#eab308", cyan: "#06b6d4", pink: "#ec4899", teal: "#14b8a6", indigo: "#6366f1", amber: "#f59e0b", emerald: "#10b981", violet: "#8b5cf6", rose: "#f43f5e", sky: "#0ea5e9", lime: "#84cc16", gray: "#6b7280", grey: "#6b7280" }
  for (const [color, expected] of [...Object.entries(colors), [" GrEeN ", "#22c55e"], [" #AbC123 ", "#AbC123"], ["unsupported", undefined], ["constructor", undefined], [42, undefined], [null, undefined]]) {
    const files = input(); files[0].data = encode(`---\n${stringify({ ...metadata, color })}---\nBody unchanged.\r\n`)
    const result = preview(files, [], { compatibilityMode: "raw", adaptClaudeAgents: true })
    const text = new TextDecoder().decode(result.files[0].data)
    const value = parse(text.slice(4, text.indexOf("---\n", 4)))
    assert.deepEqual(value, { ...metadata, ...(expected ? { color: expected } : {}) })
    assert.deepEqual(result.issues.filter(issue => issue.path && ["error", "warning"].includes(issue.severity)), [])
  }
  const files = input()
  const valid = preview(files, [], { compatibilityMode: "raw", adaptClaudeAgents: true })
  assert.deepEqual(valid.files[0].data, files[0].data, "already compatible agents need no re-encoding")
  files[0].data = encode("---\ndescription: Helpful fixture\nmodel: claude-3-7-sonnet\n---\nBody\n")
  const pinned = preview(files, [], { compatibilityMode: "raw", adaptClaudeAgents: true })
  assert.match(new TextDecoder().decode(pinned.files[0].data), /model: claude-3-7-sonnet/)
  assert.ok(pinned.issues.some(issue => /pinned model metadata preserved/.test(issue.reason)))
  files[0].data = encode("---\nname: helper\ntools: [Read]\nmodel: ' InHeRiT '\ncolor: blue\n---\nBody\n")
  const invalid = preview(files, [], { compatibilityMode: "raw", adaptClaudeAgents: true })
  assert.deepEqual(invalid.files[0].data, files[0].data, "missing descriptions are not adapted")
  assert.ok(invalid.issues.some(issue => issue.reason === "description required"))
  files[0].data = encode("---\ndescription: Helpful fixture\nmodel: ' InHeRiT '\n---\nBody\n")
  assert.doesNotMatch(new TextDecoder().decode(preview(files, [], { compatibilityMode: "raw", adaptClaudeAgents: true }).files[0].data), /model:/)
})

test("Claude raw-adapt normalizes bare and prefixed tiers without touching instruction bodies", () => {
  for (const level of MODEL_LEVELS) for (const model of [level, ` ${level.toUpperCase()} `, ` AMECODE/${level.toUpperCase()} `, `amecode/${level}`]) {
    const files = input(), body = "\r\nBody unchanged. 🤖\r\nFinal line"
    files[0].data = encode(`---\n${stringify({ description: "Helpful fixture", mode: "subagent", model })}---\n${body}`)
    const result = preview(files, [], { compatibilityMode: "raw", adaptClaudeAgents: true })
    const text = new TextDecoder().decode(result.files[0].data), end = text.indexOf("---\n", 4)
    assert.deepEqual(parse(text.slice(4, end)), { description: "Helpful fixture", mode: "subagent", model: `amecode/${level}` })
    assert.equal(text.slice(end + 4), body)
    assert.deepEqual(result.issues.filter(issue => issue.path && ["error", "warning"].includes(issue.severity)), [])
    if (model !== `amecode/${level}`) assert.ok(result.issues.some(issue => issue.severity === "change" && issue.reason.includes(`model ${model.trim()} -> amecode/${level}`)))
    else assert.deepEqual(result.files[0].data, files[0].data)
  }
})

test("native and raw bundle previews accept only portable managed tier model references cleanly", () => {
  for (const compatibilityMode of ["native", "raw"] as const) {
    for (const level of MODEL_LEVELS) {
      const files = input()
      files[0].data = encode(`---\ndescription: Helpful fixture\nmodel: amecode/${level}\n---\nBody\n`)
      const result = preview(files, [], { compatibilityMode })
      assert.deepEqual(result.files[0].data, files[0].data)
      assert.deepEqual(result.issues.filter(issue => issue.path), [])
    }
    for (const model of ["haiku", "amecode/Opus", "other/sonnet", "claude-3-7-sonnet", "amecode/opus/extra"]) {
      const files = input()
      files[0].data = encode(`---\ndescription: Helpful fixture\nmodel: ${model}\n---\nBody\n`)
      const result = preview(files, [], { compatibilityMode })
      assert.deepEqual(result.files[0].data, files[0].data)
      assert.ok(result.issues.some(issue => compatibilityMode === "raw"
        ? issue.severity === "warning" && /pinned model metadata preserved/.test(issue.reason)
        : issue.severity === "error" && /model dependency requires/.test(issue.reason)))
    }
  }
})

test("Claude adaptation rejects non-raw modes in preview, scan and import payloads", async () => {
  for (const compatibilityMode of [undefined, "native"] as const) {
    assert.throws(() => preview(input(), [], { compatibilityMode, adaptClaudeAgents: true }), /INVALID_COMPATIBILITY_MODE/)
    await assert.rejects(scan("not-absolute", undefined, { compatibilityMode, adaptClaudeAgents: true }), /INVALID_COMPATIBILITY_MODE/)
  }
  const f = await fixture({ role: "admin" })
  try {
    await login(f.service)
    for (const adaptClaudeAgents of ["", "yes", "TRUE", "1"]) await assert.rejects(f.service.call("import", { compatibilityMode: "raw", adaptClaudeAgents }), /INVALID_PAYLOAD/)
    for (const payload of [{ adaptClaudeAgents: "true" }, { compatibilityMode: "native", adaptClaudeAgents: "true" }] as Record<string, string>[]) await assert.rejects(f.service.call("import", payload), /INVALID_COMPATIBILITY_MODE/)
    assert.equal(f.pickerCount(), 0)
    await writeFile(path.join(f.imported, "agents", "helper.md"), "---\nname: Helper\ndescription: Helpful fixture\ntools: [Read]\nmodel: inherit\ncolor: green\n---\nBody\n")
    const imported = await f.service.call("import", { compatibilityMode: "raw", adaptClaudeAgents: "true" }) as { adaptClaudeAgents: boolean; compatibilityMode: string; issues: { severity: string; path: string }[] }
    assert.equal(imported.adaptClaudeAgents, true); assert.equal(imported.compatibilityMode, "raw")
    assert.ok(imported.issues.some(issue => issue.severity === "change"))
    assert.equal(imported.issues.some(issue => issue.path && ["error", "warning"].includes(issue.severity)), false)
    await f.service.call("package", { version: "1.2.3" })
    const unadapted = await f.service.call("import", { compatibilityMode: "raw", adaptClaudeAgents: "false" }) as typeof imported
    assert.equal(unadapted.adaptClaudeAgents, false)
    assert.equal(unadapted.issues.some(issue => issue.severity === "change"), false)
  } finally { await f.cleanup() }
})

test("native global sync needs no confirmation, preserves personal config and supports offline and confirmed uninstall", async () => {
  const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
  const f = await fixture({ confirm: false, onBundleChanged: event => changes.push(event) })
  try {
    await mkdir(f.globalConfigDir, { recursive: true }); await writeFile(path.join(f.globalConfigDir, "personal.json"), "personal")
    await login(f.service)
    type Inventory = { agents: string[]; skills: string[]; fileCount: number; verification: string }
    const checkInventory = (value: Inventory) => {
      assert.deepEqual(value.agents, ["helper"])
      assert.deepEqual(value.skills, ["fixture"])
      assert.equal(value.fileCount, input().length)
    }
    const result = await f.service.call("sync", {}) as Inventory & { changed: boolean }
    assert.equal(result.changed, true); assert.equal(result.verification, "runtime-ready")
    checkInventory(result)
    assert.equal(f.dialogs.length, 0)
    assert.deepEqual(changes, [{ version: "1.2.3", releaseId: f.artifact.release.releaseId, auto: false, action: "synced" }])
    assert.equal(await readFile(path.join(f.globalConfigDir, "personal.json"), "utf8"), "personal")
    assert.deepEqual(await readdir(f.project), [], "global sync never creates project configuration")
    checkInventory(await f.service.call("installed", {}) as Inventory)
    assert.equal((await f.service.call("sync", {}) as { changed: boolean }).changed, false)
    assert.equal(changes.length, 1, "unchanged sync emits no duplicate event")
    await f.service.call("logout", {})
    const before = f.requests.length
    const offline = await f.service.call("offline", {}) as Inventory
    assert.equal(offline.verification, "runtime-ready")
    checkInventory(offline)
    assert.equal(f.requests.length, before)
    await assert.rejects(f.service.call("uninstall", {}), /CANCELLED/)
    assert.ok(await f.service.call("installed", {}))
    f.confirm(true)
    assert.deepEqual(await f.service.call("uninstall", {}), { changed: true })
    assert.equal(await f.service.call("installed", {}), null)
    assert.equal(await readFile(path.join(f.globalConfigDir, "personal.json"), "utf8"), "personal")
    assert.deepEqual(changes.at(-1), { version: "", releaseId: "", auto: false, action: "uninstalled" })
    assert.deepEqual(await f.service.call("uninstall", {}), { changed: false })
    assert.equal(changes.length, 2)
  } finally { await f.cleanup() }
})

test("changed sync and uninstall reload before restoring policy and notifying, while unchanged operations do not reload", async () => {
  const order: string[] = []
  let pluginPolicy: unknown, expectedPolicy: unknown, reloads = 0, reloadFinished = false, failReload = false
  const f = await fixture({
    catalog: { ...catalog, small_model: "default" },
    reloadRuntime: async () => {
      reloads++; order.push("reload"); reloadFinished = false
      pluginPolicy = null
      await delay(1)
      reloadFinished = true; order.push("reloaded")
      if (failReload) throw new Error("transient reload error")
    },
    onBundleChanged: event => {
      assert.equal(reloadFinished, true)
      assert.deepEqual(pluginPolicy, expectedPolicy, "policy/auth must be restored before bundle notification")
      order.push(event.action)
    },
  })
  f.rpcResponse(async () => {
    pluginPolicy = f.rpc.at(-1)
    if (reloads && pluginPolicy !== null) { assert.equal(reloadFinished, true); order.push("policy") }
    return undefined
  })
  try {
    f.expiresAt(Date.now() + 3600_000)
    await login(f.service)
    await f.service.authorizeFeatureModel!("other")
    expectedPolicy = structuredClone(f.rpc.at(-1))
    assert.deepEqual((expectedPolicy as { featureModels: string[] }).featureModels, ["other"])
    Object.assign(expectedPolicy as object, { managedCatalog: { agents: ["helper"], skills: ["fixture"] } })
    assert.equal((await f.service.call("sync", {}) as { changed: boolean }).changed, true)
    assert.deepEqual(order.slice(0, 4), ["reload", "reloaded", "policy", "synced"])
    const before = reloads
    assert.equal((await f.service.call("sync", {}) as { changed: boolean }).changed, false)
    assert.equal(reloads, before)
    order.length = 0; failReload = true
    Object.assign(expectedPolicy as object, { managedCatalog: { agents: [], skills: [] } })
    assert.deepEqual(await f.service.call("uninstall", {}), { changed: true })
    assert.deepEqual(order, ["reload", "reloaded", "policy", "uninstalled"], "uninstall restores policy even when reload rejects and call skips synchronize")
    assert.deepEqual(await f.service.call("uninstall", {}), { changed: false })
    assert.equal(reloads, before + 1)
    await f.service.call("logout", {})
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    expectedPolicy = null; order.length = 0
    const rpcCount = f.rpc.length
    assert.deepEqual(await f.service.call("uninstall", {}), { changed: true })
    assert.deepEqual(order, ["reload", "reloaded", "uninstalled"])
    assert.equal(f.rpc.length, rpcCount, "signed-out uninstall must not attempt authenticated policy restoration")
  } finally { await f.cleanup() }
})

test("auto sync reloads and restores current policy before notification, and skips unchanged bundles", async t => {
  for (const concurrentInstall of [false, true]) await t.test(concurrentInstall ? "unchanged during download" : "changed and already current", async () => {
    const order: string[] = []
    let pluginPolicy: unknown, expectedPolicy: unknown, active = false, reloadFinished = false
    const f = await fixture({ autoSync: true,
      reloadRuntime: async () => {
        order.push("reload"); pluginPolicy = null; reloadFinished = false
        await delay(1)
        reloadFinished = true; order.push("reloaded")
      },
      onBundleChanged: event => {
        assert.equal(reloadFinished, true)
        assert.deepEqual(pluginPolicy, expectedPolicy)
        assert.equal(event.auto, true)
        order.push("notified")
      },
    })
    f.rpcResponse(async () => {
      pluginPolicy = f.rpc.at(-1)
      if (reloadFinished && pluginPolicy !== null) order.push("policy")
      return undefined
    })
    f.apiResponse(async url => {
      if (url.pathname.endsWith("/latest") && !active) return Response.json({ error: { code: "NO_ACTIVE_RELEASE" } }, { status: 404 })
      if (url.pathname.endsWith("/download") && concurrentInstall) {
        await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
      }
      return undefined
    })
    try {
      f.expiresAt(Date.now() + 3600_000)
      await login(f.service)
      await f.service.call("installed", {})
      await f.service.authorizeFeatureModel!("other")
      expectedPolicy = structuredClone(f.rpc.at(-1)); active = true
      Object.assign(expectedPolicy as object, { managedCatalog: { agents: ["helper"], skills: ["fixture"] } })
      await f.service.call("refresh", {})
      await f.service.call("installed", {})
      assert.ok(await installedGlobal(f.globalConfigDir, f.globalManagedDir))
      assert.deepEqual(order, concurrentInstall ? [] : ["reload", "reloaded", "policy", "notified"])
      order.length = 0; reloadFinished = false
      await f.service.call("refresh", {})
      await f.service.call("installed", {})
      assert.deepEqual(order, [], "already-current auto sync must not reload or notify")
      assert.equal((await f.service.call("status", {}) as { ready: boolean }).ready, true)
    } finally { await f.cleanup() }
  })
})

test("global native discovery failure rolls back while admin-selected raw sync requires no extra consent", async t => {
  await t.test("native discovery mismatch restores previous tree", async () => {
    const f = await fixture({ discover: async () => ({ agents: [], skills: [] }) })
    try {
      await mkdir(f.globalConfigDir, { recursive: true }); await writeFile(path.join(f.globalConfigDir, "personal.json"), "unchanged")
      const inode = (await lstat(f.globalConfigDir)).ino
      await login(f.service)
      await assert.rejects(f.service.call("sync", {}), /DISCOVERY_MISMATCH/)
      assert.deepEqual(await readdir(f.globalConfigDir), ["personal.json"])
      assert.equal((await lstat(f.globalConfigDir)).ino, inode)
      assert.equal(await readFile(path.join(f.globalConfigDir, "personal.json"), "utf8"), "unchanged")
      assert.deepEqual(await readdir(f.globalManagedDir), ["owner"])
    } finally { await f.cleanup() }
  })
  await t.test("raw service sync is silent and verified-bytes only", async () => {
    const f = await fixture({ mode: "raw", confirm: false, discover: async () => { throw new Error("MUST_NOT_RUN") } })
    try {
      await login(f.service)
      const result = await f.service.call("sync", {}) as { verification: string }
      assert.equal(result.verification, "verified-bytes")
      assert.equal(f.dialogs.length, 0)
      assert.equal((await f.service.call("offline", {}) as { verification: string }).verification, "verified-bytes")
    } finally { await f.cleanup() }
  })
})

test("global installer updates in place, preserves personal files and tolerates concurrent opencode.json writes", async () => {
  const f = await fixture()
  try {
    await mkdir(path.join(f.globalConfigDir, "agents"), { recursive: true })
    await mkdir(path.join(f.globalConfigDir, "skills", "personal"), { recursive: true })
    const config = path.join(f.globalConfigDir, "opencode.json")
    await writeFile(config, '{"personal":1}')
    await writeFile(path.join(f.globalConfigDir, "agents", "personal.md"), "personal agent")
    await writeFile(path.join(f.globalConfigDir, "skills", "personal", "SKILL.md"), "personal skill")
    await mkdir(path.join(f.globalConfigDir, "skills", "personal", "empty"))
    await mkdir(path.join(f.globalConfigDir, "unrelated", "empty"), { recursive: true })
    const inode = (await lstat(f.globalConfigDir)).ino
    let writes = 0
    const discover: NonNullable<AmeKitDependencies["discover"]> = async (directory, signal, expected, options) => {
      assert.equal(directory, f.globalConfigDir)
      assert.equal(options?.scope, "global")
      await writeFile(config, JSON.stringify({ personal: ++writes }))
      return f.dependencies.discover!(directory, signal, expected, options)
    }
    const first = await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, discover)
    assert.equal(first.changed, true)
    assert.equal(writes, 2, "exercise concurrent writes during prepare and post-activation discovery")
    assert.equal((await lstat(f.globalConfigDir)).ino, inode)
    assert.equal(await readFile(config, "utf8"), '{"personal":2}')
    assert.deepEqual(await readdir(f.globalManagedDir), ["owner"])
    assert.equal(await readFile(path.join(f.globalManagedDir, "owner"), "utf8"), "amekit-poc04\n")
    assert.equal((await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, discover)).changed, false)
    assert.equal((await offlineGlobal(f.globalConfigDir, f.globalManagedDir, discover)).verification, "runtime-ready")
    const files = input().map(file => ({ ...file, path: file.path.replace("agents/helper.md", "agents/replacement.md") }))
    const packed = await pack(preview(files), "1.2.4")
    const release = { ...f.artifact.release, releaseId: randomUUID(), version: "1.2.4", sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] }
    const replacementDiscovery: NonNullable<AmeKitDependencies["discover"]> = async (directory, _signal, expected, options) => {
      assert.equal(options?.scope, "global")
      await writeFile(config, '{"personal":"updated concurrently"}')
      return expected ? { agents: [{ id: "replacement" }], skills: [{ id: "fixture", name: "fixture", path: path.join(directory, "skills", "fixture", "SKILL.md") }] } : { agents: [], skills: [] }
    }
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", release, packed.bytes, replacementDiscovery)
    await assert.rejects(readFile(path.join(f.globalConfigDir, "agents", "helper.md")), { code: "ENOENT" })
    assert.equal((await lstat(f.globalConfigDir)).ino, inode)
    assert.equal(await uninstallGlobal(f.globalConfigDir, f.globalManagedDir), true)
    assert.equal(await uninstallGlobal(f.globalConfigDir, f.globalManagedDir), false)
    assert.equal(await installedGlobal(f.globalConfigDir, f.globalManagedDir), undefined)
    assert.equal((await lstat(f.globalConfigDir)).ino, inode)
    assert.equal(await readFile(config, "utf8"), '{"personal":"updated concurrently"}')
    assert.equal(await readFile(path.join(f.globalConfigDir, "agents", "personal.md"), "utf8"), "personal agent")
    assert.equal(await readFile(path.join(f.globalConfigDir, "skills", "personal", "SKILL.md"), "utf8"), "personal skill")
    assert.equal((await lstat(path.join(f.globalConfigDir, "skills", "personal", "empty"))).isDirectory(), true)
    assert.equal((await lstat(path.join(f.globalConfigDir, "unrelated", "empty"))).isDirectory(), true)
    await assert.rejects(lstat(path.join(f.globalConfigDir, "skills", "fixture")), { code: "ENOENT" })
    assert.deepEqual(await readdir(f.globalManagedDir), ["owner"])
  } finally { await f.cleanup() }
})

test("global failed upgrade restores exact owned bytes without reverting concurrent personal config", async () => {
  const f = await fixture()
  try {
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    const statePath = path.join(f.globalConfigDir, ".amekit-release.json"), state = await readFile(statePath)
    const inode = (await lstat(f.globalConfigDir)).ino
    const files = input(); files[0].data = encode("---\ndescription: Upgraded helper\nmode: subagent\n---\nNew instructions.\n")
    files.push({ path: "skills/fixture/new/reference.md", data: encode("New reference.\n") })
    const packed = await pack(preview(files), "1.2.4")
    const release = { ...f.artifact.release, releaseId: randomUUID(), version: "1.2.4", sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] }
    await assert.rejects(installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", release, packed.bytes, async (_directory, _signal, expected) => {
      if (expected) {
        await writeFile(path.join(f.globalConfigDir, "opencode.json"), '{"external":"keep"}')
        await writeFile(path.join(f.globalConfigDir, "agents", "personal-added.md"), "concurrent personal agent")
      }
      return { agents: [], skills: [] }
    }), /DISCOVERY_MISMATCH/)
    assert.deepEqual(await readFile(statePath), state)
    assert.equal(await readFile(path.join(f.globalConfigDir, "agents", "personal-added.md"), "utf8"), "concurrent personal agent")
    for (const file of input()) assert.deepEqual(await readFile(path.join(f.globalConfigDir, ...file.path.split("/"))), Buffer.from(file.data))
    await assert.rejects(lstat(path.join(f.globalConfigDir, "skills", "fixture", "new")), { code: "ENOENT" })
    assert.equal(await readFile(path.join(f.globalConfigDir, "opencode.json"), "utf8"), '{"external":"keep"}')
    assert.equal((await lstat(f.globalConfigDir)).ino, inode)
    assert.equal((await installedGlobal(f.globalConfigDir, f.globalManagedDir))?.releaseId, f.artifact.release.releaseId)
    assert.deepEqual(await readdir(f.globalManagedDir), ["owner"])
  } finally { await f.cleanup() }
})

test("global rollback failure retains journal, lock and backup for recovery instead of erasing evidence", async () => {
  const f = await fixture()
  try {
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    const agent = path.join(f.globalConfigDir, "agents", "helper.md"), inode = (await lstat(f.globalConfigDir)).ino
    const upgraded = { ...f.artifact.release, releaseId: randomUUID() }
    await assert.rejects(installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", upgraded, f.artifact.packed.bytes, async (_directory, _signal, expected) => {
      if (expected) { await rm(agent); await mkdir(agent) }
      return { agents: [], skills: [] }
    }), /ROLLBACK_FAILED/)
    const entries = await readdir(f.globalManagedDir)
    assert.ok(entries.includes("transaction.json"))
    assert.ok(entries.includes("lock"))
    const backup = entries.find(entry => entry.startsWith("previous-"))
    assert.ok(backup)
    assert.deepEqual(await readFile(path.join(f.globalManagedDir, backup, "agents", "helper.md")), Buffer.from(input()[0].data))
    assert.ok(await readFile(path.join(f.globalManagedDir, backup, ".amekit-release.json")))
    assert.equal((await lstat(f.globalConfigDir)).ino, inode)
    await assert.rejects(installedGlobal(f.globalConfigDir, f.globalManagedDir), /RECOVERY_REQUIRED/)
  } finally { await f.cleanup() }
})

test("global installation rejects personal collisions, ownership changes and unconsented primitive raw installs", async t => {
  for (const collision of ["file", "directory", "agent", "skill"] as const) await t.test(collision, async () => {
    const f = await fixture()
    try {
      await mkdir(f.globalConfigDir, { recursive: true })
      if (collision === "file") {
        await mkdir(path.join(f.globalConfigDir, "agents"))
        await writeFile(path.join(f.globalConfigDir, "agents", "HELPER.md"), "personal")
      }
      if (collision === "directory") await mkdir(path.join(f.globalConfigDir, "agents", "helper.md"), { recursive: true })
      const discover: NonNullable<AmeKitDependencies["discover"]> = async (_directory, _signal, _expected, options) => {
        assert.equal(options?.scope, "global")
        return { agents: collision === "agent" ? [{ id: "HELPER" }] : [], skills: collision === "skill" ? [{ id: "fixture", name: "FIXTURE", path: "personal" }] : [] }
      }
      const expected = { file: /PERSONAL_FILE_COLLISION/, directory: /PERSONAL_DIRECTORY_COLLISION/, agent: /PERSONAL_AGENT_COLLISION/, skill: /PERSONAL_SKILL_COLLISION/ }[collision]
      await assert.rejects(installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, discover), expected)
      assert.equal(await installedGlobal(f.globalConfigDir, f.globalManagedDir), undefined)
      if (collision === "file") assert.equal(await readFile(path.join(f.globalConfigDir, "agents", "HELPER.md"), "utf8"), "personal")
    } finally { await f.cleanup() }
  })
  await t.test("tamper and raw opt-in", async () => {
    const f = await fixture({ mode: "raw" })
    const discover = async () => { throw new Error("MUST_NOT_DISCOVER_RAW") }
    try {
      await assert.rejects(installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, discover), /RAW_INSTALL_CONFIRMATION_REQUIRED/)
      await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, discover, undefined, { allowRaw: true })
      await writeFile(path.join(f.globalConfigDir, "agents", "helper.md"), "manual edit")
      await assert.rejects(installedGlobal(f.globalConfigDir, f.globalManagedDir), /OWNED_FILE_CHANGED/)
      await assert.rejects(uninstallGlobal(f.globalConfigDir, f.globalManagedDir), /OWNED_FILE_CHANGED/)
      assert.equal(await readFile(path.join(f.globalConfigDir, "agents", "helper.md"), "utf8"), "manual edit")
    } finally { await f.cleanup() }
  })
})

test("installer tree scans more than 4096 files for global and retained project primitives", async () => {
  const f = await fixture()
  try {
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    await install(f.project, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    for (const config of [f.globalConfigDir, path.join(f.project, ".opencode")]) {
      const personal = path.join(config, "personal"); await mkdir(personal, { recursive: true })
      for (let start = 0; start < 4200; start += 100) await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(path.join(personal, `${start + offset}.txt`), "personal")))
    }
    assert.equal((await installedGlobal(f.globalConfigDir, f.globalManagedDir))?.files.length, 2)
    assert.equal((await installed(f.project))?.files.length, 2)
  } finally { await f.cleanup() }
})

test("global feature readers work without a project, override legacy settings and reject all owned-file tampering", async () => {
  const f = await fixture()
  const features = { commitEnhanceSkill: "fixture", commitEnhanceModel: "other", androidTranslationSkill: "fixture", androidTranslationModel: "default" }
  try {
    assert.equal(await f.service.readCommitEnhanceSkill!(), null)
    assert.deepEqual(await f.service.readCommitEnhanceFeature!(""), { skill: null })
    assert.deepEqual(await f.service.readAndroidTranslationFeature!(), { skill: null })
    const packed = await pack(preview(input()), "1.2.3", undefined, features)
    const release = { ...f.artifact.release, sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"] }
    await install(f.project, "http://localhost:3211", release, packed.bytes, f.dependencies.discover!)
    assert.deepEqual(await f.service.readCommitEnhanceSkill!("project-id"), { name: "fixture", instructions: "Run checks." })
    assert.deepEqual(await f.service.readCommitEnhanceFeature!("project-id"), { skill: { name: "fixture", instructions: "Run checks." }, model: "other" })
    assert.equal((await f.service.readAndroidTranslationFeature!("project-id")).skill?.directory, path.join(f.project, ".opencode", "skills", "fixture"))
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", release, packed.bytes, f.dependencies.discover!)
    assert.deepEqual(await readGlobalBundleFeatures(f.globalConfigDir, f.globalManagedDir), features)
    assert.deepEqual(await readGlobalCommitEnhanceSkill(f.globalConfigDir, f.globalManagedDir), { name: "fixture", instructions: "Run checks." })
    const android = { skill: { name: "fixture", instructions: "Run checks.", directory: path.join(f.globalConfigDir, "skills", "fixture") }, model: "default", rawSkillName: "fixture" }
    assert.deepEqual(await readGlobalAndroidTranslationFeature(f.globalConfigDir, f.globalManagedDir), android)
    for (const projectID of [undefined, "", "project-id", "another-project"]) {
      assert.deepEqual(await f.service.readCommitEnhanceSkill!(projectID), { name: "fixture", instructions: "Run checks." })
      assert.deepEqual(await f.service.readCommitEnhanceFeature!(projectID), { skill: { name: "fixture", instructions: "Run checks." }, model: "other" })
      assert.deepEqual(await f.service.readAndroidTranslationFeature!(projectID), android)
    }
    for (const file of input()) {
      const target = path.join(f.globalConfigDir, ...file.path.split("/")); await writeFile(target, "manual edit")
      await assert.rejects(f.service.readCommitEnhanceSkill!("project-id"), /OWNED_FILE_CHANGED/)
      await assert.rejects(f.service.readCommitEnhanceFeature!("project-id"), /OWNED_FILE_CHANGED/)
      await assert.rejects(f.service.readAndroidTranslationFeature!("project-id"), /OWNED_FILE_CHANGED/)
      await writeFile(target, file.data)
    }
    await installGlobal(f.globalConfigDir, f.globalManagedDir, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
    assert.equal(await f.service.readCommitEnhanceSkill!("project-id"), null, "active global bundle without selection must not revive legacy features")
    assert.deepEqual(await f.service.readCommitEnhanceFeature!("project-id"), { skill: null })
    assert.deepEqual(await f.service.readAndroidTranslationFeature!("project-id"), { skill: null })
    await uninstallGlobal(f.globalConfigDir, f.globalManagedDir)
    assert.deepEqual(await f.service.readCommitEnhanceFeature!("project-id"), { skill: { name: "fixture", instructions: "Run checks." }, model: "other" })
  } finally { await f.cleanup() }
})

test("legacy detection and confirmed cleanup remove only AmeKit files and empty project directories", async t => {
  for (const personal of [false, true]) await t.test(personal ? "personal files retained" : "empty directories removed", async () => {
    const f = await fixture({ confirm: false })
    try {
      assert.equal(await f.service.call("legacy-installed", { project: "project-id" }), null)
      await install(f.project, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
      if (personal) {
        await writeFile(path.join(f.project, ".opencode", "opencode.json"), '{"personal":true}')
        await mkdir(path.join(f.project, ".opencode", "skills", "personal"))
        await writeFile(path.join(f.project, ".opencode", "skills", "personal", "SKILL.md"), "personal skill")
      }
      const configInode = (await lstat(path.join(f.project, ".opencode"))).ino
      const expected = { version: "1.2.3", releaseId: f.artifact.release.releaseId, fileCount: 2, hasConfigDir: true, hasManagedDir: true }
      assert.deepEqual(await legacyProjectInstalled(f.project), expected)
      assert.deepEqual(await f.service.call("legacy-installed", { project: "project-id" }), { ...expected, projectName: "project" })
      await assert.rejects(f.service.call("clean-legacy", { project: "project-id" }), /CANCELLED/)
      assert.ok(await installed(f.project))
      assert.ok(f.dialogs[0].includes(path.join(f.project, ".opencode")))
      assert.ok(f.dialogs[0].includes(path.join(f.project, ".amekit")))
      f.confirm(true)
      const requests = f.requests.length, policies = f.rpc.length
      assert.deepEqual(await f.service.call("clean-legacy", { project: "project-id" }), { removedFiles: 3, removedOpencodeDir: !personal, removedManagedDir: true })
      assert.equal(f.requests.length, requests, "signed-out cleanup performs no account refresh")
      assert.equal(f.rpc.length, policies)
      assert.equal(await f.service.call("legacy-installed", { project: "project-id" }), null)
      await assert.rejects(lstat(path.join(f.project, ".amekit")), { code: "ENOENT" })
      await assert.rejects(lstat(path.join(f.project, ".opencode", ".amekit-release.json")), { code: "ENOENT" })
      await assert.rejects(lstat(path.join(f.project, ".opencode", "agents", "helper.md")), { code: "ENOENT" })
      if (personal) {
        assert.equal((await lstat(path.join(f.project, ".opencode"))).ino, configInode, "cleanup must not rename or replace .opencode")
        assert.equal(await readFile(path.join(f.project, ".opencode", "opencode.json"), "utf8"), '{"personal":true}')
        assert.equal(await readFile(path.join(f.project, ".opencode", "skills", "personal", "SKILL.md"), "utf8"), "personal skill")
        await assert.rejects(lstat(path.join(f.project, ".opencode", "skills", "fixture")), { code: "ENOENT" })
      } else await assert.rejects(lstat(path.join(f.project, ".opencode")), { code: "ENOENT" })
      assert.deepEqual(await cleanLegacyProject(f.project), { removedFiles: 0, removedOpencodeDir: false, removedManagedDir: false })
    } finally { await f.cleanup() }
  })
})

test("legacy cleanup rejects tampering and unsafe managed leftovers without silently deleting personal data", async t => {
  for (const problem of ["tamper", "state", "lock", "journal", "owner", "personal"] as const) await t.test(problem, async () => {
    const f = await fixture()
    try {
      await install(f.project, "http://localhost:3211", f.artifact.release, f.artifact.packed.bytes, f.dependencies.discover!)
      const managed = path.join(f.project, ".amekit"), statePath = path.join(f.project, ".opencode", ".amekit-release.json"), agent = path.join(f.project, ".opencode", "agents", "helper.md")
      const skill = path.join(f.project, ".opencode", "skills", "fixture", "SKILL.md")
      if (problem === "tamper") await writeFile(skill, "personal edit")
      if (problem === "state") await writeFile(statePath, '{"schema":9}')
      if (problem === "lock") await mkdir(path.join(managed, "lock"))
      if (problem === "journal") await writeFile(path.join(managed, "transaction.json"), "{}")
      if (problem === "owner") await writeFile(path.join(managed, "owner"), "personal owner")
      if (problem === "personal") await writeFile(path.join(managed, "personal.txt"), "personal data")
      const detected = await f.service.call("legacy-installed", { project: "project-id" }) as { modified?: boolean; error?: string; hasManagedDir: boolean }
      if (["tamper", "state", "lock", "journal"].includes(problem)) {
        assert.equal(detected.modified, true)
        assert.match(detected.error!, problem === "tamper" ? /OWNED_FILE_CHANGED/ : problem === "state" ? /INVALID_OWNERSHIP_STATE/ : /RECOVERY_REQUIRED/)
      }
      if (problem === "owner") assert.equal(detected.hasManagedDir, false)
      await assert.rejects(f.service.call("clean-legacy", { project: "project-id" }))
      if (problem === "tamper") {
        const stateBefore = await readFile(statePath)
        await assert.rejects(cleanLegacyProject(f.project), /OWNED_FILE_CHANGED/)
        assert.equal(await readFile(skill, "utf8"), "personal edit")
        assert.deepEqual(await readFile(agent), Buffer.from(input()[0].data), "earlier owned files must not be deleted before validating all owned files")
        assert.deepEqual(await readFile(statePath), stateBefore)
        assert.deepEqual(await readdir(managed), ["owner"])
      }
      if (problem === "personal") assert.equal(await readFile(path.join(managed, "personal.txt"), "utf8"), "personal data")
      if (problem === "owner") assert.equal(await readFile(path.join(managed, "owner"), "utf8"), "personal owner")
      assert.ok((await readdir(managed)).includes("owner"))
    } finally { await f.cleanup() }
  })
  await t.test("owner-only leftovers and unrelated personal project", async () => {
    const f = await fixture()
    try {
      await mkdir(path.join(f.project, ".opencode")); await writeFile(path.join(f.project, ".opencode", "personal.json"), "keep")
      assert.equal(await legacyProjectInstalled(f.project), null)
      await mkdir(path.join(f.project, ".amekit")); await writeFile(path.join(f.project, ".amekit", "owner"), "amekit-poc04\n")
      assert.deepEqual(await legacyProjectInstalled(f.project), { fileCount: 0, hasConfigDir: false, hasManagedDir: true })
      assert.deepEqual(await cleanLegacyProject(f.project), { removedFiles: 0, removedOpencodeDir: false, removedManagedDir: true })
      assert.equal(await readFile(path.join(f.project, ".opencode", "personal.json"), "utf8"), "keep")
    } finally { await f.cleanup() }
  })
})

test("bundle safeguards reject traversal, secrets, collisions, hash mismatch and modified ownership", async () => {
  const folder = await area()
  try {
    for (const name of ["../escape", "agents/CON.md", "skills/a\\b/SKILL.md", "agents/a:stream", "agents/name. "]) assert.throws(() => safePath(name))
    const leaked = preview([...input(), { path: "skills/fixture/secret.txt", data: encode("-----BEGIN PRIVATE KEY-----") }], [], { compatibilityMode: "raw" })
    await assert.rejects(pack(leaked, "1.0.0"), /IMPORT_BLOCKED/)
    const { packed, release } = await bundle()
    const collision = path.join(folder, "collision")
    await mkdir(path.join(collision, ".opencode", "agents"), { recursive: true })
    await writeFile(path.join(collision, ".opencode", "agents", "HELPER.md"), "personal agent")
    await assert.rejects(install(collision, "http://localhost:3211", release, packed.bytes, async () => ({ agents: [], skills: [] })), /PERSONAL_FILE_COLLISION/)
    assert.equal(await readFile(path.join(collision, ".opencode", "agents", "HELPER.md"), "utf8"), "personal agent")
    const discover = async (directory: string, _signal?: AbortSignal, expected?: unknown) => expected ? { agents: [{ id: "helper" }], skills: [{ id: "fixture", name: "fixture", path: path.join(directory, ".opencode", "skills", "fixture", "SKILL.md") }] } : { agents: [], skills: [] }
    await assert.rejects(install(folder, "http://localhost:3211", { ...release, sha256: "0".repeat(64) }, packed.bytes, discover), /HASH_MISMATCH/)
    await install(folder, "http://localhost:3211", release, packed.bytes, discover)
    const agent = path.join(folder, ".opencode", "agents", "helper.md")
    await writeFile(agent, "personal edit")
    await assert.rejects(uninstall(folder), /OWNED_FILE_CHANGED/)
    assert.equal(await readFile(agent, "utf8"), "personal edit")
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test("encrypted session restore and disposal keep credentials main-only", async () => {
  const f = await fixture()
  let restored: AmeKit | undefined
  try {
    await login(f.service); await f.service.dispose()
    restored = createAmeKit(f.options, f.dependencies)
    assert.equal((await restored.call("status", {}) as { ready: boolean }).ready, true)
    await restored.dispose(); await restored.dispose()
    await assert.rejects(restored.call("status", {}), /AMEKIT_DISPOSED/)
    assert.equal(f.rpc.at(-1), null)
  } finally { await restored?.dispose(); await f.cleanup() }
})

async function waitUntil(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < deadline, message)
    await delay(5)
  }
}

async function settledStatus(service: AmeKit) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    try { return await service.call("status", {}) as { ready: boolean; blocker?: string; account?: unknown } }
    catch (error) { if (!(error instanceof Error) || error.message !== "OPERATION_BUSY") throw error }
    await delay(1)
  }
  throw new Error("AmeKit operation did not settle")
}

test("auto sync silently installs on login, refresh, heartbeat, activate and activated release", async t => {
  for (const trigger of ["login", "refresh", "heartbeat", "activate", "release"] as const) await t.test(trigger, async t => {
    if (trigger === "heartbeat") t.mock.timers.enable({ apis: ["setInterval"] })
    const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
    const f = await fixture({ autoSync: true, role: "admin", confirm: trigger === "activate" || trigger === "release", refreshIntervalMs: 100, onBundleChanged: event => changes.push(event) })
    let active = trigger === "login"
    try {
      f.apiResponse(async url => url.pathname.endsWith("/latest") && !active ? Response.json({ error: { code: "NO_ACTIVE_RELEASE" } }, { status: 404 }) : undefined)
      await login(f.service)
      if (trigger !== "login") {
        assert.equal(await f.service.call("installed", {}), null)
        active = true
        if (trigger === "refresh") await f.service.call("refresh", {})
        if (trigger === "heartbeat") { t.mock.timers.tick(100); await settledStatus(f.service) }
        if (trigger === "activate") await f.service.call("activate", { id: f.artifact.release.releaseId, revision: "1" })
        if (trigger === "release") { await f.service.call("import", {}); await f.service.call("release", { version: "1.2.3" }) }
      }
      await waitUntil(() => changes.length === 1, `${trigger} did not auto-install`)
      assert.deepEqual(changes, [{ version: "1.2.3", releaseId: f.artifact.release.releaseId, auto: true, action: "synced" }])
      assert.equal(f.dialogs.length, trigger === "activate" || trigger === "release" ? 1 : 0, "auto-install never adds a confirmation to the initiating action")
      assert.equal((await installedGlobal(f.globalConfigDir, f.globalManagedDir))?.releaseId, f.artifact.release.releaseId)
      assert.deepEqual(await readdir(f.project), [])
      assert.equal((await settledStatus(f.service) as { bundleAutoSyncError?: string }).bundleAutoSyncError, undefined)
    } finally { await f.cleanup() }
  })
})

test("uninstall opt-out survives heartbeats, refresh, login, new releases and application restart until manual sync or install", async t => {
  for (const operation of ["sync", "install"]) await t.test(operation, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const f = await fixture({ autoSync: true, refreshIntervalMs: 100 })
    let service = f.service
    const downloads = () => f.requests.filter(request => request.endsWith("/download")).length
    const absent = async () => assert.equal(await service.call("installed", {}), null)
    const heartbeat = async () => { t.mock.timers.tick(100); await settledStatus(service); await absent() }
    try {
      await login(service)
      assert.ok(await service.call("installed", {}))
      f.confirm(false)
      await assert.rejects(service.call("uninstall", {}), /CANCELLED/)
      assert.ok(await service.call("installed", {}))
      f.confirm(true)
      assert.deepEqual(await service.call("uninstall", {}), { changed: true })
      const count = downloads()
      await heartbeat(); await heartbeat()
      await service.call("refresh", {}); await absent()
      await service.call("logout", {}); await login(service); await absent()
      f.apiResponse(async url => url.pathname.endsWith("/latest") ? Response.json({ ...f.artifact.latest, release: { ...f.artifact.release, releaseId: "dd7c6208-b91c-4360-b6ce-68aa65599ebe" } }) : undefined)
      await heartbeat()
      await service.dispose()
      service = createAmeKit(f.options, f.dependencies)
      await absent() // Wait for ready and its scheduled auto-sync.
      await heartbeat(); await heartbeat()
      assert.equal(downloads(), count, "opt-out prevents every automatic download")
      assert.ok(await service.call(operation, {}), "explicit installation enables the bundle again")
      // Simulate missing files without an explicit opt-out; automatic repair is enabled again.
      await uninstallGlobal(f.globalConfigDir, f.globalManagedDir)
      await service.call("refresh", {})
      assert.ok(await service.call("installed", {}))
      await service.dispose()
      service = createAmeKit(f.options, f.dependencies)
      assert.ok(await service.call("installed", {}), "manual opt-in persists across restart")
    } finally { await service.dispose(); await f.cleanup() }
  })
})

test("bundle opt-out is isolated by account ID and API origin, and another account's sync cannot clear it", async t => {
  for (const boundary of ["account", "origin"]) await t.test(boundary, async () => {
    const f = await fixture({ autoSync: true })
    let other: AmeKit | undefined, restored: AmeKit | undefined
    try {
      await login(f.service); assert.ok(await f.service.call("installed", {}))
      await f.service.call("uninstall", {})
      await f.service.dispose()
      if (boundary === "account") f.account("2", "fixture-b")
      const dependencies = boundary === "origin" ? { ...f.dependencies, fetch: (async (request, init) => f.dependencies.fetch!(String(request).replace("http://localhost:3213", "http://localhost:3211"), init)) as typeof fetch } : f.dependencies
      other = createAmeKit(f.options, dependencies)
      await other.call("login", { server: boundary === "origin" ? "http://localhost:3213" : "http://localhost:3211", username: "fixture-b", password: "fixture-password" })
      assert.ok(await other.call("installed", {}), "another account or endpoint still auto-installs")
      await other.call("sync", {})
      await other.dispose()
      await uninstallGlobal(f.globalConfigDir, f.globalManagedDir)
      f.account("1", "renamed-fixture") // Stable ID, not display name or token, owns the preference.
      restored = createAmeKit(f.options, f.dependencies)
      await login(restored)
      assert.equal(await restored.call("installed", {}), null, "A's opt-out survives B's explicit sync")
    } finally { await other?.dispose(); await restored?.dispose(); await f.cleanup() }
  })
})

test("default refresh interval makes no background session or latest requests", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const f = await fixture({ autoSync: true })
  try {
    await login(f.service)
    assert.ok(await f.service.call("installed", {})) // Drain the login auto-sync first.
    const requests = f.requests.length
    t.mock.timers.tick(600_000)
    await settledStatus(f.service)
    await f.service.call("installed", {})
    assert.deepEqual(f.requests.slice(requests), [], "no periodic session, latest, download or RPC calls")
  } finally { await f.cleanup() }
})

test("single-shot policy leases renew past 24h without polling and honor daily bundle checks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date(2026, 6, 15, 0, 5).getTime() })
  const hour = 60 * 60_000, minute = 60_000
  const f = await fixture({ autoSync: true })
  const count = (suffix: string) => f.requests.filter(request => request.endsWith(suffix)).length
  // Session lifetime exceeds the runtime's maximum 24h policy lease.
  f.expiresAt(Date.now() + 7 * 24 * hour)
  try {
    await login(f.service); await f.service.call("installed", {})
    const sessions = count("/v1/session"), policies = f.rpc.length, latest = count("/latest")
    t.mock.timers.tick(23 * hour)
    await settledStatus(f.service)
    assert.equal(count("/v1/session"), sessions, "no 30s polling or early refresh")
    t.mock.timers.tick(46 * minute)
    assert.equal((await settledStatus(f.service)).ready, true)
    await f.service.call("installed", {})
    assert.equal(count("/v1/session"), sessions + 1)
    assert.equal(f.rpc.length, policies + 1)
    assert.ok(f.rpc.at(-1))
    assert.equal(count("/latest"), latest, "same local day is already checked")
    t.mock.timers.tick(15 * minute)
    assert.ok((await settledStatus(f.service)).account, "account remains ready past 24h")
    assert.equal((await f.service.readStatus!() as { ready: boolean }).ready, true)
    t.mock.timers.tick(23 * hour + 31 * minute)
    assert.equal((await settledStatus(f.service)).ready, true)
    await f.service.call("installed", {})
    assert.equal(count("/v1/session"), sessions + 3, "next lease refresh plus the next-day latest endpoint's authentication guard")
    assert.equal(count("/latest"), latest + 1, "next local day checks once")
    assert.equal(count("/download"), 1, "unchanged bundle is not downloaded again")
  } finally { await f.cleanup() }
})

test("scheduled policy lease retries transient failures twice then revokes without dangling timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const hour = 60 * 60_000, minute = 60_000
  const f = await fixture()
  f.expiresAt(Date.now() + 7 * 24 * hour)
  const sessions = () => f.requests.filter(request => request === "/v1/session").length
  try {
    await login(f.service)
    const before = sessions(), policies = f.rpc.length
    f.sessionResponse(transientResponse(503))
    t.mock.timers.tick(23 * hour + 45 * minute)
    assert.equal((await settledStatus(f.service)).ready, true)
    assert.equal(sessions(), before + 1)
    assert.equal(f.rpc.length, policies, "transient failures cannot renew the policy")
    for (let failure = 2; failure <= 3; failure++) {
      t.mock.timers.tick(5 * minute - 1)
      assert.equal(sessions(), before + failure - 1)
      t.mock.timers.tick(1)
      const status = await settledStatus(f.service)
      assert.equal(sessions(), before + failure)
      assert.equal(status.ready, failure < 3)
      assert.equal(!!status.account, failure < 3)
    }
    assert.equal(f.rpc.at(-1), null)
    const revoked = sessions()
    t.mock.timers.tick(48 * hour); await settledStatus(f.service)
    assert.equal(sessions(), revoked, "revocation clears renewal")
    f.sessionResponse()
    await login(f.service)
    await f.service.call("logout", {})
    const loggedOut = f.requests.length
    t.mock.timers.tick(48 * hour); await settledStatus(f.service)
    assert.equal(f.requests.length, loggedOut, "logout clears renewal")
    f.expiresAt(Date.now() + 7 * 24 * hour)
    await login(f.service)
    await f.service.dispose()
    const disposed = f.requests.length
    t.mock.timers.tick(48 * hour)
    assert.equal(f.requests.length, disposed, "dispose clears renewal")
  } finally { await f.cleanup() }
})

test("ready checks once per local day while manual refresh and sync bypass the daily gate", async () => {
  const f = await fixture()
  let service = f.service
  const day = new Date(2026, 6, 15, 12).getTime()
  let now = day
  const account = { origin: "http://localhost:3211", accountId: "1" }
  const store = dailySyncStore(f.data)
  const count = (suffix: string) => f.requests.filter(request => request.endsWith(suffix)).length
  const restart = async () => {
    await service.dispose()
    service = createAmeKit({ ...f.options, autoSync: true }, { ...f.dependencies, now: () => now })
  }
  try {
    await login(service)
    await restart()
    assert.ok(await service.call("installed", {}), "fresh ready must install even without a prior bundle")
    assert.equal(count("/latest"), 1)
    assert.equal(count("/download"), 1)
    assert.equal(await store.checkedToday(account, now), true)

    await restart()
    const status = await service.call("status", {}) as { bundle?: { installedVersion?: string } }
    assert.equal(status.bundle?.installedVersion, "1.2.3", "startup snapshot survives a skipped ready sync")
    await service.call("installed", {}) // Wait for the scheduled ready gate to finish.
    assert.equal(count("/latest"), 1)
    assert.equal(count("/download"), 1)

    now += 24 * 60 * 60_000
    await restart()
    await service.call("installed", {})
    assert.equal(count("/latest"), 2)
    assert.equal(count("/download"), 1, "current release does not download again")
    assert.equal(await store.checkedToday(account, now), true, "matching release marks the next day")

    await service.call("refresh", {})
    assert.equal(count("/latest"), 3)
    await service.call("sync", {})
    assert.equal(count("/latest"), 4)
    assert.equal(await store.checkedToday(account, now), true)

    await uninstallGlobal(f.globalConfigDir, f.globalManagedDir)
    await restart()
    assert.ok(await service.call("installed", {}), "a daily marker cannot block a missing bundle's installation")
    assert.equal(count("/latest"), 5)
    assert.equal(count("/download"), 3)
  } finally { await service.dispose(); await f.cleanup() }
})

test("daily sync markers use local dates, isolate accounts and fail open for invalid files", async () => {
  const data = await area(), store = dailySyncStore(data)
  const account = { origin: "http://localhost:3211", accountId: "1" }
  const now = new Date(2026, 0, 2, 12).getTime()
  assert.equal(localDayKey(now), "2026-01-02")
  assert.throws(() => localDayKey(NaN), /INVALID_SYNC_DATE/)
  assert.equal(await store.checkedToday(account, now), false)
  await store.markChecked(account, now)
  assert.equal(await store.checkedToday(account, now), true)
  assert.equal(await store.checkedToday(account, now + 24 * 60 * 60_000), false)
  assert.equal(await store.checkedToday({ ...account, accountId: "2" }, now), false)
  assert.equal(await store.checkedToday({ ...account, origin: "http://localhost:3213" }, now), false)
  const directory = path.join(data, "amekit", "daily-sync")
  const files = await readdir(directory)
  assert.equal(files.length, 1, "atomic write leaves no pending files")
  assert.match(files[0], /^[a-f0-9]{64}\.json$/)
  const file = path.join(directory, files[0])
  for (const content of ["{", "null", JSON.stringify({ ...account, accountId: "2", lastCheckedDay: localDayKey(now) }), " ".repeat(64 * 1024 + 1)]) {
    await writeFile(file, content)
    assert.equal(await store.checkedToday(account, now), false)
  }
  await store.markChecked(account, now)
  const alias = path.join(data, "marker-link")
  await link(file, alias)
  assert.equal(await store.checkedToday(account, now), false, "hard-linked markers are unsafe")
  await rm(alias)
  await rm(file)
  await mkdir(file)
  assert.equal(await store.checkedToday(account, now), false, "directories are not markers")
})

test("auto sync restores a saved session at ready and skips downloads for an already-current global release", async () => {
  const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
  const f = await fixture({ confirm: false, onBundleChanged: event => changes.push(event) })
  let restored: AmeKit | undefined
  try {
    await login(f.service); await f.service.dispose()
    assert.equal(f.requests.some(request => request.endsWith("/download")), false, "auto sync remains opt-in")
    restored = createAmeKit({ ...f.options, autoSync: true }, f.dependencies)
    assert.equal((await restored.call("status", {}) as { ready: boolean }).ready, true)
    await waitUntil(() => changes.length === 1, "ready did not restore and auto-install")
    const downloads = f.requests.filter(request => request.endsWith("/download")).length
    const latest = f.requests.filter(request => request.endsWith("/latest")).length
    await restored.call("refresh", {})
    await restored.call("installed", {})
    assert.equal(f.requests.filter(request => request.endsWith("/latest")).length, latest + 1)
    assert.equal(f.requests.filter(request => request.endsWith("/download")).length, downloads)
    assert.equal(changes.length, 1)
    assert.equal(f.dialogs.length, 0)
    await restored.dispose()
    restored = createAmeKit({ ...f.options, autoSync: true }, f.dependencies)
    await restored.call("installed", {})
    assert.equal(f.requests.filter(request => request.endsWith("/download")).length, downloads, "ready with current release also avoids download")
  } finally { await restored?.dispose(); await f.cleanup() }
})

test("auto sync is fire-and-forget and feature reads wait only for local writes, not downloads", async () => {
  let finishDownload: (() => void) | undefined, enteredDownload!: () => void
  const downloadEntered = new Promise<void>(resolve => { enteredDownload = resolve })
  const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
  const f = await fixture({ autoSync: true, commitEnhanceSkill: "fixture", onBundleChanged: event => changes.push(event) })
  try {
    f.apiResponse(async (url, init) => {
      if (!url.pathname.endsWith("/download")) return
      enteredDownload()
      await new Promise<void>((resolve, reject) => {
        finishDownload = resolve
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
      })
      return undefined
    })
    let loggedIn = false
    const loggingIn = login(f.service).then(() => { loggedIn = true })
    await downloadEntered
    await waitUntil(() => loggedIn, "login is blocked by the auto download")
    await loggingIn
    let read = false
    const reading = f.service.readCommitEnhanceSkill!().then(value => { assert.equal(value, null); read = true })
    await waitUntil(() => read, "feature read is blocked by HTTP download")
    await reading
    let installedSettled = false
    const inventory = f.service.call("installed", {}).then(value => { installedSettled = true; return value })
    await delay(10)
    assert.equal(installedSettled, false, "disk bundle operations serialize with auto sync")
    finishDownload!()
    assert.ok(await inventory)
    assert.equal(changes.length, 1)
    assert.deepEqual(await f.service.readCommitEnhanceSkill!(), { name: "fixture", instructions: "Run checks." })
  } finally { finishDownload?.(); await f.cleanup() }
})

test("feature readers wait for local auto-install verification rather than exposing a locked or partial bundle", async () => {
  let releaseDiscovery: (() => void) | undefined, entered!: () => void
  const verifying = new Promise<void>(resolve => { entered = resolve })
  const f = await fixture({ autoSync: true, commitEnhanceSkill: "fixture", discover: async (directory, _signal, expected, options) => {
    assert.equal(options?.scope, "global")
    if (!expected) return { agents: [], skills: [] }
    entered()
    await new Promise<void>(resolve => { releaseDiscovery = resolve })
    return { agents: [{ id: "helper" }], skills: [{ id: "fixture", name: "fixture", path: path.join(directory, "skills", "fixture", "SKILL.md") }] }
  } })
  try {
    await login(f.service); await verifying
    let finished = false
    const reading = Promise.all([f.service.readCommitEnhanceSkill!(), f.service.readCommitEnhanceFeature!(), f.service.readAndroidTranslationFeature!(), f.service.readBuildNotesFeature!()]).finally(() => { finished = true })
    await delay(10)
    assert.equal(finished, false)
    releaseDiscovery!()
    assert.deepEqual(await reading, [{ name: "fixture", instructions: "Run checks." }, { skill: { name: "fixture", instructions: "Run checks." } }, { skill: null }, { skill: null }])
  } finally { releaseDiscovery?.(); await f.cleanup() }
})

test("auto sync keeps no-active and transient latest/download failures quiet and retries on heartbeat", async t => {
  for (const failure of ["no-active", "latest-network", "latest-503", "latest-429", "download-network", "download-503"] as const) await t.test(failure, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
    const f = await fixture({ autoSync: true, confirm: false, refreshIntervalMs: 100, onBundleChanged: event => changes.push(event) })
    let failing = true, attempts = 0
    try {
      f.apiResponse(async url => {
        if (!failing || !(failure.startsWith("download") ? url.pathname.endsWith("/download") : url.pathname.endsWith("/latest"))) return
        attempts++
        if (failure.endsWith("network")) throw new TypeError("fixture network error")
        return Response.json({ error: { code: failure === "no-active" ? "NO_ACTIVE_RELEASE" : "HTTP_ERROR" } }, { status: failure === "no-active" ? 404 : failure.endsWith("429") ? 429 : 503 })
      })
      await login(f.service)
      assert.equal(await f.service.call("installed", {}), null)
      for (let i = 0; i < 2; i++) {
        const status = await settledStatus(f.service) as { ready: boolean; bundleAutoSyncError?: string }
        assert.equal(status.ready, true)
        assert.equal(status.bundleAutoSyncError, undefined)
        t.mock.timers.tick(100); await settledStatus(f.service); await f.service.call("installed", {})
      }
      assert.equal(attempts, 3, "transient failures must not throttle subsequent heartbeats")
      assert.equal(changes.length, 0)
      failing = false
      t.mock.timers.tick(100); await settledStatus(f.service)
      await waitUntil(() => changes.length === 1, "heartbeat did not retry after transient failure")
      assert.equal(f.dialogs.length, 0)
      assert.equal((await settledStatus(f.service) as { bundleAutoSyncError?: string }).bundleAutoSyncError, undefined)
    } finally { await f.cleanup() }
  })
})

test("auto sync latest and download authorization failures revoke the session without warnings or further retries", async t => {
  for (const endpoint of ["latest", "download"] as const) for (const statusCode of [401, 403]) await t.test(`${endpoint} ${statusCode}`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
    const f = await fixture({ autoSync: true, confirm: false, refreshIntervalMs: 100, onBundleChanged: event => changes.push(event) })
    let attempts = 0
    try {
      f.apiResponse(async url => {
        if (!url.pathname.endsWith(`/${endpoint}`)) return
        attempts++
        return Response.json({ error: { code: "USER_DISABLED" } }, { status: statusCode })
      })
      await login(f.service)
      assert.equal(await f.service.call("installed", {}), null)
      const status = await settledStatus(f.service) as { ready: boolean; bundleAutoSyncError?: string }
      assert.equal(status.ready, false)
      assert.equal(status.bundleAutoSyncError, undefined)
      assert.equal(f.rpc.at(-1), null, "authorization failure revokes model policy")
      const requests = f.requests.length
      for (let i = 0; i < 3; i++) { t.mock.timers.tick(100); assert.equal((await settledStatus(f.service)).ready, false) }
      assert.equal(attempts, 1)
      assert.equal(f.requests.length, requests, "suspended session must not continue background requests")
      assert.equal(changes.length, 0)
      assert.equal(f.dialogs.length, 0)
      const vault = await openSessionVault(f.data, encryption)
      assert.equal(await vault.load(), undefined)
    } finally { await f.cleanup() }
  })
})

test("persistent auto-install errors are reported once per release on heartbeats but explicit refresh and new releases retry", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const changes: Parameters<NonNullable<AmeKitOptions["onBundleChanged"]>>[0][] = []
  const f = await fixture({ autoSync: true, confirm: false, refreshIntervalMs: 100, onBundleChanged: event => changes.push(event) })
  let release = f.artifact.release
  try {
    await mkdir(path.join(f.globalConfigDir, "agents"), { recursive: true })
    const personal = path.join(f.globalConfigDir, "agents", "helper.md"); await writeFile(personal, "personal collision")
    f.apiResponse(async url => url.pathname.endsWith("/latest") ? Response.json({ ...f.artifact.latest, release }) : undefined)
    await login(f.service)
    assert.equal(await f.service.call("installed", {}), null)
    const downloadCount = () => f.requests.filter(request => request.endsWith("/download")).length
    const status = () => settledStatus(f.service) as Promise<{ ready: boolean; bundleAutoSyncError?: string }>
    assert.equal((await status()).bundleAutoSyncError, "PERSONAL_AGENT_COLLISION")
    assert.equal(downloadCount(), 1)
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(100); await status(); await f.service.call("installed", {}) }
    assert.equal(downloadCount(), 1, "same failed release is not downloaded every heartbeat")
    assert.equal(await readFile(personal, "utf8"), "personal collision")
    await f.service.call("refresh", {}); await f.service.call("installed", {})
    assert.equal(downloadCount(), 2, "explicit refresh may retry the failed release")
    release = { ...release, releaseId: randomUUID() }
    t.mock.timers.tick(100); await status(); await f.service.call("installed", {})
    assert.equal(downloadCount(), 3, "a different release bypasses failure throttling")
    await rm(personal)
    await f.service.call("refresh", {})
    await waitUntil(() => changes.length === 1, "explicit refresh did not recover from collision")
    assert.equal((await status()).bundleAutoSyncError, undefined)
    assert.equal((await f.service.call("installed", {}) as { releaseId: string }).releaseId, release.releaseId)
    assert.equal(f.dialogs.length, 0)
    await writeFile(personal, "tampered owned file")
    release = { ...release, releaseId: randomUUID() }
    await f.service.call("refresh", {})
    await waitUntil(async () => (await status()).bundleAutoSyncError === "OWNED_FILE_CHANGED", "tamper warning was not recorded")
    const downloads = downloadCount(), latestCount = f.requests.filter(request => request.endsWith("/latest")).length
    t.mock.timers.tick(100); await status()
    await waitUntil(() => f.requests.filter(request => request.endsWith("/latest")).length > latestCount, "heartbeat did not inspect latest")
    assert.equal(downloadCount(), downloads)
    await f.service.call("logout", {})
    assert.equal((await status()).bundleAutoSyncError, undefined)
  } finally { await f.cleanup() }
})

test("manual sync clears persistent auto-sync warnings and draft releases never auto-install", async t => {
  await t.test("manual recovery", async () => {
    const f = await fixture({ autoSync: true, confirm: false })
    try {
      await mkdir(path.join(f.globalConfigDir, "agents"), { recursive: true })
      const target = path.join(f.globalConfigDir, "agents", "helper.md"); await writeFile(target, "personal")
      await login(f.service); await f.service.call("installed", {})
      assert.equal((await settledStatus(f.service) as { bundleAutoSyncError?: string }).bundleAutoSyncError, "PERSONAL_AGENT_COLLISION")
      await rm(target)
      await f.service.call("sync", {})
      assert.equal((await settledStatus(f.service) as { bundleAutoSyncError?: string }).bundleAutoSyncError, undefined)
      assert.equal(f.dialogs.length, 0)
    } finally { await f.cleanup() }
  })
  await t.test("draft publication", async () => {
    const f = await fixture({ autoSync: true, role: "admin" })
    try {
      f.apiResponse(async url => url.pathname.endsWith("/latest") ? Response.json({ error: { code: "NO_ACTIVE_RELEASE" } }, { status: 404 }) : undefined)
      await login(f.service); await f.service.call("installed", {})
      const latest = f.requests.filter(request => request.endsWith("/latest")).length
      await f.service.call("import", {})
      await f.service.call("release", { version: "1.2.3", activate: "false" })
      assert.equal(await f.service.call("installed", {}), null)
      assert.equal(f.requests.filter(request => request.endsWith("/latest")).length, latest)
      assert.equal(f.requests.some(request => request.endsWith("/download")), false)
      assert.equal(f.dialogs.length, 1)
    } finally { await f.cleanup() }
  })
})

const transientResponse = (failure: number | "network") => async () => {
  if (failure === "network") throw new TypeError("fixture network failure")
  return Response.json({ error: { code: "HTTP_ERROR" } }, { status: failure })
}

test("background heartbeats tolerate only two transient failures without revoking or renewing", async t => {
  for (const failure of [503, "network", 429] as const) await t.test(String(failure), async t => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const f = await fixture({ refreshIntervalMs: 100 })
    try {
      await login(f.service)
      const policyCalls = f.rpc.length
      f.sessionResponse(transientResponse(failure))
      for (let tick = 1; tick <= 3; tick++) {
        t.mock.timers.tick(100)
        const status = await settledStatus(f.service)
        assert.equal(status.ready, tick < 3)
        assert.equal(status.blocker, failure === "network" ? "NETWORK_ERROR" : "HTTP_ERROR")
        if (tick < 3) { assert.ok(status.account); assert.equal(f.rpc.length, policyCalls, "neither revoke nor lease renewal") }
        else { assert.equal(status.account, undefined); assert.deepEqual(f.rpc.slice(policyCalls), [null]) }
      }
    } finally { await f.cleanup() }
  })
})

test("a successful background heartbeat renews policy and resets the consecutive failure budget", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const f = await fixture({ refreshIntervalMs: 100 })
  const tick = async () => { t.mock.timers.tick(100); return settledStatus(f.service) }
  try {
    await login(f.service)
    const policyCalls = f.rpc.length
    f.sessionResponse(transientResponse(503))
    await tick(); await tick()
    f.sessionResponse()
    assert.equal((await tick()).ready, true)
    assert.equal(f.rpc.length, policyCalls + 1)
    assert.notEqual(f.rpc.at(-1), null)
    f.sessionResponse(transientResponse("network"))
    assert.equal((await tick()).ready, true)
    assert.equal((await tick()).ready, true)
    assert.equal(f.rpc.length, policyCalls + 1)
    assert.equal((await tick()).ready, false)
    assert.equal(f.rpc.at(-1), null)
  } finally { await f.cleanup() }
})

test("background auth, policy, storage and malformed-response failures revoke immediately", async t => {
  for (const failure of ["disabled", "forbidden", "role", "plugin", "storage", "invalid", "oversized"] as const) await t.test(failure, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const f = await fixture({ refreshIntervalMs: 100 })
    try {
      await login(f.service)
      const policyCalls = f.rpc.length
      if (failure === "disabled") f.disable()
      if (failure === "forbidden") f.sessionResponse(async () => Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }))
      if (failure === "role") f.role("invalid")
      if (failure === "plugin") f.plugin(false)
      if (failure === "storage") f.breakStorage()
      if (failure === "invalid") f.sessionResponse(async () => Response.json({}))
      if (failure === "oversized") f.sessionResponse(async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)))
      t.mock.timers.tick(100)
      const status = await settledStatus(f.service)
      assert.equal(status.ready, false)
      assert.equal(status.account, undefined)
      assert.ok(f.rpc.slice(policyCalls).includes(null))
      assert.equal(f.rpc.at(-1), null)
      const blockers = { disabled: "USER_DISABLED", forbidden: "FORBIDDEN", role: "INVALID_ROLE", plugin: "MODEL_POLICY_PLUGIN_REQUIRED", storage: "SESSION_STORAGE_UNAVAILABLE", invalid: "INVALID_AUTH_RESPONSE", oversized: "API_RESPONSE_TOO_LARGE" }
      assert.equal(status.blocker, blockers[failure])
    } finally { await f.cleanup() }
  })
})

test("an expired session cannot retain policy even on the first transient background failure", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() })
  const f = await fixture({ refreshIntervalMs: 100 })
  try {
    f.expiresAt(Date.now() + 100)
    await login(f.service)
    const policyCalls = f.rpc.length
    f.sessionResponse(transientResponse(503))
    t.mock.timers.tick(100)
    const status = await settledStatus(f.service)
    assert.equal(status.ready, false)
    assert.equal(status.account, undefined)
    assert.deepEqual(f.rpc.slice(policyCalls), [null])
  } finally { await f.cleanup() }
})

test("active assert-model rejects transient failures and revokes policy immediately", async t => {
  for (const failure of [503, "network"] as const) await t.test(String(failure), async () => {
    const f = await fixture()
    try {
      await login(f.service)
      const policyCalls = f.rpc.length
      f.sessionResponse(transientResponse(failure))
      await assert.rejects(f.service.call("assert-model", { modelID: "default" }), failure === "network" ? /NETWORK_ERROR/ : /HTTP_ERROR/)
      assert.deepEqual(f.rpc.slice(policyCalls), [null])
      assert.equal((await f.service.call("status", {}) as { ready: boolean }).ready, false)
    } finally { await f.cleanup() }
  })
})

test("background refresh queues user imports without rejecting them and skips active user operations", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const f = await fixture({ role: "admin", refreshIntervalMs: 100 })
  let release: (() => void) | undefined
  const waitForRelease = async (): Promise<() => void> => {
    while (!release) await delay(1)
    return release
  }
  try {
    await login(f.service)
    const before = f.requests.filter(request => request === "/v1/session").length
    f.sessionResponse(() => new Promise(resolve => { release = () => resolve(undefined) }))
    t.mock.timers.tick(100)
    const importing = f.service.call("import", {})
    await assert.rejects(f.service.call("status", {}), /OPERATION_BUSY/)
    t.mock.timers.tick(300)
    const releaseBackground = await waitForRelease()
    assert.equal(f.requests.filter(request => request === "/v1/session").length, before + 1)
    assert.equal(f.pickerCount(), 0, "import waits for the background refresh")
    f.sessionResponse()
    releaseBackground(); release = undefined
    assert.ok(await importing)
    assert.equal(f.pickerCount(), 1)
    assert.equal((await settledStatus(f.service)).ready, true)
    f.sessionResponse(() => new Promise(resolve => { release = () => resolve(undefined) }))
    const active = f.service.call("assert-model", { modelID: "default" })
    const releaseActive = await waitForRelease()
    t.mock.timers.tick(300)
    assert.equal(f.requests.filter(request => request === "/v1/session").length, before + 3)
    releaseActive()
    await active
  } finally { release?.(); await f.cleanup() }
})

type FixPreview = { issues: { path: string; severity: string; reason: string }[]; fixablePaths: string[]; files: { path: string; size: number }[] }
const fixReply = (content: string, summary = "Đã sửa tệp an toàn.") => Response.json({ choices: [{ message: { content: JSON.stringify({ summary, content }) } }] })
const secretFixture = "fixtureSensitiveValue1234567890"
const secretPath = "skills/turnstile-spin/references/sveltekit.md"
async function addSecretFile(imported: string, name = secretPath) {
  const entrypoint = path.join(imported, "skills", "turnstile-spin", "SKILL.md")
  await mkdir(path.dirname(entrypoint), { recursive: true })
  await writeFile(entrypoint, "---\nname: turnstile-spin\ndescription: Test skill\n---\nRun verification.\n")
  const target = path.join(imported, ...name.split("/"))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `api_key="${secretFixture}"\n`)
}

test("AI fix redacts secret patterns while preserving assignment quotes and safe templates", () => {
  const provider = "sk-" + "a".repeat(26), aws = "AKIA" + "Z".repeat(16)
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nfixture-key-material\n-----END RSA PRIVATE KEY-----"
  const unclosed = "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-unclosed-material"
  const text = `${pem}\n${provider}\n${aws}\npassword='${secretFixture}'\ntoken=${secretFixture}\nsecret=YOUR_SAFE_TEMPLATE\napi_key=INSERT_API_KEY_HERE\npassword=your_password_here\n${unclosed}`
  const result = redactSecretsForLlm(text)
  for (const secret of [provider, aws, secretFixture, "fixture-key-material", "fixture-unclosed-material"]) assert.equal(result.redactedText.includes(secret), false)
  assert.equal(result.redactionCount, 6)
  assert.match(result.redactedText, /password='\[REDACTED_SECRET_\d+\]'/)
  assert.match(result.redactedText, /secret=YOUR_SAFE_TEMPLATE/)
  assert.match(result.redactedText, /api_key=INSERT_API_KEY_HERE/)
  assert.match(result.redactedText, /password=your_password_here/)
  assert.equal(redactSecretsForLlm('token="YOUR_SAFE_TEMPLATE_extra').redactionCount, 1, "unterminated quote is not a safe template")
  assert.equal(redactSecretsForLlm("sK-" + "x".repeat(24)).redactionCount, 1, "provider detection is case insensitive like secretFindings")
})

test("AI fix accepts only bounded UTF-8 supported-root files and compact contextual diffs", () => {
  assert.equal(isFixableTextFile("agents/helper.md", encode("hello")), true)
  for (const [name, bytes] of [["README.md", encode("hello")], ["skills/a/x", new Uint8Array([0])], ["agents/x.md", new Uint8Array([255])], ["agents/x.md", new Uint8Array(256 * 1024 + 1)]] as const) assert.equal(isFixableTextFile(name, bytes), false)
  const diff = buildCompactDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nchanged\nd\ne\nf\ng")
  assert.match(diff, /- c/); assert.match(diff, /\+ changed/)
  const capped = buildCompactDiff(Array.from({ length: 140 }, (_, i) => `old-${i}`).join("\n"), "new", 12)
  assert.ok(capped.split("\n").length <= 13)
  assert.match(capped, /\.\.\. \(\+\d+ dòng\)/)
})

test("scanWithSource preserves raw Claude bytes independently from adapted previews", async () => {
  const f = await fixture({ role: "admin" })
  try {
    const raw = "---\nname: helper\ndescription: Helpful\nmodel: inherit\ntools: Read\ncolor: green\n---\nBody.\n"
    await writeFile(path.join(f.imported, "agents", "helper.md"), raw)
    const result = await scanWithSource(f.imported, undefined, { compatibilityMode: "raw", adaptClaudeAgents: true })
    assert.equal(new TextDecoder().decode(result.files.find(file => file.path === "agents/helper.md")!.data), raw)
    assert.notEqual(new TextDecoder().decode(result.preview.files.find(file => file.path === "agents/helper.md")!.data), raw)
    assert.deepEqual(result.preview, await scan(f.imported, undefined, { compatibilityMode: "raw", adaptClaudeAgents: true }))
  } finally { await f.cleanup() }
})

test("admin AI fix stages secret-safe edits, packages immediately, saves only after confirmation and reverts immutable originals", async () => {
  const f = await fixture({ role: "admin" })
  try {
    await addSecretFile(f.imported)
    f.fixResponse(async (body, init) => {
      assert.equal(JSON.stringify(body).includes(secretFixture), false)
      assert.equal(body.model, "default"); assert.equal(body.stream, false); assert.equal(Object.hasOwn(body, "temperature"), false)
      assert.equal(Object.hasOwn(body, "max_tokens"), false); assert.equal(init.redirect, "error"); assert.ok(init.signal)
      return fixReply('api_key="<YOUR_API_KEY>"\n')
    })
    await login(f.service)
    const imported = await f.service.call("import", {}) as FixPreview
    assert.ok(imported.issues.some(issue => issue.path === secretPath && issue.reason.includes("likely embedded secret")))
    assert.deepEqual(imported.fixablePaths, [secretPath])
    await assert.rejects(f.service.call("package", { version: "1.2.4" }), /IMPORT_BLOCKED/)
    const fixed = await f.service.call("fix-import", { path: secretPath, model: "other" }) as { preview: FixPreview; fix: { diff: string; redactionCount: number; model: string } }
    assert.deepEqual(fixed.preview.fixablePaths, [])
    assert.equal(fixed.preview.issues.filter(issue => issue.severity === "error").length, 0)
    assert.equal(fixed.fix.diff.includes(secretFixture), false); assert.equal(fixed.fix.redactionCount, 1); assert.equal(fixed.fix.model, "default")
    const target = path.join(f.imported, ...secretPath.split("/"))
    assert.ok((await readFile(target, "utf8")).includes(secretFixture), "AI edits are staged only")
    await f.service.call("package", { version: "1.2.4" })
    f.confirm(false)
    await assert.rejects(f.service.call("save-import-fix", { path: secretPath }), /CANCELLED/)
    assert.ok((await readFile(target, "utf8")).includes(secretFixture))
    f.confirm(true)
    assert.deepEqual(await f.service.call("save-import-fix", { path: secretPath }), { saved: secretPath })
    assert.equal(await readFile(target, "utf8"), 'api_key="<YOUR_API_KEY>"\n')
    const reverted = await f.service.call("revert-import-fix", { path: secretPath }) as { preview: FixPreview }
    assert.ok(reverted.preview.fixablePaths.includes(secretPath))
    await assert.rejects(f.service.call("package", { version: "1.2.5" }), /IMPORT_BLOCKED/)
    const excluded = await f.service.call("exclude-import-file", { path: secretPath }) as { preview: FixPreview }
    assert.equal(excluded.preview.files.some(file => file.path === secretPath), false)
    await f.service.call("package", { version: "1.2.5" })
    await f.service.call("revert-import-fix", { path: secretPath })
    await assert.rejects(f.service.call("package", { version: "1.2.6" }), /IMPORT_BLOCKED/)
    await f.service.call("import", {})
    assert.equal((await f.service.call("package", { version: "1.2.6" }) as { size: number }).size > 0, true, "reimport uses explicitly saved disk content")
    await f.service.call("logout", {}); await login(f.service)
    await assert.rejects(f.service.call("fix-import", { path: secretPath }), /IMPORT_REQUIRED/)
  } finally { await f.cleanup() }
})

test("agent and skill AI fixes ignore model overrides and use the concrete API default", async () => {
  const f = await fixture({ role: "admin", catalog: { ...catalog, default_model: "other" } })
  try {
    await writeFile(path.join(f.imported, "agents", "helper.md"), "---\ndescription: Helpful fixture\nmodel: claude-3-7-sonnet\n---\nBody\n")
    await writeFile(path.join(f.imported, "skills", "fixture", "SKILL.md"), "---\nname: fixture\n---\nRun checks.\n")
    f.fixResponse(async body => {
      assert.equal(body.model, "other", "API default wins even when it is not the first catalog model")
      const messages = body.messages as { content: string }[]
      assert.match(messages[0].content, /model \(optional portable tier: amecode\/default \| amecode\/haiku \| amecode\/sonnet \| amecode\/opus\)/)
      assert.match(messages[0].content, /NO tools, name, or concrete provider model IDs/)
      const filePath = JSON.parse(messages[1].content).filePath
      return fixReply(filePath === "agents/helper.md"
        ? "---\ndescription: Helpful fixture\nmodel: amecode/sonnet\n---\nBody\n"
        : "---\nname: fixture\ndescription: Fixture skill\n---\nRun checks.\n")
    })
    await login(f.service); await f.service.call("import", {})
    const agent = await f.service.call("fix-import", { path: "agents/helper.md", model: "default" }) as { fix: { model: string } }
    assert.equal(agent.fix.model, "other")
    const skills = await f.service.call("fix-import-all", { model: "default" }) as { preview: FixPreview; fixes: { path: string; model: string }[]; failed: unknown[] }
    assert.deepEqual(skills.failed, [])
    assert.deepEqual(skills.fixes.map(fix => ({ path: fix.path, model: fix.model })), [{ path: "skills/fixture/SKILL.md", model: "other" }])
    assert.deepEqual(skills.preview.fixablePaths, [])
    assert.equal(f.fixRequests.length, 2)
  } finally { await f.cleanup() }
})

test("AI fix retries exact validation feedback once and fails closed without altering staged originals", async () => {
  const f = await fixture({ role: "admin" })
  try {
    await addSecretFile(f.imported); await login(f.service); await f.service.call("import", {})
    f.fixResponse(async () => f.fixRequests.length === 1 ? fixReply("[missing](absent.md)\n") : fixReply("Use an environment lookup.\n"))
    await f.service.call("fix-import", { path: secretPath, model: "not-allowed" })
    assert.equal(f.fixRequests.length, 2)
    assert.ok(f.fixRequests.every(body => body.model === "default"), "every retry ignores the requested model")
    assert.match(JSON.stringify(f.fixRequests[1]), /missing\/unsafe local reference: absent.md/)
    await f.service.call("revert-import-fix", { path: secretPath })
    f.fixResponse(async () => fixReply("[missing](absent.md)\n"))
    await assert.rejects(f.service.call("fix-import", { path: secretPath }), /AI_FIX_VALIDATION_FAILED/)
    assert.equal(f.fixRequests.length, 4)
    await assert.rejects(f.service.call("package", { version: "1.2.4" }), /IMPORT_BLOCKED/)
    assert.ok((await readFile(path.join(f.imported, ...secretPath.split("/")), "utf8")).includes(secretFixture))
  } finally { await f.cleanup() }
})

test("AI fix-all applies evolving validated files and reports per-file failures without aborting", async () => {
  const f = await fixture({ role: "admin" })
  try {
    const second = "skills/turnstile-spin/references/z.md"
    await addSecretFile(f.imported); await addSecretFile(f.imported, second)
    await login(f.service); await f.service.call("import", {})
    f.fixResponse(async body => {
      assert.equal(body.model, "default")
      return f.fixRequests.length === 1 ? new Response("provider unavailable", { status: 503 }) : fixReply("Safe reference.\n")
    })
    const result = await f.service.call("fix-import-all", { model: "other" }) as { preview: FixPreview; fixes: { path: string; model: string }[]; failed: { path: string; code: string }[] }
    assert.ok(result.fixes.every(fix => fix.model === "default"))
    assert.deepEqual(result.failed, [{ path: secretPath, code: "AI_FIX_PROVIDER_ERROR", detail: "HTTP 503: provider unavailable" }])
    assert.deepEqual(result.fixes.map(fix => fix.path), [second]); assert.deepEqual(result.preview.fixablePaths, [secretPath])
    await f.service.call("exclude-import-file", { path: secretPath })
    await f.service.call("package", { version: "1.2.4" })
    await assert.rejects(f.service.call("fix-import-all", {}), /AI_FIX_NO_FIXABLE_ERRORS/)
  } finally { await f.cleanup() }
})

test("import exclusions restore scan-only issues and reject absent paths and unsupported content", async () => {
  const f = await fixture({ role: "admin" })
  try {
    await writeFile(path.join(f.imported, "README.md"), "stray content")
    await writeFile(path.join(f.imported, "agents", "binary.bin"), new Uint8Array([0, 255]))
    await writeFile(path.join(f.imported, "agents", "oversized.md"), "x".repeat(256 * 1024 + 1))
    await login(f.service); await f.service.call("import", {})
    await assert.rejects(f.service.call("fix-import", { path: "README.md" }), /AI_FIX_UNSUPPORTED_FILE/)
    await assert.rejects(f.service.call("fix-import", { path: "agents/binary.bin" }), /AI_FIX_UNSUPPORTED_FILE/)
    await assert.rejects(f.service.call("fix-import", { path: "agents/oversized.md" }), /AI_FIX_FILE_TOO_LARGE/)
    for (const operation of ["fix-import", "exclude-import-file", "revert-import-fix", "save-import-fix"]) await assert.rejects(f.service.call(operation, { path: "agents/absent.md" }), /IMPORT_FILE_NOT_FOUND/)
    await f.service.call("exclude-import-file", { path: "README.md" })
    const reverted = await f.service.call("revert-import-fix", { path: "README.md" }) as { preview: FixPreview }
    assert.ok(reverted.preview.issues.some(issue => issue.path === "README.md" && issue.severity === "error"))
    assert.equal(f.fixRequests.length, 0)
  } finally { await f.cleanup() }
})

test("save-import-fix rejects substituted directory junctions and file symlinks without changing outside data", async t => {
  for (const substitution of ["directory", "file"] as const) await t.test(substitution, async t => {
    const f = await fixture({ role: "admin" })
    try {
      await addSecretFile(f.imported); await login(f.service); await f.service.call("import", {})
      f.fixResponse(async () => fixReply("Safe replacement.\n"))
      await f.service.call("fix-import", { path: secretPath })
      const outside = path.join(f.folder, "outside"); await mkdir(outside)
      const outsideFile = path.join(outside, "sveltekit.md"); await writeFile(outsideFile, "outside unchanged")
      const directory = path.join(f.imported, "skills", "turnstile-spin", "references"), target = path.join(directory, "sveltekit.md")
      await rename(substitution === "directory" ? directory : target, (substitution === "directory" ? directory : target) + ".original")
      try { await symlink(substitution === "directory" ? outside : outsideFile, substitution === "directory" ? directory : target, substitution === "directory" && process.platform === "win32" ? "junction" : substitution === "directory" ? "dir" : "file") }
      catch (error) {
        if (substitution === "file" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) await link(outsideFile, target)
        else throw error
      }
      await assert.rejects(f.service.call("save-import-fix", { path: secretPath }), /SAVE_PATH_UNSAFE/)
      assert.equal(await readFile(outsideFile, "utf8"), "outside unchanged")
      if (substitution === "directory") {
        await f.service.call("import", {})
        const excluded = await f.service.call("exclude-import-file", { path: "skills/turnstile-spin/references" }) as { preview: FixPreview }
        assert.equal(excluded.preview.issues.some(issue => issue.path === "skills/turnstile-spin/references"), false)
        const reverted = await f.service.call("revert-import-fix", { path: "skills/turnstile-spin/references" }) as { preview: FixPreview }
        assert.ok(reverted.preview.issues.some(issue => issue.path === "skills/turnstile-spin/references" && issue.reason.includes("symlink")))
      }
    } finally { await f.cleanup() }
  })
})

test("large AI fixes use unique targeted patches with bounded safe context", async () => {
  const f = await fixture({ role: "admin" })
  try {
    const source = `${"Unchanged reference documentation.\n".repeat(1000)}api_key="${secretFixture}"\n`
    await addSecretFile(f.imported)
    await writeFile(path.join(f.imported, ...secretPath.split("/")), source)
    await login(f.service); await f.service.call("import", {})
    f.fixResponse(async body => {
      assert.equal(Object.hasOwn(body, "max_tokens"), false)
      const payload = JSON.parse((body.messages as { content: string }[]).at(-1)!.content)
      assert.ok(payload.text.length < source.length / 2)
      assert.equal(JSON.stringify(body).includes(secretFixture), false)
      const oldText = /api_key="\[REDACTED_SECRET_\d+\]"/.exec(payload.text)![0]
      return Response.json({ choices: [{ message: { content: "```json\n" + JSON.stringify({ summary: "Đã thay bằng biến môi trường.", edits: [{ oldText, newText: 'api_key="<API_KEY>"' }] }) + "\n```" } }] })
    })
    const result = await f.service.call("fix-import", { path: secretPath }) as { preview: FixPreview; fix: { diff: string } }
    assert.equal(result.preview.issues.filter(issue => issue.severity === "error").length, 0)
    assert.equal(result.fix.diff.includes(secretFixture), false)
    await f.service.call("save-import-fix", { path: secretPath })
    assert.equal(await readFile(path.join(f.imported, ...secretPath.split("/")), "utf8"), source.replace(secretFixture, "<API_KEY>"))
    await f.service.call("revert-import-fix", { path: secretPath })
    f.fixResponse(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Invalid duplicate replacement", edits: [{ oldText: "Unchanged reference documentation.", newText: "changed" }] }) } }] }))
    await assert.rejects(f.service.call("fix-import", { path: secretPath }), /AI_FIX_INVALID_RESPONSE/)
    await assert.rejects(f.service.call("package", { version: "1.2.4" }), /IMPORT_BLOCKED/)
  } finally { await f.cleanup() }
})

test("AI fix sanitizes JSON-escaped metadata, repeated raw literals, retry feedback and provider summary", async () => {
  const f = await fixture({ role: "admin" })
  try {
    const api = new AmeApi("http://localhost:3211", f.dependencies.fetch)
    await api.login("fixture", "fixture-password")
    let attempts = 0
    f.fixResponse(async body => {
      attempts++
      assert.equal(JSON.stringify(body).includes(secretFixture), false)
      assert.equal(JSON.stringify(body).includes("private-material"), false)
      return fixReply("Use <KEY> instead.\n", `Đã sửa ${secretFixture}`)
    })
    const bytes = encode(`password="${secretFixture}"\nRepeated: ${secretFixture}\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n`)
    const fixed = await fixImportFileWithLlm({ api, filePath: `skills/fixture/${secretFixture}.md`, fileBytes: bytes,
      issues: [{ path: secretPath, severity: "error", reason: `bad password="${secretFixture}"\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----` }],
      compatibilityMode: "native", adaptClaudeAgents: false, availablePaths: [`skills/${secretFixture}/SKILL.md`], signal: new AbortController().signal, fetcher: f.dependencies.fetch,
      validateCandidate: () => ({ preview: preview(input()), remainingErrors: attempts === 1 ? [{ path: secretPath, severity: "error", reason: `retry ${secretFixture}` }] : [] }),
    })
    assert.equal(attempts, 2)
    assert.equal(fixed.summary.includes(secretFixture), false); assert.equal(fixed.diff.includes(secretFixture), false)
  } finally { await f.cleanup() }
})

test("malformed, oversized and secret-echoing provider responses fail closed with sanitized codes", async t => {
  for (const kind of ["json", "empty", "marker", "echo", "oversized", "network"] as const) await t.test(kind, async () => {
    const f = await fixture({ role: "admin" })
    try {
      await addSecretFile(f.imported); await login(f.service); await f.service.call("import", {})
      f.fixResponse(async () => {
        if (kind === "network") throw new Error(secretFixture)
        if (kind === "json") return new Response("not json " + secretFixture)
        if (kind === "oversized") return new Response("x".repeat(512 * 1024 + 1))
        return fixReply(kind === "empty" ? "" : kind === "marker" ? "[REDACTED_SECRET_1]" : secretFixture)
      })
      await assert.rejects(f.service.call("fix-import", { path: secretPath }), error => {
        assert.match((error as Error).message, kind === "network" ? /^AI_FIX_PROVIDER_ERROR: / : /^AI_FIX_INVALID_RESPONSE: /)
        assert.equal((error as Error).message.includes(secretFixture), false)
        return true
      })
      await assert.rejects(f.service.call("package", { version: "1.2.4" }), /IMPORT_BLOCKED/)
    } finally { await f.cleanup() }
  })
})

test("fix-all limits work to ten sequential files and can resume remaining errors", async () => {
  const f = await fixture({ role: "admin" })
  try {
    for (let i = 0; i < 11; i++) await addSecretFile(f.imported, `skills/turnstile-spin/references/file-${i}.md`)
    await login(f.service); await f.service.call("import", {})
    f.fixResponse(async () => fixReply("Safe documentation.\n"))
    const first = await f.service.call("fix-import-all", {}) as { fixes: unknown[]; preview: FixPreview }
    assert.equal(first.fixes.length, 10); assert.equal(first.preview.fixablePaths.length, 1); assert.equal(f.fixRequests.length, 10)
    const second = await f.service.call("fix-import-all", {}) as { fixes: unknown[]; preview: FixPreview }
    assert.equal(second.fixes.length, 1); assert.equal(second.preview.fixablePaths.length, 0)
    await f.service.call("package", { version: "1.2.4" })
  } finally { await f.cleanup() }
})

test("all import fix operations freshly enforce admin role and clear session after auth loss", async () => {
  const f = await fixture({ role: "admin" })
  try {
    await addSecretFile(f.imported); await login(f.service); await f.service.call("import", {})
    f.role("user")
    for (const operation of ["fix-import", "fix-import-all", "exclude-import-file", "revert-import-fix", "save-import-fix"]) await assert.rejects(f.service.call(operation, { path: secretPath }), /FORBIDDEN/)
    assert.equal(f.requests.includes("/v1/chat/completions"), false)
    f.role("admin"); f.disable()
    await assert.rejects(f.service.call("fix-import", { path: secretPath }), /USER_DISABLED/)
    await assert.rejects(f.service.call("fix-import", { path: secretPath }), /SIGNED_OUT/)
  } finally { await f.cleanup() }
})

test("session vault rapidly overwrites credentials without leaving pending files", async () => {
  const folder = await area()
  try {
    const vault = await openSessionVault(folder, encryption)
    for (let i = 0; i < 25; i++) {
      await vault.save({ origin: "http://localhost:3211", token: `fixture-session-${i}` })
    }
    const reopened = await openSessionVault(folder, encryption)
    assert.deepEqual(await reopened.load(), { origin: "http://localhost:3211", token: "fixture-session-24" })
    assert.deepEqual(await readdir(folder), ["amekit-session.enc"])
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test("Linux basic_text storage backend is rejected even when encryption reports available", async () => {
  const folder = await area()
  try {
    const vault = await openSessionVault(folder, { ...encryption, getSelectedStorageBackend: () => "basic_text" })
    await assert.rejects(vault.save({ origin: "http://localhost:3211", token: "fixture" }), /SESSION_STORAGE_UNAVAILABLE/)
    assert.deepEqual(await readdir(folder), [])
  } finally { await rm(folder, { recursive: true, force: true }) }
})

const syntheticSecret = "synthetic_fixture_value_0123456789"
const originalReference = `# SvelteKit fixture\napi_key="${syntheticSecret}"\n`
const fixedReference = "# SvelteKit fixture\napi_key=process.env.TURNSTILE_SECRET\n"
const aiResponse = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] })
async function engineParams(f: Awaited<ReturnType<typeof fixture>>, text = originalReference) {
  const api = new AmeApi("http://localhost:3211", f.dependencies.fetch)
  await api.login("fixture", "fixture-password")
  const files = [...input(), { path: "skills/fixture/reference.md", data: encode(text) }]
  const filePath = files.at(-1)!.path
  return {
    api, filePath, fileBytes: encode(text), issues: preview(files).issues.filter(issue => issue.path === filePath),
    compatibilityMode: "native" as const, adaptClaudeAgents: false, availablePaths: files.map(file => file.path),
    signal: new AbortController().signal, fetcher: f.dependencies.fetch,
    validateCandidate: (candidateBytes: Uint8Array) => {
      const candidate = preview(files.map(file => file.path === filePath ? { ...file, data: candidateBytes } : file))
      return { preview: candidate, remainingErrors: candidate.issues.filter(issue => issue.severity === "error" && issue.path === filePath) }
    },
  }
}

const svelteReference = '# SvelteKit\n```ts title="src/routes/signup/+page.server.ts"\nimport { TURNSTILE_SECRET } from \'$env/static/private\'\nconst options = { secret: TURNSTILE_SECRET }\n```\n'

test("language-tagged env expressions are warning-only in raw modes while literal credentials stay blocked", () => {
  for (const lang of ['ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx', 'svelte', 'kotlin', 'java', 'py', 'python', 'go', 'rust', 'swift', 'dart', 'c', 'cpp', 'csharp', 'cs', 'php', 'ruby', 'rb', 'scala']) {
    const text = svelteReference.replace('```ts ', `\`\`\`${lang.toUpperCase()} `)
    assert.deepEqual(secretFindings(text), [{ rule: 'assignment', classification: 'code-expression' }])
    for (const options of [{ compatibilityMode: 'native' as const }, { compatibilityMode: 'raw' as const }, { compatibilityMode: 'raw' as const, adaptClaudeAgents: true }]) {
      const issues = preview([...input(), { path: secretPath, data: encode(text) }], [], options).issues.filter(issue => issue.path === secretPath && /secret/.test(issue.reason))
      assert.equal(issues.length, 1)
      assert.equal(issues[0].severity, options.compatibilityMode === 'native' ? 'error' : 'warning')
    }
  }
  for (const text of ['secret: TURNSTILE_SECRET', '```env\nsecret=TURNSTILE_SECRET\n```', '```ts\nsecret: "TURNSTILE_SECRET"\n```', `\`\`\`ts\nsecret: "${syntheticSecret}"\n\`\`\``, '```ts\nsk-' + 'x'.repeat(24) + '\nAKIA' + 'A'.repeat(16) + '\n-----BEGIN PRIVATE KEY-----\n```']) {
    assert.ok(secretFindings(text).every(item => item.classification === 'blocked'), text)
    assert.ok(preview([...input(), { path: secretPath, data: encode(text) }], [], { compatibilityMode: 'raw' }).issues.some(issue => issue.path === secretPath && issue.severity === 'error'))
  }
  assert.deepEqual(redactSecretsForLlm(svelteReference), { redactedText: svelteReference, redactionCount: 0 })
  assert.equal(redactSecretsForLlm('secret: "TURNSTILE_SECRET"').redactionCount, 1)
})

test("reasoning-model fixes preserve env imports, omit unrelated context and accept array/prose JSON", async () => {
  const model = 'gpt-6.1-sol(medium)'
  const f = await fixture({ role: 'admin', catalog: { ...catalog, default_model: model, small_model: model, models: [{ ...catalog.models[0], id: model, name: model }] } })
  try {
    const params = await engineParams(f, svelteReference)
    const fixedText = svelteReference.replace('secret: TURNSTILE_SECRET', 'secret: env.TURNSTILE_SECRET')
    const json = JSON.stringify({ summary: 'Đã dùng biến môi trường', content: fixedText })
    for (const content of ['Here is the repair:\n```json\n' + json + '\n```\nDone.', 'Result follows: ' + json + '\nDone.', [{ type: 'reasoning', text: 'ignored' }, { type: 'text', text: 'Repair follows:' }, { type: 'text', text: '```json\n' + json + '\n```' }]]) {
      f.fixResponse(async body => {
        assert.equal(body.model, model)
        assert.equal(Object.hasOwn(body, 'temperature'), false)
        assert.equal(Object.hasOwn(body, 'max_tokens'), false)
        const context = JSON.parse((body.messages as { content: string }[])[1].content)
        assert.equal(Object.hasOwn(context, 'availablePaths'), false)
        assert.match(context.text, /import \{ TURNSTILE_SECRET \}/)
        assert.doesNotMatch(context.text, /REDACTED/)
        return Response.json({ choices: [{ message: { content } }] })
      })
      const result = await fixImportFileWithLlm({ ...params, availablePaths: Array.from({ length: 1200 }, (_, i) => `skills/unrelated-${i}/SKILL.md`) })
      assert.equal(new TextDecoder().decode(result.contentBytes), fixedText)
      assert.equal(result.redactionCount, 0)
    }
  } finally { await f.cleanup() }
})

test("missing-reference context is capped, same-skill only, sibling-first and available on validation retry", async () => {
  const f = await fixture({ role: 'admin' })
  try {
    const params = await engineParams(f)
    const siblings = Array.from({ length: 100 }, (_, i) => `skills/fixture/references/ref-${i}.md`)
    const paths = [...Array.from({ length: 1200 }, (_, i) => `skills/unrelated-${i}/SKILL.md`), 'skills/fixture/SKILL.md', ...siblings]
    let attempt = 0
    f.fixResponse(async body => {
      const context = JSON.parse((body.messages as { content: string }[])[1].content)
      if (++attempt === 1) assert.equal(Object.hasOwn(context, 'availablePaths'), false)
      else assert.deepEqual(context.availablePaths, siblings.slice(0, 80))
      return aiResponse({ summary: 'Đã sửa', content: fixedReference })
    })
    await fixImportFileWithLlm({ ...params, filePath: 'skills/fixture/references/sveltekit.md', availablePaths: paths,
      validateCandidate: bytes => ({ preview: params.validateCandidate(bytes).preview, remainingErrors: attempt === 1 ? [{ path: params.filePath, severity: 'error', reason: 'missing/unsafe local reference: guide.md' }] : [] }) })
    assert.equal(attempt, 2)
  } finally { await f.cleanup() }
})

test("provider and validation diagnostics preserve codes and sanitize credentials in engine and IPC", async () => {
  const f = await fixture({ role: 'admin' })
  try {
    const params = await engineParams(f)
    const providerError = async () => Response.json({ error: { message: `unsupported parameter ${syntheticSecret} fixture-provider-key` } }, { status: 400 })
    f.fixResponse(providerError)
    await assert.rejects(fixImportFileWithLlm(params), error => {
      assert.ok(error instanceof AiFixError)
      assert.equal(error.message, 'AI_FIX_PROVIDER_ERROR')
      assert.match(error.detail!, /^HTTP 400: unsupported parameter/)
      assert.doesNotMatch(error.detail!, new RegExp(`${syntheticSecret}|fixture-provider-key`))
      return true
    })
    await addSecretFile(f.imported); await login(f.service); await f.service.call('import', {})
    f.fixResponse(async () => Response.json({ error: { message: `unsupported parameter ${secretFixture} fixture-provider-key` } }, { status: 400 }))
    await assert.rejects(f.service.call('fix-import', { path: secretPath }), error => {
      assert.match((error as Error).message, /^AI_FIX_PROVIDER_ERROR: HTTP 400: unsupported parameter/)
      assert.doesNotMatch((error as Error).message, new RegExp(`${secretFixture}|fixture-provider-key`))
      return true
    })
    const batch = await f.service.call('fix-import-all', {}) as { failed: { code: string; detail: string }[] }
    assert.equal(batch.failed[0].code, 'AI_FIX_PROVIDER_ERROR')
    assert.match(batch.failed[0].detail, /^HTTP 400: unsupported parameter/)
    assert.doesNotMatch(batch.failed[0].detail, new RegExp(`${secretFixture}|fixture-provider-key`))
    f.fixResponse(async () => aiResponse({ summary: 'Đã sửa', content: fixedReference }))
    await assert.rejects(fixImportFileWithLlm({ ...params, validateCandidate: () => ({ preview: preview(input()), remainingErrors: ['first ' + syntheticSecret, 'second', 'third'].map(reason => ({ path: params.filePath, severity: 'error', reason })) }) }), error => {
      assert.ok(error instanceof AiFixError)
      assert.equal(error.message, 'AI_FIX_VALIDATION_FAILED')
      assert.match(error.detail!, /^first \[REDACTED_SECRET\]; second$/)
      return true
    })
    const controller = new AbortController()
    f.fixResponse(async () => { controller.abort(); throw new Error('aborted') })
    await assert.rejects(fixImportFileWithLlm({ ...params, signal: controller.signal }), { name: 'AiFixError', message: 'CANCELLED' })
  } finally { await f.cleanup() }
})

test("canceling or failing reimport preserves staged edits and packaged output until a successful scan", async () => {
  const f = await fixture({ role: 'admin' })
  try {
    await addSecretFile(f.imported); await login(f.service); await f.service.call('import', {})
    f.fixResponse(async () => fixReply('api_key=process.env.TURNSTILE_SECRET\n'))
    await f.service.call('fix-import', { path: secretPath })
    await f.service.call('package', { version: '1.2.4' })
    f.pickResponse(async () => null)
    assert.equal(await f.service.call('import', {}), null)
    f.pickResponse(async () => path.join(f.folder, 'missing'))
    await assert.rejects(f.service.call('import', {}))
    await assert.rejects(f.service.call('import', { compatibilityMode: 'invalid' }), /INVALID_COMPATIBILITY_MODE/)
    assert.equal((await f.service.call('package', { version: '1.2.5' }) as { size: number }).size > 0, true)
    f.pickResponse()
    const imported = await f.service.call('import', {}) as FixPreview
    assert.ok(imported.fixablePaths.includes(secretPath))
    await assert.rejects(f.service.call('package', { version: '1.2.6' }), /IMPORT_BLOCKED/)
    assert.ok((await readFile(path.join(f.imported, ...secretPath.split('/')), 'utf8')).includes(secretFixture))
  } finally { await f.cleanup() }
})

test("AI fix redaction covers case-insensitive provider keys, PEM blocks and unclosed PEM payloads", () => {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "rSa pRiVaTe KeY"]) {
    const payload = "U1lOVEhFVElDX0ZJWFRVUkVfUEFZTE9BRA=="
    for (const closed of [true, false]) {
      const text = `Context before\n-----BEGIN ${label}-----\n${payload}\n${closed ? `-----END ${label}-----\nContext after` : "U1lOVEhFVElDX1NFTkRfTkVWRVI="}`
      const result = redactSecretsForLlm(text)
      assert.equal(result.redactionCount, 1, `${label}, closed=${closed}`)
      assert.match(result.redactedText, /\[REDACTED_PRIVATE_KEY_\d+\]/)
      assert.equal(result.redactedText.includes(payload), false)
      assert.doesNotMatch(result.redactedText, /U1lOVEhFVElDX1NFTkRfTkVWRVI=/)
      assert.match(result.redactedText, /Context before/)
      if (closed) assert.match(result.redactedText, /Context after/)
    }
  }
  const keys = ["sk-" + "s".repeat(24), "SK-" + "t".repeat(24), "AKIA" + "A1".repeat(8), "akia" + "b2".repeat(8)]
  const result = redactSecretsForLlm(keys.join("\n"))
  assert.equal(result.redactionCount, keys.length)
  assert.equal((result.redactedText.match(/\[REDACTED_PROVIDER_KEY_\d+\]/g) ?? []).length, keys.length)
  for (const key of keys) assert.equal(result.redactedText.includes(key), false)
})

test("AI fix redaction preserves assignment keys and quotes but honors exact safe-template boundaries", () => {
  for (const key of ["api_key", "api-key", "apikey", "password", "secret", "token", "API_KEY", "PaSsWoRd", "ToKeN"]) {
    for (const quote of ["", "'", '"']) {
      const result = redactSecretsForLlm(`prefix ${key}: ${quote}${syntheticSecret}${quote}\nsuffix`)
      assert.equal(result.redactionCount, 1)
      assert.match(result.redactedText, /\[REDACTED_SECRET_\d+\]/)
      assert.equal(result.redactedText.includes(`${key}: ${quote}[REDACTED_SECRET_`), true)
      assert.equal(result.redactedText.endsWith(`${quote}\nsuffix`), true)
      assert.equal(result.redactedText.includes(syntheticSecret), false)
    }
  }
  for (const value of ["YOUR_SYNTHETIC_SECRET", "INSERT_SYNTHETIC_SECRET_HERE", "your_synthetic_secret"]) {
    for (const quote of ["", "'", '"']) {
      const text = `token=${quote}${value}${quote}`
      assert.deepEqual(redactSecretsForLlm(text), { redactedText: text, redactionCount: 0 })
    }
  }
  for (const text of ['token="YOUR_SYNTHETIC_SECRET\'', "token=YOUR_SYNTHETIC_SECRET.extra", 'token="YOUR_SYNTHETIC_SECRET']) {
    const result = redactSecretsForLlm(text)
    assert.equal(result.redactionCount, 1, text)
    assert.doesNotMatch(result.redactedText, /YOUR_SYNTHETIC_SECRET/)
  }
  const repeated = redactSecretsForLlm(`password=${syntheticSecret}\ntoken=${syntheticSecret}`)
  assert.equal(repeated.redactionCount, 2)
  assert.equal(new Set(repeated.redactedText.match(/\[REDACTED_SECRET_\d+\]/g)).size, 2)
})

test("AI fix text eligibility accepts the exact byte boundary and rejects lookalike roots", () => {
  for (const filePath of ["agents/helper.md", "skills/fixture/reference.txt"]) {
    assert.equal(isFixableTextFile(filePath, encode("Valid tiếng Việt 🤖")), true)
    assert.equal(isFixableTextFile(filePath, new Uint8Array(256 * 1024).fill(0x61)), true)
    assert.equal(isFixableTextFile(filePath, new Uint8Array(256 * 1024 + 1).fill(0x61)), false)
  }
  for (const filePath of ["Agents/helper.md", "skills-extra/fixture.md"]) assert.equal(isFixableTextFile(filePath, encode("text")), false)
})

test("AI fix compact diff keeps local context, additions/deletions and bounded truncation", () => {
  const before = Array.from({ length: 200 }, (_, i) => `unchanged line ${i}`)
  const after = [...before]; after[100] = "replacement line"
  const diff = buildCompactDiff(before.join("\n"), after.join("\n"))
  assert.match(diff, /^-\s+unchanged line 100$/m)
  assert.match(diff, /^\+\s+replacement line$/m)
  assert.match(diff, /unchanged line 99/)
  assert.match(diff, /unchanged line 101/)
  assert.doesNotMatch(diff, /unchanged line 0\b|unchanged line 199\b/)
  assert.ok(diff.split("\n").length < 20)
  assert.match(buildCompactDiff("", "added"), /^\+\s+added$/m)
  assert.match(buildCompactDiff("removed", ""), /^-\s+removed$/m)
  assert.doesNotMatch(buildCompactDiff("same", "same"), /^[+-]\s/m)
  const capped = buildCompactDiff(before.join("\n"), before.map((_, i) => `changed ${i}`).join("\n"), 12)
  assert.ok(capped.split("\n").length <= 12)
  assert.match(capped, /\.\.\. \(\+\d+ dòng\)/)
})

test("AI fix engine uses redacted full-file requests, constrained HTTP settings and always the API default", async () => {
  const f = await fixture({ role: "admin" })
  try {
    const params = await engineParams(f)
    f.fixResponse(async (body, init) => {
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.ok(init.signal)
      assert.equal(body.stream, false); assert.equal(Object.hasOwn(body, "temperature"), false); assert.equal(Object.hasOwn(body, "max_tokens"), false)
      const serialized = JSON.stringify(body)
      assert.equal(serialized.includes(syntheticSecret), false)
      assert.match(serialized, /REDACTED_SECRET_/)
      assert.match(serialized, /likely embedded secret/)
      return Response.json({ choices: [{ message: { content: "```json\n" + JSON.stringify({ summary: "Đã thay bằng biến môi trường", content: fixedReference }) + "\n```" } }] })
    })
    for (const requestedModel of ["other", " other ", "amecode/opus", "not-allowed", " ", undefined]) {
      const result = await fixImportFileWithLlm({ ...params, requestedModel })
      assert.equal(result.model, "default")
      assert.equal(f.fixRequests.at(-1)!.model, "default")
      assert.equal(new TextDecoder().decode(result.contentBytes), fixedReference)
      assert.equal(result.redactionCount, 1)
      assert.equal(result.diff.includes(syntheticSecret), false)
    }
  } finally { await f.cleanup() }
})

test("AI fix includes sanitized YAML diagnostics and applies scalar repairs without leaking body secrets", async t => {
  for (const newline of ["\n", "\r\n"]) await t.test(newline === "\n" ? "LF" : "BOM and CRLF", async () => {
    const f = await fixture({ role: "admin" })
    try {
      const filePath = "skills/fixture/SKILL.md"
      const description = "Translate strings during feature work: after you add new strings"
      const text = (newline === "\n" ? "" : "\uFEFF") + `---\nname: fixture\ndescription: ${description}\n---\n` + "Unchanged skill documentation.\n".repeat(60) + originalReference
      const source = text.replace(/\n/g, newline)
      const files = input().map(file => file.path === filePath ? { ...file, data: encode(source) } : file)
      const issues = preview(files).issues.filter(issue => issue.path === filePath)
      assert.ok(issues.some(issue => issue.reason === "INVALID_FRONTMATTER"))
      const params = await engineParams(f)
      const decodedSource = new TextDecoder().decode(encode(source))
      const fixedText = decodedSource.replace(`description: ${description}`, `description: ${JSON.stringify(description)}`).replace(`api_key="${syntheticSecret}"`, "api_key=process.env.TURNSTILE_SECRET")
      f.fixResponse(async body => {
        const messages = body.messages as { content: string }[]
        assert.match(messages[0].content, /YAML frontmatter: plain scalar values containing/)
        const payload = JSON.parse(messages[1].content)
        const yamlIssue = payload.issues.find((reason: string) => /INVALID_FRONTMATTER/i.test(reason))
        assert.match(yamlIssue, /^INVALID_FRONTMATTER \(Nested mappings are not allowed.*line \d+, column \d+:\)$/)
        assert.equal(JSON.stringify(body).includes(syntheticSecret), false)
        assert.equal(JSON.stringify(body).includes("fixture-provider-key"), false)
        assert.equal(payload.text, redactSecretsForLlm(decodedSource).redactedText)
        const secretAssignment = /api_key="\[REDACTED_SECRET_\d+\]"/.exec(payload.text)![0]
        return aiResponse({ summary: "Đã sửa YAML và dùng biến môi trường", edits: [
          { oldText: `description: ${description}`, newText: `description: ${JSON.stringify(description)}` },
          { oldText: secretAssignment, newText: "api_key=process.env.TURNSTILE_SECRET" },
        ] })
      })
      const result = await fixImportFileWithLlm({ ...params, filePath, fileBytes: encode(source), issues, availablePaths: files.map(file => file.path),
        validateCandidate: bytes => {
          const candidate = preview(files.map(file => file.path === filePath ? { ...file, data: bytes } : file))
          return { preview: candidate, remainingErrors: candidate.issues.filter(issue => issue.severity === "error" && issue.path === filePath) }
        },
      })
      assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.contentBytes), fixedText)
      assert.equal(result.redactionCount, 1)
      assert.equal(result.diff.includes(syntheticSecret), false)
      assert.equal(f.fixRequests.length, 1)
    } finally { await f.cleanup() }
  })
})

test("medium AI fixes send complete redacted text, prefer targeted edits and accept either response format", async t => {
  for (const format of ["edits", "content"] as const) await t.test(format, async () => {
    const f = await fixture({ role: "admin" })
    try {
      const text = "Unchanged reference documentation.\n".repeat(100) + originalReference
      assert.ok(encode(text).length > 1_500 && encode(text).length <= 24_000)
      const params = await engineParams(f, text)
      const fixedText = text.replace(`api_key="${syntheticSecret}"`, "api_key=process.env.TURNSTILE_SECRET")
      f.fixResponse(async body => {
        const messages = body.messages as { content: string }[]
        assert.match(messages[0].content, /Return JSON only: .*"edits":/)
        assert.doesNotMatch(messages[0].content, /"content":|Only change supplied windows/)
        const payload = JSON.parse(messages[1].content)
        assert.equal(payload.text, redactSecretsForLlm(text).redactedText)
        assert.equal(JSON.stringify(body).includes(syntheticSecret), false)
        const oldText = /api_key="\[REDACTED_SECRET_\d+\]"/.exec(payload.text)![0]
        return aiResponse({ summary: "Đã dùng biến môi trường", ...(format === "edits"
          ? { edits: [{ oldText, newText: "api_key=process.env.TURNSTILE_SECRET" }] }
          : { content: fixedText }) })
      })
      const result = await fixImportFileWithLlm(params)
      assert.equal(new TextDecoder().decode(result.contentBytes), fixedText)
      assert.equal(result.redactionCount, 1)
      assert.equal(f.fixRequests.length, 1)
      assert.equal(new TextDecoder().decode(params.fileBytes), text)
    } finally { await f.cleanup() }
  })
})

test("AI fix rejects invalid medium-file edits even when valid content is supplied", async t => {
  for (const kind of ["not an array", "empty", "duplicate", "overlap"] as const) await t.test(kind, async () => {
    const f = await fixture({ role: "admin" })
    try {
      const text = "Unchanged reference documentation.\n".repeat(100) + originalReference
      const params = await engineParams(f, text)
      let validated = 0
      f.fixResponse(async body => {
        const payload = JSON.parse((body.messages as { content: string }[])[1].content)
        const oldText = /api_key="\[REDACTED_SECRET_\d+\]"/.exec(payload.text)![0]
        const edit = { oldText, newText: "api_key=process.env.TURNSTILE_SECRET" }
        const edits = kind === "not an array" ? {} : kind === "empty" ? [] : kind === "duplicate"
          ? [{ oldText: "Unchanged reference documentation.", newText: "changed" }] : [edit, edit]
        return aiResponse({ summary: "Đã sửa", edits, content: text.replace(`api_key="${syntheticSecret}"`, edit.newText) })
      })
      await assert.rejects(fixImportFileWithLlm({ ...params, validateCandidate: bytes => { validated++; return params.validateCandidate(bytes) } }), { name: "AiFixError", message: "AI_FIX_INVALID_RESPONSE" })
      assert.equal(validated, 0)
      assert.equal(f.fixRequests.length, 1, "invalid edits must not fall back to content or retry")
      assert.equal(new TextDecoder().decode(params.fileBytes), text)
    } finally { await f.cleanup() }
  })
})

test("AI fix engine requires fresh admin authorization and validates file support before provider access", async t => {
  for (const reason of ["signed out", "demoted", "invalid UTF-8"] as const) await t.test(reason, async () => {
    const f = await fixture({ role: "admin" })
    try {
      const params = await engineParams(f)
      f.fixResponse(async () => { assert.fail("denied request must never reach the provider") })
      const candidate = { ...params }
      let expected = /^Error: AI_FIX_UNSUPPORTED_FILE$/
      if (reason === "signed out") { candidate.api.clear(); expected = /^Error: AMECODE_LOGIN_REQUIRED$/ }
      if (reason === "demoted") { f.role("user"); expected = /^Error: FORBIDDEN$/ }
      if (reason === "invalid UTF-8") candidate.fileBytes = new Uint8Array([0xff])
      await assert.rejects(fixImportFileWithLlm(candidate), expected)
      assert.equal(f.fixRequests.length, 0)
    } finally { await f.cleanup() }
  })
})

test("AI fix response reader enforces cumulative byte limits, cancels overflow and sanitizes stream failures", async t => {
  for (const kind of ["exact limit", "chunked overflow", "read failure", "invalid UTF-8", "missing body"] as const) await t.test(kind, async () => {
    const f = await fixture({ role: "admin" })
    try {
      const params = await engineParams(f)
      let cancelled = false, validated = 0
      const valid = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Đã sửa", content: fixedReference }) } }] })
      f.fixResponse(async () => {
        if (kind === "exact limit") return new Response(valid + " ".repeat(512 * 1024 - encode(valid).length))
        if (kind === "missing body") return new Response(null)
        if (kind === "invalid UTF-8") return new Response(new Uint8Array([0xff, 0xfe]))
        let chunk = 0
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (kind === "read failure") { controller.error(new Error(syntheticSecret)); return }
            controller.enqueue(new Uint8Array(chunk++ === 0 ? 512 * 1024 : 1).fill(0x20))
          },
          cancel() { cancelled = true },
        }))
      })
      const fixing = fixImportFileWithLlm({ ...params, validateCandidate: bytes => { validated++; return params.validateCandidate(bytes) } })
      if (kind === "exact limit") {
        assert.equal(new TextDecoder().decode((await fixing).contentBytes), fixedReference)
        assert.equal(validated, 1)
      } else {
        await assert.rejects(fixing, { name: "AiFixError", message: "AI_FIX_INVALID_RESPONSE" })
        assert.equal(validated, 0, "invalid transport bytes must never reach candidate validation")
        if (kind === "chunked overflow") assert.equal(cancelled, true)
      }
      assert.equal(f.fixRequests.length, 1, "transport/shape errors are not candidate-validation retries")
    } finally { await f.cleanup() }
  })
})

test("AI fix targeted edits use evolving unique matches and reject overlaps without partial staging", async t => {
  for (const overlap of [false, true]) await t.test(overlap ? "overlapping edits rejected" : "evolving unique edits accepted", async () => {
    const f = await fixture({ role: "admin" })
    try {
      const text = "Unchanged large fixture text.\n".repeat(1100) + originalReference
      const params = await engineParams(f, text)
      let validated = 0
      f.fixResponse(async body => {
        const request = JSON.stringify(body), placeholder = request.match(/\[REDACTED_SECRET_\d+\]/)?.[0]
        assert.ok(placeholder)
        const first = { oldText: `api_key="${placeholder}"`, newText: "api_key=<INTERMEDIATE>" }
        const second = { oldText: overlap ? first.oldText : first.newText, newText: "api_key=$SYNTHETIC_KEY" }
        return aiResponse({ summary: "Sửa tuần tự", edits: [first, second] })
      })
      const fixing = fixImportFileWithLlm({ ...params, validateCandidate: bytes => { validated++; return params.validateCandidate(bytes) } })
      if (overlap) {
        await assert.rejects(fixing, { name: "AiFixError", message: "AI_FIX_INVALID_RESPONSE" })
        assert.equal(validated, 0)
      } else {
        assert.equal(new TextDecoder().decode((await fixing).contentBytes), text.replace(`api_key="${syntheticSecret}"`, "api_key=$SYNTHETIC_KEY"))
        assert.equal(validated, 1)
      }
      assert.equal(new TextDecoder().decode(params.fileBytes), text)
      assert.equal(f.fixRequests.length, 1)
    } finally { await f.cleanup() }
  })
})

test("AI fix rejects provider echoes even outside assignment syntax and strips echoed summaries", async t => {
  for (const kind of ["plain echo", "summary echo", "PEM payload echo"] as const) await t.test(kind, async () => {
    const f = await fixture({ role: "admin" })
    try {
      const params = await engineParams(f)
      let validated = 0
      const pemPayload = "fixture-pem-payload-1234567890"
      f.fixResponse(async () => aiResponse({ summary: `Đã thay ${syntheticSecret}`, content: kind === "PEM payload echo" ? `Plain documentation echo: ${pemPayload}` : kind === "plain echo" ? `Plain documentation echo: ${syntheticSecret}` : fixedReference }))
      const fixing = fixImportFileWithLlm({ ...params, ...(kind === "PEM payload echo" ? { fileBytes: encode(`-----BEGIN PRIVATE KEY-----\n${pemPayload}\n-----END PRIVATE KEY-----\n`) } : {}), validateCandidate: bytes => { validated++; return params.validateCandidate(bytes) } })
      if (kind !== "summary echo") {
        await assert.rejects(fixing, { name: "AiFixError", message: "AI_FIX_INVALID_RESPONSE" })
        assert.equal(validated, 0, "a syntactically harmless echo is still a forbidden secret literal")
      } else {
        const result = await fixing
        assert.equal(JSON.stringify(result).includes(syntheticSecret), false)
        assert.match(result.summary, /REDACTED_/)
        assert.equal(validated, 1)
      }
      assert.equal(JSON.stringify(f.fixRequests).includes(syntheticSecret), false)
    } finally { await f.cleanup() }
  })
})
