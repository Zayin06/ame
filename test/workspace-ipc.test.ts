import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as rendererState from '../apps/desktop/src/renderer/state'
import * as editorSplit from '../apps/desktop/src/renderer/editor-split'
import * as editorModelLifecycle from '../apps/desktop/src/renderer/editor-model-lifecycle'
import * as workspacePaths from '../apps/desktop/src/renderer/workspace-paths'
import * as terminalControls from '../apps/desktop/src/renderer/terminal-controls'
import * as projectRemoval from '../apps/desktop/src/renderer/project-removal'
import * as petSessionMapping from '../apps/desktop/src/renderer/pet-sessions'
import * as chatRefresh from '../apps/desktop/src/renderer/chat-refresh'
import * as platform from '../apps/desktop/src/renderer/platform'
import * as composerMentions from '../apps/desktop/src/renderer/composer-mentions'
import { chatSubmit } from '../apps/desktop/src/renderer/chat-submit'
import * as modelSelection from '../apps/desktop/src/renderer/model-selection'
import { projectChatTimeline } from '../apps/desktop/src/renderer/chat-timeline'
import { familySummaryFromSessions } from '../apps/desktop/src/renderer/agent-map-model'
import { z } from 'zod'
import { rendererSource, isRendererDocument } from '../apps/desktop/src/main/renderer-source'
import { replaceInWorkspace } from '../packages/ide-core/src/search'
import { validateWorkspacePath } from '../packages/ide-core/src/workspace-fs'
import type { BuildNotesRequest, DesktopApi } from '../packages/protocol/src/index'
import type { BuildNotesSummary } from '../packages/ide-core/src/git-ops'
import type { AmeKit } from '../packages/amekit/src/index'
import { buildAndroidTranslationPrompt, createTranslationLockStore } from '../packages/amekit/src/android-translation'

type Invocation = { method: string; args: unknown[] }
const examples: Invocation[] = [
  { method: 'forms', args: ['p', 's'] },
  { method: 'replyForm', args: ['p', 's', 'f', { locale: 'ja', multiple: ['a', 'b'], enabled: true, count: 2 }] },
  { method: 'cancelForm', args: ['p', 's', 'f', 'skip'] },
  { method: 'sessionPermissionMode', args: ['p', 's'] },
  { method: 'updateSessionPermissionMode', args: ['p', 's', 'ask'] },
  { method: 'listFiles', args: ['p'] },
  { method: 'sessionUsage', args: ['p', 's'] },
  { method: 'agentMap', args: ['p', 's'] },
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
  { method: 'commit', args: ['p', 'commit message', { amend: true, noVerify: true }] },
  { method: 'gitDeleteBranch', args: ['p', 'feature/test', false] },
  { method: 'gitFetch', args: ['p'] },
  { method: 'gitPull', args: ['p'] },
  { method: 'gitPush', args: ['p', { setUpstream: true }] },
  { method: 'gitLog', args: ['p', 40] },
  { method: 'gitCommitDetail', args: ['p', 'abcdef0123456789'] },
  { method: 'gitUndoLastCommit', args: ['p'] },
  { method: 'gitStashList', args: ['p'] },
  { method: 'gitStashPush', args: ['p', 'work in progress', true] },
  { method: 'gitStashApply', args: ['p', 0, true] },
  { method: 'gitStashDrop', args: ['p', 0] },
  { method: 'renameSession', args: ['p', 's', 'New title'] },
  { method: 'archiveSession', args: ['p', 's', true] },
  { method: 'deleteSession', args: ['p', 's'] },
  { method: 'commands', args: ['p'] },
  { method: 'skills', args: ['p'] },
  { method: 'generateCommitMessage', args: ['p', { id: 'model', name: 'Model', providerID: 'amecode' }] }
]

const buildNotesRequest: BuildNotesRequest = { mode: 'range', baseCommit: 'abcdef0', includeWorking: true }

test('form IPC rejects unsafe answer maps and oversized payloads before dispatch', async () => {
  const h = await harness()
  for (const answer of [JSON.parse('{"__proto__":"bad"}'), { constructor: 'bad' }, { prototype: 'bad' }, { nested: {} }, { a: null }, { a: Infinity }, { a: 'x'.repeat(20001) }, { ['x'.repeat(201)]: 'a' }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, true])), { a: Array(101).fill('x') }]) {
    await assert.rejects(async () => h.dispatch('replyForm', ['p', 's', 'f', answer]))
  }
  await assert.rejects(async () => h.dispatch('cancelForm', ['p', 's', 'f', 'x'.repeat(2001)]))
  assert.equal(h.calls.length, 0)
})
const buildNotesExamples: Invocation[] = [
  { method: 'buildNotesPreview', args: ['p', buildNotesRequest] },
  { method: 'generateBuildNotes', args: ['p', { mode: 'commits', commitHashes: ['ABCDEF0'], includeWorking: false, note: 'Release highlights' }] },
  { method: 'buildNotesPreview', args: ['p', { mode: 'range', includeWorking: false }] },
  { method: 'generateBuildNotes', args: ['p', { mode: 'range', includeWorking: true }] },
]
const buildNotesSummary: BuildNotesSummary = {
  branch: 'main',
  commits: [{ hash: 'abcdef0'.padEnd(40, '1'), shortHash: 'abcdef0', subject: 'Add feature', body: '', author: 'Dev', date: '2026-11-24', refs: [] }],
  files: [{ path: 'new.txt', status: 'A', additions: 3, deletions: 1, source: 'both' }],
  workingFileCount: 1, additions: 3, deletions: 1, diff: '+private diff', truncated: true,
}

const translationExamples: Invocation[] = [
  { method: 'androidTranslationInfo', args: ['p'] },
  { method: 'androidTranslationPrompt', args: ['p', undefined, 'Translate strings', 'update'] },
  { method: 'androidTranslationLock', args: ['p', 'translation-1'] }
]

const smartExamples: Invocation[] = [
  { method: 'lspUpdateDocument', args: ['p', 'src/app.ts', 'export const value = 1', 7] },
  { method: 'lspCloseDocument', args: ['p', 'src/app.ts'] },
  { method: 'lspRefresh', args: ['p'] },
  { method: 'lspDiagnostics', args: ['p', 'src/app.ts'] },
  { method: 'lspCompletions', args: ['p', 'src/app.ts', 2, 3] },
  { method: 'lspHover', args: ['p', 'src/app.ts', 2, 3] },
  { method: 'lspDefinition', args: ['p', 'src/app.ts', 2, 3] },
  { method: 'lspReferences', args: ['p', 'src/app.ts', 2, 3] },
  { method: 'lspRenamePreview', args: ['p', 'src/app.ts', 2, 3, 'nextValue'] },
  { method: 'debugState', args: ['p'] },
  { method: 'debugSetBreakpoints', args: ['p', 'src/app.ts', [1, 9]] },
  { method: 'debugStart', args: ['p', { entry: 'src/app.ts', args: ['--flag', ''], cwd: '.', env: { TEST: 'value' }, runtime: 'tsx' }] },
  { method: 'debugStop', args: ['p'] },
  { method: 'debugContinue', args: ['p'] },
  { method: 'debugPause', args: ['p'] },
  { method: 'debugStepOver', args: ['p'] },
  { method: 'debugStepInto', args: ['p'] },
  { method: 'debugStepOut', args: ['p'] },
  { method: 'debugEvaluate', args: ['p', 'value + 1', 'frame-1'] }
]
const smartTargets: Record<string, string> = {
  lspUpdateDocument: 'updateDocument', lspCloseDocument: 'closeDocument', lspRefresh: 'refreshFiles',
  lspDiagnostics: 'diagnostics', lspCompletions: 'completions', lspHover: 'hover', lspDefinition: 'definition',
  lspReferences: 'references', lspRenamePreview: 'renamePreview', debugState: 'state',
  debugSetBreakpoints: 'setBreakpoints', debugStart: 'start', debugStop: 'stop', debugContinue: 'continue',
  debugPause: 'pause', debugStepOver: 'stepOver', debugStepInto: 'stepInto', debugStepOut: 'stepOut', debugEvaluate: 'evaluate'
}

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
  let onConfirm: (() => Promise<void>) | undefined
  let picked = { canceled: true, filePaths: [] as string[] }
  const resolved = [{ ok: true, kind: 'workspace-file', path: 'src/app.ts', name: 'app.ts' }]
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
  let notesSummary = buildNotesSummary
  workspace.buildNotesSummary = async (...args: unknown[]) => { calls.push({ method: 'buildNotesSummary', args }); return notesSummary }
  workspace.stagedDiffSummary = async (...args: unknown[]) => { calls.push({ method: 'stagedDiffSummary', args }); return summary }
  const adapter: Record<string, (...args: any[]) => any> = Object.fromEntries(['forms', 'replyForm', 'cancelForm', 'sessionPermissionMode', 'updateSessionPermissionMode', 'renameSession', 'archiveSession', 'deleteSession', 'commands', 'skills', 'generateCommitMessage', 'sessionUsage', 'agentMap', 'artifacts', 'artifact', 'deleteArtifact', 'btwAsk', 'forkSession', 'prompt', 'cancel'].map(method => [method, async (...args: unknown[]) => {
    calls.push({ method, args })
    if (operationGate) await operationGate
    return method === 'generateCommitMessage' ? { message: 'feat: change', truncated: summary.truncated } : method
  }]))
  adapter.generateBuildNotes = async (...args: unknown[]) => {
    calls.push({ method: 'generateBuildNotes', args })
    if (operationGate) await operationGate
    return { notes: '# Build notes', truncated: notesSummary.truncated }
  }
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
  const account: Pick<AmeKit, 'readCommitEnhanceSkill' | 'readCommitEnhanceFeature' | 'readBuildNotesFeature' | 'readStatus' | 'readAndroidTranslationFeature' | 'authorizeFeatureModel'> & { call: (...args: unknown[]) => Promise<unknown> } = { call: async (...args: unknown[]) => {
    calls.push({ method: 'account', args })
    if (policyGate && args[0] !== 'status') await policyGate
    if (policyError && args[0] !== 'status') throw new Error(policyError)
    if (args[0] === 'status') return status
    if (args[0] === 'usage-prices') return pricing
  } }
  const services: { kind: string; directory: string; methods: Record<string, (...args: any[]) => any>; emit?: (event: unknown) => void }[] = []
  const serviceResult = { value: 'service result' }
  function serviceFactory(kind: string, directory: string, emit?: (event: unknown) => void) {
    const targets = Object.entries(smartTargets).filter(([method]) => method.startsWith(kind)).map(([, target]) => target)
    const methods = Object.fromEntries([...targets, 'dispose'].map(target => [target, (...args: unknown[]) => {
      calls.push({ method: `${kind}:${target}`, args })
      return target === 'state' || (kind === 'lsp' && target === 'dispose') ? serviceResult : Promise.resolve(serviceResult)
    }]))
    services.push({ kind, directory, methods, emit })
    return methods
  }
  const parent = { isDestroyed: () => false, webContents: { send: (channel: string, event: unknown) => { calls.push({ method: channel, args: [event] }) } } }
  const translationSessions = new Map<string, Set<string>>(), lockedSessions = new Map<string, Set<string>>()
  const translationLocks = {
    recordSession: async (projectID: string, sessionID: string) => { const ids = translationSessions.get(projectID) ?? new Set(); ids.add(sessionID); translationSessions.set(projectID, ids) },
    lockSession: async (projectID: string, sessionID: string) => { const ids = lockedSessions.get(projectID) ?? new Set(); ids.add(sessionID); lockedSessions.set(projectID, ids) },
    isTranslationSession: (projectID: string, sessionID: string) => translationSessions.get(projectID)?.has(sessionID) ?? false,
    isLocked: (projectID: string, sessionID: string) => lockedSessions.get(projectID)?.has(sessionID) ?? false,
    translationSessionIDs: (projectID: string) => [...(translationSessions.get(projectID) ?? [])],
    lockedSessionIDs: (projectID: string) => [...(lockedSessions.get(projectID) ?? [])]
  }
  let detected = { isAndroid: true, stringsFiles: ['app/src/main/res/values/strings.xml'] }
  let sessions = [{ id: 'translation-1', title: 'Translation' }]
  let sessionMessages: unknown[] = []
  let sessionModel: string | undefined
  adapter.agentMap = async (...args: unknown[]) => {
    calls.push({ method: 'agentMap', args })
    return sessionModel ? { nodes: [{ id: args[1], model: sessionModel, providerID: 'amecode' }] } : 'agentMap'
  }
  adapter.createSession = async (...args: unknown[]) => { calls.push({ method: 'createSession', args }); return sessions[0] }
  adapter.sessions = async (...args: unknown[]) => { calls.push({ method: 'sessions', args }); return sessions }
  adapter.messages = async (...args: unknown[]) => { calls.push({ method: 'messages', args }); return sessionMessages }
  const context = {
    z, Buffer, process, randomUUID, window: parent, workspace, adapter, account, petHost, sprite: 'data:image/png;base64,test', shuttingDown: false, validateWorkspacePath,
    translationLocks, buildAndroidTranslationPrompt,
    resolveDroppedPaths: async (...args: unknown[]) => { calls.push({ method: 'resolveDroppedPaths', args }); return resolved },
    detectAndroidProject: async (...args: unknown[]) => { calls.push({ method: 'detectAndroidProject', args }); return detected },
    pairingSchema: z.object({ enabled: z.boolean(), keepScreenActive: z.boolean() }),
    managed: true,
    createTsLanguageService: (directory: string) => serviceFactory('lsp', directory),
    createNodeDebugger: (directory: string, emit: (event: unknown) => void) => serviceFactory('debug', directory, emit),
    terminals: { closeProject: (...args: unknown[]) => { calls.push({ method: 'terminal:closeProject', args }) } },
    pairing: { status: () => ({ enabled: false }) },
    configurePairing: async (settings: unknown) => { calls.push({ method: 'configurePairing', args: [settings] }); return settings },
    shell: { showItemInFolder: (target: string) => calls.push({ method: 'shell', args: [target] }) },
    dialog: { showOpenDialog: async (window: unknown, options: unknown) => {
      assert.equal(window, parent)
      calls.push({ method: 'showOpenDialog', args: [options] })
      return picked
    }, showMessageBox: async (window: unknown, options: any) => {
      assert.equal(window, parent)
      assert.deepEqual(Array.from(options.buttons), options.buttons.length === 3 ? ['Hủy', 'Lưu và gỡ', 'Bỏ thay đổi và gỡ'] : ['Hủy', 'Xác nhận'])
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
      messages.push(options.message)
      calls.push({ method: 'confirm', args: options.detail ? [options.message, options.detail] : [options.message] })
      await onConfirm?.()
      return { response }
    } }
  }
  adapter.detach = (...args: unknown[]) => { calls.push({ method: 'detach', args }) }
  const { dispatch, lspServices, debuggers } = runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\n({ dispatch, lspServices, debuggers })', context) as {
    dispatch: (method: string, args: unknown[]) => Promise<unknown>
    lspServices: Map<string, any>; debuggers: Map<string, any>
  }
  return {
    dispatch, lspServices, debuggers, services, serviceResult, calls, messages, result, petState, resolved,
    setReplacement: (replace: (...args: any[]) => Promise<unknown>) => { workspace.replaceInProject = replace },
    onConfirm: (callback: () => Promise<void>) => { onConfirm = callback },
    setPicked: (value: typeof picked) => { picked = value },
    setCommitEnhanceReader: (reader: NonNullable<typeof account.readCommitEnhanceSkill>) => { account.readCommitEnhanceSkill = reader },
    setCommitEnhanceFeatureReader: (reader: NonNullable<typeof account.readCommitEnhanceFeature>) => { account.readCommitEnhanceFeature = reader },
    setBuildNotesFeatureReader: (reader: NonNullable<typeof account.readBuildNotesFeature>) => { account.readBuildNotesFeature = reader },
    setBuildNotesSummary: (value: BuildNotesSummary) => { notesSummary = value },
    setReadStatus: (reader: NonNullable<typeof account.readStatus>) => { account.readStatus = reader },
    setAndroidTranslationReader: (reader: NonNullable<typeof account.readAndroidTranslationFeature>) => { account.readAndroidTranslationFeature = reader },
    setFeatureAuthorizer: (authorize: NonNullable<typeof account.authorizeFeatureModel>) => { account.authorizeFeatureModel = authorize },
    setDetected: (value: typeof detected) => { detected = value },
    setSessionMessages: (value: unknown[]) => { sessionMessages = value },
    setSessionModel: (value: string) => { sessionModel = value },
    failInterrupt: () => { adapter.cancel = async () => { throw new Error('INTERRUPT_FAILED') } },
    setSessions: (value: typeof sessions) => { sessions = value },
    translationLocks,
    useLockStore: (store: ReturnType<typeof createTranslationLockStore>) => { context.translationLocks = store },
    failRemove: () => { workspace.remove = async (...args: unknown[]) => { calls.push({ method: 'remove', args }); throw new Error('REMOVE_FAILED') } },
    setProjectDirectory: (id: string, value: string) => { const previous = workspace.get; workspace.get = key => key === id ? { directory: value } : previous(key) },
    invalidateProject: () => { workspace.get = () => { throw new Error('UNKNOWN_PROJECT') } }, setPricing: (value: typeof pricing) => { pricing = value },
    setStatus: (value: unknown) => { status = value }, setProjects: (value: { id: string; directory: string }[]) => { workspace.list = () => value },
    gateOperation: (value: Promise<void>) => { operationGate = value }, shutdown: () => { context.shuttingDown = true },
    setModels: (value: typeof models) => {
      models = value
      status = { account: { role: 'admin' }, models: { default_model: value[0]?.modelID ?? 'missing', models: value.map(model => ({ id: model.modelID ?? model.id })) } }
    }, setSummary: (value: typeof summary) => { summary = value },
    failPolicy: (value: string) => { policyError = value }, gatePolicy: (value: Promise<void>) => { policyGate = value },
    cancel: () => { response = 0 }, approve: () => { response = 1 }, discard: () => { response = 2 }, empty: () => { preview = { filesChanged: 0, replacements: 0, previews: [] } }
  }
}

function plain(value: unknown) { return JSON.parse(JSON.stringify(value)) }

// Run root hooks without a DOM; child components remain elements, so native editor/xterm effects never execute.
function rendererHooks() {
  const slots: any[] = []
  let cursor = 0, rendering = false
  const effects: (() => void)[] = []
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
  const react = {
    ...React,
    useState(initial: any) {
      if (!rendering) return React.useState(initial)
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial: any) {
      if (!rendering) return React.useRef(initial)
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useId() { return `test-id-${cursor++}` },
    useCallback(callback: any, deps: readonly unknown[]) {
      const index = cursor++, previous = slots[index]
      if (!previous || !same(previous.deps, deps)) slots[index] = { deps, callback }
      return slots[index].callback
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      if (!rendering) return React.useEffect(effect, deps)
      const index = cursor++, previous = slots[index]
      if (previous && same(previous.deps, deps)) return
      slots[index] = { deps, cleanup: previous?.cleanup }
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect() })
    }
  }
  return {
    react,
    render(component: (props: any) => React.ReactNode, props: any = {}) {
      cursor = 0; rendering = true
      try { return component(props) } finally { rendering = false }
    },
    effects() { effects.splice(0).forEach(effect => effect()) },
    dispose() { slots.forEach(slot => slot?.cleanup?.()); effects.length = 0 }
  }
}

async function rendererModule(file: string, hooks: ReturnType<typeof rendererHooks>, globals: Record<string, unknown> = {}) {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', file), 'utf8')
  const modules: Record<string, unknown> = {
    react: hooks.react, 'react/jsx-runtime': jsxRuntime, './state': rendererState, './editor-split': editorSplit,
    './workspace-paths': workspacePaths, './terminal-controls': terminalControls, './platform': platform, './project-removal': projectRemoval,
    './pet-sessions': petSessionMapping, '../chat-refresh': chatRefresh, './editor-model-lifecycle': editorModelLifecycle,
    'monaco-editor': { editor: { getModels: () => [] }, Uri: { parse: (uri: string) => ({ toString: () => uri }) } },
    '../composer-mentions': composerMentions, '../chat-submit': { chatSubmit }, '../model-selection': modelSelection,
    '../chat-timeline': { projectChatTimeline }, '../agent-map-model': { familySummaryFromSessions }
  }
  const components = new Map<string, React.ComponentType<any>>()
  const exports: Record<string, any> = {}
  runInNewContext(ts.transpileModule(source.replaceAll('import.meta.env.DEV', 'false'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, {
    exports, ...globals,
    require: (id: string) => {
      if (id in modules) return modules[id]
      if (id.endsWith('.css') || id.startsWith('@xterm/')) return {}
      if (id === '../terminal-controls') return terminalControls
      if (id === './session-changes') return { watchSessionChanges: () => () => {} }
      if (id.startsWith('./components/') || file.startsWith('components\\')) return new Proxy({}, { get: (_, name: string) => {
        if (name === 'errorText') return (value: unknown) => String(value)
        if (!components.has(name)) {
          const component = (props: any) => React.createElement('div', { 'data-component': name }, props.children)
          component.displayName = name; components.set(name, component)
        }
        return components.get(name)
      } })
      throw new Error(`Unexpected renderer import: ${id}`)
    }
  })
  return { exports, components }
}

function rendererElements(tree: React.ReactNode, match: (element: React.ReactElement<any>) => boolean): React.ReactElement<any>[] {
  const found: React.ReactElement<any>[] = []
  const visit = (node: React.ReactNode) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return
    if (match(node)) found.push(node)
    visit(node.props.children)
  }
  visit(tree)
  return found
}

const flushRendererPromises = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

test('TerminalPanel defaults to terminal and tab switches retain the same Shell position, key and surface markup', async () => {
  const hooks = rendererHooks(), listeners = new Set<(event: any) => void>()
  const terminal = { id: 'shell-1', projectID: 'p', title: 'PowerShell' }
  const { exports } = await rendererModule('components\\TerminalPanel.tsx', hooks, { window: { ame: {
    terminalProfiles: async () => [{ id: 'powershell', name: 'PowerShell' }], terminalList: async () => [terminal],
    onEvent: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  } } })
  const props = { projectID: 'p', theme: 'dark', visible: true, close() {} }
  const render = (extra = {}) => hooks.render(exports.TerminalPanel, { ...props, ...extra })
  let tree = render(); hooks.effects(); await flushRendererPromises(); tree = render()
  const initial = rendererElements(tree, element => typeof element.type === 'function' && element.type.name === 'Shell')[0]
  assert.ok(initial)
  assert.equal(rendererElements(tree, element => element.props.role === 'tab' && element.props.type === 'button' && element.props['aria-selected'])[0].key, 'terminal')
  const initialWrap = rendererElements(tree, element => element.props.className === 'terminal-wrap')[0]
  const shellPosition = React.Children.toArray(initialWrap.props.children).findIndex(child => React.isValidElement(child) && child.type === initial.type)
  for (const tab of ['terminal', 'problems', 'debug', 'terminal']) {
    const tabs = rendererElements(tree, element => element.props.role === 'tab' && element.props.type === 'button')
    tabs[['terminal', 'problems', 'debug'].indexOf(tab)].props.onClick()
    tree = render()
    assert.equal(rendererElements(tree, element => element.props.role === 'tab' && element.props.type === 'button' && element.props['aria-selected'])[0].key, tab)
    const wrap = rendererElements(tree, element => element.props.className === 'terminal-wrap')[0]
    assert.equal(wrap.props.hidden, tab !== 'terminal')
    const shell = React.Children.toArray(wrap.props.children)[shellPosition] as React.ReactElement<any>
    assert.ok(shell && shell.type === initial.type, `Shell must remain at the same terminal-wrap position on ${tab}`)
    assert.equal(shell.type, initial.type); assert.equal(shell.props.terminal, initial.props.terminal)
    assert.equal(rendererElements(tree, element => element.type === initial.type)[0].key, initial.key)
    assert.match(renderToStaticMarkup(tree), /class="terminal-surface" data-terminal-id="shell-1"/)
    const bodies = rendererElements(tree, element => element.props.className === 'bottom-panel-body')
    assert.equal(bodies.length, tab === 'terminal' ? 0 : 1)
    if (tab === 'debug') {
      const panel = rendererElements(tree, element => (element.type as any).displayName === 'DebugPanel')[0]
      assert.equal(panel.props.snapshot.status, 'idle'); assert.deepEqual(plain(await panel.props.onEvaluate('1')), { value: '', type: 'error', error: 'Chưa mở project.' })
    }
    if (tab === 'problems') assert.deepEqual(plain(rendererElements(tree, element => (element.type as any).displayName === 'ProblemsPanel')[0].props.problems), [])
  }
  tree = render({ visible: false, activeTab: 'debug' })
  assert.match(renderToStaticMarkup(tree), /editor-terminal is-hidden/)
  assert.equal(rendererElements(tree, element => element.type === initial.type).length, 1)
  hooks.dispose(); assert.equal(listeners.size, 0)
})

async function appRenderer(overrides: Record<string, (...args: any[]) => any> = {}) {
  const hooks = rendererHooks(), calls: Invocation[] = [], listeners = new Set<(event: any) => void>()
  const windowListeners = new Map<string, (event: any) => void>()
  const timers = new Map<number, { delay: number; callback: () => void }>(); let timerID = 0
  const preferences = { ...rendererState.defaults(), project: 'p', inspector: true }
  const projectItems = [{ id: 'p', name: 'Primary', directory: 'workspace' }, { id: 'q', name: 'Other', directory: 'other' }]
  const debugStates = new Map<string, unknown>()
  const api = new Proxy({} as Record<string, any>, { get: (_, method: string) => {
    if (method === 'onEvent') return (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener) }
    return async (...args: any[]) => {
      calls.push({ method, args })
      if (method in overrides) return overrides[method](...args)
      if (method === 'projects') return projectItems
      if (method === 'platform') return 'win32'
      if (method === 'connection') return { connected: false, url: '' }
      if (method === 'debugState') return debugStates.get(args[0]) ?? { status: 'idle', frames: [], variables: [], breakpoints: [] }
      if (method === 'lspDiagnostics') return []
      if (method === 'read' || method === 'save') return { path: args[1], content: method === 'save' ? args[2] : 'original', revision: 'revision', language: 'plaintext' }
      return undefined
    }
  } })
  const { exports } = await rendererModule('App.tsx', hooks, {
    window: { ame: api, addEventListener: (type: string, listener: (event: any) => void) => windowListeners.set(type, listener), removeEventListener: (type: string) => windowListeners.delete(type), dispatchEvent() {}, confirm: () => true },
    document: { documentElement: { dataset: {}, style: { setProperty() {} } } },
    localStorage: { getItem: () => JSON.stringify(preferences), setItem() {} },
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerID; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id: number) => timers.delete(id)
  })
  let tree: React.ReactNode
  const settle = async () => { for (let index = 0; index < 3; index++) { tree = hooks.render(exports.App); hooks.effects(); await flushRendererPromises() } }
  const props = (name: string) => {
    const element = rendererElements(tree, element => (element.type as any).displayName === name)[0]
    assert.ok(element, `${name} should be rendered`); return element.props
  }
  await settle()
  return { calls, props, settle, windowListeners, alerts: () => rendererElements(tree, element => element.props.role === 'alert'), dispose: () => hooks.dispose(),
    emit: (event: any) => {
      if (event.type === 'debug' && event.event.snapshot) debugStates.set(event.projectID, event.event.snapshot)
      listeners.forEach(listener => listener(event))
    },
    tick: async (delay: number) => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() }; await flushRendererPromises(); await settle() }
  }
}

test('App New Chat rotates draft identity and ignores in-flight creation callbacks from the old draft', async () => {
  for (const phase of ['create', 'prompt']) {
    const h = await appRenderer({ connection: async () => ({ connected: true, url: '' }), sessions: async () => [] })
    try {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const oldChat = h.props('Chat')
      const prompts: [string, string][] = []
      let creates = 0
      const submit = chatSubmit({
        createSession: async () => { const id = `session-${++creates}`; if (phase === 'create' && creates === 1) await gate; return { id, title: id } },
        prompt: async (_project, id, text) => { prompts.push([id, text]); if (phase === 'prompt' && id === 'session-1') await gate },
      }, oldChat.onCreated)
      const old = submit('p', undefined, 'A', selectedModel, undefined, undefined, oldChat.draftID)
      await flushRendererPromises()
      oldChat.onCreate()
      // The guard must work even before React has rendered the new draft.
      if (phase === 'create') { release(); await old }
      await h.settle()
      const newChat = h.props('Chat')
      assert.notEqual(newChat.draftID, oldChat.draftID)
      assert.equal(newChat.sessionID, undefined)
      const newSubmit = chatSubmit({
        createSession: async () => ({ id: `session-${++creates}`, title: 'B' }),
        prompt: async (_project, id, text) => { prompts.push([id, text]) },
      }, newChat.onCreated)
      await newSubmit('p', undefined, 'B', selectedModel, undefined, undefined, newChat.draftID)
      if (phase === 'prompt') { release(); await old }
      await h.settle()
      assert.equal(h.props('Chat').sessionID, 'session-2')
      assert.equal(creates, 2)
      assert.deepEqual(prompts, [['session-1', 'A'], ['session-2', 'B']])
      oldChat.onCreated({ id: 'stale', title: 'Stale' })
      await h.settle()
      assert.equal(h.props('Chat').sessionID, 'session-2')
    } finally { h.dispose() }
  }
})

test('file-only submission retains the pending guard and reuses a draft after a failed prompt', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let creates = 0, attempts = 0
  const calls: Invocation[] = []
  const files = [{ uri: 'data:image/png;base64,YQ==', name: 'shot.png', source: { type: 'inline' as const } }]
  const submit = chatSubmit({
    createSession: async () => { creates++; await gate; return { id: 'draft', title: 'Draft' } },
    prompt: async (...args) => { calls.push({ method: 'prompt', args }); if (++attempts === 1) throw new Error('offline') }
  }, () => {})
  assert.equal(await submit('p', undefined, ' ', selectedModel, undefined, []), false)
  const first = submit('p', undefined, '', selectedModel, 'build', files)
  assert.equal(await submit('p', undefined, '', selectedModel, 'build', files), false)
  release()
  await assert.rejects(first, /offline/)
  assert.equal(await submit('p', undefined, '', selectedModel, 'build', files), true)
  assert.equal(creates, 1)
  assert.equal(calls.length, 2)
  for (const call of calls) assert.deepEqual(call.args, ['p', 'draft', '', selectedModel, 'build', files])
})

test('permission IPC validates enum-only inputs and forwards create/update/read through preload', async () => {
  const h = await harness()
  for (const mode of ['default', 'ask', 'readonly', 'full']) {
    await h.dispatch('createSession', ['p', mode])
    assert.deepEqual(plain(h.calls.at(-1)), { method: 'createSession', args: ['p', mode] })
    await h.dispatch('updateSessionPermissionMode', ['p', 's', mode])
    assert.deepEqual(plain(h.calls.at(-1)), { method: 'updateSessionPermissionMode', args: ['p', 's', mode] })
  }
  for (const invalid of ['admin', '', null, 42, {}, [{ action: '*', resource: '*', effect: 'allow' }]]) {
    await assert.rejects(h.dispatch('createSession', ['p', invalid]))
    await assert.rejects(h.dispatch('updateSessionPermissionMode', ['p', 's', invalid]))
  }
  await assert.rejects(h.dispatch('updateSessionPermissionMode', ['p', 's']))
  await assert.rejects(h.dispatch('updateSessionPermissionMode', ['p', 's', 'full', []]))
})

test('Chat permission picker replaces Agent, persists drafts, updates sessions immediately and guards pending sends', async () => {
  const hooks = rendererHooks(), calls: Invocation[] = [], errors: unknown[] = []
  const saved = new Map([['s1', 'readonly'], ['s2', 'ask']])
  let release: (() => void) | undefined, fail = false
  const api = {
    models: async () => [selectedModel], agents: async () => [], commands: async () => [], skills: async () => [],
    onEvent: () => () => {}, messages: async () => [], permissions: async () => [],
    sessionPermissionMode: async (_project: string, session: string) => saved.get(session) ?? 'default',
    updateSessionPermissionMode: async (...args: string[]) => {
      calls.push({ method: 'updateSessionPermissionMode', args })
      await new Promise<void>(resolve => { release = resolve })
      if (fail) throw new Error('update failed')
      saved.set(args[1], args[2]); return args[2]
    },
    createSession: async (...args: unknown[]) => { calls.push({ method: 'createSession', args }); return { id: 'created', title: 'New' } },
    prompt: async (...args: unknown[]) => { calls.push({ method: 'prompt', args }) },
  }
  const { exports } = await rendererModule('components\\Chat.tsx', hooks, {
    window: { ame: api, addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout,
  })
  let props: any = { projectID: 'permission-project', connected: true, ready: true, accountRole: 'admin', defaultModelID: selectedModel.id, modelLevels: {},
    draftID: 1, sessions: [], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark',
    report: (e: unknown) => errors.push(e), onCreated() {}, onActivity() {}, onCreate() {}, onOpenPanel() {}, onOpenFile() {}, onSelectSession() {} }
  let tree: React.ReactNode
  const render = () => { tree = hooks.render(exports.Chat, props) }
  const settle = async () => { for (let i = 0; i < 3; i++) { render(); hooks.effects(); await flushRendererPromises() }; render() }
  const picker = () => rendererElements(tree, node => node.type === 'select' && node.props['aria-label'] === 'Quyền thực thi')[0].props
  const send = async () => {
    const event = { preventDefault() {} }
    rendererElements(tree, node => node.type === 'form' && node.props.className === 'composer-card')[0].props.onSubmit(event)
    await settle()
  }
  const enter = () => rendererElements(tree, node => node.type === 'textarea')[0].props.onChange({ target: { value: 'hello', selectionStart: 5 } })
  try {
    await settle()
    assert.equal(rendererElements(tree, node => node.type === 'select' && node.props['aria-label'] === 'Agent').length, 0)
    assert.deepEqual(plain(rendererElements(picker().children, node => node.type === 'option').map(node => [node.props.value, node.props.children])), [
      ['default', 'Mặc định'], ['ask', 'Hỏi trước'], ['readonly', 'Chỉ đọc'], ['full', 'Tự động cho phép'],
    ])
    picker().onChange({ target: { value: 'full' } }); await settle()
    assert.match(rendererElements(tree, node => node.type === 'label' && String(node.props.className).includes('composer-picker--permission'))[0].props.title, /Cảnh báo.*không hỏi/)
    assert.equal(calls.length, 0)
    props = { ...props, draftID: 2 }; await settle(); assert.equal(picker().value, 'default')
    props = { ...props, draftID: 1 }; await settle(); assert.equal(picker().value, 'full')
    enter(); await settle(); await send()
    assert.deepEqual(plain(calls.find(call => call.method === 'createSession')), { method: 'createSession', args: ['permission-project', 'full'] })
    assert.equal(calls.find(call => call.method === 'prompt')?.args[4], undefined, 'OpenCode chooses the agent')
    props = { ...props, sessionID: 's1' }; await settle(); assert.equal(picker().value, 'readonly')
    picker().onChange({ target: { value: 'ask' } }); await settle()
    assert.equal(picker().disabled, true)
    enter(); await settle(); const count = calls.length; await send(); assert.equal(calls.length, count)
    release!(); await settle(); assert.equal(picker().value, 'ask')
    assert.deepEqual(plain(calls.at(-1)), { method: 'updateSessionPermissionMode', args: ['permission-project', 's1', 'ask'] })
    fail = true; picker().onChange({ target: { value: 'full' } }); release!(); await settle()
    assert.equal(picker().value, 'ask'); assert.equal(errors.length, 1)
    props = { ...props, sessionID: 's2' }; await settle(); assert.equal(picker().value, 'ask')
    saved.set('s1', 'readonly'); props = { ...props, sessionID: 's1' }; await settle(); assert.equal(picker().value, 'readonly')
  } finally { hooks.dispose() }
})

test('Chat wires nested drops, browser paste, native picker, deduplication, limits and attachment-only submission', async () => {
  const hooks = rendererHooks(), calls: Invocation[] = []
  const image = { ok: true, kind: 'media', name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,YQ==', size: 1 }
  let picked = [image], translation = false
  const browser = { name: 'paste.png', type: 'image/png', size: 1, arrayBuffer: async () => Uint8Array.of(98).buffer } as File
  const api = {
    account: async () => ({ account: { role: 'admin' } }),
    androidTranslationInfo: async () => ({ lockedSessionIDs: [], translationSessionIDs: translation ? ['s'] : [] }),
    models: async () => [selectedModel], agents: async () => [], commands: async () => [], skills: async () => [],
    messages: async () => [], permissions: async () => [], onEvent: () => () => {},
    sessionPermissionMode: async () => 'default',
    filePath: (file: { path?: string }) => file.path ?? '',
    resolveDroppedPaths: async (...args: unknown[]) => { calls.push({ method: 'resolveDroppedPaths', args }); return [image] },
    pickAttachmentFiles: async (...args: unknown[]) => { calls.push({ method: 'pickAttachmentFiles', args }); return picked },
    createSession: async () => ({ id: 'created', title: 'Chat', projectID: 'p' }),
    prompt: async (...args: unknown[]) => { calls.push({ method: 'prompt', args }) }
  }
  const { exports } = await rendererModule('components\\Chat.tsx', hooks, {
    window: { ame: api, addEventListener() {}, removeEventListener() {} },
    document: { getElementById: () => null }, requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout, clearTimeout
  })
  let props: any = { projectID: 'p', sessionID: 's', connected: true, ready: true, sessions: [], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark',
    report(error: unknown) { throw error }, onCreated() {}, onActivity() {}, onCreate() {}, onOpenPanel() {}, onOpenFile() {}, onSelectSession() {} }
  let tree: React.ReactNode
  const render = () => { tree = hooks.render(exports.Chat, props) }
  const settle = async () => { for (let i = 0; i < 3; i++) { render(); hooks.effects(); await flushRendererPromises() }; render() }
  const element = (match: (node: React.ReactElement<any>) => boolean) => {
    const found = rendererElements(tree, match)[0]; assert.ok(found); return found
  }
  const pane = () => element(node => node.type === 'main').props
  const component = (name: string) => element(node => (node.type as any).displayName === name).props
  const input = () => element(node => node.type === 'textarea' && node.props.className === 'composer-input').props
  const event = (types: string[], files: File[] = [], workspacePath = '') => ({
    dataTransfer: { types, files, getData: (type: string) => type === composerMentions.WORKSPACE_DRAG_MIME ? workspacePath : '', dropEffect: '' },
    prevented: false, preventDefault() { this.prevented = true }
  })
  await settle()
  try {
    const drag = event(['Files'])
    pane().onDragEnter(drag); pane().onDragEnter(drag); render()
    assert.equal(component('ComposerDropOverlay').active, true)
    pane().onDragLeave(drag); render()
    assert.equal(component('ComposerDropOverlay').active, true)
    pane().onDragLeave(drag); render()
    assert.equal(component('ComposerDropOverlay').active, false)
    pane().onDragOver(drag)
    assert.equal(drag.dataTransfer.dropEffect, 'copy')
    const unsupported = event(['text/plain'])
    pane().onDragEnter(unsupported); assert.equal(unsupported.prevented, false)
    pane().onDrop(event([composerMentions.WORKSPACE_DRAG_MIME], [], 'src/app.ts'))
    pane().onDrop(event([composerMentions.WORKSPACE_DRAG_MIME], [], 'src/app.ts'))
    render(); assert.equal(component('ComposerAttachmentStrip').attachments.length, 1)
    const drop = event(['Files'], [{ path: 'C:\\images\\shot.png' } as unknown as File, browser])
    pane().onDrop(drop); await settle()
    assert.equal(drop.prevented, true)
    assert.equal(component('ComposerDropOverlay').active, false)
    assert.deepEqual(plain(calls[0]), { method: 'resolveDroppedPaths', args: ['p', ['C:\\images\\shot.png']] })
    assert.equal(component('ComposerAttachmentStrip').attachments.length, 3)
    const paste = (plainText: string) => ({ clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => browser }, { kind: 'string', type: 'text/plain', getAsFile: () => null }],
      getData: () => plainText
    }, prevented: false, preventDefault() { this.prevented = true } })
    const mixed = paste('keep text'); input().onPaste(mixed); await settle()
    assert.equal(mixed.prevented, false)
    const imageOnly = paste(''); input().onPaste(imageOnly); await settle()
    assert.equal(imageOnly.prevented, true)
    assert.equal(component('ComposerAttachmentStrip').attachments.length, 3)
    const pick = async () => {
      element(node => node.type === 'button' && node.props.title === 'Đính kèm ngữ cảnh').props.onClick()
      render()
      element(node => node.props.className === 'composer-popover__pick-file').props.onClick()
      await settle()
    }
    picked = Array.from({ length: 8 }, (_, index) => ({ ...image, name: `${index}.png` }))
    await pick()
    assert.equal(calls.at(-1)!.method, 'pickAttachmentFiles')
    assert.equal(component('ComposerAttachmentStrip').attachments.length, 9)
    assert.match(String(element(node => node.props.className === 'inline-error').props.children), /tối đa 8/)
    const workspace = component('ComposerAttachmentStrip').attachments.find((item: any) => item.kind === 'file')
    component('ComposerAttachmentStrip').onRemove(workspace.id); render()
    await element(node => node.type === 'form' && node.props.className === 'composer-card').props.onSubmit({ preventDefault() {} })
    await settle()
    const submitted = calls.find(call => call.method === 'prompt')!
    assert.ok(submitted)
    assert.equal(submitted.args[2], '')
    assert.equal((submitted.args[5] as unknown[]).length, 8)
    assert.equal(component('ComposerAttachmentStrip').attachments.length, 0)
    picked = [{ ok: false, name: 'bad.zip', reason: 'Unsupported' }, { ok: true, kind: 'workspace-file', path: 'src/other.ts', name: 'other.ts' }] as any
    await pick()
    assert.match(String(element(node => node.props.className === 'inline-error').props.children), /bad.zip: Unsupported/)
    assert.equal(component('ComposerAttachmentStrip').attachments.length, 1)
    props = { ...props, connected: false }; await settle()
    const disconnected = event(['Files'], [browser]); pane().onDrop(disconnected)
    assert.equal(disconnected.prevented, false)
    const blockedPaste = paste(''); input().onPaste(blockedPaste); assert.equal(blockedPaste.prevented, false)
    translation = true; props = { ...props, connected: true }; await settle()
    const locked = event(['Files'], [browser]); pane().onDrop(locked)
    assert.equal(locked.prevented, false)
    assert.equal(rendererElements(tree, node => node.type === 'textarea').length, 0)
  } finally { hooks.dispose() }
})

test('App prevents OS-file drag navigation outside Chat and removes both global listeners', async () => {
  const h = await appRenderer()
  for (const type of ['dragover', 'drop']) {
    const handler = h.windowListeners.get(type)
    assert.ok(handler)
    for (const types of [['Files'], ['text/plain'], undefined]) {
      let prevented = false
      handler({ dataTransfer: types ? { types } : null, preventDefault() { prevented = true } })
      assert.equal(prevented, types?.includes('Files') ?? false)
    }
  }
  h.dispose()
  assert.equal(h.windowListeners.has('dragover'), false)
  assert.equal(h.windowListeners.has('drop'), false)
})

test('App routes project debug output, pause navigation and exit without treating debug events as file changes', async () => {
  const h = await appRenderer()
  try {
    const frame = { callFrameId: 'frame-q', path: 'src/main.ts', line: 9, column: 4, functionName: 'main' }
    const snapshot = { status: 'paused', frames: [frame], variables: [], breakpoints: [{ path: frame.path, line: 9 }] }
    h.calls.length = 0
    h.emit({ type: 'debug', projectID: 'q', event: { type: 'output', stream: 'stderr', text: 'other output' } })
    h.emit({ type: 'debug', projectID: 'p', event: { type: 'output', stream: 'stdout', text: 'primary output' } })
    await h.settle()
    assert.deepEqual(plain(h.props('TerminalPanel').debugProps.output), [{ stream: 'stdout', text: 'primary output' }])
    h.emit({ type: 'debug', projectID: 'q', event: { type: 'stopped', reason: 'breakpoint', snapshot } })
    await h.settle(); await h.tick(180)
    const bottom = h.props('TerminalPanel'), editor = h.props('EditorStage')
    assert.equal(bottom.projectID, 'q'); assert.equal(bottom.activeTab, 'debug'); assert.equal(bottom.visible, true)
    assert.deepEqual(plain(bottom.debugProps.snapshot), snapshot)
    assert.deepEqual(plain(bottom.debugProps.output), [{ stream: 'stderr', text: 'other output' }])
    assert.equal(bottom.debugProps.selectedFrameId, 'frame-q')
    assert.deepEqual(plain(editor.target), { projectID: 'q', path: frame.path, line: 9, column: 4, nonce: 1 })
    assert.deepEqual(plain(editor.breakpoints), [9])
    assert.equal(h.calls.filter(call => call.method === 'lspRefresh').length, 0)
    assert.equal(h.calls.filter(call => call.method === 'read').length, 1, 'only navigation should read a file')
    h.emit({ type: 'debug', projectID: 'q', event: { type: 'exited', code: 7 } })
    await h.settle()
    assert.equal(h.props('TerminalPanel').debugProps.snapshot.status, 'exited')
    assert.equal(h.props('TerminalPanel').debugProps.snapshot.exitCode, 7)
    assert.deepEqual(plain(h.props('TerminalPanel').debugProps.snapshot.frames), [])
    assert.equal(h.props('TerminalPanel').debugProps.selectedFrameId, undefined)
    h.props('ProjectRail').onRemove('q'); await h.settle()
    h.emit({ type: 'debug', projectID: 'q', event: { type: 'stopped', reason: 'breakpoint', snapshot } }); await h.settle()
    assert.equal(h.props('TerminalPanel').projectID, 'p', 'late removed-project events must not reopen it')
  } finally { h.dispose() }
})

test('App edits, saves and closes non-source files without LSP document calls while source files retain overlay lifecycle', async () => {
  const h = await appRenderer()
  try {
    for (const file of ['README.md', 'config.json', 'styles.css', 'notes.txt', 'src/app.ts', 'src/view.TSX', 'src/run.mjs']) {
      h.props('Inspector').onOpen(file); await h.settle()
      h.props('EditorStage').onChange('edited'); await h.settle()
      h.calls.length = 0
      await h.tick(300)
      h.props('EditorStage').onSave(); await h.settle()
      h.props('EditorStage').onClose({ path: file, mode: 'file' }); await h.settle()
      assert.ok(h.calls.some(call => call.method === 'save' && call.args[1] === file), file)
      const updates = h.calls.filter(call => call.method === 'lspUpdateDocument')
      const closes = h.calls.filter(call => call.method === 'lspCloseDocument')
      if (['README.md', 'config.json', 'styles.css', 'notes.txt'].includes(file)) {
        assert.deepEqual(updates, [], file); assert.deepEqual(closes, [], file)
      } else {
        assert.ok(updates.length >= 1, file)
        updates.forEach(call => assert.deepEqual(plain(call.args), ['p', file, 'edited']))
        assert.deepEqual(plain(closes), [{ method: 'lspCloseDocument', args: ['p', file] }])
      }
    }
  } finally { h.dispose() }
})

test('App serializes rapid breakpoint toggles and preserves optimistic lines across pending state events', async () => {
  const writes: { lines: number[]; release: () => void }[] = []
  let persisted: number[] = []
  const snapshot = () => ({ status: 'running', frames: [], variables: [], breakpoints: persisted.map(line => ({ path: 'src/main.ts', line })) })
  const h = await appRenderer({
    debugState: async () => snapshot(),
    debugSetBreakpoints: (_id: string, _path: string, lines: number[]) => new Promise<void>(resolve => {
      writes.push({ lines: [...lines], release: () => { persisted = [...lines]; resolve() } })
    })
  })
  try {
    h.props('Inspector').onOpen('src/main.ts'); await h.settle()
    const toggle = h.props('EditorStage').onToggleBreakpoint
    toggle(5); toggle(9); toggle(5); await h.settle()
    assert.deepEqual(plain(h.props('EditorStage').breakpoints), [9])
    assert.deepEqual(writes.map(write => write.lines), [[5]], 'later requests must await the first write')
    h.emit({ type: 'debug', projectID: 'p', event: { type: 'state', snapshot: snapshot() } }); await h.settle()
    assert.deepEqual(plain(h.props('EditorStage').breakpoints), [9], 'stale empty backend snapshot must not erase pending lines')
    writes[0].release(); await h.settle()
    assert.deepEqual(writes.map(write => write.lines), [[5], [5, 9]])
    h.emit({ type: 'debug', projectID: 'p', event: { type: 'state', snapshot: snapshot() } }); await h.settle()
    assert.deepEqual(plain(h.props('EditorStage').breakpoints), [9], 'partially applied backend snapshot must not undo the final toggle')
    writes[1].release(); await h.settle()
    assert.deepEqual(writes.map(write => write.lines), [[5], [5, 9], [9]])
    writes[2].release(); await h.settle()
    assert.deepEqual(persisted, [9])
    assert.deepEqual(plain(h.props('EditorStage').breakpoints), [9])
  } finally { h.dispose() }
})

test('all 19 LSP/debug tuples reject malformed input before creating services', async () => {
  const h = await harness()
  for (const { method, args } of smartExamples) {
    for (const invalid of [[], [...args, 'extra'], ...['', ' ', 'bad\0id', 42, 'x'.repeat(513)].map(id => [id, ...args.slice(1)])]) {
      await assert.rejects(h.dispatch(method, invalid), method)
    }
  }
  const invalid: Invocation[] = []
  const paths = ['', ' ', '.', '..', '../outside.ts', 'src\\..\\app.ts', '/absolute.ts', '\\root.ts', 'C:\\app.ts', 'app.ts:stream', '.git/config', 'src/.GIT./config', 'app.ts ', 'bad\0path', 'x'.repeat(4097), 42]
  for (const invocation of smartExamples.filter(({ method }) => (method.startsWith('lsp') && method !== 'lspRefresh') || method === 'debugSetBreakpoints')) {
    for (const file of paths) invalid.push({ method: invocation.method, args: ['p', file, ...invocation.args.slice(2)] })
  }
  for (const method of ['lspCompletions', 'lspHover', 'lspDefinition', 'lspReferences', 'lspRenamePreview']) {
    const args = smartExamples.find(item => item.method === method)!.args
    for (const index of [2, 3]) for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      const bad = [...args]; bad[index] = value; invalid.push({ method, args: bad })
    }
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, '1', null]) invalid.push({ method: 'debugSetBreakpoints', args: ['p', 'app.ts', [value]] })
  for (const lines of [Array(1001).fill(1), '1', null]) invalid.push({ method: 'debugSetBreakpoints', args: ['p', 'app.ts', lines] })
  for (const value of [42, null, 'a'.repeat(4 * 1024 * 1024 + 1), '😀'.repeat(1024 * 1024 + 1)]) invalid.push({ method: 'lspUpdateDocument', args: ['p', 'app.ts', value] })
  for (const value of [-1, 0.5, Infinity, NaN, '1', null]) invalid.push({ method: 'lspUpdateDocument', args: ['p', 'app.ts', '', value] })
  for (const value of ['', ' ', 'bad\0name', 'a'.repeat(201), 42, null]) invalid.push({ method: 'lspRenamePreview', args: ['p', 'app.ts', 1, 1, value] })
  for (const value of ['', ' \n ', 'bad\0expression', 'a'.repeat(20001), 42, null]) invalid.push({ method: 'debugEvaluate', args: ['p', value] })
  for (const value of ['', ' ', 'bad\0frame', 'a'.repeat(513), 42, null]) invalid.push({ method: 'debugEvaluate', args: ['p', '1', value] })
  for (const config of [
    {}, null, { entry: 'app.ts', extra: true }, ...paths.map(entry => ({ entry })),
    ...paths.filter(cwd => cwd !== '.').map(cwd => ({ entry: 'app.ts', cwd })),
    ...[null, 'node', [42], ['bad\0arg'], ['a'.repeat(8193)], Array(101).fill('arg')].map(args => ({ entry: 'app.ts', args })),
    ...[null, 'bun', 42].map(runtime => ({ entry: 'app.ts', runtime }))
  ]) invalid.push({ method: 'debugStart', args: ['p', config] })
  for (const env of [null, [], 'env', { OK: 42 }, { 'BAD=KEY': 'x' }, { 'BAD\0KEY': 'x' }, { '': 'x' }, { ['a'.repeat(201)]: 'x' }, { OK: 'bad\0value' }, { OK: 'a'.repeat(8193) }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`KEY_${i}`, 'x']))]) {
    invalid.push({ method: 'debugStart', args: ['p', { entry: 'app.ts', env }] })
  }
  for (const { method, args } of invalid) await assert.rejects(h.dispatch(method, args), `${method}: ${String(args[1]).slice(0, 80)}`)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.services, [])
  assert.deepEqual(h.messages, [])
})

test('LSP/debug dispatch forwards all 19 methods and optional arguments to lazy isolated project services', async () => {
  const h = await harness('workspace-one')
  await h.dispatch('projects', [])
  assert.equal(h.services.length, 0)
  for (const { method, args } of smartExamples) {
    h.calls.length = 0
    assert.equal(await h.dispatch(method, args), h.serviceResult, method)
    assert.deepEqual(plain(h.calls), [{ method: `${method.startsWith('lsp') ? 'lsp' : 'debug'}:${smartTargets[method]}`, args: args.slice(1) }])
  }
  assert.deepEqual(h.services.map(({ kind, directory }) => ({ kind, directory })), [{ kind: 'lsp', directory: 'workspace-one' }, { kind: 'debug', directory: 'workspace-one' }])
  for (const invocation of [
    { method: 'lspUpdateDocument', args: ['p', 'app.ts', '', undefined] },
    { method: 'lspUpdateDocument', args: ['p', 'app.ts', '', 0] },
    { method: 'lspDiagnostics', args: ['p', undefined] },
    { method: 'debugEvaluate', args: ['p', ' 1 + 1 ', undefined] },
    { method: 'debugSetBreakpoints', args: ['p', 'app.ts', []] },
    { method: 'debugStart', args: ['p', { entry: 'app.js' }] },
    { method: 'debugStart', args: ['p', { entry: 'app.js', cwd: 'src', runtime: 'node' }] }
  ]) {
    h.calls.length = 0
    await h.dispatch(invocation.method, invocation.args)
    assert.deepEqual(h.calls, [{ method: `${invocation.method.startsWith('lsp') ? 'lsp' : 'debug'}:${smartTargets[invocation.method]}`, args: invocation.args.slice(1) }])
  }
  const snapshot = { status: 'paused', frames: [], variables: [], breakpoints: [] }
  for (const event of [{ type: 'output', stream: 'stdout', text: 'hello' }, { type: 'state', snapshot }, { type: 'stopped', reason: 'breakpoint', snapshot }, { type: 'exited', code: 0 }]) {
    h.calls.length = 0; h.services[1].emit!(event)
    assert.deepEqual(plain(h.calls), [{ method: 'ame:event', args: [{ type: 'debug', projectID: 'p', event }] }])
  }
  h.setProjectDirectory('q', 'workspace-two')
  await h.dispatch('lspRefresh', ['q']); await h.dispatch('debugState', ['q'])
  assert.equal(h.lspServices.size, 2); assert.equal(h.debuggers.size, 2)
  assert.equal(h.services[2].directory, 'workspace-two'); assert.equal(h.services[3].directory, 'workspace-two')
  assert.notEqual(h.lspServices.get('p'), h.lspServices.get('q'))
  assert.notEqual(h.debuggers.get('p'), h.debuggers.get('q'))
  for (const { method, args } of smartExamples) await assert.rejects(h.dispatch(method, ['missing', ...args.slice(1)]), /UNKNOWN_PROJECT/)
  assert.equal(h.services.length, 4)
  h.invalidateProject()
  await assert.rejects(h.dispatch('lspRefresh', ['p']), /UNKNOWN_PROJECT/)
  await assert.rejects(h.dispatch('debugState', ['p']), /UNKNOWN_PROJECT/)
  h.shutdown()
  for (const { method, args } of smartExamples) await assert.rejects(h.dispatch(method, args), /APP_SHUTTING_DOWN/)
})

test('LSP/debug service failures propagate without evicting or duplicating project services', async () => {
  const h = await harness()
  await h.dispatch('lspRefresh', ['p']); await h.dispatch('debugState', ['p'])
  for (const { method, args } of smartExamples) {
    const service = h.services.find(service => service.kind === (method.startsWith('lsp') ? 'lsp' : 'debug'))!
    const target = smartTargets[method], previous = service.methods[target]
    for (const asyncFailure of [false, true]) {
      service.methods[target] = () => {
        if (asyncFailure) return Promise.reject(new Error('SERVICE_FAILED'))
        throw new Error('SERVICE_FAILED')
      }
      await assert.rejects(h.dispatch(method, args), /SERVICE_FAILED/, method)
    }
    service.methods[target] = previous
    assert.equal(await h.dispatch(method, args), h.serviceResult)
  }
  assert.equal(h.services.length, 2)
  assert.equal(h.lspServices.size, 1); assert.equal(h.debuggers.size, 1)
})

test('project removal retains services on cancellation/failure and awaits debugger disposal only after successful removal', async () => {
  for (const failure of ['cancel', 'remove', 'none', 'dispose', 'lsp-dispose']) {
    const h = await harness()
    await h.dispatch('lspRefresh', ['p']); await h.dispatch('debugState', ['p'])
    h.calls.length = 0
    if (failure === 'cancel') h.cancel()
    if (failure === 'remove') h.failRemove()
    if (failure === 'cancel' || failure === 'remove') {
      await assert.rejects(h.dispatch('removeProject', ['p']), failure === 'cancel' ? /CANCELLED/ : /REMOVE_FAILED/)
      assert.equal(h.lspServices.size, 1); assert.equal(h.debuggers.size, 1)
      assert.equal(h.calls.some(call => call.method.endsWith(':dispose')), false)
      continue
    }
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    h.services[1].methods.dispose = async () => { h.calls.push({ method: 'debug:dispose', args: [] }); await pending; if (failure === 'dispose') throw new Error('DISPOSE_FAILED') }
    if (failure === 'lsp-dispose') h.services[0].methods.dispose = () => { h.calls.push({ method: 'lsp:dispose', args: [] }); throw new Error('DISPOSE_FAILED') }
    const removal = h.dispatch('removeProject', ['p'])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(h.calls.map(call => call.method), ['confirm', 'terminal:closeProject', 'remove', 'lsp:dispose', 'debug:dispose'])
    assert.equal(h.lspServices.size, 0); assert.equal(h.debuggers.size, 1)
    release()
    if (failure === 'dispose' || failure === 'lsp-dispose') await assert.rejects(removal, /DISPOSE_FAILED/)
    else await removal
    assert.equal(h.debuggers.size, 0); assert.equal(h.calls.at(-1)?.method, 'detach')
  }
  const h = await harness()
  await h.dispatch('removeProject', ['p'])
  assert.equal(h.services.length, 0)
})

test('App removal includes inactive dirty tabs and only cleans renderer state after approved successful removal', async () => {
  for (const choice of ['cancel', 'discard', 'save', 'failure']) {
    const h = await appRenderer({
      confirmProjectRemoval: async (_id, paths) => {
        assert.deepEqual(plain(paths), ['hidden.txt', 'visible.txt'])
        return choice === 'cancel' ? null : { choice: choice === 'discard' ? 'discard' : 'save', token: 'approved' }
      },
      save: async (_id, path, content) => {
        if (choice === 'failure' && path === 'visible.txt') throw new Error('FILE_CONFLICT')
        return { path, content, revision: 'v2' }
      },
    })
    try {
      for (const path of ['hidden.txt', 'visible.txt']) {
        h.props('Inspector').onOpen(path); await h.settle()
        h.props('EditorStage').onChange(`edited ${path}`); await h.settle()
      }
      h.calls.length = 0
      h.props('ProjectRail').onRemove('p'); await h.settle()
      const saves = h.calls.filter(call => call.method === 'save')
      assert.deepEqual(saves.map(call => call.args[1]), choice === 'save' || choice === 'failure' ? ['hidden.txt', 'visible.txt'] : [])
      const removed = choice === 'save' || choice === 'discard'
      assert.equal(h.props('ProjectRail').projects.some((project: any) => project.id === 'p'), !removed)
      assert.equal(h.calls.some(call => call.method === 'removeProject'), removed)
      if (removed && choice === 'save') assert.ok(h.calls.findIndex(call => call.method === 'removeProject') > Math.max(...h.calls.map((call, index) => call.method === 'save' ? index : -1)))
      if (!removed) {
        assert.equal(h.props('EditorStage').buffer.text, 'edited visible.txt')
        if (choice === 'failure') {
          assert.equal(h.props('EditorStage').buffer.conflict, true)
          assert.match(renderToStaticMarkup(h.alerts()), /visible.txt.*FILE_CONFLICT/)
        }
        h.props('Inspector').onOpen('hidden.txt'); await h.settle()
        assert.equal(h.props('EditorStage').buffer.text, 'edited hidden.txt')
      }
    } finally { h.dispose() }
  }
})

test('dirty removal requires a native, project-bound, single-use approval without a second dialog', async () => {
  for (const choice of ['save', 'discard', 'cancel']) {
    const h = await harness()
    if (choice === 'discard') h.discard()
    if (choice === 'cancel') h.cancel()
    const approval = await h.dispatch('confirmProjectRemoval', ['p', ['visible.txt', 'hidden.txt']]) as { choice: string; token: string } | null
    assert.deepEqual(h.calls.map(call => call.method), ['confirm'])
    assert.match(h.calls[0].args[1] as string, /hidden.txt/)
    if (choice === 'cancel') { assert.equal(approval, null); continue }
    assert.equal(approval!.choice, choice)
    await h.dispatch('removeProject', ['p', approval!.token])
    assert.deepEqual(h.calls.map(call => call.method), ['confirm', 'terminal:closeProject', 'remove', 'detach'])
    await assert.rejects(h.dispatch('removeProject', ['p', approval!.token]), /CANCELLED/)
  }
  const h = await harness()
  for (const args of [[], ['p', []], ['p', ['../escape']], ['p', ['ok'], true]]) await assert.rejects(h.dispatch('confirmProjectRemoval', args))
  await assert.rejects(h.dispatch('removeProject', ['p', randomUUID()]), /CANCELLED/)
  assert.deepEqual(h.calls, [])
})

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

test('commit messages and side-thread questions prefer the API default over catalog order', async () => {
  const h = await harness()
  const other = { id: 'other', modelID: 'other', name: 'Other', providerID: 'amecode' }
  const preferred = { id: 'amecode/preferred', modelID: 'preferred', name: 'Preferred', providerID: 'amecode' }
  h.setModels([other, preferred])
  h.setStatus({ account: { role: 'admin' }, models: { default_model: 'preferred', models: [{ id: 'other' }, { id: 'preferred' }] } })
  await h.dispatch('generateCommitMessage', ['p'])
  assert.deepEqual(plain(h.calls.at(-1)?.args[1]), preferred)
  await h.dispatch('btwAsk', ['p', 's', 'question'])
  assert.deepEqual(plain(h.calls.at(-1)?.args[3]), preferred)
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

test('desktop lifecycle stays lazy, refreshes existing LSP on files, and awaits all service disposal before quit', async () => {
  const source = await readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'index.ts'), 'utf8')
  for (const platform of ['darwin', 'win32']) {
    const events = new Map<string, (...args: any[]) => any>(), sequence: string[] = [], windows: any[] = []
    let boot!: Promise<void>, options: any, accountOptions: any, spritePath = '', release!: () => void
    const bundleTimers: (() => void)[] = [], bundleEvents: unknown[] = []
    const pending = new Promise<void>(resolve => { release = resolve })
    let onFiles!: (projectID: string) => void, releaseDebugger!: () => void
    const debugPending = new Promise<void>(resolve => { releaseDebugger = resolve })
    const lspServices = new Map<string, any>(), debuggers = new Map<string, any>()
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
      renderer: rendererSource(false, path.resolve('main')), isRendererDocument,
      workspace: undefined, terminals: undefined, adapter: undefined, runtime: undefined, account: undefined, pairing: undefined,
      petHost: undefined, sprite: '', managed: true, shuttingDown: false, authority: Promise.resolve(), lspServices, debuggers,
      translationLocks: undefined,
      createTranslationLockStore: (file: string) => {
        assert.equal(file, path.join('userData', 'translation-locks.json'))
        return { load: async () => { sequence.push('translation-locks:load') } }
      },
      app: { requestSingleInstanceLock: () => true, on: (name: string, callback: (...args: any[]) => any) => { events.set(name, callback) },
        whenReady: () => ({ then: (callback: () => Promise<void>) => { boot = callback(); return boot } }),
        isPackaged: false, getAppPath: () => process.cwd(), getPath: () => 'userData', quit: () => { sequence.push('quit') } },
      BrowserWindow: MockWindow, screen: {},
      Menu: { buildFromTemplate: (template: any[]) => { assert.deepEqual(plain(template).map((item: any) => item.role), ['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu']); return template }, setApplicationMenu: () => { sequence.push('menu') } },
      Workspaces: class {
        constructor(_file: string, changed: (projectID: string) => void) { onFiles = changed }
        async load() {} list() { return [] } dispose() { sequence.push('workspace:dispose') }
      },
      Terminals: class { dispose() { sequence.push('terminals:dispose') } },
      OpenCodeAdapter: class { dispose() { sequence.push('adapter:dispose') } },
      PrivateRuntime: class { constructor() { sequence.push('runtime:create') } executable() { return 'opencode' } async stop() { sequence.push('runtime:stop') } },
      PairingHost: class {}, RemotePairing: class { async stop() { sequence.push('pairing:stop') } }, automaticTunnel: () => ({}),
      createAmeKit: (value: any) => { accountOptions = value; return { generatePetDialogue: (model: string, signal: AbortSignal) => ({ model, signal }), dispose: async () => { sequence.push('account:dispose') } } },
      setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 500); bundleTimers.push(callback); return { unref() {} } },
      loadPetSprite: async (value: string) => { spritePath = value; throw new Error('missing sprite') },
      createPetHost: (value: any) => { options = value; sequence.push('pet:create'); return pet },
      notify: (event: any) => { sequence.push(`notify:${event.type}:${event.projectID}`); if (event.type === 'amekit-bundle') bundleEvents.push(plain(event)) }, pickImport: () => {}, ipcMain: { handle: () => {} }, schema: {},
      dispatch: async () => { sequence.push('backend:start') },
      readFile: async () => { throw new Error('no saved pairing') }, screenActive: () => {},
      dialog: { showErrorBox: () => { assert.fail('startup failed') } }
    }
    runInNewContext(ts.transpileModule(source.slice(source.indexOf('async function openWindow()')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
    await boot
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(accountOptions.globalConfigDir, path.join('userData', 'backend', 'config', 'opencode'))
    assert.equal(accountOptions.autoSync, true)
    accountOptions.onBundleChanged({ version: '1.2.3', releaseId: 'fixture', auto: true, action: 'synced' })
    assert.equal(bundleTimers.length, 1)
    assert.equal(sequence.some(item => item.startsWith('notify:amekit-bundle')), false)
    bundleTimers.shift()!()
    assert.equal(sequence.at(-1), 'notify:amekit-bundle:')
    assert.deepEqual(bundleEvents, [{ type: 'amekit-bundle', version: '1.2.3', releaseId: 'fixture', auto: true, action: 'synced', projectID: '' }])
    accountOptions.onBundleChanged({ version: '', releaseId: '', auto: false, action: 'uninstalled' })
    context.shuttingDown = true
    bundleTimers.shift()!()
    assert.equal(bundleEvents.length, 1)
    context.shuttingDown = false
    assert.equal(options.defaultEnabled, false)
    assert.equal(options.sprite, '')
    assert.equal(options.electron.screen, context.screen)
    assert.equal(options.hasMainWindow(), true)
    assert.equal(spritePath, path.join(process.cwd(), 'packages/amekit/src/assets/ame-chibi.png'))
    assert.ok(sequence.indexOf('pet:create') < sequence.indexOf('runtime:create'))
    assert.ok(sequence.indexOf('translation-locks:load') < sequence.indexOf('window'))
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
    assert.equal(lspServices.size, 0); assert.equal(debuggers.size, 0)
    onFiles('unopened')
    assert.equal(sequence.at(-1), 'notify:files:unopened')
    assert.equal(lspServices.size, 0); assert.equal(debuggers.size, 0)
    lspServices.set('p', {
      refreshFiles: async () => { sequence.push('lsp:refresh'); throw new Error('refresh failed') },
      dispose: () => { sequence.push('lsp:dispose'); throw new Error('dispose failed') }
    })
    lspServices.set('q', { dispose: () => { sequence.push('lsp:q:dispose') } })
    debuggers.set('p', { dispose: async () => { sequence.push('debug:dispose'); await debugPending; sequence.push('debug:disposed') } })
    debuggers.set('q', { dispose: async () => { sequence.push('debug:q:dispose'); throw new Error('dispose failed') } })
    onFiles('p')
    assert.deepEqual(sequence.slice(-2), ['lsp:refresh', 'notify:files:p'])
    await new Promise(resolve => setImmediate(resolve))
    context.authority = pending
    events.get('will-quit')!({ preventDefault: () => { sequence.push('preventQuit') } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(context.shuttingDown, true)
    assert.ok(sequence.includes('lsp:dispose')); assert.ok(sequence.includes('lsp:q:dispose'))
    assert.ok(sequence.includes('debug:dispose')); assert.ok(sequence.includes('debug:q:dispose'))
    assert.equal(lspServices.size, 0)
    assert.equal(sequence.includes('quit'), false)
    events.get('will-quit')!({ preventDefault: () => { assert.fail('reentrant quit must not restart cleanup') } })
    releaseDebugger()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(debuggers.size, 0)
    assert.ok(sequence.indexOf('debug:disposed') < sequence.indexOf('quit'))
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
    ...['', ' ', 'bad\0message', 'x'.repeat(10001)].map(message => ({ method: 'commit', args: ['p', message] })),
    ...[{ amend: 'true' }, { noVerify: 1 }, { unknown: true }].map(options => ({ method: 'commit', args: ['p', 'message', options] })),
    { method: 'gitDeleteBranch', args: ['p', 'main', 'true'] },
    ...[{ setUpstream: 'true' }, { force: true }].map(options => ({ method: 'gitPush', args: ['p', options] })),
    ...[0, -1, 1.5, 201, Infinity, '40'].map(limit => ({ method: 'gitLog', args: ['p', limit] })),
    ...['HEAD', '-abcdef0', 'abc', 'g'.repeat(40), 'a'.repeat(41)].map(hash => ({ method: 'gitCommitDetail', args: ['p', hash] })),
    ...[-1, 1.5, 10001, Infinity, '0'].flatMap(index => [
      { method: 'gitStashApply', args: ['p', index] }, { method: 'gitStashDrop', args: ['p', index] }
    ]),
    { method: 'gitStashPush', args: ['p', 'bad\0message'] },
    { method: 'gitStashPush', args: ['p', 'x'.repeat(501)] },
    { method: 'gitStashPush', args: ['p', 'message', 'true'] },
    { method: 'gitStashApply', args: ['p', 0, 'true'] },
    ...['', '   ', 'bad\0title', 'a'.repeat(501), 42].map(title => ({ method: 'renameSession', args: ['p', 's', title] })),
    { method: 'archiveSession', args: ['p', 's', 'true'] },
    { method: 'deleteSession', args: ['p', ''] },
    ...[undefined, '', 42, null, 'x'.repeat(513)].map(session => ({ method: 'sessionUsage', args: ['p', session] })),
    ...[undefined, '', '   ', 42, 'bad\0id', 'x'.repeat(513)].flatMap(value => [
      { method: 'agentMap', args: [value, 's'] },
      { method: 'agentMap', args: ['p', value] }
    ]),
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
  for (const { method, args } of examples.filter(({ method }) => !['deletePath', 'discardFile', 'revealPath', 'deleteSession', 'generateCommitMessage', 'sessionUsage', 'gitDeleteBranch', 'gitStashDrop'].includes(method))) {
    calls.length = 0
    const result = await dispatch(method, args)
    assert.deepEqual(plain(calls), [{ method, args }])
    if (method !== 'replaceInProject') assert.equal(result, method)
  }
  for (const [method, args] of [
    ['createFile', ['p', 'new.txt']], ['createBranch', ['p', 'feature']],
    ['stage', ['p', 'new.txt', true]], ['stage', ['p', 'new.txt', false]],
    ['commit', ['p', 'message']], ['gitPush', ['p']], ['gitLog', ['p']],
    ['gitStashPush', ['p']], ['gitStashApply', ['p', 0]]
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

test('build notes IPC validates strict bounded requests before any service access', async () => {
  const h = await harness()
  const invalid = [
    null, {}, { ...buildNotesRequest, mode: 'all' }, { mode: 'range' },
    { ...buildNotesRequest, includeWorking: 'true' }, { ...buildNotesRequest, extra: true },
    ...['', 'abcdef', 'a'.repeat(41), 'ggggggg', 'HEAD', 'abcdef0\0', '--all'].flatMap(hash => [
      { ...buildNotesRequest, baseCommit: hash }, { ...buildNotesRequest, commitHashes: [hash] },
    ]),
    { ...buildNotesRequest, commitHashes: Array(51).fill('abcdef0') },
    { ...buildNotesRequest, commitHashes: 'abcdef0' },
    { ...buildNotesRequest, note: 'x'.repeat(2001) }, { ...buildNotesRequest, note: 'bad\0note' },
    { ...buildNotesRequest, note: 42 },
  ]
  for (const method of ['buildNotesPreview', 'generateBuildNotes']) {
    for (const request of invalid) await assert.rejects(h.dispatch(method, ['p', request]), method)
    for (const args of [[], ['p'], ['', buildNotesRequest], ['p', buildNotesRequest, 'extra']]) {
      await assert.rejects(h.dispatch(method, args), method)
    }
  }
  assert.equal(h.calls.length, 0)
  for (const method of ['buildNotesPreview', 'generateBuildNotes']) {
    for (const request of [
      { mode: 'range', includeWorking: false },
      { mode: 'commits', commitHashes: [], includeWorking: true },
      { ...buildNotesRequest, baseCommit: 'A'.repeat(40), commitHashes: Array(50).fill('ABCDEF0'), note: 'x'.repeat(2000) },
    ]) {
      await h.dispatch(method, ['p', request])
      assert.deepEqual(plain([...h.calls].reverse().find(call => call.method === 'buildNotesSummary')!.args), ['p', request, 56_000])
    }
  }
  assert.deepEqual(h.messages, [])
})

test('build notes preview omits diff bytes and reports skill and active or fallback model metadata', async () => {
  const h = await harness()
  h.setBuildNotesFeatureReader(async projectID => {
    assert.equal(projectID, 'p')
    return { skill: { name: 'release-notes', instructions: 'Private instructions' }, rawSkillName: 'raw-name', model: 'pinned' }
  })
  h.setStatus({ models: { default_model: 'server-model', models: [{ id: 'server-model' }], active_models: [{ id: 'pinned' }, { id: 'server-model' }] } })
  const { diff: _diff, ...metadata } = buildNotesSummary
  assert.deepEqual(plain(await h.dispatch('buildNotesPreview', ['p', buildNotesRequest])), {
    ...metadata, commitCount: 1, skill: 'release-notes', configuredModelID: 'pinned', effectiveModelID: 'pinned', fallbackToDefault: false,
  })
  h.setBuildNotesFeatureReader(async () => ({ skill: null, rawSkillName: 'raw-name', model: 'pinned' }))
  h.setStatus({ models: { default_model: 'server-model', models: [{ id: 'pinned' }], active_models: [{ id: 'server-model' }] } })
  assert.deepEqual(plain(await h.dispatch('buildNotesPreview', ['p', buildNotesRequest])), {
    ...metadata, commitCount: 1, skill: 'raw-name', configuredModelID: 'pinned', effectiveModelID: 'server-model', fallbackToDefault: true,
  })
  h.setBuildNotesFeatureReader(async () => ({ skill: null }))
  h.setStatus({ models: { default_model: 'server-model', models: [{ id: 'server-model' }] } })
  assert.deepEqual(plain(await h.dispatch('buildNotesPreview', ['p', buildNotesRequest])), {
    ...metadata, commitCount: 1, effectiveModelID: 'server-model', fallbackToDefault: true,
  })
  h.setBuildNotesFeatureReader(async () => { throw new Error('OWNED_FILE_CHANGED') })
  h.setReadStatus(async () => { throw new Error('SIGNED_OUT') })
  assert.deepEqual(plain(await h.dispatch('buildNotesPreview', ['p', buildNotesRequest])), {
    ...metadata, commitCount: 1, fallbackToDefault: true,
  })
  assert.equal(h.calls.some(call => ['models', 'generateBuildNotes', 'authorizeFeatureModel', 'confirm'].includes(call.method)), false)
  assert.deepEqual(h.messages, [])
})

test('build notes preview bypasses pending authority operations using read-only cached status', { timeout: 5000 }, async () => {
  const h = await harness()
  let release!: () => void
  h.gatePolicy(new Promise<void>(resolve => { release = resolve }))
  const pending = h.dispatch('account', ['logout', {}])
  await new Promise(resolve => setImmediate(resolve))
  h.setReadStatus(async () => {
    h.calls.push({ method: 'readStatus', args: [] })
    return { models: { default_model: 'server-model', active_models: [{ id: 'server-model' }] } }
  })
  h.setBuildNotesFeatureReader(async () => ({ skill: null }))
  try {
    const preview = await h.dispatch('buildNotesPreview', ['p', buildNotesRequest]) as any
    assert.equal(preview.effectiveModelID, 'server-model')
    assert.equal('diff' in preview, false)
    assert.deepEqual(h.calls.map(call => call.method), ['account', 'buildNotesSummary', 'readStatus'])
  } finally { release(); await pending }
})

test('build notes generation authorizes the pinned bundle model and forwards skill and trimmed note without confirmation', async () => {
  const h = await harness()
  const defaultModel = { ...selectedModel, modelID: 'server-model' }
  const pinned = { id: 'pinned-ui', modelID: 'pinned', name: 'Pinned', providerID: 'amecode' }
  const skill = { name: 'release-notes', instructions: 'Use team headings' }
  h.setStatus({ account: { role: 'user' }, models: { default_model: 'server-model', models: [{ id: 'server-model' }] } })
  h.setBuildNotesFeatureReader(async projectID => {
    h.calls.push({ method: 'readBuildNotesFeature', args: [projectID] })
    return { model: 'pinned', skill }
  })
  h.setFeatureAuthorizer(async modelID => {
    h.calls.push({ method: 'authorizeFeatureModel', args: [modelID] })
    h.setModels([defaultModel, { ...pinned, providerID: 'external' }, pinned])
    return modelID
  })
  h.cancel()
  assert.deepEqual(plain(await h.dispatch('generateBuildNotes', ['p', { ...buildNotesRequest, note: '  Highlights  ' }])), {
    notes: '# Build notes', truncated: true, commitCount: 1, fileCount: 1, workingFileCount: 1, modelID: 'pinned', skill: 'release-notes',
  })
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'buildNotesSummary', 'readBuildNotesFeature', 'authorizeFeatureModel', 'models', 'generateBuildNotes'])
  assert.deepEqual(plain(h.calls.at(-1)!.args), [buildNotesSummary, pinned, skill, 'Highlights'])
  assert.deepEqual(h.messages, [])
})

test('build notes generation falls back gracefully and uses default prompt mode without a skill', async () => {
  for (const mode of ['inactive', 'missing-runtime', 'missing-authorizer', 'default', 'unset', 'unreadable', 'missing-reader'] as const) {
    const h = await harness()
    if (mode !== 'missing-reader') h.setBuildNotesFeatureReader(async () => {
      if (mode === 'unreadable') throw new Error('OWNED_FILE_CHANGED')
      return { skill: null, model: mode === 'unset' ? undefined : mode === 'default' ? 'server-model' : 'pinned' }
    })
    if (mode !== 'missing-authorizer') h.setFeatureAuthorizer(async modelID => {
      h.calls.push({ method: 'authorizeFeatureModel', args: [modelID] })
      return mode === 'inactive' ? null : modelID
    })
    const result = await h.dispatch('generateBuildNotes', ['p', { ...buildNotesRequest, note: ' \n ' }]) as any
    assert.deepEqual(plain(result), { notes: '# Build notes', truncated: true, commitCount: 1, fileCount: 1, workingFileCount: 1, modelID: 'server-model' })
    const args = h.calls.at(-1)!.args
    assert.deepEqual(plain(args.slice(0, 2)), [buildNotesSummary, { ...selectedModel, modelID: 'server-model' }])
    assert.equal(args[2], undefined); assert.equal(args[3], undefined)
    assert.equal(h.calls.some(call => call.method === 'authorizeFeatureModel'), mode === 'inactive' || mode === 'missing-runtime')
    assert.deepEqual(h.messages, [])
  }
})

test('build notes generation rejects empty changes before feature or provider generation and accepts commits-only or working-only changes', async () => {
  const h = await harness()
  h.setBuildNotesSummary({ ...buildNotesSummary, commits: [], files: [], workingFileCount: 0, diff: '' })
  h.setBuildNotesFeatureReader(async () => { assert.fail('No feature access for empty changes') })
  await assert.rejects(h.dispatch('generateBuildNotes', ['p', buildNotesRequest]), /NO_BUILD_CHANGES/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'buildNotesSummary'])
  h.setBuildNotesFeatureReader(async () => ({ skill: null }))
  for (const summary of [
    { ...buildNotesSummary, files: [], workingFileCount: 0 },
    { ...buildNotesSummary, commits: [] },
  ]) {
    h.setBuildNotesSummary(summary)
    const result = await h.dispatch('generateBuildNotes', ['p', buildNotesRequest]) as any
    assert.equal(result.commitCount, summary.commits.length)
    assert.equal(result.fileCount, summary.files.length)
    assert.equal(result.workingFileCount, summary.workingFileCount)
  }
  h.failPolicy('USER_DISABLED'); h.calls.length = 0
  await assert.rejects(h.dispatch('generateBuildNotes', ['p', buildNotesRequest]), /USER_DISABLED/)
  assert.equal(h.calls.some(call => call.method === 'generateBuildNotes' || call.method === 'buildNotesSummary'), false)
})

test('build notes generation holds authority through policy, feature reads, authorization and provider completion', async () => {
  for (const stage of ['policy', 'feature', 'authorization', 'generation'] as const) {
    const h = await harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    if (stage === 'policy') h.gatePolicy(gate)
    if (stage === 'generation') h.gateOperation(gate)
    h.setBuildNotesFeatureReader(async () => {
      if (stage === 'feature') await gate
      return { skill: null, model: 'pinned' }
    })
    h.setFeatureAuthorizer(async () => { if (stage === 'authorization') await gate; return null })
    const generation = h.dispatch('generateBuildNotes', ['p', buildNotesRequest])
    await new Promise(resolve => setImmediate(resolve))
    const following = h.dispatch('account', ['logout', {}])
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(h.calls.some(call => call.args[0] === 'logout'), false, stage)
      assert.equal(h.calls.some(call => call.method === 'generateBuildNotes'), stage === 'generation', stage)
    } finally { release(); await Promise.all([generation, following]) }
    assert.deepEqual(plain(h.calls.at(-1)), { method: 'account', args: ['logout', {}] })
  }
  const h = await harness()
  h.setBuildNotesFeatureReader(async () => ({ skill: null, model: 'pinned' }))
  h.setFeatureAuthorizer(async () => { throw new Error('POLICY_RELOAD_FAILED') })
  await assert.rejects(h.dispatch('generateBuildNotes', ['p', buildNotesRequest]), /POLICY_RELOAD_FAILED/)
  assert.equal(h.calls.some(call => call.method === 'generateBuildNotes'), false)
  await h.dispatch('account', ['logout', {}])
  assert.deepEqual(plain(h.calls.at(-1)), { method: 'account', args: ['logout', {}] })
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

test('AI commit forwards the synced skill and silently falls back to the two-argument contract', async () => {
  const h = await harness()
  const skill = { name: 'team-commit', instructions: 'Use the team commit format.' }
  for (const mode of ['configured', 'unset', 'unreadable'] as const) {
    h.calls.length = 0
    const projects: string[] = []
    h.setCommitEnhanceReader(async projectID => {
      assert.ok(projectID)
      projects.push(projectID)
      if (mode === 'unreadable') throw new Error('OWNED_FILE_CHANGED')
      return mode === 'configured' ? skill : null
    })
    await h.dispatch('generateCommitMessage', ['p'])
    assert.deepEqual(projects, ['p'])
    assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary', 'generateCommitMessage'])
    const args = plain(h.calls.at(-1)!.args)
    assert.deepEqual(args.slice(0, 2), [
      { diff: '+change', files: ['new.txt'], truncated: false },
      { id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' },
    ])
    assert.equal(args.length, mode === 'configured' ? 3 : 2)
    if (mode === 'configured') assert.deepEqual(args[2], skill)
  }
  h.setSummary({ diff: '', files: [], truncated: false })
  h.setCommitEnhanceReader(async () => { assert.fail('Skill must not be read without staged files') })
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /NO_STAGED_CHANGES/)
})

test('AI commit authorizes a configured feature model after the staged summary and preserves the skill contract', async () => {
  const h = await harness()
  const featureModel = { id: 'gemini-ui', modelID: 'gemini', name: 'Gemini', providerID: 'amecode' }
  const defaultModel = { id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }
  h.setStatus({ account: { role: 'user' }, models: { default_model: 'server-model', models: [{ id: 'server-model' }] } })
  h.setCommitEnhanceFeatureReader(async projectID => {
    h.calls.push({ method: 'readFeature', args: [projectID] })
    return { model: 'gemini', skill: { name: 'team-commit', instructions: 'Team format' } }
  })
  h.setFeatureAuthorizer(async modelID => {
    h.calls.push({ method: 'authorizeFeatureModel', args: [modelID] })
    h.setModels([defaultModel, { ...featureModel, providerID: 'external' }, featureModel])
    h.setStatus({ account: { role: 'user' }, models: { default_model: 'server-model', models: [{ id: 'server-model' }, { id: 'gemini' }] } })
    return modelID
  })
  await h.dispatch('generateCommitMessage', ['p', featureModel])
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary', 'readFeature', 'authorizeFeatureModel', 'models', 'generateCommitMessage'])
  assert.deepEqual(plain(h.calls.at(-1)!.args), [
    { diff: '+change', files: ['new.txt'], truncated: false }, featureModel,
    { name: 'team-commit', instructions: 'Team format' }
  ])
  await h.dispatch('prompt', ['p', 'main-chat', 'Regular chat', featureModel])
  assert.deepEqual(plain(h.calls.at(-1)!.args[3]), defaultModel)
  h.setSummary({ diff: '', files: [], truncated: false }); h.calls.length = 0
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /NO_STAGED_CHANGES/)
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary'])
})

test('AI commit falls back when feature models are inactive, unavailable, or already default', async () => {
  for (const mode of ['inactive', 'missing-runtime', 'missing-authorizer', 'default'] as const) {
    const h = await harness()
    h.setCommitEnhanceFeatureReader(async () => ({ model: mode === 'default' ? 'server-model' : 'gemini', skill: null }))
    if (mode !== 'missing-authorizer') h.setFeatureAuthorizer(async modelID => {
      h.calls.push({ method: 'authorizeFeatureModel', args: [modelID] })
      return mode === 'inactive' ? null : modelID
    })
    await h.dispatch('generateCommitMessage', ['p'])
    assert.deepEqual(plain(h.calls.at(-1)!.args[1]), { id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' })
    assert.equal(h.calls.at(-1)!.args.length, 2)
    assert.equal(h.calls.some(call => call.method === 'authorizeFeatureModel'), mode === 'inactive' || mode === 'missing-runtime')
  }
})

test('feature authorization retains authority and fails closed on authorization errors or shutdown', async () => {
  for (const shutdown of [false, true]) {
    const h = await harness()
    h.setCommitEnhanceFeatureReader(async () => ({ skill: null, model: 'gemini' }))
    let release!: (model: string) => void
    h.setFeatureAuthorizer(() => new Promise<string>(resolve => { release = resolve }))
    const generation = h.dispatch('generateCommitMessage', ['p'])
    await new Promise(resolve => setImmediate(resolve))
    const following = h.dispatch('account', ['logout', {}])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.calls.some(call => call.method === 'generateCommitMessage' || call.args[0] === 'logout'), false)
    if (shutdown) h.shutdown()
    release('gemini')
    if (shutdown) {
      await assert.rejects(generation, /APP_SHUTTING_DOWN/)
      await assert.rejects(following, /APP_SHUTTING_DOWN/)
      assert.equal(h.calls.some(call => call.method === 'generateCommitMessage'), false)
    } else {
      await Promise.all([generation, following])
      assert.deepEqual(plain(h.calls.at(-1)), { method: 'account', args: ['logout', {}] })
    }
  }
  const h = await harness()
  h.setCommitEnhanceFeatureReader(async () => ({ skill: null, model: 'gemini' }))
  h.setFeatureAuthorizer(async () => { throw new Error('POLICY_RELOAD_FAILED') })
  await assert.rejects(h.dispatch('generateCommitMessage', ['p']), /POLICY_RELOAD_FAILED/)
  assert.equal(h.calls.some(call => call.method === 'generateCommitMessage'), false)
})

test('Android translation info reports active feature models, project detection, fallback, and lock state', async () => {
  const h = await harness()
  h.setAndroidTranslationReader(async () => ({ rawSkillName: 'android-strings-translation', skill: null, model: 'gemini' }))
  h.setStatus({ account: { role: 'user' }, models: {
    default_model: 'server-model', models: [{ id: 'server-model', name: 'Default' }],
    active_models: [{ id: 'server-model', name: 'Default' }, { id: 'gemini', name: 'Gemini' }]
  } })
  await h.translationLocks.recordSession('p', 'translation-1')
  await h.translationLocks.lockSession('p', 'translation-1')
  assert.deepEqual(plain(await h.dispatch('androidTranslationInfo', ['p'])), {
    configured: true, isAndroid: true, skill: 'android-strings-translation', configuredModelID: 'gemini',
    effectiveModelID: 'gemini', effectiveModelName: 'Gemini', fallbackToDefault: false,
    stringsFiles: ['app/src/main/res/values/strings.xml'], translationSessionIDs: ['translation-1'], lockedSessionIDs: ['translation-1']
  })
  h.setStatus({ models: { default_model: 'server-model', active_models: [{ id: 'server-model', name: 'Default' }] } })
  assert.equal((await h.dispatch('androidTranslationInfo', ['p']) as any).fallbackToDefault, true)
  assert.equal((await h.dispatch('androidTranslationInfo', ['p']) as any).effectiveModelID, 'server-model')
  h.setAndroidTranslationReader(async () => ({ skill: null }))
  h.setDetected({ isAndroid: false, stringsFiles: [] })
  const unset = await h.dispatch('androidTranslationInfo', ['p']) as any
  assert.equal(unset.configured, false); assert.equal(unset.isAndroid, false)
  assert.deepEqual(plain(unset.stringsFiles), [])
  assert.equal(h.calls.some(call => call.method === 'authorizeFeatureModel'), false)
  h.invalidateProject()
  await assert.rejects(h.dispatch('androidTranslationInfo', ['p']), /UNKNOWN_PROJECT/)
})

const translationSkill = { name: 'android-strings-translation', instructions: 'Run bundled scripts/strings_tool.py.', directory: 'workspace/.opencode/skills/android-strings-translation' }

test('Android translation creates an isolated session, authorizes the pinned model, and wraps first and follow-up prompts', async () => {
  const h = await harness()
  const model = { id: 'gemini-runtime', modelID: 'gemini', name: 'Gemini', providerID: 'amecode' }
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill, model: 'gemini' }))
  h.setFeatureAuthorizer(async modelID => {
    h.setModels([{ id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }, model])
    return modelID
  })
  const result = await h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate into Japanese', 'full'])
  assert.deepEqual(plain(result), { session: { id: 'translation-1', title: 'Translation' }, model, locked: false })
  const first = h.calls.find(call => call.method === 'prompt')!
  assert.deepEqual(plain(first.args.slice(0, 2)), ['p', 'translation-1'])
  assert.deepEqual(plain(first.args[3]), model)
  for (const fragment of ['[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY]', translationSkill.instructions, translationSkill.directory, 'app/src/main/res/values/strings.xml', 'Translate into Japanese', 'full']) assert.ok(String(first.args[2]).includes(fragment), fragment)
  assert.equal(h.translationLocks.isTranslationSession('p', 'translation-1'), true)
  assert.equal(h.translationLocks.isTranslationSession('p', 'main-chat'), false)
  h.calls.length = 0; h.setSessionMessages([{ role: 'user', text: 'previous' }])
  await h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Now French', 'custom'])
  const next = h.calls.find(call => call.method === 'prompt')!
  assert.match(String(next.args[2]), /\[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY\]/)
  assert.match(String(next.args[2]), /Now French/)
  assert.equal(String(next.args[2]).includes(translationSkill.instructions), false)
  assert.equal(h.calls.some(call => call.method === 'createSession'), false)
})

test('translation followups keep their initial model despite configuration/default changes and never leak it to regular Chat', async () => {
  const h = await harness()
  const defaultModel = { id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }
  const featureModel = { id: 'gemini-runtime', modelID: 'gemini', name: 'Gemini', providerID: 'amecode' }
  h.setModels([defaultModel, featureModel])
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill, model: 'gemini' }))
  h.setFeatureAuthorizer(async id => id)
  await h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate'])
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill, model: 'changed-model' }))
  h.setStatus({ account: { role: 'user' }, models: { default_model: 'server-model', models: [{ id: 'server-model' }, { id: 'gemini' }] } })
  h.calls.length = 0
  const followup = await h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Continue']) as any
  assert.equal(followup.model.modelID, 'gemini')
  assert.deepEqual(plain(h.calls.find(call => call.method === 'prompt')!.args[3]), featureModel)
  await h.dispatch('prompt', ['p', 'normal-chat', 'Code', featureModel])
  assert.deepEqual(plain(h.calls.at(-1)!.args[3]), defaultModel)
  await h.dispatch('btwAsk', ['p', 'normal-chat', 'Question', featureModel])
  assert.deepEqual(plain(h.calls.at(-1)!.args[3]), defaultModel)
  h.calls.length = 0
  await assert.rejects(h.dispatch('prompt', ['p', 'translation-1', 'Code', featureModel]), /ANDROID_TRANSLATION_SESSION_REQUIRED/)
  await assert.rejects(h.dispatch('btwAsk', ['p', 'translation-1', 'Code', featureModel]), /ANDROID_TRANSLATION_SESSION_REQUIRED/)
  assert.equal(h.calls.length, 0)
  h.setFeatureAuthorizer(async () => null)
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Continue']), /TRANSLATION_MODEL_UNAVAILABLE/)
  assert.equal((h.calls as Invocation[]).some(call => call.method === 'prompt'), false)
})

test('a translation started on API default stays on that model after the default changes', async () => {
  const h = await harness()
  const original = { id: 'model', modelID: 'server-model', name: 'Original', providerID: 'amecode' }
  const replacement = { id: 'new-default', modelID: 'new-default', name: 'New default', providerID: 'amecode' }
  h.setModels([original, replacement])
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill }))
  await h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate'])
  h.setStatus({ account: { role: 'user' }, models: { default_model: 'new-default', models: [{ id: 'server-model' }, { id: 'new-default' }] } })
  h.setFeatureAuthorizer(async id => id)
  const followup = await h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Continue']) as any
  assert.equal(followup.model.modelID, 'server-model')
  await h.dispatch('prompt', ['p', 'normal-chat', 'Code', original])
  assert.deepEqual(plain(h.calls.at(-1)!.args[3]), replacement)
})

test('translation pins are recovered from owned session metadata after restart rather than current configuration', async () => {
  const h = await harness()
  await h.translationLocks.recordSession('p', 'translation-1')
  h.setSessionModel('gemini-runtime')
  const pinned = { id: 'gemini-runtime', modelID: 'gemini', name: 'Gemini', providerID: 'amecode' }
  h.setModels([{ id: 'model', modelID: 'server-model', name: 'Model', providerID: 'amecode' }, pinned])
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill, model: 'new-config' }))
  h.setFeatureAuthorizer(async id => id)
  const result = await h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Continue']) as any
  assert.deepEqual(plain(result.model), pinned)
  assert.ok(h.calls.some(call => call.method === 'agentMap'))
  h.setProjectDirectory('other', 'another-workspace')
  h.calls.length = 0
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['other', 'translation-1', 'Translate']), /ANDROID_TRANSLATION_SESSION_REQUIRED/)
  await assert.rejects(h.dispatch('androidTranslationLock', ['other', 'translation-1']), /ANDROID_TRANSLATION_SESSION_REQUIRED/)
  assert.deepEqual(h.calls, [])
})

test('translation lock interrupts accepted asynchronous generation and rejects every queued subsequent prompt', async () => {
  const h = await harness()
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill }))
  // Submission resolves without waiting for server-side generation.
  await h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate'])
  const lock = h.dispatch('androidTranslationLock', ['p', 'translation-1'])
  const regular = h.dispatch('prompt', ['p', 'translation-1', 'Code', selectedModel])
  const translation = h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Continue'])
  await lock
  await assert.rejects(regular, /TRANSLATION_SESSION_LOCKED/)
  await assert.rejects(translation, /TRANSLATION_SESSION_LOCKED/)
  assert.deepEqual(plain(h.calls.filter(call => call.method === 'cancel')), [{ method: 'cancel', args: ['p', 'translation-1'] }])
  assert.equal(h.calls.filter(call => call.method === 'prompt').length, 1)
})

test('translation sessions remain durably locked and notify the renderer even if interrupt fails', async () => {
  const h = await harness()
  await h.translationLocks.recordSession('p', 'translation-1')
  h.failInterrupt()
  await assert.rejects(h.dispatch('androidTranslationLock', ['p', 'translation-1']), /INTERRUPT_FAILED/)
  assert.equal(h.translationLocks.isLocked('p', 'translation-1'), true)
  assert.deepEqual(plain(h.calls.at(-1)), { method: 'ame:event', args: [{ type: 'opencode', projectID: 'p', sessionID: 'translation-1' }] })
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Continue']), /TRANSLATION_SESSION_LOCKED/)
  await assert.rejects(h.dispatch('btwAsk', ['p', 'translation-1', 'Continue']), /TRANSLATION_SESSION_LOCKED/)
})

test('Android translation requires verified configuration, rejects main sessions, and falls back to the default model', async () => {
  const h = await harness()
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate']), /ANDROID_TRANSLATION_NOT_CONFIGURED/)
  h.setAndroidTranslationReader(async () => ({ rawSkillName: translationSkill.name, skill: null }))
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate']), /ANDROID_TRANSLATION_NOT_CONFIGURED/)
  h.setAndroidTranslationReader(async () => ({ skill: translationSkill, model: 'inactive' }))
  h.setFeatureAuthorizer(async () => null)
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', 'main-chat', 'Translate']), /ANDROID_TRANSLATION_SESSION_REQUIRED/)
  await assert.rejects(h.dispatch('androidTranslationLock', ['p', 'main-chat']), /ANDROID_TRANSLATION_SESSION_REQUIRED/)
  assert.equal(h.calls.some(call => call.method === 'prompt' || call.method === 'createSession'), false)
  const result = await h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate']) as any
  assert.equal(result.model.modelID, 'server-model')
  h.setSessions([])
  await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Translate']), /SESSION_NOT_FOUND/)
})

test('Android translation IPC validates bounds, modes and extra arguments before any side effect', async () => {
  const h = await harness()
  const invalid: Invocation[] = [
    ...translationExamples.flatMap(({ method, args }) => [[], ['', ...args.slice(1)], ['bad\0id', ...args.slice(1)], [' '.repeat(3), ...args.slice(1)], ['x'.repeat(513), ...args.slice(1)], [...args, 'extra']].map(args => ({ method, args }))),
    ...['', '   ', '\0', 42, 'x'.repeat(200001)].map(value => ({ method: 'androidTranslationPrompt', args: ['p', undefined, value] })),
    ...['', null, 42, 'bad\0id', '  '].flatMap(value => [
      { method: 'androidTranslationPrompt', args: ['p', value, 'Translate'] },
      { method: 'androidTranslationLock', args: ['p', value] }
    ]),
    { method: 'androidTranslationPrompt', args: ['p', undefined, 'Translate', 'invalid'] }
  ]
  for (const { method, args } of invalid) await assert.rejects(h.dispatch(method, args), method)
  assert.deepEqual(h.calls, [])
})

test('translation lock serializes after pending prompts and permanently rejects both translation and normal Chat writes', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.ame-translation-ipc-'))
  try {
    const file = path.join(root, 'translation-locks.json')
    const store = createTranslationLockStore(file); await store.load()
    const h = await harness(); h.useLockStore(store)
    h.setAndroidTranslationReader(async () => ({ skill: translationSkill }))
    let release!: () => void
    h.gateOperation(new Promise<void>(resolve => { release = resolve }))
    const pending = h.dispatch('androidTranslationPrompt', ['p', undefined, 'Translate'])
    await new Promise(resolve => setImmediate(resolve))
    const lock = h.dispatch('androidTranslationLock', ['p', 'translation-1'])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.isLocked('p', 'translation-1'), false)
    release(); await pending
    assert.deepEqual(plain(await lock), { translationSessionIDs: ['translation-1'], lockedSessionIDs: ['translation-1'] })
    h.calls.length = 0
    await assert.rejects(h.dispatch('prompt', ['p', 'translation-1', 'Code now', selectedModel]), /TRANSLATION_SESSION_LOCKED/)
    await assert.rejects(h.dispatch('androidTranslationPrompt', ['p', 'translation-1', 'Translate again']), /TRANSLATION_SESSION_LOCKED/)
    assert.deepEqual(h.calls, [])
    const reloaded = createTranslationLockStore(file); await reloaded.load()
    const restarted = await harness(); restarted.useLockStore(reloaded)
    await assert.rejects(restarted.dispatch('prompt', ['p', 'translation-1', 'Code now', selectedModel]), /TRANSLATION_SESSION_LOCKED/)
    await restarted.dispatch('prompt', ['p', 'main-chat', 'Normal chat', selectedModel])
    assert.equal(reloaded.isLocked('another-project', 'translation-1'), false)
    await restarted.dispatch('androidTranslationLock', ['p', 'translation-1'])
    assert.deepEqual(reloaded.lockedSessionIDs('p'), ['translation-1'])
  } finally { await rm(root, { recursive: true, force: true }) }
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

test('AI commit retains authority while reading a synced skill without an account operation', async () => {
  const h = await harness()
  let release!: (value: { name: string; instructions: string } | null) => void
  const pending = new Promise<{ name: string; instructions: string } | null>(resolve => { release = resolve })
  h.setCommitEnhanceReader(() => pending)
  const generation = h.dispatch('generateCommitMessage', ['p'])
  await new Promise(resolve => setImmediate(resolve))
  const following = h.dispatch('account', ['status', {}])
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary'])
  } finally { release(null) }
  await Promise.all([generation, following])
  assert.deepEqual(h.calls.map(call => call.method), ['models', 'account', 'account', 'stagedDiffSummary', 'generateCommitMessage', 'account'])
})

test('Agent Map reads bypass an authority operation awaiting policy', { timeout: 5000 }, async () => {
  const h = await harness()
  let release!: () => void
  h.gatePolicy(new Promise<void>(resolve => { release = resolve }))
  const generate = h.dispatch('generateCommitMessage', ['p'])
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(await h.dispatch('agentMap', ['p', 's']), 'agentMap')
    assert.deepEqual(plain(h.calls.at(-1)), { method: 'agentMap', args: ['p', 's'] })
    assert.deepEqual(h.messages, [])
  } finally {
    release()
    await generate
  }
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
    { method: 'replaceInProject', args: ['p', options, []] }
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

test('replacement confirmation applies the fixed preview despite new files and revision edits while dialog is open', async t => {
  const root = await mkdtemp(path.join(process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA!, 'Temp', 'opencode') : tmpdir(), 'ame-replace-ipc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'a.txt'), 'cat')
  await writeFile(path.join(root, 'b.txt'), 'cat')
  const h = await harness(root)
  h.setReplacement((_id, options, plan) => replaceInWorkspace(root, options, plan))
  h.onConfirm(async () => {
    await writeFile(path.join(root, 'new.txt'), 'cat')
    await writeFile(path.join(root, 'b.txt'), 'cat edited during confirmation')
  })
  const result = await h.dispatch('replaceInProject', ['p', { query: 'cat', replacement: 'dog' }]) as Awaited<ReturnType<typeof replaceInWorkspace>>
  assert.deepEqual(result.writtenFiles, ['a.txt'])
  assert.deepEqual(result.conflicts, ['b.txt'])
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'cat')
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'cat edited during confirmation')
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'dog')
})

test('commit skips confirmation while pairing, branch deletion and stash drop retain native confirmations', async () => {
  const h = await harness()
  h.cancel()
  await h.dispatch('commit', ['p', 'commit message'])
  assert.deepEqual(h.calls.map(call => call.method), ['commit'])
  assert.deepEqual(h.messages, [])
  const destructive: Invocation[] = [
    { method: 'pairingConfigure', args: [{ enabled: true, keepScreenActive: false }] },
    { method: 'gitDeleteBranch', args: ['p', 'feature/test', true] },
    { method: 'gitStashDrop', args: ['p', 2] }
  ]
  for (const { method, args } of destructive) {
    h.calls.length = 0
    await assert.rejects(h.dispatch(method, args), /CANCELLED/)
    assert.deepEqual(h.calls.map(call => call.method), ['confirm'])
  }
  assert.deepEqual(h.messages.slice(-2), ['Xóa nhánh feature/test?', 'Xóa stash@{2}? Hành động này không thể hoàn tác.'])
  h.approve()
  for (const { method, args } of destructive) {
    h.calls.length = 0
    await h.dispatch(method, args)
    assert.deepEqual(h.calls.map(call => call.method), ['confirm', method === 'pairingConfigure' ? 'configurePairing' : method])
    assert.deepEqual(plain(h.calls.at(-1)!.args), args)
  }
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

test('dropped paths and native picker resolve against the registered workspace and preserve cancellation', async () => {
  const h = await harness('C:\\workspace')
  const paths = ['C:\\workspace\\src\\app.ts', 'C:\\images\\shot.png']
  assert.equal(await h.dispatch('resolveDroppedPaths', ['p', paths]), h.resolved)
  assert.deepEqual(plain(h.calls.pop()), { method: 'resolveDroppedPaths', args: ['C:\\workspace', paths] })
  assert.deepEqual(plain(await h.dispatch('pickAttachmentFiles', ['p'])), [])
  assert.equal(h.calls.at(-1)!.method, 'showOpenDialog')
  h.setPicked({ canceled: false, filePaths: [] })
  assert.deepEqual(plain(await h.dispatch('pickAttachmentFiles', ['p'])), [])
  h.setPicked({ canceled: false, filePaths: paths })
  assert.equal(await h.dispatch('pickAttachmentFiles', ['p']), h.resolved)
  assert.deepEqual(plain(h.calls.pop()), { method: 'resolveDroppedPaths', args: ['C:\\workspace', paths] })
  const options = h.calls.at(-1)!.args[0] as any
  assert.deepEqual(Array.from(options.properties), ['openFile', 'multiSelections'])
  assert.ok(options.filters[0].extensions.includes('png'))
  h.calls.length = 0
  await assert.rejects(h.dispatch('resolveDroppedPaths', ['unknown', paths]), /UNKNOWN_PROJECT/)
  await assert.rejects(h.dispatch('pickAttachmentFiles', ['unknown']), /UNKNOWN_PROJECT/)
  for (const args of [['p', Array(33).fill('x')], ['p', ['x'.repeat(4097)]], ['\0', paths]]) await assert.rejects(h.dispatch('resolveDroppedPaths', args))
  assert.equal(h.calls.length, 0)
})

test('prompt IPC forwards bounded file parts and rejects malformed parts before invoking the adapter', async () => {
  const h = await harness()
  const file = { uri: 'data:image/png;base64,YQ==', name: 'shot.png', mime: 'image/png', source: { type: 'inline' } }
  const files = [file, { uri: 'file:///C:/notes.txt', source: { type: 'uri', uri: 'file:///C:/notes.txt' } }]
  await h.dispatch('prompt', ['p', 's', '', selectedModel, 'agent', files])
  assert.deepEqual(plain(h.calls.at(-1)), { method: 'prompt', args: ['p', 's', '', { ...selectedModel, modelID: 'server-model' }, 'agent', files] })
  await h.dispatch('prompt', ['p', 's', '', selectedModel, undefined, Array(8).fill(file)])
  h.calls.length = 0
  for (const invalid of [
    Array(9).fill(file), [{ ...file, uri: 'data:image/png;base64,' + 'A'.repeat(15 * 1024 * 1024) }],
    [{ ...file, uri: file.uri + '\0' }], [{ ...file, name: 'bad\0.png' }], [{ ...file, mime: 'image/\0png' }],
    [{ ...file, name: 'x'.repeat(256) }], [{ ...file, mime: 'x'.repeat(121) }],
    [{ ...file, uri: 'https://example.com/image.png' }], [{ ...file, uri: 'data:image/png;base64,Y Q==' }],
    [{ ...file, extra: true }], [{ ...file, source: { type: 'inline', extra: true } }],
    [{ ...file, source: { type: 'uri', uri: 'bad\0' } }], [{ ...file, source: { type: 'uri', uri: 'x'.repeat(4097) } }],
  ]) await assert.rejects(h.dispatch('prompt', ['p', 's', '', selectedModel, undefined, invalid]))
  assert.equal(h.calls.length, 0)
  await h.translationLocks.recordSession('p', 'translation')
  await assert.rejects(h.dispatch('prompt', ['p', 'translation', '', selectedModel, undefined, [file]]), /TRANSLATION/)
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
        webUtils: { getPathForFile: (file: { path?: string }) => file.path ?? '' },
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
  for (const { method, args } of [...examples, ...nativeExamples, ...smartExamples, ...translationExamples, ...buildNotesExamples,
    { method: 'confirmProjectRemoval', args: ['p', ['visible.txt', 'hidden.txt']] },
    { method: 'removeProject', args: ['p'] },
    { method: 'removeProject', args: ['p', randomUUID()] },
    { method: 'resolveDroppedPaths', args: ['p', ['C:\\images\\shot.png']] },
    { method: 'pickAttachmentFiles', args: ['p'] },
    { method: 'prompt', args: ['p', 's', '', selectedModel, undefined, [{ uri: 'data:image/png;base64,YQ==', name: 'shot.png', source: { type: 'inline' } }]] }
  ]) {
    assert.equal(await methods[method](...args), result)
    assert.deepEqual(calls.pop(), { method, args })
    rejected = true
    await assert.rejects(methods[method](...args), /CANCELLED/)
    calls.length = 0; rejected = false
  }
  assert.equal(api.filePath({ path: 'C:\\images\\shot.png' } as unknown as File), 'C:\\images\\shot.png')
  assert.equal(api.filePath({} as File), '')
  assert.equal(api.filePath(null as unknown as File), '')
  await api.prompt('p', 's', 'text')
  assert.deepEqual(calls.pop(), { method: 'prompt', args: ['p', 's', 'text', undefined, undefined, undefined] })
  await api.createFile('p', 'empty.txt')
  assert.deepEqual(calls.pop(), { method: 'createFile', args: ['p', 'empty.txt', undefined] })
  await api.createBranch('p', 'feature')
  assert.deepEqual(calls.pop(), { method: 'createBranch', args: ['p', 'feature', undefined] })
  await api.generateCommitMessage('p')
  assert.deepEqual(calls.pop(), { method: 'generateCommitMessage', args: ['p', undefined] })
  await api.androidTranslationPrompt('p', undefined, 'Translate strings')
  assert.deepEqual(calls.pop(), { method: 'androidTranslationPrompt', args: ['p', undefined, 'Translate strings', undefined] })
  await api.artifacts('p')
  assert.deepEqual(calls.pop(), { method: 'artifacts', args: ['p', undefined] })
  await api.btwAsk('p', 's', 'question')
  assert.deepEqual(calls.pop(), { method: 'btwAsk', args: ['p', 's', 'question', undefined] })
  await api.petGenerateDialogue()
  assert.deepEqual(calls.pop(), { method: 'petGenerateDialogue', args: [undefined] })
  await api.lspUpdateDocument('p', 'app.ts', '')
  assert.deepEqual(calls.pop(), { method: 'lspUpdateDocument', args: ['p', 'app.ts', '', undefined] })
  await api.lspDiagnostics('p')
  assert.deepEqual(calls.pop(), { method: 'lspDiagnostics', args: ['p', undefined] })
  await api.debugEvaluate('p', '1 + 1')
  assert.deepEqual(calls.pop(), { method: 'debugEvaluate', args: ['p', '1 + 1', undefined] })
})
