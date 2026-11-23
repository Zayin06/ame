import type { SessionInfo, SessionMessageInfo } from '@opencode/client'
import type { AgentMapNode, AgentMapTokens, AgentMapTool, AgentMapView } from '../../protocol/src/index'

export type AgentMapEntry = { id: string; parentID?: string; depth: number; info?: SessionInfo; childIDs: string[] }
export type AgentMapFamily = { rootID: string; entries: AgentMapEntry[]; limited: boolean }

export function truncateSafe(value: string, maxChars: number): string {
  const end = Math.max(0, Math.floor(maxChars))
  if (value.length <= end) return value
  const result = value.slice(0, end)
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result
}

export function resolveAgentMapFamily(sessions: readonly SessionInfo[], activeSessionID: string, maxNodes = 200): AgentMapFamily {
  const byID = new Map(sessions.map(info => [info.id, info]))
  const upSeen = new Set<string>([activeSessionID])
  let rootID = activeSessionID
  for (;;) {
    const parentID = byID.get(rootID)?.parentID
    if (!parentID || !byID.has(parentID) || upSeen.has(parentID)) break
    upSeen.add(parentID)
    rootID = parentID
  }
  const children = new Map<string, SessionInfo[]>()
  for (const info of byID.values()) {
    if (!info.parentID || !byID.has(info.parentID)) continue
    const siblings = children.get(info.parentID) ?? []
    siblings.push(info)
    children.set(info.parentID, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => (a.time?.created ?? Number.MAX_SAFE_INTEGER) - (b.time?.created ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
  const queue = [{ id: rootID, depth: 0 }], seen = new Set<string>()
  const entries: AgentMapEntry[] = []
  let limited = false
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    if (seen.has(current.id)) continue
    if (entries.length >= maxNodes) { limited = true; break }
    seen.add(current.id)
    const info = byID.get(current.id)
    const childIDs = (children.get(current.id) ?? []).map(child => child.id)
    entries.push({ ...current, parentID: info?.parentID, info, childIDs })
    for (const id of childIDs) queue.push({ id, depth: current.depth + 1 })
  }
  for (const entry of entries) entry.childIDs = entry.childIDs.filter(id => seen.has(id))
  return { rootID, entries, limited }
}

function chronological(messages: readonly SessionMessageInfo[]): SessionMessageInfo[] {
  return [...new Map(messages.map(message => [message.id, message])).values()]
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
}
const validCounter = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
function tokenCounts(tokens?: SessionInfo['tokens']): AgentMapTokens {
  const result = { input: validCounter(tokens?.input), output: validCounter(tokens?.output), reasoning: validCounter(tokens?.reasoning), cacheRead: validCounter(tokens?.cache?.read), cacheWrite: validCounter(tokens?.cache?.write), total: 0 }
  result.total = result.input + result.output + result.reasoning + result.cacheRead + result.cacheWrite
  return result
}
function elapsed(end?: number, start?: number): number | undefined {
  return end !== undefined && start !== undefined && Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : undefined
}
function toolInput(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}
const titleOf = (info?: SessionInfo) => info?.title?.trim() || info?.agent || 'Untitled'

export function summarizeAgentMapNode(input: AgentMapEntry & {
  messages: readonly SessionMessageInfo[]
  parentMessages?: readonly SessionMessageInfo[]
  parentInfo?: SessionInfo
  historyComplete?: boolean
  liveText?: string
  now: number
}): AgentMapNode {
  const { info, depth, now } = input
  const messages = chronological(input.messages)
  const assistants = messages.filter(message => message.type === 'assistant')
  const lastAssistant = assistants.at(-1)
  const lastIdle = messages.filter(message => message.type === 'idle').at(-1)
  const lastAgent = messages.filter(message => message.type === 'agent-switched').at(-1)
  const lastModel = messages.filter(message => message.type === 'model-switched').at(-1)
  const model = lastAssistant?.model ?? lastModel?.model ?? info?.model
  const tools = new Map<string, AgentMapTool>(), skills = new Map<string, number>()
  const sums = tokenCounts()
  let sumAssistantDurationMs = 0
  for (const message of messages) {
    if (message.type === 'skill') {
      const name = (message.name || message.skill).trim()
      if (name) skills.set(name, (skills.get(name) ?? 0) + 1)
    }
    if (message.type !== 'assistant') continue
    const tokens = tokenCounts(message.tokens)
    for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'] as const) sums[key] += tokens[key]
    sumAssistantDurationMs += elapsed(message.time?.completed, message.time?.created) ?? 0
    for (const part of message.content) {
      if (part.type !== 'tool') continue
      const tool = tools.get(part.name) ?? { name: part.name, calls: 0, errors: 0, running: 0, durationMs: 0 }
      tool.calls++
      if (part.state.status === 'error') tool.errors++
      if (part.state.status === 'running' || part.state.status === 'streaming') tool.running++
      tool.durationMs += elapsed(part.time?.completed, part.time?.ran ?? part.time?.created) ?? 0
      tools.set(part.name, tool)
    }
  }
  const addSkill = (name?: string) => {
    const trimmed = name?.trim()
    if (trimmed && !skills.has(trimmed)) skills.set(trimmed, 1)
  }
  for (const message of messages) {
    if (message.type === 'user') for (const skill of message.skills ?? []) addSkill(skill.name || skill.id)
    if (message.type === 'assistant') for (const part of message.content) {
      if (part.type !== 'tool' || part.name.toLowerCase() !== 'skill') continue
      const data = toolInput(part.state.input)
      const name = data?.name || data?.skill
      if (typeof name === 'string') addSkill(name)
    }
  }
  const status = info
    ? info.time?.busy !== undefined && (info.time.idle === undefined || info.time.busy > info.time.idle) ? 'running' : 'idle'
    : [...tools.values()].some(tool => tool.running > 0) ? 'running' : 'idle'
  let durationMs: number | undefined
  if (status === 'running') {
    const start = info?.time?.busy ?? info?.time?.created
    durationMs = start !== undefined && Number.isFinite(start) ? Math.max(0, now - start) : sumAssistantDurationMs || undefined
  } else if (depth > 0) durationMs = elapsed(info?.time?.idle ?? info?.time?.updated, info?.time?.created) ?? (sumAssistantDurationMs || undefined)
  else durationMs = (sumAssistantDurationMs || undefined) ?? elapsed(info?.time?.idle, info?.time?.busy) ?? elapsed(info?.time?.updated, info?.time?.created)

  const userPrompts = messages.flatMap(message => message.type === 'user' && message.text.trim() ? [message.text] : [])
  let prompt = userPrompts[0] ?? ''
  if (!userPrompts.length) {
    const synthetic = messages.find(message => message.type === 'synthetic' && message.metadata?.source !== 'subagent' && message.text.trim())
    if (synthetic?.type === 'synthetic') prompt = synthetic.text
    else {
      const candidates = chronological(input.parentMessages ?? []).flatMap(message => message.type !== 'assistant' ? [] : message.content.flatMap(part => {
        if (part.type !== 'tool' || !['subagent', 'task'].includes(part.name.toLowerCase()) || !('input' in part.state)) return []
        const data = toolInput(part.state.input)
        return data && typeof data.prompt === 'string' ? [data] : []
      }))
      const titles = candidates.filter(candidate => info?.title !== undefined && candidate.description === info.title)
      const agents = candidates.filter(candidate => info?.agent !== undefined && candidate.agent === info.agent)
      const match = titles.length === 1 ? titles[0] : agents.length === 1 ? agents[0] : undefined
      if (match) prompt = match.prompt as string
    }
  }
  let output = ''
  for (let index = assistants.length - 1; index >= 0; index--) {
    const parts = assistants[index].content.filter(part => part.type === 'text')
    if (!parts.some(part => part.text.trim())) continue
    output = parts.map(part => part.text).join('\n\n')
    break
  }
  const liveText = input.liveText?.trim()
  if (status === 'running' && liveText && liveText.length > output.length) output = liveText
  const error = lastAssistant?.error || lastIdle?.error
  const sessionTokens = tokenCounts(info?.tokens)
  return {
    id: input.id, parentID: input.parentID, depth, childIDs: [...input.childIDs], title: titleOf(info),
    agent: info?.agent?.trim() || lastAssistant?.agent || lastAgent?.agent || 'default',
    model: model?.id, providerID: model?.providerID, variant: model?.variant, status,
    outcome: info?.outcome ?? (status === 'idle' ? lastIdle?.outcome : undefined),
    createdAt: info?.time?.created, updatedAt: info?.time?.updated, durationMs,
    tokens: sessionTokens.total > 0 ? sessionTokens : sums,
    prompt: truncateSafe(prompt, 32768), promptCount: userPrompts.length,
    latestPrompt: userPrompts.length > 1 && userPrompts.at(-1) !== userPrompts[0] ? truncateSafe(userPrompts.at(-1)!, 32768) : undefined,
    output: truncateSafe(output, 65536), error: error ? error.message || error.type : undefined,
    skills: [...skills].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    spawnedByTitle: input.parentID && input.parentInfo ? titleOf(input.parentInfo) : undefined,
    spawnedByAgent: input.parentID ? input.parentInfo?.agent : undefined,
    historyComplete: input.historyComplete ?? true,
  }
}

export function buildAgentMap(input: {
  family: AgentMapFamily
  activeSessionID: string
  messagesBySession: ReadonlyMap<string, readonly SessionMessageInfo[]>
  historyCompleteBySession?: ReadonlyMap<string, boolean>
  liveTextBySession?: ReadonlyMap<string, string>
  now: number
}): AgentMapView {
  const infos = new Map(input.family.entries.map(entry => [entry.id, entry.info]))
  return {
    rootID: input.family.rootID, activeSessionID: input.activeSessionID, limited: input.family.limited, fetchedAt: input.now,
    nodes: input.family.entries.map(entry => summarizeAgentMapNode({
      ...entry, messages: input.messagesBySession.get(entry.id) ?? [],
      parentMessages: entry.parentID ? input.messagesBySession.get(entry.parentID) : undefined,
      parentInfo: entry.parentID ? infos.get(entry.parentID) : undefined,
      historyComplete: input.historyCompleteBySession?.get(entry.id) ?? true,
      liveText: input.liveTextBySession?.get(entry.id), now: input.now,
    })),
  }
}
