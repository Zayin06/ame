import type { AgentMapNode, AgentMapView, Session } from '../../../../packages/protocol/src/index'

export type AgentMapTreeNode = { node: AgentMapNode; children: AgentMapTreeNode[] }
export type AgentMapSummary = { totalAgents: number; subagentCount: number; runningCount: number; failedCount: number; maxDepth: number }

export function familySummaryFromSessions(sessions: readonly Session[], activeSessionID?: string): { rootID?: string; totalAgents: number; subagentCount: number; runningCount: number } {
  if (!activeSessionID) return { totalAgents: 0, subagentCount: 0, runningCount: 0 }
  const byID = new Map(sessions.map(session => [session.id, session]))
  let rootID = activeSessionID
  const upSeen = new Set([rootID])
  while (true) {
    const parentID = byID.get(rootID)?.parentID
    if (!parentID || !byID.has(parentID) || upSeen.has(parentID)) break
    rootID = parentID
    upSeen.add(rootID)
  }
  const children = new Map<string, string[]>()
  for (const session of byID.values()) if (session.parentID) {
    const siblings = children.get(session.parentID) ?? []
    siblings.push(session.id)
    children.set(session.parentID, siblings)
  }
  const queue = [rootID], seen = new Set<string>()
  let totalAgents = 0, runningCount = 0
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    if (seen.has(id)) continue
    seen.add(id)
    const session = byID.get(id)
    if (session) { totalAgents++; if (session.status === 'running') runningCount++ }
    queue.push(...(children.get(id) ?? []))
  }
  return { rootID, totalAgents, subagentCount: Math.max(0, totalAgents - 1), runningCount }
}

export function buildAgentMapTree(view: AgentMapView): { roots: AgentMapTreeNode[]; byID: Map<string, AgentMapNode>; summary: AgentMapSummary } {
  const byID = new Map<string, AgentMapNode>()
  for (const node of view.nodes) if (!byID.has(node.id)) byID.set(node.id, node)
  const children = new Map<string, AgentMapNode[]>(), rootNodes: AgentMapNode[] = []
  for (const node of byID.values()) {
    const parentID = node.parentID && byID.has(node.parentID) ? node.parentID : node.id !== view.rootID ? view.rootID : undefined
    if (parentID && parentID !== node.id && byID.has(parentID)) {
      const siblings = children.get(parentID) ?? []
      siblings.push(node)
      children.set(parentID, siblings)
    } else rootNodes.push(node)
  }
  const seen = new Set<string>()
  const visit = (node: AgentMapNode): AgentMapTreeNode => {
    seen.add(node.id)
    const branch: AgentMapTreeNode = { node, children: [] }
    for (const child of children.get(node.id) ?? []) if (!seen.has(child.id)) branch.children.push(visit(child))
    return branch
  }
  const roots: AgentMapTreeNode[] = []
  for (const node of [...rootNodes, ...byID.values()]) if (!seen.has(node.id)) roots.push(visit(node))
  const nodes = [...byID.values()]
  return { roots, byID, summary: {
    totalAgents: nodes.length, subagentCount: Math.max(0, nodes.length - 1),
    runningCount: nodes.filter(node => node.status === 'running').length,
    failedCount: nodes.filter(node => node.outcome === 'failed').length,
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
  } }
}

export function formatAgentDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return '<1s'
  const seconds = Math.floor(ms / 1000)
  if (ms < 60_000) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (ms < 3_600_000) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatAgentTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 100_000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(count))
}

export function agentStatusInfo(node: AgentMapNode): { tone: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'idle'; label: string } {
  if (node.status === 'running') return { tone: 'running', label: 'Đang chạy' }
  if (node.outcome === 'succeeded') return { tone: 'succeeded', label: 'Hoàn tất' }
  if (node.outcome === 'failed') return { tone: 'failed', label: 'Thất bại' }
  if (node.outcome === 'interrupted') return { tone: 'interrupted', label: 'Đã dừng' }
  return { tone: 'idle', label: 'Đang chờ' }
}
