import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createAmeKit, type AmeKitDependencies, type AmeKit } from "../src/index"
import { openSessionVault, type Encryption } from "../src/session-vault"
import { pack, preview, safePath } from "../src/bundle/package"
import { installed, install, uninstall } from "../src/installer"
import type { Release } from "../src/api"

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
async function fixture(settings: { role?: unknown; plugin?: boolean; confirm?: boolean; encryption?: Encryption; mode?: "native" | "raw"; discover?: AmeKitDependencies["discover"] } = {}) {
  const folder = await area(), project = path.join(folder, "project"), imported = path.join(folder, "source"), data = path.join(folder, "data")
  await mkdir(project); await mkdir(imported)
  for (const file of input()) { const target = path.join(imported, ...file.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.data) }
  const artifact = await bundle(settings.mode)
  const rpc: unknown[] = [], requests: string[] = [], dialogs: string[] = []
  let role: unknown = settings.role ?? "user", plugin = settings.plugin !== false, accepted = settings.confirm !== false, failAuth = false, failStorage = false, pickerCount = 0
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(String(request)); requests.push(url.pathname)
    if (url.origin === "http://127.0.0.1:3210") {
      assert.equal(url.pathname, "/api/rpc/amekit-models/update")
      assert.equal(new Headers(init?.headers).get("authorization"), "Basic fixture-owner")
      rpc.push(JSON.parse(String(init?.body)).input)
      return Response.json(plugin ? { output: true } : { type: "rpc.unavailable" }, { status: plugin ? 200 : 400 })
    }
    assert.equal(url.origin, "http://localhost:3211", "no real API calls")
    if (failAuth) return Response.json({ error: { code: "USER_DISABLED" } }, { status: 401 })
    if (url.pathname === "/v1/amekit/releases/latest") return Response.json(artifact.latest)
    if (url.pathname.endsWith("/download")) return new Response(Uint8Array.from(artifact.packed.bytes))
    if (url.pathname === "/v1/amekit/releases" && init?.method !== "POST") return Response.json({ releases: [artifact.release], active: { release_id: artifact.release.releaseId, revision: 1, activated_at: 1 }, nextCursor: null })
    if (url.pathname.endsWith("/activate")) return Response.json(artifact.latest)
    if (url.pathname === "/v1/amekit/bundles/uploads") return Response.json({ uploadId: artifact.release.releaseId })
    if (url.pathname === "/v1/amekit/releases" && init?.method === "POST") return Response.json({ release: artifact.release })
    return Response.json({ session: { token: "fixture-session-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, user: { id: "1", name: "Fixture", username: "fixture", role }, provider: { base_url: "http://localhost:3212/v1", api_key: "fixture-provider-key" }, catalog, registry: {} })
  }
  const dependencies: AmeKitDependencies = {
    fetch: fetcher,
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

test("Linux basic_text storage backend is rejected even when encryption reports available", async () => {
  const folder = await area()
  try {
    const vault = await openSessionVault(folder, { ...encryption, getSelectedStorageBackend: () => "basic_text" })
    await assert.rejects(vault.save({ origin: "http://localhost:3211", token: "fixture" }), /SESSION_STORAGE_UNAVAILABLE/)
    assert.deepEqual(await readdir(folder), [])
  } finally { await rm(folder, { recursive: true, force: true }) }
})
