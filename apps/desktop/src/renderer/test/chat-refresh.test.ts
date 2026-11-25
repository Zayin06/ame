import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatRefresh } from '../chat-refresh'

const settle = async () => { await Promise.resolve(); await Promise.resolve() }

for (const interval of [30, 40, 50]) test(`continuous ${interval}ms stream refreshes throughout the stream and syncs on idle`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  const calls: number[] = []
  const scheduler = createChatRefresh(async () => { calls.push(now) })
  try {
    scheduler.request()
    for (now = interval; now <= 1800; now += interval) {
      t.mock.timers.tick(interval)
      await settle()
      scheduler.request()
    }
    assert.ok(calls.length >= 12, 'must not wait for the stream to stop')
    assert.ok(calls[0] <= 150)
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i] - calls[i - 1] <= 150)
    assert.ok(calls.at(-1)! >= 1650, 'must keep refreshing near the end of the stream')
    const beforeIdle = calls.length
    scheduler.request(true)
    await settle()
    assert.equal(calls.length, beforeIdle + 1, 'idle forces a final sync without waiting for a timer')
    t.mock.timers.tick(1000)
    await settle()
    assert.equal(calls.length, beforeIdle + 1, 'final sync consumes the pending timer')
  } finally { scheduler.dispose() }
})

test('events during a slow read coalesce into exactly one immediate follow-up, including idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const finishes: (() => void)[] = []
  let calls = 0
  const scheduler = createChatRefresh(() => { calls++; return new Promise<void>(resolve => finishes.push(resolve)) })
  scheduler.request(true)
  for (let i = 0; i < 50; i++) { scheduler.request(); t.mock.timers.tick(40) }
  scheduler.request(true)
  assert.equal(calls, 1, 'reads never overlap')
  finishes.shift()!()
  await settle()
  assert.equal(calls, 2, 'queued read starts immediately, without another throttle delay')
  finishes.shift()!()
  await settle()
  t.mock.timers.tick(1000)
  assert.equal(calls, 2)
  scheduler.dispose()
})

test('dispose cancels scheduled reads and suppresses queued reads after an in-flight read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, finish!: () => void
  const scheduler = createChatRefresh(() => { calls++; return new Promise<void>(resolve => { finish = resolve }) })
  scheduler.request()
  scheduler.dispose()
  t.mock.timers.tick(1000)
  assert.equal(calls, 0)
  const loading = createChatRefresh(() => { calls++; return new Promise<void>(resolve => { finish = resolve }) })
  loading.request(true)
  loading.request()
  loading.dispose()
  finish()
  await settle()
  loading.request(true)
  assert.equal(calls, 1)
})
