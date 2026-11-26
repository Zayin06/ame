import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { OpenCodeAdapter } from '../packages/opencode-adapter/src/index'

test('shutdown cancels a real HTTP response stalled after its headers without stopping Account access', { timeout: 5000 }, async () => {
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const server = createServer((req, res) => {
    if (req.url === '/api/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: '2.3.2' })); return }
    if (req.url === '/api/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"data":')
    reached()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const adapter = new OpenCodeAdapter(() => {})
  adapter.attach('p', path.resolve('shutdown-project'))
  try {
    await adapter.connect(url)
    const outcome = adapter.prompt('p', 's1', 'hello', { id: 'model', providerID: 'amecode', name: 'Model' }).then(() => 'completed', () => 'aborted')
    await waiting
    adapter.abortRequests()
    assert.equal(await outcome, 'aborted')
    assert.equal(adapter.endpoint()?.url, url, 'Account revocation still needs the current endpoint')
    adapter.dispose()
    await adapter.connect(url)
    assert.equal(adapter.connection().connected, true, 'a deliberate reconnect gets a fresh request lifetime')
  } finally {
    adapter.dispose(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
