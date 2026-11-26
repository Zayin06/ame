import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

test('LSP queries flush the current Monaco buffer before reading and discard edits during synchronization', async () => {
  const source = await readFile(new URL('../components/EditorStage.tsx', import.meta.url), 'utf8')
  const code = source.slice(source.indexOf('async function requestLsp'), source.indexOf('const completionKinds'))
  const calls: string[] = []
  let finish: (() => void) | undefined
  const requestLsp = runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nrequestLsp', {
    fileLocation: () => ({ projectID: 'p', relativePath: 'app.ts' }),
    window: { ame: { lspUpdateDocument: async (_project: string, _path: string, content: string) => { calls.push(content); if (finish) await new Promise<void>(resolve => { finish = resolve }) } } },
  }) as (model: unknown, token: unknown, request: () => Promise<string>) => Promise<string | null>
  let version = 2
  const model = { uri: {}, getVersionId: () => version, isDisposed: () => false, getValue: () => 'object.' }
  const query = async () => { calls.push('query'); return 'member' }
  assert.equal(await requestLsp(model, { isCancellationRequested: false }, query), 'member')
  assert.deepEqual(calls, ['object.', 'query'])
  calls.length = 0; finish = () => {}
  const pending = requestLsp(model, { isCancellationRequested: false }, query)
  version++; finish!()
  assert.equal(await pending, null)
  assert.deepEqual(calls, ['object.'])
})
