import type { Project, Session } from '../../../../packages/protocol/src/index'

export function formatRelativeTime(updatedAt?: number, now = Date.now()): string {
  if (updatedAt === undefined || !Number.isFinite(updatedAt) || updatedAt <= 0) return ''
  const deltaMs = Math.max(0, now - updatedAt)
  if (deltaMs < 60_000) return 'now'
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m`
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h`
  if (deltaMs < 30 * 86_400_000) return `${Math.floor(deltaMs / 86_400_000)}d`
  if (deltaMs < 365 * 86_400_000) return `${Math.floor(deltaMs / (30 * 86_400_000))}mo`
  return `${Math.floor(deltaMs / (365 * 86_400_000))}y`
}

function resolveRoot(byID: ReadonlyMap<string, Session>, sessionID?: string): string | undefined {
  const visited = new Set<string>()
  while (sessionID && !visited.has(sessionID)) {
    visited.add(sessionID)
    const session = byID.get(sessionID)
    if (!session) return undefined
    if (!session.parentID) return session.id
    sessionID = session.parentID
  }
  // Incomplete or cyclic ancestry must not create a synthetic sidebar root.
  return undefined
}

export function resolveRootSessionID(sessions: readonly Session[], sessionID?: string): string | undefined {
  return resolveRoot(new Map(sessions.map(session => [session.id, session])), sessionID)
}

export function runningRootSessionIDs(sessions: readonly Session[]): Set<string> {
  const byID = new Map(sessions.map(session => [session.id, session]))
  const roots = new Set<string>()
  for (const session of sessions) {
    if (session.status !== 'running') continue
    const root = resolveRoot(byID, session.id)
    if (root) roots.add(root)
  }
  return roots
}

export function visibleProjectSessions(sessions: readonly Session[], options: { expanded?: boolean; activeSessionID?: string; query?: string; limit?: number } = {}): { items: Session[]; total: number; hiddenCount: number } {
  const limit = Math.max(1, options.limit ?? 3)
  const sorted = sessions.filter(session => !session.parentID).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  if (options.expanded || options.query?.trim() || sorted.length <= limit) {
    return { items: sorted, total: sorted.length, hiddenCount: 0 }
  }
  let top = sorted.slice(0, limit)
  const activeSessionID = resolveRootSessionID(sessions, options.activeSessionID)
  const activeItem = activeSessionID ? sorted.find(session => session.id === activeSessionID) : undefined
  if (activeItem && !top.includes(activeItem)) top = [...top.slice(0, limit - 1), activeItem]
  return { items: top, total: sorted.length, hiddenCount: sorted.length - top.length }
}

export function projectsByChatActivity(projects: Project[], sessions: Record<string, Session[]>) {
  const latest = (id: string) => (sessions[id] || []).reduce((time, session) => Math.max(time, session.updatedAt || 0), 0)
  return [...projects].sort((a, b) => latest(b.id) - latest(a.id))
}
