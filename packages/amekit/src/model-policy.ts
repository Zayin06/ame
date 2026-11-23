// Adapted from opencode-amekit/src/model-policy.ts; see ../docs/amekit.md for provenance.
import { z } from "zod"
import type { Role } from "./api"

export const managedProvider = "amecode"
export const MODEL_LEVELS = ["default", "haiku", "sonnet", "opus"] as const
export type ModelLevel = (typeof MODEL_LEVELS)[number]
export type ModelLevels = Record<ModelLevel, string>
const levelsSchema = z.object({
  default: z.string().min(1), haiku: z.string().min(1),
  sonnet: z.string().min(1), opus: z.string().min(1),
})
const entry = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(200),
  tool_call: z.boolean(), vision: z.boolean(), reasoning: z.boolean().default(false),
  context: z.number().int().positive(), output: z.number().int().positive(),
})
export const catalogSchema = z.object({
  version: z.string().min(1).max(100), default_model: z.string().min(1),
  small_model: z.string().min(1), models: z.array(entry).min(1).max(2000),
  model_levels: levelsSchema.optional(),
}).superRefine((catalog, ctx) => {
  const ids = new Set(catalog.models.map(model => model.id))
  if (ids.size !== catalog.models.length || !ids.has(catalog.default_model) || !ids.has(catalog.small_model) ||
    (catalog.model_levels && (catalog.model_levels.default !== catalog.default_model || MODEL_LEVELS.some(level => !ids.has(catalog.model_levels![level])))))
    ctx.addIssue({ code: "custom", message: "INVALID_MODEL_DEFAULT" })
})
export type ManagedCatalog = z.infer<typeof catalogSchema>
export function parseModelLevel(value: string | undefined): ModelLevel | undefined {
  const match = /^(?:amecode\/)?(default|haiku|sonnet|opus)$/.exec(value?.trim().toLowerCase() ?? "")
  return match?.[1] as ModelLevel | undefined
}
export function resolveModelLevel(policy: { default_model: string; model_levels: ModelLevels }, idOrLevel: string): string {
  const level = parseModelLevel(idOrLevel)
  return level ? policy.model_levels[level] : idOrLevel
}
export function modelPolicy(role: Role | undefined, value: unknown, options: { featureModels?: readonly string[] } = {}) {
  if (role !== "admin" && role !== "user") throw new Error("INVALID_ROLE")
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success) throw new Error("INVALID_MODEL_CATALOG")
  const catalog = parsed.data
  const model_levels: ModelLevels = role === "admin" ? {
    default: catalog.default_model,
    haiku: catalog.model_levels?.haiku ?? catalog.small_model,
    sonnet: catalog.model_levels?.sonnet ?? catalog.default_model,
    opus: catalog.model_levels?.opus ?? catalog.default_model,
  } : { default: catalog.default_model, haiku: catalog.default_model, sonnet: catalog.default_model, opus: catalog.default_model }
  const active_models = catalog.models
  const chat_models = role === "admin" ? catalog.models : catalog.models.filter(model => model.id === catalog.default_model)
  const feature_models = [...new Set(options.featureModels ?? [])].filter(id => id !== catalog.default_model && catalog.models.some(model => model.id === id))
  const allowedIds = new Set([...chat_models.map(model => model.id), ...feature_models])
  const models = catalog.models.filter(model => allowedIds.has(model.id))
  return { ...catalog, model_levels, active_models, chat_models, feature_models, models }
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
