import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rendererSource, isRendererDocument } from '../apps/desktop/src/main/renderer-source'

test('packaged renderer ignores even invalid environment URLs and trusts only the internal normalized file', () => {
  const here = path.resolve('out/main')
  const source = rendererSource(true, here, 'https://attacker.example/')
  assert.deepEqual(source, rendererSource(true, here, 'not a URL'))
  assert.equal(source.url, undefined)
  assert.equal(source.file, path.resolve(here, '../renderer/index.html'))
  assert.ok(isRendererDocument(pathToFileURL(source.file!).href, source))
  assert.ok(isRendererDocument(pathToFileURL(source.file!).href + '#search', source))
  for (const url of ['https://attacker.example/', 'about:blank', 'file:///different/index.html', pathToFileURL(source.file!).href + '?override=true', 'not a URL']) assert.equal(isRendererDocument(url, source), false, url)
})

test('development accepts only the configured HTTP origin or exact local renderer fallback', () => {
  const source = rendererSource(false, path.resolve('out/main'), 'http://localhost:5173/')
  assert.equal(source.url, 'http://localhost:5173/')
  assert.ok(isRendererDocument('http://localhost:5173/search?q=test', source))
  for (const url of ['https://localhost:5173/', 'http://localhost:5174/', 'http://localhost:5173.attacker.example/', 'http://127.0.0.1:5173/', 'file:///index.html']) assert.equal(isRendererDocument(url, source), false, url)
  const local = rendererSource(false, path.resolve('out/main'))
  assert.ok(isRendererDocument(pathToFileURL(local.file!).href, local))
  assert.equal(isRendererDocument('http://localhost:5173/', local), false)
})
