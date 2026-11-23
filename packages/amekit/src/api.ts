// Adapted from opencode-amekit/src/api.ts; see ../docs/amekit.md for provenance.
import { z } from "zod"
import { Features, type BundleFeatures } from "./bundle/manifest"
import { MAX_ZIP } from "./bundle/limits"
export type { BundleFeatures } from "./bundle/manifest"

export type Role = "admin" | "user"
export type AuthPayload = {
  session: { token: string; expires_at: string }
  user: { id: string; username: string; name: string; role?: Role }
  provider: { base_url: string; api_key: string }
  catalog: unknown
  registry: unknown
}
export type Summary = {
  schemaVersion: 1; target: "opencode"; version: string; channel: "stable"
  features?: BundleFeatures
  compatibility: { testedOpenCode: string[]; mode?: "native" | "raw" }; agents: number; skills: number; fileCount: number; expandedSize: number
}
export type Release = { releaseId: string; version: string; channel: "stable"; sha256: string; size: number; manifest: Summary; publishedAt: number; downloadUrl: string }
export type Latest = { release: Release; revision: number; activatedAt: number }
export type History = { releases: Release[]; active: { release_id: string | null; revision: number; activated_at: number | null }; nextCursor: string | null }
const authSchema = z.object({ session: z.object({ token: z.string().min(1).max(8192), expires_at: z.string().datetime() }), user: z.object({ id: z.string().min(1), username: z.string().min(1), name: z.string().min(1), role: z.unknown().optional() }), provider: z.object({ base_url: z.string().url(), api_key: z.string().min(1).max(8192) }), catalog: z.unknown(), registry: z.unknown() })
const summarySchema = z.object({ schemaVersion: z.literal(1), target: z.literal("opencode"), version: z.string(), channel: z.literal("stable"), compatibility: z.object({ testedOpenCode: z.array(z.string()), mode: z.enum(["native", "raw"]).optional() }), agents: z.number().int().positive(), skills: z.number().int().positive(), fileCount: z.number().int().positive(), expandedSize: z.number().int().nonnegative(), features: Features.optional() })
const releaseSchema = z.object({ releaseId: z.string().uuid(), version: z.string().min(1), channel: z.literal("stable"), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(MAX_ZIP), manifest: summarySchema, publishedAt: z.number().int(), downloadUrl: z.string() })
const latestSchema = z.object({ release: releaseSchema, revision: z.number().int().nonnegative(), activatedAt: z.number().int() })
const historySchema = z.object({ releases: z.array(releaseSchema).max(100), active: z.object({ release_id: z.string().uuid().nullable(), revision: z.number().int().nonnegative(), activated_at: z.number().int().nullable() }), nextCursor: z.string().nullable() })
async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new ClientError("INVALID_API_RESPONSE")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new ClientError("API_RESPONSE_TOO_LARGE") }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ClientError) throw error
    throw new ClientError("NETWORK_ERROR")
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw new ClientError("INVALID_API_RESPONSE") }
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new ClientError("INVALID_API_RESPONSE"); return parsed.data }
export class ClientError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code) }
}
export function isTransientError(error: unknown): error is ClientError {
  return error instanceof ClientError && error.status !== 401 && error.status !== 403 &&
    !["USER_DISABLED", "INVALID_ROLE", "INVALID_AUTH_RESPONSE", "MODEL_POLICY_PLUGIN_REQUIRED"].includes(error.code) &&
    (error.code === "NETWORK_ERROR" || error.status === 429 || error.status >= 500)
}
export function serverURL(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new ClientError("INVALID_SERVER")
  return url.origin
}
export class AmeApi {
  readonly origin: string
  private auth?: AuthPayload
  private token?: string
  constructor(server = "https://amecode.ameno.tech", private fetcher: typeof fetch = fetch) { this.origin = serverURL(server) }
  get account() { return this.auth?.user }
  get expires() { return this.auth ? Date.parse(this.auth.session.expires_at) : 0 }
  get provider() { return this.auth && { provider: this.auth.provider, catalog: this.auth.catalog, registry: this.auth.registry } }
  get credential() { return this.token ? { origin: this.origin, token: this.token } : undefined }
  clear() { this.auth = undefined; this.token = undefined }
  suspend() { this.auth = undefined }
  async resume(token: string, signal?: AbortSignal) {
    this.clear()
    if (!token || token.length > 8192) throw new ClientError("INVALID_AUTH_RESPONSE")
    this.token = token
    return this.refresh(signal)
  }
  private accept(value: unknown) {
    const result = authSchema.safeParse(value)
    if (!result.success || Date.parse(result.data.session.expires_at) <= Date.now()) {
      this.clear(); throw new ClientError("INVALID_AUTH_RESPONSE")
    }
    const p = result.data
    this.auth = { ...p, catalog: p.catalog, registry: p.registry, user: { ...p.user, role: p.user.role === "admin" || p.user.role === "user" ? p.user.role : undefined } }
    this.token = p.session.token
    return this.account!
  }
  private async request(path: string, init: RequestInit = {}, protectedRequest = true) {
    if (protectedRequest && !this.token) throw new ClientError("SIGNED_OUT", 401)
    const headers = new Headers(init.headers)
    if (protectedRequest) headers.set("Authorization", `Bearer ${this.token}`)
    let response: Response
    try { response = await this.fetcher(this.origin + path, { ...init, headers, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]) }) }
    catch (error) { if (init.signal?.aborted) throw new ClientError("CANCELLED"); throw new ClientError("NETWORK_ERROR") }
    if (!response.ok) {
      let code = "HTTP_ERROR"
      try { code = (await json(response) as { error?: { code?: string } }).error?.code ?? code } catch { /* No response details are exposed. */ }
      if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) code = "HTTP_ERROR"
      if (response.status === 401 || code === "USER_DISABLED" || code === "INVALID_ROLE") this.clear()
      if (response.status === 403 && this.auth) this.auth.user.role = undefined
      throw new ClientError(code, response.status)
    }
    return response
  }
  async login(username: string, password: string, signal?: AbortSignal) {
    this.clear()
    return this.accept(await json(await this.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, client: { editor: "AmeKit", app_version: "0.1.0" } }), signal }, false)))
  }
  async refresh(signal?: AbortSignal, options?: { preserveOnTransient?: boolean }) {
    try { return this.accept(await json(await this.request("/v1/session", { signal }))) }
    catch (error) {
      if (!(options?.preserveOnTransient && isTransientError(error) && this.auth && this.expires > Date.now())) this.auth = undefined
      if (!(error instanceof ClientError) || !["NETWORK_ERROR", "CANCELLED"].includes(error.code) && !(error.status >= 500 || error.status === 429)) this.clear()
      throw error
    }
  }
  async logout(signal?: AbortSignal) { try { if (this.token) await this.request("/v1/auth/logout", { method: "POST", signal }) } finally { this.clear() } }
  async guard(admin = false, signal?: AbortSignal) {
    const account = await this.refresh(signal)
    if (admin && account.role !== "admin") throw new ClientError("FORBIDDEN", 403)
  }
  async latest(signal?: AbortSignal): Promise<Latest> { await this.guard(false, signal); return decode(latestSchema, await json(await this.request("/v1/amekit/releases/latest?channel=stable", { signal }))) }
  async history(cursor?: string, signal?: AbortSignal): Promise<History> {
    await this.guard(true, signal)
    return decode(historySchema, await json(await this.request(`/v1/amekit/releases?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal })))
  }
  async publish(bytes: Uint8Array, version: string, hash: string, stage: (value: string) => void, signal?: AbortSignal): Promise<Release> {
    await this.guard(true, signal)
    const post = async (path: string, body?: unknown) => json(await this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }))
    stage("create")
    const upload = await post("/v1/amekit/bundles/uploads", { version, channel: "stable", filename: "amekit.zip", size: bytes.length, sha256: hash }) as { uploadId: string }
    if (!/^[0-9a-f-]{36}$/i.test(upload.uploadId)) throw new ClientError("INVALID_UPLOAD_RESPONSE")
    stage("transfer")
    await this.guard(true, signal)
    await this.request(`/v1/amekit/bundles/uploads/${upload.uploadId}/content`, { method: "PUT", headers: { "Content-Type": "application/zip", "Content-Length": String(bytes.length) }, body: bytes as BodyInit, signal })
    stage("finalize")
    await this.guard(true, signal)
    await post(`/v1/amekit/bundles/uploads/${upload.uploadId}/finalize`)
    stage("publish")
    await this.guard(true, signal)
    const result = await post("/v1/amekit/releases", { uploadId: upload.uploadId }) as { release: Release }
    stage("published-not-active")
    return decode(releaseSchema, result.release)
  }
  async activate(id: string, expectedRevision: number, signal?: AbortSignal): Promise<Latest> {
    await this.guard(true, signal)
    return decode(latestSchema, await json(await this.request(`/v1/amekit/releases/${encodeURIComponent(id)}/activate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision }), signal })))
  }
  async download(release: Release, signal?: AbortSignal) {
    await this.guard(false, signal)
    if (!/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isInteger(release.size) || release.size < 1 || release.size > MAX_ZIP) throw new ClientError("INVALID_RELEASE")
    const response = await this.request(`/v1/amekit/releases/${encodeURIComponent(release.releaseId)}/download`, { signal })
    const reader = response.body?.getReader()
    if (!reader) throw new ClientError("EMPTY_DOWNLOAD")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > release.size) { await reader.cancel(); throw new ClientError("SIZE_MISMATCH") }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    if (size !== release.size) throw new ClientError("SIZE_MISMATCH")
    const bytes = new Uint8Array(size)
    let at = 0
    for (const part of chunks) { bytes.set(part, at); at += part.length }
    return bytes
  }
}
