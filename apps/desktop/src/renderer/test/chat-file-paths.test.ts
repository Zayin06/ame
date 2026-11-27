import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChatFilePath } from '../chat-file-paths'

const activity = 'app/src/main/java/com/example/enhance/OpenEyesActivity.kt'

test('assistant filename chips resolve nested Kotlin sources and retain navigation lines', async () => {
  const files = async () => [activity, 'app/src/main/java/com/example/AnalyticsManager.kt']
  assert.deepEqual(await resolveChatFilePath('OpenEyesActivity.kt', '/project', files), { path: activity })
  assert.deepEqual(await resolveChatFilePath('OpenEyesActivity.kt:42-45', '/project', files), { path: activity, line: 42, endLine: 45 })
  assert.deepEqual(await resolveChatFilePath('AnalyticsManager.kt#L12', '/project', files), { path: 'app/src/main/java/com/example/AnalyticsManager.kt', line: 12 })
})

test('root files win and duplicate basenames never open an arbitrary file', async () => {
  assert.deepEqual(await resolveChatFilePath('OpenEyesActivity.kt', '/project', async () => [activity, 'OpenEyesActivity.kt']), { path: 'OpenEyesActivity.kt' })
  await assert.rejects(resolveChatFilePath('OpenEyesActivity.kt', '/project', async () => [activity, 'other/OpenEyesActivity.kt']), /Có nhiều tệp tên OpenEyesActivity\.kt/)
})

test('explicit paths and invalid references do not trigger a workspace scan', async () => {
  const noScan = async (): Promise<string[]> => { throw new Error('Unexpected scan') }
  assert.deepEqual(await resolveChatFilePath(`/project/${activity}:9`, '/project', noScan), { path: activity, line: 9 })
  assert.deepEqual(await resolveChatFilePath(activity, '/project', noScan), { path: activity })
  for (const value of ['../secret.kt', '/outside/file.kt', '.git/config', 'https://example.com/file.kt']) {
    assert.equal(await resolveChatFilePath(value, '/project', noScan), null)
  }
})

test('missing files keep the regular editor error and indexing failures are surfaced', async () => {
  assert.deepEqual(await resolveChatFilePath('Missing.kt', '/project', async () => [activity]), { path: 'Missing.kt' })
  await assert.rejects(resolveChatFilePath('OpenEyesActivity.kt', '/project', async () => { throw new Error('Index unavailable') }), /Index unavailable/)
})
