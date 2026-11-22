import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { monacoHighlightFix } from '../scripts/monaco-highlight-fix'

const id = 'C:\\app\\node_modules\\monaco-editor\\esm\\vs\\editor\\contrib\\wordHighlighter\\browser\\wordHighlighter.js'
const transform = monacoHighlightFix().transform as (source: string, id: string) => { code: string } | undefined

test('Monaco highlight timer promises have cancellation handlers without disabling highlighting', async () => {
  const source = await readFile(new URL('../node_modules/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js', import.meta.url), 'utf8')
  const result = transform(source, id)!
  assert.equal((result.code.match(/\.catch\(onUnexpectedError\)/g) ?? []).length, 3)
  assert.equal(result.code.replaceAll('.catch(onUnexpectedError)', ''), source)
  assert.equal(transform(source, id.replace('wordHighlighter.js', 'other.js')), undefined)
})

test('Monaco fix refuses changed upstream timer code instead of silently skipping the patch', () => {
  assert.throws(() => transform('this.runDelayer.trigger(() => this._run());', id), /Review Monaco/)
})
