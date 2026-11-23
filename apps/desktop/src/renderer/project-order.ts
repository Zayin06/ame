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

export function visibleProjectSessions(sessions: readonly Session[], options: { expanded?: boolean; activeSessionID?: string; query?: string; limit?: number } = {}): { items: Session[]; total: number; hiddenCount: number } {
  const limit = Math.max(1, options.limit ?? 3)
  const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  if (options.expanded || options.query?.trim() || sorted.length <= limit) {
    return { items: sorted, total: sorted.length, hiddenCount: 0 }
  }
  let top = sorted.slice(0, limit)
  const activeItem = options.activeSessionID ? sorted.find(session => session.id === options.activeSessionID) : undefined
  if (activeItem && !top.includes(activeItem)) top = [...top.slice(0, limit - 1), activeItem]
  return { items: top, total: sorted.length, hiddenCount: sorted.length - top.length }
}

export function projectsByChatActivity(projects: Project[], sessions: Record<string, Session[]>) {
  const latest = (id: string) => (sessions[id] || []).reduce((time, session) => Math.max(time, session.updatedAt || 0), 0)
  return [...projects].sort((a, b) => latest(b.id) - latest(a.id))
}
