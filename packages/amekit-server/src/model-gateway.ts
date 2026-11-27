import { createServer, type IncomingHttpHeaders } from "node:http"
import { randomBytes, randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { assertModel, managedProvider, parseModelLevel, type modelPolicy } from "../../amekit/src/model-policy"
import { MAX_MODEL_REQUEST_BYTES } from "../../ide-core/src/dropped-attachments"

export const FORWARDED_REQUEST_HEADERS = [
  "x-session-affinity",
  "x-session-id",
  "x-opencode-session-id",
  "session-id",
  "x-parent-session-id",
  "x-parent-session-affinity",
  "x-client-request-id",
] as const

const FORWARDED_HEADER_SET = new Set<string>(FORWARDED_REQUEST_HEADERS)

export type GatewayTelemetryEvent = {
  event: "http_error" | "fetch_error" | "stream_error" | "idle_timeout" | "client_abort" | "stream_complete"
  requestId: string
  sessionId?: string
  sessionAffinity?: string
  model?: string
  requestedModel?: string
  hasPromptCacheKey: boolean
  status?: number
  upstreamRequestId?: string
  elapsedMs: number
  firstByteMs?: number
  bytesSent: number
  errorCode?: string
  errorMessage?: string
}

export function extractForwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase()
    if (!FORWARDED_HEADER_SET.has(key)) continue
    const candidate = typeof rawValue === "string" ? rawValue : Array.isArray(rawValue) ? rawValue[0] : undefined
    if (typeof candidate !== "string") continue
    const trimmed = candidate.trim()
    if (!trimmed || trimmed.length > 256 || /[\r\n\x00]/.test(trimmed)) continue
    forwarded[key] = trimmed
  }
  return forwarded
}

function sanitizeTelemetryMessage(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]")
    .replace(/((?:api[_-]?key|access[_-]?token|token)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 200)
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const direct = (error as { code?: unknown }).code
  if (typeof direct === "string" && direct) return direct
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === "object") {
    const nested = (cause as { code?: unknown }).code
    if (typeof nested === "string" && nested) return nested
  }
  if (error instanceof Error && /^AMECODE_[A-Z_]+$/.test(error.message)) return error.message
  return undefined
}

type Access = { policy: ReturnType<typeof modelPolicy>; provider: { base_url: string; api_key: string } }
export async function modelGateway(
  access: () => Access | undefined,
  options: { headerTimeoutMs?: number; idleTimeoutMs?: number; onTelemetry?: (event: GatewayTelemetryEvent) => void } = {},
) {
  const { headerTimeoutMs = 120_000, idleTimeoutMs = 10 * 60_000 } = options
  const onTelemetry = options.onTelemetry ?? (entry => {
    if (entry.event === "http_error" || entry.event === "fetch_error" || entry.event === "stream_error" || entry.event === "idle_timeout") {
      console.error("[amekit-gateway]", JSON.stringify(entry))
    }
  })
  const route = `/${randomBytes(24).toString("hex")}/v1`
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    req.on("aborted", () => controller.abort())
    res.on("close", () => { if (!res.writableEnded) controller.abort() })
    const startedAt = Date.now()
    const forwarded = extractForwardedHeaders(req.headers)
    const requestId = forwarded["x-client-request-id"] || randomUUID()
    const sessionId = forwarded["x-session-id"] || forwarded["session-id"] || forwarded["x-opencode-session-id"]
    const sessionAffinity = forwarded["x-session-affinity"]
    let requestedModel: string | undefined
    let resolvedModel: string | undefined
    let hasPromptCacheKey = false
    let upstreamRequestId: string | undefined
    let firstByteMs: number | undefined
    let bytesSent = 0
    let terminalEmitted = false
    const emit = (patch: Pick<GatewayTelemetryEvent, "event" | "status" | "errorCode" | "errorMessage">) => {
      if (terminalEmitted) return
      terminalEmitted = true
      onTelemetry({
        ...patch,
        requestId,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionAffinity ? { sessionAffinity } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(requestedModel ? { requestedModel } : {}),
        hasPromptCacheKey,
        ...(upstreamRequestId ? { upstreamRequestId } : {}),
        elapsedMs: Date.now() - startedAt,
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
        bytesSent,
      })
    }
    try {
      if (req.method !== "POST" || req.url !== `${route}/chat/completions`) throw new Error("AMECODE_ROUTE_NOT_ALLOWED")
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_MODEL_REQUEST_BYTES) throw new Error("AMECODE_REQUEST_TOO_LARGE")
        chunks.push(Buffer.from(chunk))
      }
      let body = Buffer.concat(chunks)
      const payload = JSON.parse(body.toString("utf8"))
      requestedModel = typeof payload?.model === "string" ? payload.model : undefined
      hasPromptCacheKey = typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
      const current = access()
      const level = typeof payload?.model === "string" ? parseModelLevel(payload.model) : undefined
      if (level && current?.policy) {
        payload.model = current.policy.model_levels[level]
        body = Buffer.from(JSON.stringify(payload), "utf8")
      }
      resolvedModel = typeof payload?.model === "string" ? payload.model : undefined
      assertModel(current?.policy, { providerID: managedProvider, id: payload.model })
      const provider = current!.provider
      const headerController = new AbortController()
      const headerTimer = setTimeout(() => headerController.abort(new Error("AMECODE_HEADER_TIMEOUT")), headerTimeoutMs)
      const response = await fetch(provider.base_url.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        body,
        headers: { ...forwarded, "content-type": "application/json", authorization: `Bearer ${provider.api_key}` },
        redirect: "error",
        signal: AbortSignal.any([controller.signal, headerController.signal]),
      }).finally(() => clearTimeout(headerTimer))
      upstreamRequestId = response.headers.get("x-request-id")?.trim() || undefined
      if (!response.ok) {
        await response.body?.cancel()
        emit({ event: "http_error", status: response.status, errorMessage: `Upstream returned HTTP ${response.status}` })
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = response.headers.get("retry-after")
          const headers: Record<string, string> = { "content-type": "application/json" }
          if (retryAfter && (/^\d+$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter))) && !/[\r\n]/.test(retryAfter)) headers["retry-after"] = retryAfter
          res.writeHead(response.status, headers)
          res.end(JSON.stringify({ error: { code: "AMECODE_PROVIDER_ERROR", message: "AMECODE_PROVIDER_ERROR" } }))
          return
        }
        throw new Error("AMECODE_PROVIDER_ERROR")
      }
      res.writeHead(200, { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" })
      if (response.body) {
        const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
        let idleTimer: ReturnType<typeof setTimeout>
        const clearIdle = () => clearTimeout(idleTimer)
        const resetIdle = () => {
          clearIdle()
          idleTimer = setTimeout(() => {
            if (!stream.destroyed && !stream.readableEnded) {
              emit({ event: "idle_timeout", status: 200, errorCode: "AMECODE_IDLE_TIMEOUT", errorMessage: `Stream idle timeout after ${idleTimeoutMs}ms` })
              controller.abort(new Error("AMECODE_IDLE_TIMEOUT"))
              stream.destroy(); res.destroy()
            }
          }, idleTimeoutMs)
        }
        res.once("close", () => {
          clearIdle()
          stream.destroy()
          if (!res.writableEnded) emit({ event: "client_abort", status: 200, errorMessage: "Client closed response before completion" })
        })
        stream.on("data", (chunk: Buffer | string) => {
          if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt
          bytesSent += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
          resetIdle()
        })
        stream.once("end", () => {
          clearIdle()
          emit({ event: "stream_complete", status: 200 })
        })
        stream.once("close", clearIdle)
        stream.once("error", error => {
          clearIdle()
          emit({
            event: "stream_error",
            status: 200,
            errorCode: extractErrorCode(error),
            errorMessage: sanitizeTelemetryMessage(error instanceof Error ? error.message : String(error)),
          })
          res.destroy()
        })
        resetIdle(); stream.pipe(res)
      } else {
        emit({ event: "stream_complete", status: 200 })
        res.end()
      }
    } catch (error) {
      const errorMessage = sanitizeTelemetryMessage(error instanceof Error ? error.message : String(error))
      emit({ event: "fetch_error", errorCode: extractErrorCode(error), errorMessage })
      if (res.headersSent) { res.destroy(); return }
      const code = error instanceof Error && /^AMECODE_[A-Z_]+$/.test(error.message) ? error.message : "AMECODE_PROVIDER_ERROR"
      res.writeHead(code === "AMECODE_REQUEST_TOO_LARGE" ? 413 : 403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code, message: code } }))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() }) })
  const address = server.address() as import("node:net").AddressInfo
  return { baseURL: `http://127.0.0.1:${address.port}${route}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
