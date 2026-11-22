import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { z } from 'zod'
import { validateWorkspacePath } from '../packages/ide-core/src/workspace-fs'
import type { DesktopApi } from '../packages/protocol/src/index'

type Invocation = { method: string; args: unknown[] }
const examples: Invocation[] = [
  { method: 'createFile', args: ['p', 'new.txt', 'hello'] },
  { method: 'createDirectory', args: ['p', 'folder'] },
  { method: 'renamePath', args: ['p', 'old.txt', 'new.txt'] },
  { method: 'deletePath', args: ['p', 'old.txt'] },
  { method: 'revealPath', args: ['p', 'new.txt'] },
  { method: 'searchProject', args: ['p', { query: 'hello', include: ['**/*.txt'], exclude: ['out/**'], caseSensitive: true, wholeWord: true, regex: false, maxFiles: 10, maxMatches: 20 }] },
  { method: 'replaceInProject', args: ['p', { query: 'hello', replacement: 'bye', files: ['new.txt'], dryRun: true }] },
  { method: 'stageAll', args: ['p'] },
  { method: 'unstageAll', args: ['p'] },
  { method: 'discardFile', args: ['p', 'new.txt'] },
  { method: 'gitBranches', args: ['p'] },
  { method: 'checkoutBranch', args: ['p', 'feature/test'] },
  { method: 'createBranch', args: ['p', 'feature/test', false] },
  { method: 'renameSession', args: ['p', 's', 'New title'] },
  { method: 'archiveSession', args: ['p', 's', true] },
  { method: 'deleteSession', args: ['p', 's'] },
  { method: 'commands', args: ['p'] },
  { method: 'skills', args: ['p'] },
  { method: 'generateCommitMessage', args: ['p', { id: 'model', name: 'Model', providerID: 'amecode' }] }
]

async function harness(directory = 'workspace') {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'index.ts'), 'utf8')
  const start = source.indexOf('const text ='), end = source.indexOf('async function openWindow()')
  assert.ok(start >= 0 && end > start)
  const calls: Invocation[] = []
  const messages: string[] = []
  let response = 1
  let preview = { filesChanged: 2, replacements: 3, previews: [] }
  const result = { filesChanged: 2, replacements: 3, previews: [] }
  const workspace: Record<string, (...args: any[]) => any> = Object.fromEntries([...examples.map(({ method }) => method), 'stage', 'commit', 'remove'].map(method => [method, async (...args: unknown[]) => {
    calls.push({ method, args })
    if (method === 'replaceInProject') return (args[1] as { dryRun?: boolean }).dryRun === true ? preview : result
    return method
  }]))
  workspace.get = (id: unknown) => { if (id !== 'p') throw new Error('UNKNOWN_PROJECT'); return { directory } }
  let models = [{ id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }]
  let summary = { diff: '+change', files: ['new.txt'], truncated: false }
  let policyError = ''
  let policyGate: Promise<void> | undefined
  workspace.stagedDiffSummary = async (...args: unknown[]) => { calls.push({ method: 'stagedDiffSummary', args }); return summary }
  const adapter: Record<string, (...args: any[]) => any> = Object.fromEntries(['renameSession', 'archiveSession', 'deleteSession', 'commands', 'skills', 'generateCommitMessage'].map(method => [method, async (...args: unknown[]) => {
    calls.push({ method, args }); return method === 'generateCommitMessage' ? { message: 'feat: change', truncated: summary.truncated } : method
  }]))
  adapter.models = async (...args: unknown[]) => { calls.push({ method: 'models', args }); return models }
  const account = { call: async (...args: unknown[]) => {
    calls.push({ method: 'account', args })
    if (policyGate) await policyGate
    if (policyError) throw new Error(policyError)
  } }
  const parent = {}
  const context = {
    z, Buffer, window: parent, workspace, adapter, account, validateWorkspacePath,
    pairingSchema: z.object({ enabled: z.boolean(), keepScreenActive: z.boolean() }),
    managed: true,
    pairing: { status: () => ({ enabled: false }) },
    configurePairing: async (settings: unknown) => { calls.push({ method: 'configurePairing', args: [settings] }); return settings },
    shell: { showItemInFolder: (target: string) => calls.push({ method: 'shell', args: [target] }) },
    dialog: { showMessageBox: async (window: unknown, options: any) => {
      assert.equal(window, parent)
      assert.deepEqual(Array.from(options.buttons), ['Hủy', 'Xác nhận'])
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
      messages.push(options.message)
      calls.push({ method: 'confirm', args: [options.message] })
      return { response }
    } }
  }
  const dispatch = runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\ndispatch', context) as (method: string, args: unknown[]) => Promise<unknown>
  return {
    dispatch, calls, messages, result,
    setModels: (value: typeof models) => { models = value }, setSummary: (value: typeof summary) => { summary = value },
    failPolicy: (value: string) => { policyError = value }, gatePolicy: (value: Promise<void>) => { policyGate = value },
    cancel: () => { response = 0 }, approve: () => { response = 1 }, empty: () => { preview = { filesChanged: 0, replacements: 0, previews: [] } }
  }
}

function plain(value: unknown) { return JSON.parse(JSON.stringify(value)) }

test('all new IPC tuples reject malformed requests before dispatch or confirmation', async () => {
  const { dispatch, calls, messages } = await harness()
  for (const { method, args } of examples) {
    for (const invalid of [[], ['', ...args.slice(1)], [42, ...args.slice(1)], ['x'.repeat(513), ...args.slice(1)], [...args, 'extra']]) {
      await assert.rejects(dispatch(method, invalid), method)
    }
  }
  const malformed: Invocation[] = [
    { method: 'createFile', args: ['p', '', 'text'] },
    { method: 'createFile', args: ['p', 'new.txt', 1] },
    { method: 'createFile', args: ['p', 'new.txt', 'a'.repeat(4 * 1024 * 1024 + 1)] },
    { method: 'createFile', args: ['p', 'new.txt', '😀'.repeat(1024 * 1024 + 1)] },
    { method: 'createDirectory', args: ['p', 'x'.repeat(4097)] },
    { method: 'renamePath', args: ['p', 'old.txt', ''] },
    { method: 'deletePath', args: ['p', 'bad\0path'] },
    { method: 'discardFile', args: ['p', null] },
    { method: 'revealPath', args: ['p', 'bad\0path'] },
    { method: 'checkoutBranch', args: ['p', 'x'.repeat(513)] },
    { method: 'createBranch', args: ['p', '', true] },
    { method: 'createBranch', args: ['p', 'feature', 'true'] },
    ...['', '   ', 'bad\0title', 'a'.repeat(501), 42].map(title => ({ method: 'renameSession', args: ['p', 's', title] })),
    { method: 'archiveSession', args: ['p', 's', 'true'] },
    { method: 'deleteSession', args: ['p', ''] },
    ...[{}, { id: 'model', name: 'Model' }, { id: 'model', name: 'Model', providerID: 1 }, { id: 'model', name: 'Model', providerID: 'amecode', extra: true }].map(model => ({ method: 'generateCommitMessage', args: ['p', model] }))
  ]
  const invalidQueries = [
    {}, { query: 42 }, { query: 'x'.repeat(20001) }, { query: 'x', unknown: true },
    { query: 'x', regex: 'true' }, { query: 'x', caseSensitive: 1 }, { query: 'x', wholeWord: null },
    { query: 'x', include: ['x'.repeat(4097)] }, { query: 'x', include: Array(101).fill('*') },
    { query: 'x', exclude: Array(101).fill('*') }, { query: 'x', exclude: [''] },
    ...['maxFiles', 'maxMatches'].flatMap(key => [0, -1, 1.5, Infinity, 100001].map(value => ({ query: 'x', [key]: value })))
  ]
  for (const query of invalidQueries) {
    malformed.push({ method: 'searchProject', args: ['p', query] }, { method: 'replaceInProject', args: ['p', { ...query, replacement: 'y' }] })
  }
  for (const options of [{ query: 'x' }, { query: 'x', replacement: 42 }, { query: 'x', replacement: 'x'.repeat(200001) }, { query: 'x', replacement: 'y', files: Array(5001).fill('a') }, { query: 'x', replacement: 'y', files: [''] }, { query: 'x', replacement: 'y', dryRun: 'true' }]) {
    malformed.push({ method: 'replaceInProject', args: ['p', options] })
  }
  for (const { method, args } of malformed) await assert.rejects(dispatch(method, args), method)
  assert.deepEqual(calls, [])
  assert.deepEqual(messages, [])
})

test('new IPC dispatch preserves arguments and optional defaults without stage or dry-run dialogs', async () => {
  const { dispatch, calls, messages } = await harness()
  for (const { method, args } of examples.filter(({ method }) => !['deletePath', 'discardFile', 'revealPath', 'deleteSession', 'generateCommitMessage'].includes(method))) {
    calls.length = 0
    const result = await dispatch(method, args)
    assert.deepEqual(plain(calls), [{ method, args }])
    if (method !== 'replaceInProject') assert.equal(result, method)
  }
  for (const [method, args] of [
    ['createFile', ['p', 'new.txt']], ['createBranch', ['p', 'feature']],
    ['stage', ['p', 'new.txt', true]], ['stage', ['p', 'new.txt', false]]
  ] as [string, unknown[]][]) {
    calls.length = 0
    await dispatch(method, args)
    assert.equal(calls[0].method, method)
    assert.deepEqual(calls[0].args.slice(0, args.length), args)
  }
  assert.deepEqual(messages, [])
})

test('delete and discard require approval before mutation and propagate cancellation', async () => {
  for (const [method, message] of [
    ['deletePath', 'Xóa new.txt khỏi ổ đĩa? Hành động này không thể hoàn tác.'],
    ['discardFile', 'Hủy mọi thay đổi chưa lưu trong new.txt? Hành động này không thể hoàn tác.'],
    ['deleteSession', 'Xóa cuộc trò chuyện này? Hành động này không thể hoàn tác.']
  ]) {
    const h = await harness()
    h.cancel()
    await assert.rejects(h.dispatch(method, ['p', 'new.txt']), /CANCELLED/)
    assert.deepEqual(h.messages, [message])
    assert.deepEqual(h.calls.map(call => call.method), ['confirm'])
    h.calls.length = 0
    h.approve()
    assert.equal(await h.dispatch(method, ['p', 'new.txt']), method)
    assert.deepEqual(h.calls.map(call => call.method), ['confirm', method])
  }
})

test('AI commit uses a fresh authorized model and bounded staged summary without mutating git', async () => {
  const h = await harness()
  const selected = { id: 'second', modelID: 'canonical', name: 'Second', providerID: 'amecode' }
  h.setModels([{ id: 'other', modelID: 'other', name: 'Other', providerID: 'external' }, selected])
  for (const model of [undefined, { id: 'second', name: 'Forged name', providerID: 'external', modelID: 'forged' }]) {
    h.calls.length = 0
    assert.deepEqual(plain(await h.dispatch('generateCommitMessage', model ? ['p', model] : ['p'])), { message: 'feat: change', truncated: false })
    assert.deepEqual(plain(h.calls), [
      { method: 'models', args: ['p'] },
      { method: 'account', args: ['assert-model', { modelID: 'canonical', providerID: 'amecode' }] },
      { method: 'stagedDiffSummary', args: ['p', 24576] },
      { method: 'generateCommitMessage', args: [{ diff: '+change', files: ['new.txt'], truncated: false }, selected] }
    ])
  }
  assert.deepEqual(h.messages, [])
})

test('AI commit fails closed for unavailable models, rejected policy, or no staged changes', async () => {
  const h = await harness()
  for (const models of [[], [{ id: 'model', modelID: 'model', name: 'Model', providerID: 'external' }]]) {
    h.setModels(models); h.calls.length = 0
    await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /AMEKIT_MODEL_REQUIRED/)
    assert.deepEqual(h.calls.map(call => call.method), ['models'])
  }
  h.setModels([{ id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }])
  h.calls.length = 0
  await assert.rejects(h.dispatch('generateCommitMessage', ['p', { id: 'missing', name: 'Missing', providerID: 'amecode' }]), /AMEKIT_MODEL_REQUIRED/)
  assert.deepEqual(h.calls.map(call => call.method), ['models'])
  h.calls.length = 0; h.failPolicy('USER_DISABLED')
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /USER_DISABLED/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account'])
  h.failPolicy(''); h.calls.length = 0; h.setSummary({ diff: '', files: [], truncated: false })
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /NO_STAGED_CHANGES/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'stagedDiffSummary'])
})

test('AI commit holds the authority queue through policy validation and generation', async () => {
  const h = await harness()
  let release!: () => void
  h.gatePolicy(new Promise<void>(resolve => { release = resolve }))
  const generate = h.dispatch('generateCommitMessage', ['p'])
  await new Promise(resolve => setImmediate(resolve))
  const following = h.dispatch('account', ['status', {}])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account'])
  release()
  await Promise.all([generate, following])
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'stagedDiffSummary', 'generateCommitMessage', 'account'])
})

test('replacement previews before confirmation, cancels without writes, and skips zero-match dialogs', async () => {
  const h = await harness()
  const options = { query: 'hello', replacement: 'bye', files: ['new.txt'], dryRun: false }
  h.cancel()
  await assert.rejects(h.dispatch('replaceInProject', ['p', options]), /CANCELLED/)
  assert.deepEqual(plain(h.calls), [
    { method: 'replaceInProject', args: ['p', { ...options, dryRun: true }] },
    { method: 'confirm', args: ['Thay thế 3 vị trí trong 2 tệp?'] }
  ])
  h.calls.length = 0
  h.approve()
  assert.equal(await h.dispatch('replaceInProject', ['p', options]), h.result)
  assert.deepEqual(plain(h.calls), [
    { method: 'replaceInProject', args: ['p', { ...options, dryRun: true }] },
    { method: 'confirm', args: ['Thay thế 3 vị trí trong 2 tệp?'] },
    { method: 'replaceInProject', args: ['p', options] }
  ])
  h.calls.length = 0
  await h.dispatch('replaceInProject', ['p', { query: 'hello', replacement: 'bye' }])
  assert.deepEqual(h.calls.map(call => call.method), ['replaceInProject', 'confirm', 'replaceInProject'])
  h.calls.length = 0; h.messages.length = 0
  h.empty()
  assert.deepEqual(plain(await h.dispatch('replaceInProject', ['p', options])), { filesChanged: 0, replacements: 0, previews: [] })
  assert.deepEqual(h.calls.map(call => call.method), ['replaceInProject'])
  assert.deepEqual(h.messages, [])
})

test('commit and enabling pairing retain their existing native confirmations', async () => {
  const h = await harness()
  h.cancel()
  await assert.rejects(h.dispatch('commit', ['p', 'commit message']), /CANCELLED/)
  await assert.rejects(h.dispatch('pairingConfigure', [{ enabled: true, keepScreenActive: false }]), /CANCELLED/)
  assert.deepEqual(h.calls.map(call => call.method), ['confirm', 'confirm'])
  h.approve(); h.calls.length = 0
  await h.dispatch('commit', ['p', 'commit message'])
  await h.dispatch('pairingConfigure', [{ enabled: true, keepScreenActive: false }])
  assert.deepEqual(h.calls.map(call => call.method), ['confirm', 'commit', 'confirm', 'configurePairing'])
})

test('shell reveal validates the actual workspace path including root, metadata, escapes and junctions', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.ame-ipc-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'project'), outside = path.join(root, 'outside')
  await mkdir(directory); await mkdir(outside)
  await writeFile(path.join(directory, 'file.txt'), 'hello')
  await symlink(outside, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const h = await harness(directory)
  for (const relative of ['file.txt', '']) {
    await h.dispatch('revealPath', ['p', relative])
    assert.deepEqual(h.calls.pop(), { method: 'shell', args: [path.join(directory, relative)] })
  }
  for (const relative of ['..\\outside', '.git/config', 'C:\\Windows', 'file.txt:stream', 'escape']) {
    await assert.rejects(h.dispatch('revealPath', ['p', relative]))
  }
  await assert.rejects(h.dispatch('revealPath', ['missing', '']), /UNKNOWN_PROJECT/)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.messages, [])
})

test('preload forwards all new methods, optional arguments, return values and rejections', async () => {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'preload', 'index.ts'), 'utf8')
  let api: DesktopApi | undefined, rejected = false
  const calls: Invocation[] = []
  const result = { value: 'IPC response' }
  const context = {
    exports: {},
    require: (name: string) => {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld: (name: string, value: DesktopApi) => { assert.equal(name, 'ame'); api = value } },
        ipcRenderer: { invoke: async (channel: string, method: string, args: unknown[]) => {
          assert.equal(channel, 'ame:call'); calls.push({ method, args: Array.from(args) })
          if (rejected) throw new Error('CANCELLED')
          return result
        } }
      }
    }
  }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  assert.ok(api)
  const methods = api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const { method, args } of examples) {
    assert.equal(await methods[method](...args), result)
    assert.deepEqual(calls.pop(), { method, args })
    rejected = true
    await assert.rejects(methods[method](...args), /CANCELLED/)
    calls.length = 0; rejected = false
  }
  await api.createFile('p', 'empty.txt')
  assert.deepEqual(calls.pop(), { method: 'createFile', args: ['p', 'empty.txt', undefined] })
  await api.createBranch('p', 'feature')
  assert.deepEqual(calls.pop(), { method: 'createBranch', args: ['p', 'feature', undefined] })
  await api.generateCommitMessage('p')
  assert.deepEqual(calls.pop(), { method: 'generateCommitMessage', args: ['p', undefined] })
})
