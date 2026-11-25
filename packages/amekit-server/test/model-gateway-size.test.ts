import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { modelGateway } from '../src/model-gateway'
import { modelPolicy } from '../../amekit/src/model-policy'
import { MAX_MODEL_REQUEST_BYTES } from '../../ide-core/src/dropped-attachments'

test('gateway returns HTTP 413 and the explicit code above 8 MiB without accessing provider', async () => {
  let accessed = false
  const gateway = await modelGateway(() => { accessed = true; return undefined })
  try {
    const response = await fetch(`${gateway.baseURL}/chat/completions`, { method: 'POST', body: ' '.repeat(MAX_MODEL_REQUEST_BYTES + 1) })
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: { code: 'AMECODE_REQUEST_TOO_LARGE', message: 'AMECODE_REQUEST_TOO_LARGE' } })
    assert.equal(accessed, false)
  } finally { await gateway.close() }
})

test('gateway accepts a valid JSON request just below and exactly at 8 MiB', async () => {
  let forwarded = 0
  const provider = createServer(async (req, res) => {
    let size = 0
    for await (const chunk of req) size += chunk.length
    forwarded++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ size }))
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address() as import('node:net').AddressInfo
  const policy = modelPolicy('user', { version: '1', default_model: 'test-model', small_model: 'test-model', models: [{ id: 'test-model', name: 'Test', tool_call: true, vision: true, context: 100, output: 100 }] })
  const gateway = await modelGateway(() => ({ policy, provider: { base_url: `http://127.0.0.1:${address.port}`, api_key: 'test' } }))
  try {
    const json = JSON.stringify({ model: 'test-model', messages: [] })
    for (const size of [MAX_MODEL_REQUEST_BYTES - 1, MAX_MODEL_REQUEST_BYTES]) {
      const response = await fetch(`${gateway.baseURL}/chat/completions`, { method: 'POST', body: json + ' '.repeat(size - Buffer.byteLength(json)) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { size })
    }
    assert.equal(forwarded, 2)
  } finally {
    await gateway.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
  }
})
