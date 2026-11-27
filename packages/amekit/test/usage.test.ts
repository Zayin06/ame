import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { estimateUsage, readUsagePrices, tokenValues, validTokens, type UsagePrice, type UsageTokens } from "../src/usage-pricing"
import { aggregateUsageTree, cacheHitLevel, cacheHitRate, emptyTokens, formatCacheHitRate, formatTokenCount, formatUsageCost, HIGH_CONTEXT_THRESHOLD, LOW_CACHE_MIN_REQUESTS, LOW_CACHE_MIN_UNCACHED, summarizeUsage, usageDiagnostics, usageFamily } from "../src/usage"

function price(overrides: Partial<UsagePrice> = {}): UsagePrice {
  return { model_id: "catalog-model", upstream_model_id: "model", provider_route: "amecode", status: "priced",
    price_kind: "catalog_estimate", currency: "USD", unit: "per_1m_tokens", source: { id: "catalog", source_model_id: "model" },
    profiles: { standard: { base: { input: "1", output: "2", reasoning: "3", cache_read: "0.5", cache_write: "1.5" }, overrides: [] } },
    revision: 1, ...overrides }
}
const prices = readUsagePrices({ models: [{ id: "model", pricing: price() }] })
function session(id: string, parentID?: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id, parentID, projectID: "project", cost: 999, tokens: emptyTokens(), time: { created: 0, updated: 10 },
    location: { directory: "C:\\workspace" }, ...overrides }
}
function assistant(id: string, overrides: Partial<SessionMessageAssistant> = {}): SessionMessageAssistant {
  return { id, type: "assistant", agent: "coder", model: { id: "model", providerID: "amecode" }, content: [],
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }, time: { created: 10, completed: 110 }, ...overrides }
}
function summarize(messages: readonly SessionMessageInfo[], overrides: Partial<Parameters<typeof summarizeUsage>[0]> = {}) {
  return summarizeUsage({ id: "root", depth: 0, messages, prices, historyComplete: true, ...overrides })
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`) }

test("cache hit helpers use the complete SDK prompt and exclude output/reasoning", () => {
  for (const [input, read, write, rate, text, level] of [
    [0, 0, 0, null, "—", "none"],
    [100, 0, 0, 0, "0%", "low"],
    [130, 200, 0, 200 / 330, "60.6%", "warn"],
    [78000, 332500, 0, 332500 / 410500, "81%", "good"],
    [0, 100, 0, 1, "100%", "good"],
    [10, 60, 0, 60 / 70, "85.7%", "good"],
    [10, 60, 30, 0.6, "60%", "warn"],
    [0, 0, 100, 0, "0%", "low"],
    [70, 30, 0, 0.3, "30%", "warn"],
    [30, 70, 0, 0.7, "70%", "good"],
    [701, 299, 0, 0.299, "29.9%", "low"],
  ] as const) {
    const tokens = { input, output: 500, reasoning: 200, cache: { read, write } }
    const before = JSON.stringify(tokens)
    assert.equal(cacheHitRate(tokens), rate)
    assert.equal(formatCacheHitRate(tokens), text)
    assert.equal(cacheHitLevel(tokens), level)
    assert.equal(JSON.stringify(tokens), before)
  }
})

test("cache hit helpers return no rate for invalid tokens in any category", () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const base = { input: 10, output: 20, reasoning: 5, cache: { read: 60, write: 30 } }
    for (const tokens of [
      ...(["input", "output", "reasoning"] as const).map(key => ({ ...base, [key]: invalid })),
      ...(["read", "write"] as const).map(key => ({ ...base, cache: { ...base.cache, [key]: invalid } })),
    ]) {
      assert.equal(cacheHitRate(tokens), null)
      assert.equal(formatCacheHitRate(tokens), "—")
      assert.equal(cacheHitLevel(tokens), "none")
    }
  }
})

test("readUsagePrices accepts strict catalogs, handles prototype keys and ignores invalid/mismatched pricing", () => {
  const invalid = [
    { ...price(), currency: "EUR" }, { ...price(), unexpected: true },
    { ...price(), revision: 0 }, { ...price(), reference_price_route: "other" },
    price({ profiles: { standard: { base: { input: "-1" }, overrides: [] } } }),
    price({ profiles: { standard: { base: {}, overrides: [
      { when: { input_tokens_gt: 20 }, rates: {}, application: "whole_request" },
      { when: { input_tokens_gt: 20 }, rates: {}, application: "whole_request" },
    ] } } }),
    price({ status: "free" }),
    price({ status: "free", profiles: { standard: { base: { input: "0" }, overrides: [] } } }),
  ]
  const result = readUsagePrices({ models: [
    { id: "model", pricing: price() }, { id: "mismatch", pricing: price() },
    { id: "__proto__", pricing: price({ upstream_model_id: "__proto__" }) },
    ...invalid.map((pricing, index) => ({ id: `invalid-${index}`, pricing: { ...pricing, upstream_model_id: `invalid-${index}` } })),
    null, { id: 1, pricing: price() },
  ] })
  assert.equal(Object.getPrototypeOf(result), null)
  assert.deepEqual(Object.keys(result), ["model", "__proto__"])
  assert.equal(result.model.revision, 1)
  for (const input of [null, [], 7, { models: "invalid" }]) assert.deepEqual(Object.keys(readUsagePrices(input)), [])
  const models = Array.from({ length: 2001 }, (_, index) => ({ id: String(index), pricing: price({ upstream_model_id: String(index) }) }))
  const limited = readUsagePrices({ models })
  assert.equal(Object.keys(limited).length, 2000)
  assert.equal(limited["2000"], undefined)
})

test("pricing charges all token categories and selects the highest strict prompt threshold including cache", () => {
  const tokens: UsageTokens = { input: 100, output: 20, reasoning: 5, cache: { read: 70, write: 30 } }
  close(estimateUsage(tokens, price())!, 0.000235)
  const tiered = price({ profiles: { standard: { base: { input: "1", output: "2", cache_read: "0", cache_write: "0" }, overrides: [
    { when: { input_tokens_gt: 100 }, rates: { input: "2" }, application: "whole_request" },
    { when: { input_tokens_gt: 200 }, rates: { input: "4", output: "8" }, application: "whole_request" },
  ] } } })
  close(estimateUsage({ ...tokens, reasoning: 0 }, tiered)!, 0.00024)
  close(estimateUsage({ ...tokens, reasoning: 0, cache: { read: 71, write: 30 } }, tiered)!, 0.00056)
  close(estimateUsage({ ...emptyTokens(), input: 100 }, tiered)!, 0.0001)
})

test("free, unavailable rates/status and unsafe tokens never confuse Unknown with free", () => {
  const free = price({ status: "free", profiles: { standard: { base: { input: "0", output: "0", cache_read: "0", cache_write: "0" }, overrides: [] } } })
  assert.equal(estimateUsage(assistant("a").tokens!, free), 0)
  const missingReasoning = price({ profiles: { standard: { base: { input: "1" }, overrides: [] } } })
  assert.equal(estimateUsage({ ...emptyTokens(), reasoning: 1 }, missingReasoning), undefined)
  assert.equal(estimateUsage({ ...emptyTokens(), input: 1 }, missingReasoning), 0.000001)
  for (const status of ["missing", "unsupported"] as const) assert.equal(estimateUsage(emptyTokens(), price({ status })), undefined)
  assert.equal(estimateUsage(emptyTokens()), undefined)
  const missingTierRate = price({ profiles: { standard: { base: { input: "1" }, overrides: [
    { when: { input_tokens_gt: 0 }, rates: { input: null }, application: "whole_request" },
  ] } } })
  assert.equal(estimateUsage({ ...emptyTokens(), input: 1 }, missingTierRate), undefined)
  for (const input of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const tokens = { ...emptyTokens(), input }
    assert.equal(validTokens(tokens), false)
    assert.equal(estimateUsage(tokens, free), undefined)
  }
  assert.equal(validTokens({ ...emptyTokens(), cache: { read: -1, write: 0 } }), false)
})

test("usageFamily is breadth-first across four-plus levels, missing roots and cycles", () => {
  const sessions = [session("l3", "l2"), session("root"), session("l1", "root"), session("sibling", "root"), session("l2", "l1"), session("l4", "l3")]
  assert.deepEqual(usageFamily(sessions, "root").map(({ id, depth }) => [id, depth]), [["root", 0], ["l1", 1], ["sibling", 1], ["l2", 2], ["l3", 3], ["l4", 4]])
  assert.deepEqual(usageFamily([session("a", "b"), session("b", "a"), session("a", "b")], "a").map(node => node.id), ["a", "b"])
  assert.deepEqual(usageFamily([], "missing"), [{ id: "missing", depth: 0, info: undefined }])
})

test("summarizeUsage deduplicates messages, groups model variants and counts skills and tool outcomes/durations", () => {
  const skill: SessionMessageInfo = { id: "skill1", type: "skill", skill: "skill", name: "testing", text: "", time: { created: 0 } }
  const first = assistant("first", { content: [
    { type: "tool", id: "t1", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] }, time: { created: 0, ran: 10, completed: 40 } },
    { type: "tool", id: "t2", name: "shell", state: { status: "error", input: {}, error: { type: "tool", message: "failed" } }, time: { created: 10, completed: 30 } },
    { type: "tool", id: "t3", name: "shell", state: { status: "running", input: {}, metadata: {} }, time: { created: 10 } },
    { type: "tool", id: "t4", name: "read", state: { status: "streaming", input: "" }, time: { created: 10 } },
  ] })
  const second = assistant("second", { finish: "error", retry: { attempt: 1, at: 30, error: { type: "retry", message: "retrying" } } })
  const variant = assistant("variant", { model: { id: "model", providerID: "amecode", variant: "high" } })
  const agent = assistant("agent", { agent: "reviewer" })
  const foreign = assistant("foreign", { model: { id: "model", providerID: "external" } })
  const node = summarize([skill, skill, { ...skill, id: "skill2" }, first, first, second, variant, agent, foreign])
  assert.deepEqual(node.skills, [{ name: "testing", count: 2 }])
  assert.deepEqual(node.tools, [{ name: "shell", calls: 3, errors: 1, running: 1, duration: 50 }, { name: "read", calls: 1, errors: 0, running: 1, duration: 0 }])
  assert.equal(node.groups.length, 4)
  assert.equal(node.groups[0].requests, 2)
  assert.equal(node.groups[0].errors, 1)
  assert.equal(node.groups[0].retries, 1)
  assert.equal(node.groups[0].duration, 200)
  assert.equal(node.groups[0].completed, 2)
  assert.equal(node.groups[0].sources.length, 1)
  assert.deepEqual(tokenValues(node.tokens), [500, 100, 25, 50, 10])
  assert.equal(node.priced, 4)
  assert.equal(node.unknown, 1)
  close(node.knownCost, 4 * 0.000163)
  assert.equal(aggregateUsageTree([node]).incomplete, true)
})

test("fork boundaries exclude inherited history and mark a missing boundary unassigned", () => {
  const messages = [assistant("inherited"), assistant("boundary"), assistant("own")]
  for (const [type, requests] of [["through", 1], ["before", 2]] as const) {
    const info = session("fork", "root", { fork: { sessionID: "root", boundary: { type, messageID: "boundary" } } })
    const node = summarize(messages, { id: "fork", depth: 1, info })
    assert.equal(node.groups[0].requests, requests)
    assert.equal(node.parentID, "root")
  }
  const missing = summarize(messages, { info: session("fork", undefined, { fork: { sessionID: "root", boundary: { type: "through", messageID: "absent" } } }) })
  assert.equal(missing.groups.length, 0)
  assert.equal(missing.partial, true)
  assert.equal(missing.unassigned, true)
})

test("compaction is priced once when attributable; auxiliary usage and session-total gaps stay unassigned", () => {
  const compaction: SessionMessageInfo = { id: "compact", type: "compaction", status: "completed", reason: "auto", summary: "", time: { created: 0 }, model: { id: "model", providerID: "amecode" }, tokens: assistant("a").tokens }
  const node = summarize([compaction, compaction], { info: session("root", undefined, { tokens: assistant("a").tokens! }) })
  assert.equal(node.priced, 1)
  assert.equal(node.groups[0].agent, "Compaction (agent unavailable)")
  assert.equal(node.groups[0].pending, 0)
  assert.equal(node.partial, false)
  assert.equal(node.unassigned, false)
  close(node.knownCost, 0.000163)
  const auxiliary: SessionMessageInfo = { id: "aux", type: "compaction", status: "failed", reason: "manual", time: { created: 0 }, error: { type: "compaction", message: "failed" }, tokens: { ...emptyTokens(), input: 1 } }
  assert.equal(summarize([auxiliary]).unassigned, true)
  assert.equal(summarize([], { info: session("root", undefined, { tokens: { ...emptyTokens(), input: 1 } }) }).unassigned, true)
})

test("missing/invalid usage and unfinished requests keep rollups incomplete without manufacturing costs", () => {
  const node = summarize([
    assistant("missing", { tokens: undefined, time: { created: 0 } }),
    assistant("invalid", { tokens: { ...emptyTokens(), input: -1 } }),
  ], { historyComplete: false })
  assert.equal(node.partial, true)
  assert.equal(node.unknown, 2)
  assert.equal(node.priced, 0)
  assert.deepEqual(node.tokens, emptyTokens())
  assert.equal(aggregateUsageTree([node]).pending, 1)
  assert.equal(formatUsageCost(node.knownCost, node.priced, true), "Unknown")
})

test("aggregateUsageTree sums every generation without SDK costs or tool double charges and does not mutate nodes", () => {
  const sessions = [session("root"), session("l1", "root"), session("l2", "l1"), session("l3", "l2")]
  const nodes = usageFamily(sessions, "root").map(node => summarize([assistant(node.id)], { ...node, info: { ...node.info!, tokens: assistant("a").tokens! } }))
  const before = JSON.stringify(nodes)
  const summary = aggregateUsageTree(nodes)
  assert.deepEqual({ ...summary, knownCost: 0 }, { nodeCount: 4, maxDepth: 3, tokens: { input: 400, output: 80, reasoning: 20, cache: { read: 40, write: 8 } }, knownCost: 0, priced: 4, unknown: 0, requests: 4, errors: 0, pending: 0, incomplete: false, maxPromptTokens: 112, cacheMissDrops: 0 })
  close(summary.knownCost, 4 * 0.000163)
  assert.equal(JSON.stringify(nodes), before)
  for (const flag of ["partial", "unassigned"] as const) assert.equal(aggregateUsageTree([{ ...nodes[0], [flag]: true }]).incomplete, true)
  assert.equal(aggregateUsageTree([{ ...nodes[0], groups: [{ ...nodes[0].groups[0], pending: 1, errors: 1 }] }]).errors, 1)
  assert.equal(aggregateUsageTree([{ ...nodes[0], groups: [{ ...nodes[0].groups[0], pending: 1 }] }]).incomplete, true)
  assert.deepEqual(aggregateUsageTree([]), { nodeCount: 0, maxDepth: 0, tokens: emptyTokens(), knownCost: 0, priced: 0, unknown: 0, requests: 0, errors: 0, pending: 0, incomplete: false, maxPromptTokens: 0, cacheMissDrops: 0 })
})

test("formatters distinguish unknown, free and partial cost and compact token magnitudes", () => {
  assert.equal(formatUsageCost(0, 0, false), "Unknown")
  assert.equal(formatUsageCost(0, 1, false), "$0.000000")
  assert.equal(formatUsageCost(1.25, 2, true), "Partial · $1.250000")
  assert.equal(formatUsageCost(0.0000001, 1, false), "<$0.000001")
  for (const [count, expected] of [[0, "0"], [999, "999"], [1000, "1K"], [12400, "12.4K"], [999999, "1M"], [1250000, "1.25M"]] as const)
    assert.equal(formatTokenCount(count), expected)
})


test("summarizeUsage, aggregateUsageTree and usageDiagnostics track maxPromptTokens, cacheMissDrops and threshold flags", () => {
  const highContextMessages = [
    assistant("step-1", { tokens: { input: 2_000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assistant("step-2", { tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 4_000, write: 0 } } }),
    assistant("step-3", { tokens: { input: 10_000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assistant("step-4", { tokens: { input: 8_000, output: 50, reasoning: 0, cache: { read: 10_000, write: 0 } } }),
    assistant("step-5", { tokens: { input: 50_000, output: 50, reasoning: 0, cache: { read: 5_000, write: 0 } } }),
    assistant("step-6", { tokens: { input: 2_000, output: 50, reasoning: 0, cache: { read: HIGH_CONTEXT_THRESHOLD - 2_000, write: 0 } } }),
  ]
  const rootNode = summarize(highContextMessages, { info: session("root") })
  assert.equal(rootNode.requests, 6)
  assert.equal(rootNode.maxPromptTokens, HIGH_CONTEXT_THRESHOLD)
  assert.equal(rootNode.cacheMissDrops, 2)
  assert.deepEqual(usageDiagnostics(rootNode), {
    highContext: true,
    cacheDropWarning: true,
    lowSampleShortSession: false,
  })

  const shortMessages = [
    assistant("short-1", { tokens: { input: 1_500, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assistant("short-2", { tokens: { input: 900, output: 20, reasoning: 0, cache: { read: 1_400, write: 0 } } }),
    assistant("short-3", { tokens: { input: 13_000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]
  const childNode = summarize(shortMessages, { depth: 1, id: "child", info: session("child", "root") })
  assert.equal(childNode.requests, 3)
  assert.ok(childNode.requests < LOW_CACHE_MIN_REQUESTS)
  assert.ok(childNode.tokens.input < LOW_CACHE_MIN_UNCACHED)
  assert.equal(childNode.maxPromptTokens, 13_000)
  assert.equal(childNode.cacheMissDrops, 1)
  assert.deepEqual(usageDiagnostics(childNode), {
    highContext: false,
    cacheDropWarning: false,
    lowSampleShortSession: true,
  })

  const tree = aggregateUsageTree([rootNode, childNode])
  assert.equal(tree.maxPromptTokens, HIGH_CONTEXT_THRESHOLD)
  assert.equal(tree.cacheMissDrops, 3)
})
