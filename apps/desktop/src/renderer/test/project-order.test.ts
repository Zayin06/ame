import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectsByChatActivity } from '../project-order'

const projects = ['empty', 'older', 'newer', 'also-empty'].map(id => ({ id, name: id, directory: id }))
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
