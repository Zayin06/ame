import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import { assertModel, managedProvider, parseModelLevel, type modelPolicy } from "../../amekit/src/model-policy"
import { MAX_MODEL_REQUEST_BYTES } from "../../ide-core/src/dropped-attachments"

type Access = { policy: ReturnType<typeof modelPolicy>; provider: { base_url: string; api_key: string } }
export async function modelGateway(access: () => Access | undefined) {
  const route = `/${randomBytes(24).toString("hex")}/v1`
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    res.on("close", () => { if (!res.writableEnded) controller.abort() })
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
      const current = access()
      const level = typeof payload?.model === "string" ? parseModelLevel(payload.model) : undefined
      if (level && current?.policy) {
        payload.model = current.policy.model_levels[level]
        body = Buffer.from(JSON.stringify(payload), "utf8")
      }
      assertModel(current?.policy, { providerID: managedProvider, id: payload.model })
      const provider = current!.provider
      const response = await fetch(provider.base_url.replace(/\/$/, "") + "/chat/completions", {
        method: "POST", body, headers: { "content-type": "application/json", authorization: `Bearer ${provider.api_key}` },
        redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      })
      if (!response.ok) throw new Error("AMECODE_PROVIDER_ERROR")
      res.writeHead(200, { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" })
      if (response.body) {
        const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
        stream.on("error", () => res.destroy()); stream.pipe(res)
      } else res.end()
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      const code = error instanceof Error && /^AMECODE_[A-Z_]+$/.test(error.message) ? error.message : "AMECODE_PROVIDER_ERROR"
      res.writeHead(code === "AMECODE_REQUEST_TOO_LARGE" ? 413 : 403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code, message: code } }))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() }) })
  const address = server.address() as import("node:net").AddressInfo
  return { baseURL: `http://127.0.0.1:${address.port}${route}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
