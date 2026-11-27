import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideSessionRetry } from '../src/retry-policy'
import { applyModelRequestHeaders } from '../src/server'

test('retries transient provider.transport socket resets on early attempts with bounded backoff', () => {
  for (const [attempt, expectedDelay] of [[1, 1500], [2, 3000]] as const) {
    const input = {
      error: { type: 'provider.transport', message: 'Connection lost while reading the response: ECONNRESET', status: 200 },
      attempt,
      decision: { retry: false } as const,
    }
    decideSessionRetry(input)
    assert.deepEqual(input.decision, { retry: true, delay: expectedDelay })
  }

  const third = {
    error: { type: 'provider.transport', message: 'ECONNRESET', status: 200 },
    attempt: 3,
    decision: { retry: false } as const,
  }
  decideSessionRetry(third)
  assert.deepEqual(third.decision, { retry: false })

  const fourth = {
    error: { type: 'rate_limit', message: '429', status: 429 },
    attempt: 4,
    decision: { retry: true, delay: 5000 },
  }
  decideSessionRetry(fourth)
  assert.deepEqual(fourth.decision, { retry: true, delay: 5000 })

  for (const nonRetryable of [
    { type: 'aborted', message: 'User cancelled' },
    { type: 'provider.transport', message: 'ECONNRESET', status: 400 },
    { type: 'unknown', message: 'ECONNRESET' },
  ]) {
    const input = { error: nonRetryable, attempt: 1, decision: { retry: false } as const }
    decideSessionRetry(input)
    assert.deepEqual(input.decision, { retry: false })
  }
})

test('applyModelRequestHeaders strips secret headers and preserves or populates x-session-id', () => {
  const headers: Record<string, string> = {
    Authorization: 'Bearer stale',
    'X-Api-Key': 'stale-key',
    'x-session-affinity': 'ses_root',
  }
  applyModelRequestHeaders({ sessionID: 'ses_child_1', headers })
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers['X-Api-Key'], undefined)
  assert.equal(headers['x-session-affinity'], 'ses_root')
  assert.equal(headers['x-session-id'], 'ses_child_1')

  const existing: Record<string, string> = { 'X-Session-Id': 'custom-id' }
  applyModelRequestHeaders({ sessionID: 'ses_other', headers: existing })
  assert.equal(existing['X-Session-Id'], 'custom-id')
  assert.equal(existing['x-session-id'], undefined)
})
