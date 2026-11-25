import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PermissionRule } from '@opencode/client'
import { permissionModeSchema } from '../packages/protocol/src/permission-mode'
import { permissionRules, permissionModeFromSession } from '../packages/opencode-adapter/src/permission-mode'
import { OpenCodeAdapter } from '../packages/opencode-adapter/src/index'

test('four permission presets round trip and enforce V2 actions, including plugin tools', () => {
  const expected = {
    default: [],
    full: [{ action: '*', resource: '*', effect: 'allow' }],
    ask: [
      { action: '*', resource: '*', effect: 'ask' },
      ...['read', 'glob', 'grep', 'webfetch', 'websearch'].map(action => ({ action, resource: '*', effect: 'allow' })),
      ...['edit', 'shell', 'external_directory'].map(action => ({ action, resource: '*', effect: 'ask' })),
    ],
    readonly: [
      { action: '*', resource: '*', effect: 'deny' },
      ...['read', 'glob', 'grep', 'webfetch', 'websearch'].map(action => ({ action, resource: '*', effect: 'allow' })),
    ],
  }
  for (const mode of permissionModeSchema.options) {
    assert.deepEqual(permissionRules(mode), expected[mode])
    assert.equal(permissionModeFromSession({ permissions: permissionRules(mode) }), mode)
  }
  const effect = (rules: PermissionRule[], action: string) => rules.filter(rule => rule.action === '*' || rule.action === action).at(-1)?.effect
  for (const action of ['edit', 'shell', 'external_directory', 'custom_mutation', 'subagent', 'execute']) {
    assert.equal(effect(permissionRules('readonly'), action), 'deny')
    assert.equal(effect(permissionRules('ask'), action), 'ask')
    assert.equal(effect(permissionRules('full'), action), 'allow')
  }
  assert.equal(permissionModeFromSession({ permissions: undefined }), 'default')
  assert.equal(permissionModeFromSession({ permissions: [{ action: 'edit', resource: '*', effect: 'allow' }] }), 'default')
  assert.equal(permissionModeFromSession({ permissions: [...permissionRules('readonly')].reverse() }), 'default')
  const copy = permissionRules('full'); copy[0].effect = 'deny'
  assert.equal(permissionRules('full')[0].effect, 'allow')
  for (const value of ['invalid', '', null, {}, [], [{ action: '*', resource: '*', effect: 'allow' }]]) assert.equal(permissionModeSchema.safeParse(value).success, false)
})

test('adapter creates, updates, reads back persisted modes and rejects foreign sessions and invalid modes', async () => {
  const directory = process.cwd(), calls: { method?: string; path: string; body: any }[] = []
  let permissions: PermissionRule[] = []
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const adapter = new OpenCodeAdapter(() => {}, async (input, init = {}) => {
    const url = new URL(String(input)), body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init.method, path: url.pathname, body })
    if (url.pathname === '/api/info') return json({ version: '2.3.2' })
    if (url.pathname === '/api/event') return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close()) } }), { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/session' && init.method === 'POST') {
      assert.deepEqual(body.location, { directory }); permissions = body.permissions
      return json({ data: { id: 's', title: 'New', permissions, time: { updated: 1 } } })
    }
    if (url.pathname === '/api/session/foreign') return json({ data: { location: { directory: directory + '-other' } } })
    if (url.pathname === '/api/session/s') {
      if (body) { permissions = body.permissions; return new Response(null, { status: 204 }) }
      return json({ data: { id: 's', permissions, location: { directory } } })
    }
    throw new Error('Unexpected request: ' + url.pathname)
  })
  adapter.attach('p', directory)
  try {
    await adapter.connect('http://localhost:4096')
    for (const mode of permissionModeSchema.options) {
      assert.equal((await adapter.createSession('p', mode)).permissionMode, mode)
      assert.deepEqual(permissions, permissionRules(mode))
      for (const next of permissionModeSchema.options) {
        assert.equal(await adapter.updateSessionPermissionMode('p', 's', next), next)
        assert.equal(await adapter.sessionPermissionMode('p', 's'), next)
        assert.deepEqual(permissions, permissionRules(next))
      }
    }
    const count = calls.filter(call => call.body).length
    await assert.rejects(adapter.updateSessionPermissionMode('p', 'foreign', 'full'), /SESSION_PROJECT_MISMATCH/)
    await assert.rejects(adapter.createSession('p', 'invalid' as never))
    await assert.rejects(adapter.updateSessionPermissionMode('p', 's', {} as never))
    assert.equal(calls.filter(call => call.body).length, count)
  } finally { adapter.dispose() }
})
