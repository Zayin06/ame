import test, { after } from "node:test"
import assert from "node:assert/strict"
import { link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { createAmeKit, type AmeKitDependencies, type AmeKit } from "../src/index"
import { openSessionVault, type Encryption } from "../src/session-vault"
import { zipSync, unzipSync } from "fflate"
import { pack, preview, safePath } from "../src/bundle/package"
import { validate } from "../src/bundle/manifest"
import { scan, scanWithSource } from "../src/bundle/scan"
import { buildCompactDiff, fixImportFileWithLlm, isFixableTextFile, redactSecretsForLlm } from "../src/bundle/ai-fix"
import { AmeApi } from "../src/api"
import { assertModel, catalogSchema, MODEL_LEVELS, modelPolicy, parseModelLevel, resolveModelLevel, type ModelLevels } from "../src/model-policy"
import { parse, stringify } from "yaml"
import { installed, install, readCommitEnhanceSkill, uninstall } from "../src/installer"
import type { Release } from "../src/api"
import { dialoguePrompt, localDialogue } from "../src/pet-dialogue"
import type { PetHostOptions } from "../src/pet-host"

const root = path.resolve("packages", "amekit", "test", `.work-${randomUUID()}`)
after(async () => { await rm(root, { recursive: true, force: true }) })
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
async function fixture(settings: { catalog?: unknown; role?: unknown; plugin?: boolean; confirm?: boolean; encryption?: Encryption; mode?: "native" | "raw"; commitEnhanceSkill?: string; discover?: AmeKitDependencies["discover"]; refreshIntervalMs?: number } = {}) {
  const folder = await area(), project = path.join(folder, "project"), imported = path.join(folder, "source"), data = path.join(folder, "data")
  await mkdir(project); await mkdir(imported)
  for (const file of input()) { const target = path.join(imported, ...file.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data) }
  const artifact = await bundle(settings.mode, settings.commitEnhanceSkill)
  const rpc: unknown[] = [], requests: string[] = [], dialogs: string[] = []
  let role: unknown = settings.role ?? "user", plugin = settings.plugin !== false, accepted = settings.confirm !== false, failAuth = false, failStorage = false, pickerCount = 0
  let sessionResponse: (() => Promise<Response | undefined>) | undefined, expiresAt: number | undefined
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
    if (failAuth) return Response.json({ error: { code: "USER_DISABLED" } }, { status: 401 })
    if (url.pathname === "/v1/session") { const response = await sessionResponse?.(); if (response) return response }
    if (url.pathname === "/v1/amekit/releases/latest") return Response.json(artifact.latest)
    if (url.pathname.endsWith("/download")) return new Response(Uint8Array.from(artifact.packed.bytes))
    if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") return Response.json({ releases: [artifact.release], active: { release_id: artifact.release.releaseId, revision: 1, activated_at: 1 }, nextCursor: null })
    if (url.pathname.endsWith("/activate")) return Response.json(artifact.latest)
    if (url.pathname === "/v1/amekit/bundles/uploads") return Response.json({ uploadId: artifact.release.releaseId })
    if (url.pathname === "/v1/amekit/releases" && init?.method === "POST") return Response.json({ release: artifact.release })
    return Response.json({ session: { token: "fixture-session-token", expires_at: new Date(expiresAt ?? Date.now() + 3600_000).toISOString() }, user: { id: "1", name: "Fixture", username: "fixture", role }, provider: { base_url: "http://localhost:3212/v1", api_key: "fixture-provider-key" }, catalog: settings.catalog ?? catalog, registry: {} })
  }
  const dependencies: AmeKitDependencies = {
    fetch: fetcher, refreshIntervalMs: settings.refreshIntervalMs,
    electron: async () => ({ safeStorage: { ...(settings.encryption ?? encryption), encryptString(text: string) { if (failStorage) throw new Error("contains-sensitive-material"); return (settings.encryption ?? encryption).encryptString(text) } }, dialog: { showMessageBox: async (options: { message?: string; detail?: string }) => { dialogs.push(options.detail ?? options.message ?? ""); return { response: accepted ? 1 : 0, checkboxChecked: false } } } as never }),
    discover: settings.discover ?? (async directory => {
      try { await readFile(path.join(directory, ".opencode", "agents", "helper.md")) } catch { return { agents: [], skills: [] } }
      return { agents: [{ id: "helper" }], skills: [{ id: "fixture", name: "fixture", path: path.join(directory, ".opencode", "skills", "fixture", "SKILL.md") }] }
    }),
  }
  const options = { userData: data, endpoint: () => ({ url: "http://127.0.0.1:3210", headers: { authorization: "Basic fixture-owner" } }), project: async (id: string) => { assert.equal(id, "project-id"); return project }, pickImport: async () => { pickerCount++; return imported } }
  const service = createAmeKit(options, dependencies)
  return { service, folder, project, imported, data, rpc, requests, dialogs, options, dependencies, artifact,
    role: (value: unknown) => { role = value }, plugin: (value: boolean) => { plugin = value }, confirm: (value: boolean) => { accepted = value }, disable: () => { failAuth = true }, breakStorage: () => { failStorage = true }, pickerCount: () => pickerCount,
    sessionResponse: (value?: () => Promise<Response | undefined>) => { sessionResponse = value }, expiresAt: (value: number) => { expiresAt = value },
    rpcResponse: (value?: () => Promise<Response | undefined>) => { rpcResponse = value },
    dialogueResponse: (value: (signal: AbortSignal) => Promise<Response>) => { dialogueResponse = value },
    fixRequests, fixResponse: (value: (body: Record<string, unknown>, init: RequestInit) => Promise<Response>) => { fixResponse = value },
    cleanup: async () => { await service.dispose(); await rm(folder, { recursive: true, force: true }) } }
}
const login = (service: AmeKit) => service.call("login", { server: "http://localhost:3211", username: "fixture", password: "fixture-password" })

test("model policy maps explicit tiers for admins and locks every user tier to the default", () => {
  const levels: ModelLevels = { default: "balanced-v2", haiku: "fast-v1", sonnet: "coding-v3", opus: "reasoning-v4" }
  const value = { ...catalog, default_model: levels.default, small_model: levels.haiku, model_levels: levels,
    models: Object.values(levels).map(id => ({ ...catalog.models[0], id, name: id })) }
  const admin = modelPolicy("admin", value)
  assert.deepEqual(admin.model_levels, levels)
  assert.deepEqual(admin.models.map(model => model.id), Object.values(levels))
  const user = modelPolicy("user", value)
  assert.deepEqual(user.models.map(model => model.id), [levels.default])
  assert.deepEqual(user.model_levels, { default: levels.default, haiku: levels.default, sonnet: levels.default, opus: levels.default })
  for (const level of MODEL_LEVELS) {
    assert.equal(resolveModelLevel(admin, `amecode/${level}`), levels[level])
    assert.equal(resolveModelLevel(user, level), levels.default)
  }
  assertModel(user, { providerID: "amecode", id: levels.default })
  for (const id of [levels.haiku, levels.sonnet, levels.opus, "haiku", "amecode/opus"])
    assert.throws(() => assertModel(user, { providerID: "amecode", id }), /AMECODE_MODEL_NOT_ALLOWED/)
  assert.throws(() => assertModel(admin, { providerID: "other", id: levels.default }), /AMECODE_MODEL_NOT_ALLOWED/)
  assert.deepEqual(modelPolicy("admin", catalog).model_levels, { default: "default", haiku: "other", sonnet: "default", opus: "default" })
  assert.deepEqual(modelPolicy("user", catalog).model_levels, { default: "default", haiku: "default", sonnet: "default", opus: "default" })
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
    assert.deepEqual(status.models.models.map(model => model.id), ["default"])
    assert.equal(status.models.small_model, "default")
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
    assert.deepEqual(refreshed.models.model_levels, { default: "default", haiku: "default", sonnet: "default", opus: "default" })
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
  assert.deepEqual((await validate(rewrite({}), "1.2.3")).features, {})
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
    await assert.rejects(readSkill(""), /PROJECT_REQUIRED/)
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
    const state = JSON.parse(await readFile(path.join(f.project, ".opencode", ".amekit-release.json"), "utf8"))
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
    const replaced = await install(f.project, "http://localhost:3211", baseline.release, baseline.packed.bytes, f.dependencies.discover!)
    assert.equal(Object.hasOwn(replaced.state, "features"), false, "syncing an unconfigured bundle clears the old selection")
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(f.project, ".opencode", ".amekit-release.json"), "utf8")), "features"), false)
    assert.equal(await readSkill("project-id"), null)
    await f.service.dispose()
    await assert.rejects(readSkill("project-id"), /AMEKIT_DISPOSED/)
  } finally { f.sessionResponse(); release?.(); await f.cleanup() }
})

test("commit Enhance reader strips frontmatter, preserves markdown, bounds text and strictly decodes UTF-8", async t => {
  for (const [name, bytes, expected] of [
    ["CRLF and BOM", encode("\uFEFF---\r\nname: fixture\r\ndescription: Fixture skill\r\n---\r\n\r\n# Tiêu đề\r\nKeep  two spaces.\r\n---\r\nEnd\r\n"), "# Tiêu đề\r\nKeep  two spaces.\r\n---\r\nEnd"],
    ["plain markdown", encode("  # Instructions\n\nKeep markdown.  "), "# Instructions\n\nKeep markdown."],
    ["bounded", encode("---\nname: fixture\ndescription: Fixture skill\n---\n" + "x".repeat(16_001)), "x".repeat(16_000)],
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
    await login(f.service)
    await f.service.call("sync", { project: "project-id" })
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

test("native sync preserves personal config, verifies runtime, supports offline and safe uninstall", async () => {
  const f = await fixture()
  try {
    await mkdir(path.join(f.project, ".opencode")); await writeFile(path.join(f.project, ".opencode", "personal.json"), "personal")
    await login(f.service)
    f.confirm(false)
    await assert.rejects(f.service.call("sync", { project: "project-id" }), /CANCELLED/)
    assert.equal(f.requests.some(request => request.endsWith("/download")), false)
    f.confirm(true)
    type Inventory = { agents: string[]; skills: string[]; fileCount: number; verification: string }
    const checkInventory = (value: Inventory) => {
      assert.deepEqual(value.agents, ["helper"])
      assert.deepEqual(value.skills, ["fixture"])
      assert.equal(value.fileCount, input().length)
    }
    const result = await f.service.call("sync", { project: "project-id" }) as Inventory & { changed: boolean }
    assert.equal(result.changed, true); assert.equal(result.verification, "runtime-ready")
    checkInventory(result)
    assert.equal(await readFile(path.join(f.project, ".opencode", "personal.json"), "utf8"), "personal")
    checkInventory(await f.service.call("installed", { project: "project-id" }) as Inventory)
    await f.service.call("logout", {})
    const before = f.requests.length
    const offline = await f.service.call("offline", { project: "project-id" }) as Inventory
    assert.equal(offline.verification, "runtime-ready")
    checkInventory(offline)
    assert.equal(f.requests.length, before)
    f.confirm(false); await assert.rejects(f.service.call("uninstall", { project: "project-id" }), /CANCELLED/)
    f.confirm(true)
    assert.deepEqual(await f.service.call("uninstall", { project: "project-id" }), { changed: true })
    assert.equal(await installed(f.project), undefined)
    assert.equal(await readFile(path.join(f.project, ".opencode", "personal.json"), "utf8"), "personal")
  } finally { await f.cleanup() }
})

test("native discovery failure rolls back while raw requires consent and never claims runtime-ready", async t => {
  await t.test("native discovery mismatch restores previous tree", async () => {
    const f = await fixture({ discover: async () => ({ agents: [], skills: [] }) })
    try {
      await mkdir(path.join(f.project, ".opencode")); await writeFile(path.join(f.project, ".opencode", "personal.json"), "unchanged")
      await login(f.service)
      await assert.rejects(f.service.call("sync", { project: "project-id" }), /DISCOVERY_MISMATCH/)
      assert.deepEqual(await readdir(path.join(f.project, ".opencode")), ["personal.json"])
      assert.equal(await readFile(path.join(f.project, ".opencode", "personal.json"), "utf8"), "unchanged")
    } finally { await f.cleanup() }
  })
  await t.test("raw consent is not renderer-only", async () => {
    const f = await fixture({ mode: "raw", discover: async () => { throw new Error("MUST_NOT_RUN") } })
    try {
      await login(f.service)
      await assert.rejects(f.service.call("sync", { project: "project-id" }), /RAW_INSTALL_CONFIRMATION_REQUIRED/)
      f.confirm(false)
      await assert.rejects(f.service.call("sync", { project: "project-id", allowRaw: "true" }), /CANCELLED/)
      f.confirm(true)
      const result = await f.service.call("sync", { project: "project-id", allowRaw: "true" }) as { verification: string }
      assert.equal(result.verification, "verified-bytes")
      assert.ok(f.dialogs.some(detail => detail.includes("RAW")))
      assert.equal((await f.service.call("offline", { project: "project-id" }) as { verification: string }).verification, "verified-bytes")
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

async function settledStatus(service: AmeKit) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    try { return await service.call("status", {}) as { ready: boolean; blocker?: string; account?: unknown } }
    catch (error) { if (!(error instanceof Error) || error.message !== "OPERATION_BUSY") throw error }
    await delay(1)
  }
  throw new Error("AmeKit operation did not settle")
}

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

test("background refresh and active IPC share the same operation mutex", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const f = await fixture({ refreshIntervalMs: 100 })
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
    await assert.rejects(f.service.call("assert-model", { modelID: "default" }), /OPERATION_BUSY/)
    t.mock.timers.tick(300)
    const releaseBackground = await waitForRelease()
    assert.equal(f.requests.filter(request => request === "/v1/session").length, before + 1)
    releaseBackground(); release = undefined
    assert.equal((await settledStatus(f.service)).ready, true)
    const active = f.service.call("assert-model", { modelID: "default" })
    const releaseActive = await waitForRelease()
    t.mock.timers.tick(300)
    assert.equal(f.requests.filter(request => request === "/v1/session").length, before + 2)
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
      assert.equal(body.model, "default"); assert.equal(body.stream, false); assert.equal(body.temperature, 0.1)
      assert.equal(body.max_tokens, 8192); assert.equal(init.redirect, "error"); assert.ok(init.signal)
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
    assert.deepEqual(result.failed, [{ path: secretPath, code: "AI_FIX_PROVIDER_ERROR" }])
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
      assert.equal(body.max_tokens, 4096)
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
      await assert.rejects(f.service.call("fix-import", { path: secretPath }), new RegExp(kind === "network" ? "^Error: AI_FIX_PROVIDER_ERROR$" : "^Error: AI_FIX_INVALID_RESPONSE$"))
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
      assert.equal(body.stream, false); assert.equal(body.temperature, 0.1); assert.equal(body.max_tokens, 8192)
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
        await assert.rejects(fixing, /^Error: AI_FIX_INVALID_RESPONSE$/)
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
        await assert.rejects(fixing, /^Error: AI_FIX_INVALID_RESPONSE$/)
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
        await assert.rejects(fixing, /^Error: AI_FIX_INVALID_RESPONSE$/)
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
