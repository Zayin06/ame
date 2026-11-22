import type { Session } from '../../../../packages/protocol/src/index'

export type SessionRow = { session: Session; depth: number; runningDescendants: number }
export function sessionTree(sessions: Session[]): SessionRow[] {
  const byID = new Map(sessions.map(session => [session.id, session]))
  const children = new Map<string, Session[]>()
  for (const session of byID.values()) if (session.parentID && byID.has(session.parentID)) {
    const siblings = children.get(session.parentID) ?? []
    siblings.push(session); children.set(session.parentID, siblings)
  }
  const rows: SessionRow[] = [], visited = new Set<string>()
  const visit = (session: Session, depth: number): number => {
    if (visited.has(session.id)) return 0
    visited.add(session.id)
    const row = { session, depth, runningDescendants: 0 }
    rows.push(row)
    for (const child of children.get(session.id) ?? []) row.runningDescendants += visit(child, depth + 1)
    return row.runningDescendants + Number(session.status === 'running')
  }
  for (const session of byID.values()) if (!session.parentID || !byID.has(session.parentID)) visit(session, 0)
  // Keep orphaned/cyclic server data visible without recursing indefinitely.
  for (const session of byID.values()) if (!visited.has(session.id)) visit(session, 0)
  return rows
}
