import type { Session, PetSession } from '../../../../packages/protocol/src/index'

/** Keep the renderer's Pet report mapping shared with integration tests. */
export function petSessions(cache: Readonly<Record<string, readonly Session[]>>): PetSession[] {
  return Object.entries(cache).flatMap(([project, items]) => items.map(item => ({
    key: `${project}:${item.id}`, running: item.status === 'running',
    waiting: item.activity === 'waiting', thinking: item.activity === 'thinking',
    child: Boolean(item.parentID), outcome: item.outcome, busy: item.busyAt, idle: item.idleAt,
  })))
}
