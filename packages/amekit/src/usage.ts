import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { estimateUsage, tokenValues, validTokens, type UsagePrices, type UsageTokens } from "./usage-pricing"

export const emptyTokens = (): UsageTokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

export function cacheHitRate(tokens: UsageTokens): number | null {
  if (!validTokens(tokens)) return null
  // SDK input excludes cache reads/writes; include both in the complete prompt.
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  return prompt > 0 ? tokens.cache.read / prompt : null
}

export function formatCacheHitRate(tokens: UsageTokens): string {
  const rate = cacheHitRate(tokens)
  return rate === null ? "—" : `${Number((rate * 100).toFixed(1))}%`
}

export function cacheHitLevel(tokens: UsageTokens): "good" | "warn" | "low" | "none" {
  const rate = cacheHitRate(tokens)
  return rate === null ? "none" : rate >= 0.7 ? "good" : rate >= 0.3 ? "warn" : "low"
}

function addTokens(to: UsageTokens, from: UsageTokens) {
  to.input += from.input; to.output += from.output; to.reasoning += from.reasoning
  to.cache.read += from.cache.read; to.cache.write += from.cache.write
}
export type UsageGroup = {
  agent: string; provider: string; model: string; variant?: string; requests: number
  pending: number; errors: number; retries: number; tokens: UsageTokens
  knownCost: number; priced: number; unknown: number; duration: number; completed: number
  sources: string[]
}
export type UsageNode = {
  id: string; depth: number; parentID?: string; info?: SessionInfo; groups: UsageGroup[]
  skills: { name: string; count: number }[]
  tools: { name: string; calls: number; errors: number; running: number; duration: number }[]
  knownCost: number; unknown: number; priced: number; partial: boolean; unassigned: boolean
  tokens: UsageTokens
}
export function usageFamily(sessions: readonly SessionInfo[], id: string): { id: string; depth: number; info?: SessionInfo }[] {
  const result: { id: string; depth: number; info?: SessionInfo }[] = []
  const infos = new Map(sessions.map(session => [session.id, session]))
  const seen = new Set<string>()
  const queue = [{ id, depth: 0 }]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    if (seen.has(current.id)) continue
    seen.add(current.id)
    result.push({ ...current, info: infos.get(current.id) })
    for (const child of sessions) if (child.parentID === current.id) queue.push({ id: child.id, depth: current.depth + 1 })
  }
  return result
}

export function summarizeUsage(input: {
  id: string; depth: number; info?: SessionInfo; messages: readonly SessionMessageInfo[]
  prices: UsagePrices; historyComplete: boolean
}): UsageNode {
  const groups = new Map<string, UsageGroup>(), skills = new Map<string, number>()
  const tools = new Map<string, UsageNode["tools"][number]>()
  const tokens = emptyTokens()
  let unassigned = false, partial = !input.historyComplete
  const fork = input.info?.fork
  const boundary = fork ? input.messages.findIndex(message => message.id === fork.boundary.messageID) : -1
  if (fork && boundary < 0) { partial = true; unassigned = true }
  const messages = !fork ? input.messages : boundary < 0 ? [] : input.messages.slice(boundary + (fork.boundary.type === "through" ? 1 : 0))
  const seen = new Set<string>()
  for (const source of messages) {
    const message = source.type === "compaction" && "model" in source && source.model ? {
      ...source, model: source.model, type: "assistant" as const, agent: "Compaction (agent unavailable)", content: [],
      time: { ...source.time, completed: source.time.created }, finish: undefined, error: undefined, retry: undefined,
    } : source
    if (seen.has(message.id)) continue
    seen.add(message.id)
    if (message.type === "skill") skills.set(message.name, (skills.get(message.name) ?? 0) + 1)
    if (message.type !== "assistant") {
      if ("tokens" in message && message.tokens && tokenValues(message.tokens).some(value => value > 0)) unassigned = true
      continue
    }
    const key = JSON.stringify([message.agent, message.model.providerID, message.model.id, message.model.variant])
    let group = groups.get(key)
    if (!group) {
      group = { agent: message.agent, provider: message.model.providerID, model: message.model.id, variant: message.model.variant,
        requests: 0, pending: 0, errors: 0, retries: 0, tokens: emptyTokens(), knownCost: 0, priced: 0, unknown: 0, duration: 0, completed: 0, sources: [] }
      groups.set(key, group)
    }
    group.requests++
    if (message.time.completed === undefined) { group.pending++; partial = true }
    else { group.completed++; group.duration += Math.max(0, message.time.completed - message.time.created) }
    if (message.error || message.finish === "error") group.errors++
    if (message.retry) group.retries++
    if (!message.tokens || !validTokens(message.tokens)) { group.unknown++; partial = true }
    else {
      addTokens(group.tokens, message.tokens); addTokens(tokens, message.tokens)
      const price = message.model.providerID === "amecode" && Object.hasOwn(input.prices, message.model.id) ? input.prices[message.model.id] : undefined
      const cost = estimateUsage(message.tokens, price)
      if (cost === undefined) group.unknown++
      else { group.knownCost += cost; group.priced++ }
      if (price) {
        const source = `${price.price_kind} · ${price.source.id} / ${price.source.source_model_id} · revision ${price.revision}`
        if (!group.sources.includes(source)) group.sources.push(source)
      }
    }
    for (const part of message.content) {
      if (part.type !== "tool") continue
      const tool = tools.get(part.name) ?? { name: part.name, calls: 0, errors: 0, running: 0, duration: 0 }
      tool.calls++
      if (part.state.status === "error") tool.errors++
      if (["running", "streaming"].includes(part.state.status)) tool.running++
      if (part.time.completed !== undefined) tool.duration += Math.max(0, part.time.completed - (part.time.ran ?? part.time.created))
      tools.set(part.name, tool)
    }
  }
  // Session totals can include compaction/generation absent from the message breakdown.
  if (input.info && tokenValues(input.info.tokens).some((value, index) => value !== tokenValues(tokens)[index])) unassigned = true
  const list = [...groups.values()]
  return { id: input.id, depth: input.depth, parentID: input.info?.parentID, info: input.info,
    groups: list, skills: [...skills].map(([name, count]) => ({ name, count })), tools: [...tools.values()],
    knownCost: list.reduce((sum, group) => sum + group.knownCost, 0), unknown: list.reduce((sum, group) => sum + group.unknown, 0),
    priced: list.reduce((sum, group) => sum + group.priced, 0), partial, unassigned, tokens }
}

export type UsageTreeSummary = {
  nodeCount: number; maxDepth: number; tokens: UsageTokens; knownCost: number; priced: number
  unknown: number; requests: number; errors: number; pending: number; incomplete: boolean
}

export function aggregateUsageTree(nodes: readonly UsageNode[]): UsageTreeSummary {
  const summary: UsageTreeSummary = { nodeCount: nodes.length, maxDepth: 0, tokens: emptyTokens(), knownCost: 0,
    priced: 0, unknown: 0, requests: 0, errors: 0, pending: 0, incomplete: false }
  for (const node of nodes) {
    summary.maxDepth = Math.max(summary.maxDepth, node.depth)
    addTokens(summary.tokens, node.tokens)
    summary.knownCost += node.knownCost
    summary.priced += node.priced
    summary.unknown += node.unknown
    summary.incomplete ||= node.partial || node.unassigned || node.unknown > 0
    for (const group of node.groups) {
      summary.requests += group.requests
      summary.errors += group.errors
      summary.pending += group.pending
    }
  }
  summary.incomplete ||= summary.pending > 0
  return summary
}

export function formatUsageCost(cost: number, priced: number, incomplete: boolean): string {
  if (!priced) return "Unknown"
  const amount = cost > 0 && cost < 0.000001 ? "<$0.000001" : `$${cost.toFixed(6)}`
  return `${incomplete ? "Partial · " : ""}${amount}`
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) {
    const thousands = Number((count / 1000).toFixed(1))
    if (thousands < 1000) return `${thousands}K`
  }
  return `${Number((count / 1_000_000).toFixed(2))}M`
}
