// Upstream reference fixture: anomalyco/opencode v2.3.2, MIT (references/OPENCODE_LICENSE.txt).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode, renderSVG } from '../qr'

test('Android pairing QR matches the upstream reference encoder', () => {
  const text = "{\"code\":\"abc_DEF-123_4567890123\",\"urls\":[\"https://r1.tunnel.opencode.ai\"]}"
  const rows = ["3fc883f7f", "305be0841", "374e3495d", "375bca25d", "374593f5d", "3054f0941", "3fd55557f", "200076d00", "3f7ee82aa", "37aa52f0d", "3c7825086", "3a1c16a4f", "32cacb023", "3a1411f4d", "2cc96c1ee", "263752e87", "3769cf020", "36bf9abc5", "3850fc012", "253d36895", "367bfc008", "3f8a1e3c1", "345ca9d10", "31a572867", "33f1fd1f1", "201e9fb17", "3fd5e8352", "304e5191d", "3757ca5f1", "375703e34", "375c7cece", "305826f3c", "3fd9fd7e2"]
  const expected = rows.map(row => [...BigInt('0x' + row).toString(2).slice(1)].map(bit => bit === '1'))
  assert.deepEqual(encode(text), expected)
  assert.match(renderSVG(text, { border: 4 }), /viewBox="0 0 410 410"/)
})
