import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { createAmeKit, type AmeKitDependencies, type AmeKit } from "../src/index"
import { openSessionVault, type Encryption } from "../src/session-vault"
import { pack, preview, safePath } from "../src/bundle/package"
import { scan } from "../src/bundle/scan"
import { parse, stringify } from "yaml"
import { installed, install, uninstall } from "../src/installer"
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
async function bundle(mode: "native" | "raw" = "native") {
  const packed = await pack(preview(input(), [], { compatibilityMode: mode }), "1.2.3")
  const release: Release = { releaseId: "ef2b4502-3b3f-4ac7-a223-81fdb4b77557", version: "1.2.3", channel: "stable", sha256: packed.sha256, size: packed.bytes.length, manifest: packed.summary as Release["manifest"], publishedAt: 1, downloadUrl: "/ignored" }
  return { packed, release, latest: { release, revision: 1, activatedAt: 1 } }
}
async function fixture(settings: { catalog?: unknown; role?: unknown; plugin?: boolean; confirm?: boolean; encryption?: Encryption; mode?: "native" | "raw"; discover?: AmeKitDependencies["discover"]; refreshIntervalMs?: number } = {}) {
  const folder = await area(), project = path.join(folder, "project"), imported = path.join(folder, "source"), data = path.join(folder, "data")
  await mkdir(project); await mkdir(imported)
  for (const file of input()) { const target = path.join(imported, ...file.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data) }
  const artifact = await bundle(settings.mode)
  const rpc: unknown[] = [], requests: string[] = [], dialogs: string[] = []
  let role: unknown = settings.role ?? "user", plugin = settings.plugin !== false, accepted = settings.confirm !== false, failAuth = false, failStorage = false, pickerCount = 0
  let sessionResponse: (() => Promise<Response | undefined>) | undefined, expiresAt: number | undefined
  let rpcResponse: (() => Promise<Response | undefined>) | undefined
  let dialogueResponse: ((signal: AbortSignal) => Promise<Response>) | undefined
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
    cleanup: async () => { await service.dispose(); await rm(folder, { recursive: true, force: true }) } }
}
const login = (service: AmeKit) => service.call("login", { server: "http://localhost:3211", username: "fixture", password: "fixture-password" })

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
    const imported = await f.service.call("import", { root: "C:\\ignored" }) as { files: { path: string; size: number }[] }
    assert.equal(f.pickerCount(), 1); assert.equal(imported.files.length, 2)
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
    const result = await f.service.call("sync", { project: "project-id" }) as { changed: boolean; verification: string }
    assert.equal(result.changed, true); assert.equal(result.verification, "runtime-ready")
    assert.equal(await readFile(path.join(f.project, ".opencode", "personal.json"), "utf8"), "personal")
    assert.ok(await f.service.call("installed", { project: "project-id" }))
    await f.service.call("logout", {})
    const before = f.requests.length
    assert.equal((await f.service.call("offline", { project: "project-id" }) as { verification: string }).verification, "runtime-ready")
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

test("Linux basic_text storage backend is rejected even when encryption reports available", async () => {
  const folder = await area()
  try {
    const vault = await openSessionVault(folder, { ...encryption, getSelectedStorageBackend: () => "basic_text" })
    await assert.rejects(vault.save({ origin: "http://localhost:3211", token: "fixture" }), /SESSION_STORAGE_UNAVAILABLE/)
    assert.deepEqual(await readdir(folder), [])
  } finally { await rm(folder, { recursive: true, force: true }) }
})
