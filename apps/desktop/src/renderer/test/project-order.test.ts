import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatRelativeTime, projectsByChatActivity, resolveRootSessionID, runningRootSessionIDs, visibleProjectSessions } from '../project-order'
import type { Session } from '../../../../../packages/protocol/src/index'

const now = 2_000_000_000_000
const day = 86_400_000
for (const updatedAt of [undefined, 0, -1, NaN, Infinity, -Infinity]) {
  test(`relative time ignores invalid timestamp ${updatedAt}`, () => {
    assert.equal(formatRelativeTime(updatedAt, now), '')
  })
}
for (const [delta, expected] of [
  [-60_000, 'now'], [0, 'now'], [59_999, 'now'], [60_000, '1m'],
  [10 * 60_000, '10m'], [3_599_999, '59m'], [3_600_000, '1h'],
  [3 * 3_600_000, '3h'], [day - 1, '23h'], [day, '1d'],
  [2 * day, '2d'], [10 * day, '10d'], [30 * day - 1, '29d'],
  [30 * day, '1mo'], [60 * day, '2mo'], [365 * day - 1, '12mo'],
  [365 * day, '1y'], [2 * 365 * day, '2y'],
] as const) {
  test(`relative time formats age ${delta}ms as ${expected}`, () => {
    assert.equal(formatRelativeTime(now - delta, now), expected)
  })
}

const sessionItems: readonly Session[] = Object.freeze([1, 5, 3, 2, 4].map(updatedAt => Object.freeze({ id: String(updatedAt), title: `Chat ${updatedAt}`, updatedAt })))
test('visible sessions sort a copy, cap at three and report the full total', () => {
  const result = visibleProjectSessions(sessionItems)
  assert.deepEqual(result.items.map(session => session.id), ['5', '4', '3'])
  assert.equal(result.total, 5)
  assert.equal(result.hiddenCount, 2)
  assert.deepEqual(sessionItems.map(session => session.id), ['1', '5', '3', '2', '4'])
})
test('visible sessions preserve ties and place missing activity last', () => {
  const items = [{ id: 'missing', title: 'Legacy' }, { id: 'a', title: 'A', updatedAt: 10 }, { id: 'b', title: 'B', updatedAt: 10 }]
  assert.deepEqual(visibleProjectSessions(items).items.map(session => session.id), ['a', 'b', 'missing'])
  assert.deepEqual(visibleProjectSessions([]), { items: [], total: 0, hiddenCount: 0 })
})
for (const activeSessionID of ['2', '1']) {
  test(`collapsed sessions keep active session ${activeSessionID} within the budget`, () => {
    assert.deepEqual(visibleProjectSessions(sessionItems, { activeSessionID }), {
      items: [sessionItems[1], sessionItems[4], sessionItems.find(session => session.id === activeSessionID)], total: 5, hiddenCount: 2,
    })
  })
}
test('an active session already in the top three or absent does not replace a slot', () => {
  for (const activeSessionID of ['4', 'absent']) assert.deepEqual(visibleProjectSessions(sessionItems, { activeSessionID }), visibleProjectSessions(sessionItems))
})
test('expansion and a non-empty query show every supplied matching session', () => {
  const expected = ['5', '4', '3', '2', '1']
  for (const options of [{ expanded: true }, { query: '  Chat  ' }]) {
    const result = visibleProjectSessions(sessionItems, options)
    assert.deepEqual(result.items.map(session => session.id), expected)
    assert.equal(result.total, 5)
    assert.equal(result.hiddenCount, 0)
  }
  assert.equal(visibleProjectSessions(sessionItems, { query: '  ' }).hiddenCount, 2)
})
test('custom limits are clamped to at least one while retaining the active session', () => {
  assert.deepEqual(visibleProjectSessions(sessionItems, { limit: 0, activeSessionID: '1' }), { items: [sessionItems[0]], total: 5, hiddenCount: 4 })
  assert.equal(visibleProjectSessions(sessionItems, { limit: -2 }).items.length, 1)
  assert.equal(visibleProjectSessions(sessionItems, { limit: 4 }).hiddenCount, 1)
  assert.equal(visibleProjectSessions(sessionItems, { limit: 5 }).hiddenCount, 0)
})

const projects = ['empty', 'older', 'newer', 'also-empty'].map(id => ({ id, name: id, directory: id }))
const descendants: Session[] = [1, 2, 3, 4].map(depth => ({ id: `child-${depth}`, parentID: depth === 1 ? '1' : `child-${depth - 1}`, title: `Agent ${depth}`, updatedAt: 100 + depth }))
test('subagents never occupy sidebar slots or contribute to totals, including expanded and search results', () => {
  const items = [...sessionItems, ...descendants]
  for (const options of [{}, { expanded: true }, { query: 'Agent' }]) {
    assert.deepEqual(visibleProjectSessions(items, options), visibleProjectSessions(sessionItems, options))
  }
  assert.deepEqual(visibleProjectSessions(descendants), { items: [], total: 0, hiddenCount: 0 })
})
for (let depth = 1; depth <= 4; depth++) {
  test(`active descendant at depth ${depth} pins only its root`, () => {
    const items = [...sessionItems, ...descendants]
    assert.equal(resolveRootSessionID(items, `child-${depth}`), '1')
    assert.deepEqual(visibleProjectSessions(items, { activeSessionID: `child-${depth}` }), {
      items: [sessionItems[1], sessionItems[4], sessionItems[0]], total: 5, hiddenCount: 2,
    })
  })
  test(`running descendant at depth ${depth} lights its idle root`, () => {
    const items: Session[] = [...sessionItems.map(session => ({ ...session, status: 'idle' as const })), ...descendants.map(session => ({ ...session, status: session.id === `child-${depth}` ? 'running' as const : 'idle' as const }))]
    assert.deepEqual(runningRootSessionIDs(items), new Set(['1']))
  })
}
test('root resolution and running roots handle missing ancestors and cycles safely', () => {
  const items: Session[] = [
    { id: 'root', title: 'Root', status: 'running' },
    { id: 'idle', title: 'Idle', status: 'idle' },
    { id: 'a', title: 'A', parentID: 'b', status: 'running' },
    { id: 'b', title: 'B', parentID: 'a' },
    { id: 'self', title: 'Self', parentID: 'self', status: 'running' },
    { id: 'orphan', title: 'Orphan', parentID: 'missing', status: 'running' },
  ]
  assert.equal(resolveRootSessionID(items, 'root'), 'root')
  for (const id of [undefined, '', 'missing', 'a', 'b', 'self', 'orphan']) assert.equal(resolveRootSessionID(items, id), undefined)
  assert.deepEqual(runningRootSessionIDs(items), new Set(['root']))
  assert.deepEqual(runningRootSessionIDs([]), new Set())
  assert.deepEqual(visibleProjectSessions(items, { activeSessionID: 'a' }).items.map(session => session.id), ['root', 'idle'])
})
test('projects follow latest chat activity, not selection or session array order', () => {
  const cache = {
    older: [{ id: 'old', title: 'Old', updatedAt: 10 }],
    newer: [{ id: 'first', title: 'First', updatedAt: 5 }, { id: 'latest', title: 'Latest', updatedAt: 20 }],
  }
  assert.deepEqual(projectsByChatActivity(projects, cache).map(p => p.id), ['newer', 'older', 'empty', 'also-empty'])
  assert.deepEqual(projectsByChatActivity(projects, { ...cache }).map(p => p.id), ['newer', 'older', 'empty', 'also-empty'])
  assert.deepEqual(projects.map(p => p.id), ['empty', 'older', 'newer', 'also-empty'])
  cache.older[0].updatedAt = 30
  assert.equal(projectsByChatActivity(projects, cache)[0].id, 'older')
})
test('missing activity preserves project order and background child activity participates', () => {
  assert.deepEqual(projectsByChatActivity(projects, { older: [{ id: 'legacy', title: 'Legacy' }] }), projects)
  assert.equal(projectsByChatActivity(projects, { older: [{ id: 'child', parentID: 'root', title: 'Child', updatedAt: 100 }] })[0].id, 'older')
})
