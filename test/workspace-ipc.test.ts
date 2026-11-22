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
  { method: 'listFiles', args: ['p'] },
  { method: 'sessionUsage', args: ['p', 's'] },
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

const selectedModel = { id: 'model', name: 'Model', providerID: 'amecode' }
const palette = { background: '#242424', foreground: '#eeeeee', border: '#505050' }
const petSessions = [{ key: 'p:s', running: true, waiting: false, thinking: true, child: false, outcome: 'succeeded', busy: 123, idle: 100 }]
const nativeExamples: Invocation[] = [
  { method: 'platform', args: [] },
  { method: 'artifacts', args: ['p', 's'] }, { method: 'artifact', args: ['p', 'artifact'] }, { method: 'deleteArtifact', args: ['p', 'artifact'] },
  { method: 'btwAsk', args: ['p', 's', 'Question?', selectedModel] }, { method: 'forkSession', args: ['p', 's'] },
  { method: 'petState', args: [] }, { method: 'petSprite', args: [] },
  { method: 'petConfigure', args: [{ enabled: true, scale: 0.5, resetPosition: true }] },
  { method: 'petSpeech', args: [{ enabled: true, sound: false }] }, { method: 'petTheme', args: [palette] },
  { method: 'petReport', args: [petSessions] }, { method: 'petTestSpeech', args: [] }, { method: 'petGenerateDialogue', args: ['model'] }
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
  workspace.list = () => [{ id: 'p', directory }]
  let models = [{ id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }]
  let status: any = { account: { role: 'admin' }, models: { default_model: 'server-model', models: [{ id: 'server-model' }] } }
  let operationGate: Promise<void> | undefined
  let summary = { diff: '+change', files: ['new.txt'], truncated: false }
  let pricing = { origin: 'https://usage.example', prices: { model: { revision: 1 } } }
  let policyError = ''
  let policyGate: Promise<void> | undefined
  workspace.stagedDiffSummary = async (...args: unknown[]) => { calls.push({ method: 'stagedDiffSummary', args }); return summary }
  const adapter: Record<string, (...args: any[]) => any> = Object.fromEntries(['renameSession', 'archiveSession', 'deleteSession', 'commands', 'skills', 'generateCommitMessage', 'sessionUsage', 'artifacts', 'artifact', 'deleteArtifact', 'btwAsk', 'forkSession', 'prompt'].map(method => [method, async (...args: unknown[]) => {
    calls.push({ method, args })
    if (operationGate) await operationGate
    return method === 'generateCommitMessage' ? { message: 'feat: change', truncated: summary.truncated } : method
  }]))
  const petState = { preferences: { enabled: false, scale: 0.25, position: null }, activity: 'idle', error: '', speech: { enabled: true, sound: true }, generating: false, dialogueModel: '', generatedAt: 0 }
  const petHost = {
    state: () => petState,
    theme: (...args: unknown[]) => { calls.push({ method: 'pet:theme', args }) },
    report: (...args: unknown[]) => { calls.push({ method: 'pet:report', args }); return 'thinking' },
    testSpeech: (...args: unknown[]) => { calls.push({ method: 'pet:testSpeech', args }) },
    ...Object.fromEntries(['configure', 'speech', 'generate'].map(method => [method, async (...args: unknown[]) => {
      calls.push({ method: `pet:${method}`, args })
      if (operationGate && method === 'generate') await operationGate
      return petState
    }]))
  }
  adapter.models = async (...args: unknown[]) => { calls.push({ method: 'models', args }); return models }
  const account = { call: async (...args: unknown[]) => {
    calls.push({ method: 'account', args })
    if (policyGate && args[0] !== 'status') await policyGate
    if (policyError && args[0] !== 'status') throw new Error(policyError)
    if (args[0] === 'status') return status
    if (args[0] === 'usage-prices') return pricing
  } }
  const parent = {}
  const context = {
    z, Buffer, process, window: parent, workspace, adapter, account, petHost, sprite: 'data:image/png;base64,test', shuttingDown: false, validateWorkspacePath,
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
      calls.push({ method: 'confirm', args: options.detail ? [options.message, options.detail] : [options.message] })
      return { response }
    } }
  }
  const dispatch = runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\ndispatch', context) as (method: string, args: unknown[]) => Promise<unknown>
  return {
    dispatch, calls, messages, result, petState, setPricing: (value: typeof pricing) => { pricing = value },
    setStatus: (value: unknown) => { status = value }, setProjects: (value: { id: string; directory: string }[]) => { workspace.list = () => value },
    gateOperation: (value: Promise<void>) => { operationGate = value }, shutdown: () => { context.shuttingDown = true },
    setModels: (value: typeof models) => {
      models = value
      status = { account: { role: 'admin' }, models: { default_model: value[0]?.modelID ?? 'missing', models: value.map(model => ({ id: model.modelID ?? model.id })) } }
    }, setSummary: (value: typeof summary) => { summary = value },
    failPolicy: (value: string) => { policyError = value }, gatePolicy: (value: Promise<void>) => { policyGate = value },
    cancel: () => { response = 0 }, approve: () => { response = 1 }, empty: () => { preview = { filesChanged: 0, replacements: 0, previews: [] } }
  }
}

function plain(value: unknown) { return JSON.parse(JSON.stringify(value)) }

test('artifact, side-thread, pet and platform tuples reject extra or malformed input without side effects', async () => {
  const h = await harness()
  for (const { method, args } of nativeExamples) {
    await assert.rejects(h.dispatch(method, [...args, 'extra']), method)
    if (args.length && method !== 'petGenerateDialogue') await assert.rejects(h.dispatch(method, []), method)
  }
  const invalid: Invocation[] = [
    ...['artifacts', 'artifact', 'deleteArtifact', 'btwAsk', 'forkSession'].flatMap(method => {
      const args = nativeExamples.find(example => example.method === method)!.args
      return ['', ' ', 'bad\0id', 42, 'x'.repeat(513)].map(value => ({ method, args: [value, ...args.slice(1)] }))
    }),
    ...['artifact', 'deleteArtifact'].flatMap(method => ['', ' ', ' trailing ', 'bad\0id', 42, 'x'.repeat(201)].map(value => ({ method, args: ['p', value] }))),
    ...['artifacts', 'forkSession', 'btwAsk'].flatMap(method => ['', ' ', 'bad\0id', 42, 'x'.repeat(513)].map(value => ({ method, args: ['p', value, ...nativeExamples.find(example => example.method === method)!.args.slice(2)] }))),
    ...['', ' ', 'x'.repeat(20001), 42, null, 'bad\0question'].map(value => ({ method: 'btwAsk', args: ['p', 's', value] })),
    ...[{}, { ...selectedModel, extra: true }, { ...selectedModel, providerID: 42 }].map(value => ({ method: 'btwAsk', args: ['p', 's', 'question', value] })),
    ...[null, { enabled: 1 }, { scale: 0.24 }, { scale: 2.01 }, { scale: NaN }, { scale: Infinity }, { resetPosition: 'yes' }, { extra: true }].map(value => ({ method: 'petConfigure', args: [value] })),
    ...[null, { enabled: 1 }, { sound: 'true' }, { extra: true }].map(value => ({ method: 'petSpeech', args: [value] })),
    ...[{}, { ...palette, extra: true }, { ...palette, border: 'red;display:none' }, { ...palette, background: 'x'.repeat(161) }].map(value => ({ method: 'petTheme', args: [value] })),
    ...[{}, Array(2001).fill(petSessions[0]), [{}], [{ ...petSessions[0], extra: true }], [{ ...petSessions[0], key: '' }], [{ ...petSessions[0], running: 'true' }], [{ ...petSessions[0], busy: -1 }], [{ ...petSessions[0], idle: Infinity }], [{ ...petSessions[0], busy: 1.5 }], [{ ...petSessions[0], outcome: 'unknown' }]].map(value => ({ method: 'petReport', args: [value] })),
    ...['', ' ', ' padded ', 'bad\0model', 'x'.repeat(201), 42, null].map(value => ({ method: 'petGenerateDialogue', args: [value] }))
  ]
  for (const { method, args } of invalid) await assert.rejects(h.dispatch(method, args), method)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.messages, [])
})

test('artifact and fork dispatch preserve ownership arguments and artifact deletion uses exact native confirmation', async () => {
  const h = await harness()
  for (const invocation of nativeExamples.filter(example => ['artifacts', 'artifact', 'forkSession'].includes(example.method))) {
    h.calls.length = 0
    assert.equal(await h.dispatch(invocation.method, invocation.args), invocation.method)
    assert.deepEqual(plain(h.calls), [invocation])
  }
  h.calls.length = 0
  await h.dispatch('artifacts', ['p'])
  assert.deepEqual(h.calls[0], { method: 'artifacts', args: ['p', undefined] })
  h.calls.length = 0; h.cancel()
  await assert.rejects(h.dispatch('deleteArtifact', ['p', 'artifact']), /CANCELLED/)
  assert.deepEqual(plain(h.calls), [{ method: 'confirm', args: ['Xóa artifact này?', 'Hành động này không thể hoàn tác.'] }])
  h.calls.length = 0; h.approve()
  await h.dispatch('deleteArtifact', ['p', 'artifact'])
  assert.deepEqual(plain(h.calls), [
    { method: 'confirm', args: ['Xóa artifact này?', 'Hành động này không thể hoàn tác.'] },
    { method: 'deleteArtifact', args: ['p', 'artifact'] }
  ])
})

test('pet methods return host state even when host theme, report and testSpeech do not', async () => {
  const h = await harness()
  assert.equal(await h.dispatch('platform', []), process.platform)
  assert.equal(await h.dispatch('petSprite', []), 'data:image/png;base64,test')
  for (const { method, args } of nativeExamples.filter(example => example.method.startsWith('pet') && !['petSprite', 'petGenerateDialogue'].includes(example.method))) {
    assert.equal(await h.dispatch(method, args), h.petState, method)
  }
  assert.deepEqual(plain(h.calls), [
    { method: 'pet:configure', args: [{ enabled: true, scale: 0.5, resetPosition: true }] },
    { method: 'pet:speech', args: [{ enabled: true, sound: false }] },
    { method: 'pet:theme', args: [palette] }, { method: 'pet:report', args: ['main', petSessions] },
    { method: 'pet:testSpeech', args: [] }
  ])
})

test('side-thread and pet generation resolve canonical catalog models and enforce User server locks across AI APIs', async () => {
  const h = await harness()
  const locked = { id: 'amecode/locked', modelID: 'locked', name: 'Locked', providerID: 'amecode' }
  const other = { id: 'other', modelID: 'other', name: 'Other', providerID: 'amecode' }
  h.setModels([other, locked])
  h.setStatus({ account: { role: 'user' }, models: { default_model: 'locked', models: [{ id: 'locked' }, { id: 'other' }] } })
  for (const invocation of [
    { method: 'btwAsk', args: ['p', 's', 'question', { ...other, modelID: 'forged', providerID: 'external' }] },
    { method: 'btwAsk', args: ['p', 's', 'question'] },
    { method: 'petGenerateDialogue', args: ['other'] }, { method: 'petGenerateDialogue', args: [] },
    { method: 'prompt', args: ['p', 's', 'question', other, 'agent'] }, { method: 'prompt', args: ['p', 's', 'question'] },
    { method: 'generateCommitMessage', args: ['p', other] }
  ]) {
    h.calls.length = 0
    await h.dispatch(invocation.method, invocation.args)
    assert.deepEqual(plain(h.calls.slice(0, 3)), [
      { method: 'models', args: ['p'] }, { method: 'account', args: ['status', {}] },
      { method: 'account', args: ['assert-model', { modelID: 'locked', providerID: 'amecode' }] }
    ])
    const last = h.calls.at(-1)!
    if (invocation.method === 'petGenerateDialogue') assert.deepEqual(last, { method: 'pet:generate', args: ['locked'] })
    else assert.deepEqual(plain(last.args[invocation.method === 'generateCommitMessage' ? 1 : 3]), locked)
  }
  h.setStatus({ account: { role: 'admin' }, models: { default_model: 'locked', models: [{ id: 'locked' }, { id: 'other' }] } })
  for (const model of ['amecode/locked', 'locked']) {
    h.calls.length = 0
    await h.dispatch('petGenerateDialogue', [model])
    assert.deepEqual(h.calls.at(-1), { method: 'pet:generate', args: ['locked'] })
  }
  h.calls.length = 0
  await h.dispatch('petGenerateDialogue', [])
  assert.deepEqual(h.calls.at(-1), { method: 'pet:generate', args: ['locked'] })
  h.calls.length = 0
  await h.dispatch('btwAsk', ['p', 's', 'question', { ...other, providerID: 'forged', modelID: 'forged' }])
  assert.deepEqual(plain(h.calls.at(-1)), { method: 'btwAsk', args: ['p', 's', 'question', other] })
  await assert.rejects(h.dispatch('prompt', ['p', 's', 'question']), /AMEKIT_MODEL_REQUIRED/)
})

test('side-thread and pet generation fail closed on policy, catalog and project failures', async () => {
  const invocations = [{ method: 'btwAsk', args: ['p', 's', 'question', selectedModel] }, { method: 'petGenerateDialogue', args: ['model'] }]
  for (const invocation of invocations) {
    for (const error of ['USER_DISABLED', 'OPERATION_BUSY', 'RATE_LIMITED', 'AMECODE_MODEL_NOT_ALLOWED']) {
      const h = await harness(); h.failPolicy(error)
      await assert.rejects(h.dispatch(invocation.method, invocation.args), new RegExp(error))
      assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account'])
    }
    for (const status of [null, { account: { role: 'unknown' }, models: {} }, { account: { role: 'admin' }, models: { default_model: 'other', models: [{ id: 'other' }] } }, { account: { role: 'user' }, models: { default_model: 'missing', models: [{ id: 'server-model' }] } }]) {
      const h = await harness(); h.setStatus(status)
      await assert.rejects(h.dispatch(invocation.method, invocation.args), /AMECODE_LOGIN_REQUIRED|MODEL_POLICY_UNAVAILABLE|AMEKIT_MODEL_REQUIRED/)
      assert.deepEqual(h.calls.map(call => call.method), ['models', 'account'])
    }
  }
  const h = await harness(); h.setProjects([])
  await assert.rejects(h.dispatch('petGenerateDialogue', []), /AMEKIT_MODEL_REQUIRED/)
  assert.deepEqual(h.calls, [])
})

test('side-thread and pet generation hold authority through fresh policy and operation, recovering after denial', async () => {
  for (const invocation of [{ method: 'btwAsk', args: ['p', 's', 'question'] }, { method: 'petGenerateDialogue', args: [] }]) {
    const h = await harness()
    let releasePolicy!: () => void, releaseOperation!: () => void
    h.gatePolicy(new Promise<void>(resolve => { releasePolicy = resolve }))
    h.gateOperation(new Promise<void>(resolve => { releaseOperation = resolve }))
    const generation = h.dispatch(invocation.method, invocation.args)
    await new Promise(resolve => setImmediate(resolve))
    const following = h.dispatch('account', ['status', {}])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account'])
    releasePolicy()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.calls.at(-1)?.method, invocation.method === 'btwAsk' ? 'btwAsk' : 'pet:generate')
    releaseOperation()
    await Promise.all([generation, following])
    assert.deepEqual(h.calls.at(-1), { method: 'account', args: ['status', {}] })
    h.failPolicy('RATE_LIMITED')
    await assert.rejects(h.dispatch(invocation.method, invocation.args), /RATE_LIMITED/)
    h.failPolicy('')
    await h.dispatch(invocation.method, invocation.args)
  }
})

test('shutdown blocks queued AI work and requests already awaiting model authorization', async () => {
  const h = await harness()
  let release!: () => void
  h.gatePolicy(new Promise<void>(resolve => { release = resolve }))
  const pending = h.dispatch('btwAsk', ['p', 's', 'question'])
  await new Promise(resolve => setImmediate(resolve))
  const queued = h.dispatch('petGenerateDialogue', [])
  h.shutdown(); release()
  await assert.rejects(pending, /APP_SHUTTING_DOWN/)
  await assert.rejects(queued, /APP_SHUTTING_DOWN/)
  await assert.rejects(h.dispatch('petConfigure', [{ enabled: true }]), /APP_SHUTTING_DOWN/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account'])
})

test('desktop lifecycle initializes the disabled pet before backend start, reconciles native windows and aborts before quit', async () => {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'index.ts'), 'utf8')
  for (const platform of ['darwin', 'win32']) {
    const events = new Map<string, (...args: any[]) => any>(), sequence: string[] = [], windows: any[] = []
    let boot!: Promise<void>, options: any, spritePath = '', release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const pet = { init: async () => { sequence.push('pet:init') }, reconcile: () => { sequence.push('pet:reconcile') }, dispose: () => { sequence.push('pet:dispose'); release() } }
    class MockWindow {
      options: any; events = new Map<string, (...args: any[]) => any>()
      webContents = { setWindowOpenHandler: () => {}, on: () => {}, mainFrame: {}, send: () => {} }
      constructor(value: any) { this.options = value; windows.push(this); sequence.push('window') }
      on(name: string, callback: (...args: any[]) => any) { this.events.set(name, callback) }
      isDestroyed() { return false }
      async loadFile() { sequence.push('load') }
    }
    const context = {
      process: { platform, env: {}, resourcesPath: 'resources' }, path, here: 'main', window: undefined,
      workspace: undefined, terminals: undefined, adapter: undefined, runtime: undefined, account: undefined, pairing: undefined,
      petHost: undefined, sprite: '', managed: true, shuttingDown: false, authority: Promise.resolve(),
      app: { requestSingleInstanceLock: () => true, on: (name: string, callback: (...args: any[]) => any) => { events.set(name, callback) },
        whenReady: () => ({ then: (callback: () => Promise<void>) => { boot = callback(); return boot } }),
        isPackaged: false, getAppPath: () => process.cwd(), getPath: () => 'userData', quit: () => { sequence.push('quit') } },
      BrowserWindow: MockWindow, screen: {},
      Menu: { buildFromTemplate: (template: any[]) => { assert.deepEqual(plain(template).map((item: any) => item.role), ['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu']); return template }, setApplicationMenu: () => { sequence.push('menu') } },
      Workspaces: class { async load() {} list() { return [] } dispose() { sequence.push('workspace:dispose') } },
      Terminals: class { dispose() { sequence.push('terminals:dispose') } },
      OpenCodeAdapter: class { dispose() { sequence.push('adapter:dispose') } },
      PrivateRuntime: class { constructor() { sequence.push('runtime:create') } executable() { return 'opencode' } async stop() { sequence.push('runtime:stop') } },
      PairingHost: class {}, RemotePairing: class { async stop() { sequence.push('pairing:stop') } }, automaticTunnel: () => ({}),
      createAmeKit: () => ({ generatePetDialogue: (model: string, signal: AbortSignal) => ({ model, signal }), dispose: async () => { sequence.push('account:dispose') } }),
      loadPetSprite: async (value: string) => { spritePath = value; throw new Error('missing sprite') },
      createPetHost: (value: any) => { options = value; sequence.push('pet:create'); return pet },
      notify: () => {}, pickImport: () => {}, ipcMain: { handle: () => {} }, schema: {},
      dispatch: async () => { sequence.push('backend:start') },
      readFile: async () => { throw new Error('no saved pairing') }, screenActive: () => {},
      dialog: { showErrorBox: () => { assert.fail('startup failed') } }
    }
    runInNewContext(ts.transpileModule(source.slice(source.indexOf('async function openWindow()')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
    await boot
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(options.defaultEnabled, false)
    assert.equal(options.sprite, '')
    assert.equal(options.electron.screen, context.screen)
    assert.equal(options.hasMainWindow(), true)
    assert.equal(spritePath, path.join(process.cwd(), 'packages/amekit/src/assets/ame-chibi.png'))
    assert.ok(sequence.indexOf('pet:create') < sequence.indexOf('runtime:create'))
    assert.ok(sequence.indexOf('pet:init') < sequence.indexOf('window'))
    assert.ok(sequence.indexOf('pet:init') < sequence.indexOf('backend:start'))
    const signal = new AbortController().signal
    assert.deepEqual(options.generateDialogue('canonical', signal), { model: 'canonical', signal })
    assert.equal(windows[0].options.frame, platform === 'win32' ? false : undefined)
    assert.equal(windows[0].options.titleBarStyle, platform === 'darwin' ? 'hiddenInset' : undefined)
    if (platform === 'darwin') assert.deepEqual(plain(windows[0].options.trafficLightPosition), { x: 14, y: 12 })
    assert.equal(sequence.includes('menu'), platform === 'darwin')
    windows[0].events.get('closed')!()
    assert.equal(options.hasMainWindow(), false)
    assert.equal(sequence.at(-1), 'pet:reconcile')
    events.get('activate')!()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(windows.length, 2)
    assert.equal(sequence.at(-1), 'pet:reconcile')
    context.authority = pending
    events.get('will-quit')!({ preventDefault: () => { sequence.push('preventQuit') } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(context.shuttingDown, true)
    assert.ok(sequence.indexOf('pet:dispose') < sequence.indexOf('pairing:stop'))
    assert.ok(sequence.indexOf('pet:dispose') < sequence.indexOf('account:dispose'))
    assert.equal(sequence.at(-1), 'quit')
  }
})

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
    ...[undefined, '', 42, null, 'x'.repeat(513)].map(session => ({ method: 'sessionUsage', args: ['p', session] })),
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
  for (const { method, args } of examples.filter(({ method }) => !['deletePath', 'discardFile', 'revealPath', 'deleteSession', 'generateCommitMessage', 'sessionUsage'].includes(method))) {
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

test('sessionUsage dispatch passes safe prices and falls back without policy authorization or confirmation', async () => {
  const h = await harness()
  const pricing = { origin: 'https://usage.example', prices: { model: { revision: 7 } } }
  h.setPricing(pricing)
  assert.equal(await h.dispatch('sessionUsage', ['p', 's']), 'sessionUsage')
  assert.deepEqual(plain(h.calls), [
    { method: 'account', args: ['usage-prices', {}] },
    { method: 'sessionUsage', args: ['p', 's', pricing.prices, pricing.origin] }
  ])
  for (const error of ['SIGNED_OUT', 'OPERATION_BUSY', 'NETWORK_ERROR', 'UNKNOWN_OPERATION']) {
    h.calls.length = 0; h.failPolicy(error)
    assert.equal(await h.dispatch('sessionUsage', ['p', 's']), 'sessionUsage')
    assert.deepEqual(plain(h.calls), [
      { method: 'account', args: ['usage-prices', {}] },
      { method: 'sessionUsage', args: ['p', 's', {}, null] }
    ])
  }
  assert.deepEqual(h.messages, [])
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
      { method: 'account', args: ['status', {}] },
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
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account'])
  h.calls.length = 0; h.failPolicy('USER_DISABLED')
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /USER_DISABLED/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account'])
  h.failPolicy(''); h.calls.length = 0; h.setSummary({ diff: '', files: [], truncated: false })
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /NO_STAGED_CHANGES/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary'])
})

test('AI commit holds the authority queue through policy validation and generation', async () => {
  const h = await harness()
  let release!: () => void
  h.gatePolicy(new Promise<void>(resolve => { release = resolve }))
  const generate = h.dispatch('generateCommitMessage', ['p'])
  await new Promise(resolve => setImmediate(resolve))
  const following = h.dispatch('account', ['status', {}])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account'])
  release()
  await Promise.all([generate, following])
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary', 'generateCommitMessage', 'account'])
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
  for (const { method, args } of [...examples, ...nativeExamples]) {
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
  await api.artifacts('p')
  assert.deepEqual(calls.pop(), { method: 'artifacts', args: ['p', undefined] })
  await api.btwAsk('p', 's', 'question')
  assert.deepEqual(calls.pop(), { method: 'btwAsk', args: ['p', 's', 'question', undefined] })
  await api.petGenerateDialogue()
  assert.deepEqual(calls.pop(), { method: 'petGenerateDialogue', args: [undefined] })
})
