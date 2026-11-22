import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionTree } from '../session-tree'

test('renders four native generations and retains running descendants of completed parents', () => {
  const rows = sessionTree([
    { id: 'leaf', title: 'Leaf', parentID: 'architect', status: 'running' },
    { id: 'root', title: 'Root', outcome: 'succeeded', status: 'idle' },
    { id: 'dev', title: 'Dev', parentID: 'root', outcome: 'succeeded' },
    { id: 'architect', title: 'Architect', parentID: 'dev', outcome: 'interrupted' },
  ])
  assert.deepEqual(rows.map(r => [r.session.id, r.depth, r.runningDescendants]), [['root', 0, 1], ['dev', 1, 1], ['architect', 2, 1], ['leaf', 3, 0]])
})
test('missing parents and malformed cycles remain visible once without looping', () => {
  const rows = sessionTree([{ id: 'a', title: 'A', parentID: 'b' }, { id: 'b', title: 'B', parentID: 'a' }, { id: 'orphan', title: 'Orphan', parentID: 'archived' }, { id: 'self', title: 'Self', parentID: 'self' }])
  assert.equal(rows.length, 4)
  assert.equal(new Set(rows.map(r => r.session.id)).size, 4)
  assert.equal(rows.find(r => r.session.id === 'orphan')?.depth, 0)
})
