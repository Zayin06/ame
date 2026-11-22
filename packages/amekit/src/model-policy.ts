// Adapted from opencode-amekit/src/model-policy.ts; see ../docs/amekit.md for provenance.
import { z } from "zod"
import type { Role } from "./api"

export const managedProvider = "amecode"
const entry = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(200),
  tool_call: z.boolean(), vision: z.boolean(), reasoning: z.boolean().default(false),
  context: z.number().int().positive(), output: z.number().int().positive(),
})
export const catalogSchema = z.object({
  version: z.string().min(1).max(100), default_model: z.string().min(1),
  small_model: z.string().min(1), models: z.array(entry).min(1).max(2000),
}).superRefine((catalog, ctx) => {
  const ids = new Set(catalog.models.map(model => model.id))
  if (ids.size !== catalog.models.length || !ids.has(catalog.default_model) || !ids.has(catalog.small_model))
    ctx.addIssue({ code: "custom", message: "INVALID_MODEL_DEFAULT" })
})
export type ManagedCatalog = z.infer<typeof catalogSchema>
export function modelPolicy(role: Role | undefined, value: unknown) {
  if (role !== "admin" && role !== "user") throw new Error("INVALID_ROLE")
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success) throw new Error("INVALID_MODEL_CATALOG")
  const catalog = parsed.data
  return { ...catalog, models: role === "admin" ? catalog.models : catalog.models.filter(model => model.id === catalog.default_model) }
}
export function assertModel(policy: ReturnType<typeof modelPolicy> | undefined, model: { providerID: string; id: string }) {
  if (!policy) throw new Error("AMECODE_LOGIN_REQUIRED")
  if (model.providerID !== managedProvider || !policy.models.some(entry => entry.id === model.id)) throw new Error("AMECODE_MODEL_NOT_ALLOWED")
}
export function providerURL(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("INVALID_PROVIDER_URL")
  return url.href.replace(/\/$/, "")
}
