import type { Project, Session } from '../../../../packages/protocol/src/index'

export function projectsByChatActivity(projects: Project[], sessions: Record<string, Session[]>) {
  const latest = (id: string) => (sessions[id] || []).reduce((time, session) => Math.max(time, session.updatedAt || 0), 0)
  return [...projects].sort((a, b) => latest(b.id) - latest(a.id))
}
