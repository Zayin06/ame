import { z } from "zod"

const rate = z.string().regex(/^\d{1,12}(?:\.\d{1,18})?$/).nullable().optional()
const rates = z.object({ input: rate, output: rate, cache_read: rate, cache_write: rate, reasoning: rate }).strict()
const text = z.string().min(1).max(200)
const pricingSchema = z.object({
  model_id: text, upstream_model_id: text, provider_route: text,
  reference_price_route: text.optional(),
  status: z.enum(["priced", "free", "missing", "unsupported"]),
  price_kind: z.enum(["catalog_estimate", "equivalent_api_estimate"]),
  currency: z.literal("USD"), unit: z.literal("per_1m_tokens"),
  source: z.object({ id: text, source_model_id: text }).strict(),
  profiles: z.object({ standard: z.object({
    base: rates,
    overrides: z.array(z.object({
      when: z.object({ input_tokens_gt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
      rates, application: z.literal("whole_request"),
    }).strict()).max(20),
  }).strict() }).strict(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((price, ctx) => {
  const profile = price.profiles.standard
  if (profile.overrides.some((rule, index) => index > 0 && rule.when.input_tokens_gt <= profile.overrides[index - 1].when.input_tokens_gt))
    ctx.addIssue({ code: "custom", message: "Invalid thresholds" })
  if (price.reference_price_route && price.price_kind !== "equivalent_api_estimate")
    ctx.addIssue({ code: "custom", message: "Invalid reference route" })
  if (price.status === "free" && (
    [profile.base.input, profile.base.output, profile.base.cache_read, profile.base.cache_write].some(value => value == null) ||
    [profile.base, ...profile.overrides.map(rule => rule.rates)].some(value => Object.values(value).some(value => value != null && Number(value) !== 0))
  )) ctx.addIssue({ code: "custom", message: "Invalid free price" })
})
export type UsagePrice = z.infer<typeof pricingSchema>
export type UsagePrices = Record<string, UsagePrice>
export type UsageTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export function readUsagePrices(catalog: unknown): UsagePrices {
  const result: UsagePrices = Object.create(null)
  if (!catalog || typeof catalog !== "object" || !("models" in catalog) || !Array.isArray(catalog.models)) return result
  for (const model of catalog.models.slice(0, 2000)) {
    if (!model || typeof model !== "object" || typeof model.id !== "string") continue
    const parsed = pricingSchema.safeParse(model.pricing)
    if (parsed.success && parsed.data.upstream_model_id === model.id) result[model.id] = parsed.data
  }
  return result
}

export function tokenValues(tokens: UsageTokens): number[] {
  return [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write]
}
export function validTokens(tokens: UsageTokens): boolean {
  return tokenValues(tokens).every(value => Number.isSafeInteger(value) && value >= 0)
}

export function estimateUsage(tokens: UsageTokens, price?: UsagePrice): number | undefined {
  if (!validTokens(tokens) || !price || !["priced", "free"].includes(price.status)) return undefined
  if (price.status === "free") return 0
  const profile = price.profiles.standard
  // SDK input excludes cache reads/writes; tiers use the complete request prompt.
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  const tier = [...profile.overrides].reverse().find(rule => prompt > rule.when.input_tokens_gt)
  const selected = { ...profile.base, ...tier?.rates }
  const counts = { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache_read: tokens.cache.read, cache_write: tokens.cache.write }
  let cost = 0
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    if (counts[key] === 0) continue
    const value = selected[key]
    if (value == null) return undefined
    cost += counts[key] * Number(value) / 1_000_000
  }
  return Number.isFinite(cost) ? cost : undefined
}
