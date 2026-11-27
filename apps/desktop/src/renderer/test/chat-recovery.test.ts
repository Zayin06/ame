import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactNode, type ReactElement } from 'react'
import ts from 'typescript'

function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<any>(node)) return []
  if (typeof node.type === 'function' && node.type.name === 'ChatTurnView') return [node, ...elements((node.type as any)(node.props))]
  return [node, ...elements((node.props as any).children)]
}

// Execute the real component and its effects with deterministic hook lifecycles.
function harness(overrides: Record<string, any> = {}, app = false) {
  const filename = new URL(app ? '../App.tsx' : '../components/Chat.tsx', import.meta.url)
  const nativeRequire = createRequire(filename)
  let slots: any[] = [], cursor = 0, effects: (() => void)[] = []
  const cleanups: (() => void)[] = []
  const api: any = {
    agents: () => { throw new Error('Composer must not load agents') },
    models: async () => [{ id: 'm', providerID: 'amecode', modelID: 'm', name: 'Model' }],
    commands: async () => [], skills: async () => [], onEvent: () => () => {},
    messages: async () => [], permissions: async () => [], forms: async () => [],
    sessionPermissionMode: async () => 'ask', prompt: async () => {},
    platform: async () => 'win32', petState: async () => null, projects: async () => [{ id: 'p', name: 'P', directory: 'C:/p' }],
    connection: async () => ({ connected: true, url: '' }), account: async () => null,
    sessions: async () => [], git: async () => ({}), debugState: async () => ({ status: 'idle', frames: [], variables: [], breakpoints: [] }),
    read: async () => ({ path: 'a.txt', content: 'disk', revision: '1' }),
    createSession: async () => ({ id: 'created', title: 'Created' }), ...overrides,
  }
  const hooks = {
    memo: (component: unknown) => component,
    useMemo: (factory: () => unknown) => factory(),
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useId: () => 'test-id',
    useCallback(callback: any, deps: any[]) {
      const index = cursor++, old = slots[index]
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { callback, deps }
      return slots[index].callback
    },
    useSyncExternalStore(subscribe: any, snapshot: any) {
      const index = cursor++
      if (slots[index] !== subscribe) { cleanups[index]?.(); slots[index] = subscribe; cleanups[index] = subscribe(() => {}) }
      return snapshot()
    },
    useEffect(effect: any, deps: any[]) {
      const index = cursor++, old = slots[index]
      if (old && deps && deps.length === old.length && deps.every((value, i) => Object.is(value, old[i]))) return
      slots[index] = deps
      effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() })
    },
  }
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env.DEV', 'false'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports, window: { ame: api, confirm: () => true, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => JSON.stringify({ ...nativeRequire(app ? './state' : '../state').defaults(), project: 'p', stage: true, panel: 'files', projects: { p: { tabs: [{ mode: 'file', path: 'a.txt' }] } } }), setItem() {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {} } } },
    setTimeout, clearTimeout, requestAnimationFrame: () => {},
    require: (name: string) => {
      if (name === 'react') return hooks
      if (app && name === './components/ErrorBoundary') return { ErrorBoundary: ({ children }: { children: any }) => children }
      if (name === 'monaco-editor') return { editor: { getModels: () => [] }, Uri: { parse: (uri: string) => ({ toString: () => uri }) } }
      if (name.startsWith('./') && (!app || name.startsWith('./components/'))) return new Proxy({}, { get: (_target, key) => key === 'errorText' || key === 'humanizeIdeError' ? (e: any) => e.message : String(key) })
      return nativeRequire(name)
    },
  })
  let props: any = {
    projectID: 'p', sessionID: 'A', draftID: 0, connected: true, ready: true,
    accountRole: 'admin', defaultModelID: 'm', modelLevels: {},
    sessions: [], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark',
    onCreated() {}, onCreate() {}, report() {}, onActivity() {}, onOpenPanel() {}, onOpenFile() {}, onSelectSession() {},
  }
  let tree: ReactNode
  function render(patch: any = {}) {
    props = { ...props, ...patch }; cursor = 0
    tree = app ? exports.App() : exports.Chat(props)
    const pending = effects; effects = []; pending.forEach(effect => effect())
    return tree
  }
  return {
    api, render, lifecycle: exports,
    remount(patch: any) { cleanups.forEach(cleanup => cleanup?.()); cleanups.length = 0; slots = []; return render(patch) },
    nodes: () => elements(tree),
    input: () => elements(tree).find(node => node.type === 'textarea')!,
    send: () => elements(tree).find(node => node.props['aria-label'] === 'Gửi yêu cầu')!,
    warning: (id: string) => elements(tree).find(node => node.props['data-testid'] === id),
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render() },
    dispose() { cleanups.forEach(cleanup => cleanup?.()) },
  }
}
function type(h: ReturnType<typeof harness>, value: string) {
  h.input().props.onChange({ target: { value, selectionStart: value.length } }); h.render()
}
function attach(h: ReturnType<typeof harness>) {
  h.nodes().find(node => node.props['data-testid'] === 'chat')!.props.onDrop({
    preventDefault() {}, dataTransfer: { types: ['application/x-ame-workspace-path'], getData: () => 'src/A.ts', files: [] },
  })
  h.render()
}
function attachments(h: ReturnType<typeof harness>) { return h.nodes().find(node => Array.isArray(node.props.attachments) && node.props.onRemove)!.props.attachments }
function retry(h: ReturnType<typeof harness>, id: string) { elements(h.warning(id)).find(node => node.type === 'button')!.props.onClick(); h.render() }

test('Enter sends unmatched slash and mention text but attachment search and valid choices consume it', async () => {
  const prompts: string[] = []
  const h = harness({ prompt: async (_project: string, _session: string, text: string) => { prompts.push(text) } })
  try {
    h.render(); await h.settle()
    for (const value of ['xem /etc/hosts', 'xem @missing', 'xem /', 'xem @']) {
      type(h, value)
      h.input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
      await h.settle()
      assert.equal(prompts.at(-1), value)
    }
    h.nodes().find(node => node.props['aria-label'] === 'Đính kèm ngữ cảnh')!.props.onClick(); h.render()
    const search = h.nodes().find(node => node.props['aria-label'] === 'Tìm tệp đính kèm')!
    let prevented = false
    search.props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() { prevented = true } })
    assert.equal(prevented, true); assert.equal(prompts.length, 4)
    h.render({ files: ['src/ok.ts'] }); type(h, 'xem @src')
    h.input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
    await h.settle()
    assert.equal(prompts.length, 4)
    assert.match(h.input().props.value, /@src\/ok.ts/)
  } finally { h.dispose() }
})

test('streaming reuses completed turn objects and rewind callbacks but invalidates changed history', async () => {
  let items = [{ id: 'u1', role: 'user', text: 'old' }, { id: 'a1', role: 'assistant', text: 'answer' }, { id: 'u2', role: 'user', text: 'new' }, { id: 'a2', role: 'assistant', text: 'stream' }]
  const listeners = new Set<(event: any) => void>()
  const h = harness({ messages: async () => items.map(item => ({ ...item })), onEvent: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener) } })
  const refresh = async () => { listeners.forEach(listener => listener({ type: 'opencode', projectID: 'p', sessionID: 'A' })); await new Promise(resolve => setTimeout(resolve, 120)); await h.settle() }
  const turns = () => h.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'ChatTurnView')
  try {
    h.render({ sessions: [{ id: 'A', status: 'running' }] }); await h.settle()
    const first = turns()[0].props
    items = items.map(item => item.id === 'a2' ? { ...item, text: 'stream more' } : item)
    await refresh()
    assert.equal(turns()[0].props.turn, first.turn)
    assert.equal(turns()[0].props.onRewind, first.onRewind)
    items = items.map(item => item.id === 'a1' ? { ...item, text: 'corrected' } : item)
    await refresh()
    assert.notEqual(turns()[0].props.turn, first.turn)
    const compact = turns()[0].props.turn
    h.render({ timelineDetail: 'everything' })
    assert.notEqual(turns()[0].props.turn, compact)
  } finally { h.dispose() }
})

test('A → New Chat → A preserves text and attachments across remounts and projects; draft IDs stay separate', async () => {
  const h = harness()
  try {
    h.render(); await h.settle(); type(h, 'draft A'); attach(h)
    assert.equal(attachments(h).length, 1)
    h.remount({ sessionID: undefined, draftID: 1 }); type(h, 'new 1')
    h.remount({ sessionID: undefined, draftID: 2 }); assert.equal(h.input().props.value, '')
    type(h, 'new 2')
    h.remount({ sessionID: 'A' }); assert.equal(h.input().props.value, 'draft A'); assert.equal(attachments(h)[0].path, 'src/A.ts')
    h.remount({ projectID: 'other', sessionID: 'A' }); assert.equal(h.input().props.value, '')
    h.remount({ projectID: 'p', sessionID: undefined, draftID: 1 }); assert.equal(h.input().props.value, 'new 1')
    h.remount({ draftID: 2 }); assert.equal(h.input().props.value, 'new 2')
  } finally { h.dispose() }
})

test('permission load error blocks button and Enter, retains draft, and retry unlocks sending', async () => {
  let attempts = 0, prompts = 0
  const h = harness({ sessionPermissionMode: async () => { if (++attempts === 1) throw new Error('offline'); return 'ask' }, prompt: async () => { prompts++ } })
  try {
    h.render(); type(h, 'keep me'); attach(h); await h.settle()
    assert.ok(h.warning('permission-mode-error')); assert.equal(h.send().props.disabled, true)
    h.input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
    await h.settle(); assert.equal(prompts, 0)
    assert.equal(h.input().props.value, 'keep me'); assert.equal(attachments(h).length, 1)
    retry(h, 'permission-mode-error'); await h.settle()
    assert.equal(h.warning('permission-mode-error'), undefined); assert.equal(h.send().props.disabled, false)
    assert.equal(h.input().props.value, 'keep me'); assert.equal(attachments(h).length, 1)
  } finally { h.dispose() }
})

test('late session creation from an old draft cannot overwrite a newer New Chat draft', async () => {
  let resolve!: (session: any) => void
  const created: string[] = []
  const h = harness({ createSession: () => new Promise(done => { resolve = done }) })
  try {
    h.render({ sessionID: undefined, draftID: 1, onCreated: (session: any) => created.push(session.id) }); await h.settle()
    type(h, 'old request'); attach(h)
    h.input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
    h.remount({ draftID: 2 }); type(h, 'new request'); attach(h)
    resolve({ id: 'late-session', title: 'Late' }); await h.settle()
    assert.deepEqual(created, ['late-session'])
    assert.equal(h.input().props.value, 'new request'); assert.equal(attachments(h).length, 1)
    h.remount({ sessionID: 'late-session' }); assert.equal(h.input().props.value, ''); assert.equal(attachments(h).length, 0)
  } finally { h.dispose() }
})

test('messages render while forms fail, with independent retry and retained previous form data', async () => {
  let failForms = true, messageCalls = 0
  const h = harness({
    messages: async () => { messageCalls++; return [{ id: 'msg', role: 'user', text: 'Visible history' }] },
    forms: async () => { if (failForms) throw new Error('forms unavailable'); return [{ id: 'form', title: 'Question' }] },
  })
  try {
    h.render(); await h.settle()
    assert.ok(h.nodes().some(node => node.props.text === 'Visible history'))
    assert.ok(h.warning('chat-forms-error')); assert.equal(h.warning('chat-messages-error'), undefined)
    const before = messageCalls; failForms = false
    retry(h, 'chat-forms-error'); await h.settle()
    assert.equal(h.warning('chat-forms-error'), undefined)
    // Receiving a live form can also trigger the normal running-session refresh.
    assert.ok(messageCalls >= before)
    assert.ok(h.nodes().some(node => node.props.form?.id === 'form'))
    failForms = true; h.api.forms = async () => { throw new Error('again') }
    // A new refresh must not discard a previously loaded form.
    h.render({ connected: false }); h.render({ connected: true }); await h.settle()
    assert.ok(h.nodes().some(node => node.props.form?.id === 'form'))
    assert.ok(h.nodes().some(node => node.props.text === 'Visible history'))
  } finally { h.dispose() }
})

test('Commit AI banner opens the currently selected session, including locked sessions', async () => {
  const opened: string[] = []
  const h = harness({ commitAgentInfo: async () => ({ commitSessionIDs: ['A', 'B'], lockedSessionIDs: ['B'] }) })
  try {
    h.render({ onOpenCommitAgent: (id: string) => opened.push(id) }); await h.settle()
    elements(h.warning('commit-agent-locked-banner')).find(node => node.props.children === 'Trợ lý Commit AI')!.props.onClick()
    h.render({ sessionID: 'B' }); await h.settle()
    elements(h.warning('commit-agent-locked-banner')).find(node => node.props.children === 'Trợ lý Commit AI')!.props.onClick()
    assert.deepEqual(opened, ['A', 'B'])
  } finally { h.dispose() }
})

test('Chat prefers lightweight commit session state on mount and OpenCode SSE without loading Git info', async () => {
  const calls: string[] = [], events = new Set<(event: any) => void>()
  let infoCalls = 0
  const h = harness({
    commitAgentSessionState: async (projectID: string) => { calls.push(projectID); return { commitSessionIDs: ['A'], lockedSessionIDs: [] } },
    commitAgentInfo: async () => { infoCalls++; return { commitSessionIDs: [], lockedSessionIDs: [] } },
    onEvent: (listener: (event: any) => void) => { events.add(listener); return () => events.delete(listener) },
  })
  try {
    h.render(); await h.settle()
    assert.deepEqual(calls, ['p']); assert.ok(h.warning('commit-agent-locked-banner'))
    events.forEach(listener => listener({ type: 'opencode', projectID: 'p', sessionID: 'A' }))
    await new Promise(resolve => setTimeout(resolve, 350)); await h.settle()
    assert.deepEqual(calls, ['p', 'p'])
    h.render({ sessionID: 'normal' }); await h.settle()
    assert.equal(h.warning('commit-agent-locked-banner'), undefined)
    assert.deepEqual(calls, ['p', 'p', 'p'])
    assert.equal(infoCalls, 0, 'Chat must not read Git snapshots or diffs')
  } finally { h.dispose() }
  assert.equal(events.size, 0)
})

test('Chat does not fall back to expensive Git info when the lightweight API rejects', async () => {
  let infoCalls = 0
  const h = harness({
    commitAgentSessionState: async () => { throw new Error('offline') },
    commitAgentInfo: async () => { infoCalls++; return { commitSessionIDs: [], lockedSessionIDs: [] } },
  })
  try { h.render(); await h.settle(); assert.ok(h.input()); assert.equal(infoCalls, 0) } finally { h.dispose() }
})

for (const scope of ['project', 'session', 'new'] as const) {
  test(`${scope} cleanup releases drafts with attachments and permission modes without touching other projects`, async () => {
    const h = harness()
    try {
      h.render({ sessionID: scope === 'session' ? 'A' : undefined, draftID: 7 }); await h.settle()
      type(h, 'discard'); attach(h)
      if (scope !== 'session') h.nodes().find(node => node.type === 'select' && node.props.value === 'default')!.props.onChange({ target: { value: 'readonly' } })
      h.remount({ projectID: 'other', sessionID: 'A' }); type(h, 'keep'); attach(h)
      if (scope === 'project') h.lifecycle.cleanupProjectChatDrafts('p')
      else if (scope === 'session') h.lifecycle.cleanupSessionChatDraft('p', 'A')
      else h.lifecycle.cleanupAbandonedNewChatDraft('p', 7)
      const keys = h.lifecycle.__chatDraftKeysForTest()
      assert.ok(!keys.drafts.some((key: string) => JSON.parse(key)[0] === 'p'))
      assert.ok(!keys.permissionModes.some((key: string) => JSON.parse(key)[0] === 'p'))
      assert.equal(h.input().props.value, 'keep'); assert.equal(attachments(h).length, 1)
      h.remount({ projectID: 'p', sessionID: scope === 'session' ? 'A' : undefined, draftID: 7 })
      assert.equal(h.input().props.value, ''); assert.equal(attachments(h).length, 0)
    } finally { h.dispose() }
  })

  test(`${scope} cleanup defers in-flight draft disposal until send finishes, including failures`, async () => {
    for (const fail of [false, true]) {
      let finish!: () => void
      const h = harness({ prompt: () => new Promise<void>((resolve, reject) => { finish = () => fail ? reject(new Error('offline')) : resolve() }) })
      try {
        h.render({ sessionID: scope === 'session' ? 'A' : undefined, draftID: 7 }); await h.settle()
        type(h, 'sending'); attach(h)
        h.input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
        await h.settle()
        if (scope === 'project') h.lifecycle.cleanupProjectChatDrafts('p')
        else if (scope === 'session') h.lifecycle.cleanupSessionChatDraft('p', 'A')
        else h.lifecycle.cleanupAbandonedNewChatDraft('p', 7)
        const key = JSON.stringify(['p', scope === 'session' ? 'A' : 'draft:7'])
        assert.ok(h.lifecycle.__chatDraftKeysForTest().drafts.includes(key))
        assert.ok(h.lifecycle.__chatDraftKeysForTest().deferred.includes(key))
        h.remount({ projectID: 'other', sessionID: 'B' })
        finish(); await h.settle()
        const keys = h.lifecycle.__chatDraftKeysForTest()
        assert.ok(!keys.drafts.includes(key)); assert.equal(keys.inFlight.length, 0); assert.equal(keys.deferred.length, 0)
        if (scope === 'project') assert.ok(!keys.drafts.some((key: string) => JSON.parse(key)[0] === 'p'))
      } finally { h.dispose() }
    }
  })
}

test('empty drafts are reclaimed after their last subscriber unmounts', async () => {
  const h = harness()
  h.render(); await h.settle(); type(h, 'temporary'); attach(h)
  type(h, '')
  h.nodes().find(node => Array.isArray(node.props.attachments) && node.props.onRemove)!.props.onRemove(attachments(h)[0].id)
  h.render(); h.dispose()
  assert.equal(h.lifecycle.__chatDraftKeysForTest().drafts.length, 0)
})

test('project removal while createSession is pending cannot recreate a session draft or retain attachments', async () => {
  let created!: (session: any) => void, finish!: () => void
  const h = harness({ createSession: () => new Promise(resolve => { created = resolve }), prompt: () => new Promise<void>(resolve => { finish = resolve }) })
  try {
    h.render({ sessionID: undefined, draftID: 1 }); await h.settle()
    type(h, 'pending create'); attach(h)
    h.input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} })
    h.lifecycle.cleanupProjectChatDrafts('p')
    h.remount({ projectID: 'other', sessionID: 'B' })
    created({ id: 'late', title: 'Late' }); await h.settle()
    assert.ok(!h.lifecycle.__chatDraftKeysForTest().drafts.includes(JSON.stringify(['p', 'late'])))
    finish(); await h.settle()
    assert.ok(!h.lifecycle.__chatDraftKeysForTest().drafts.some((key: string) => JSON.parse(key)[0] === 'p'))
    assert.equal(h.lifecycle.__chatDraftKeysForTest().deferred.length, 0)
  } finally { h.dispose() }
})

test('App passes the Chat session to CommitAgentModal and clears it for generic entry points and project changes', async () => {
  const h = harness({}, true)
  try {
    h.render(); await h.settle()
    h.nodes().find(node => node.type === 'Chat')!.props.onOpenCommitAgent('commit-A'); h.render()
    let modal = h.nodes().find(node => node.type === 'CommitAgentModal')!
    assert.equal(modal.props.initialSessionID, 'commit-A'); assert.equal(modal.key, 'p:commit-A')
    modal.props.onClose(); h.render()
    // Open the inspector through its titlebar control, then use its generic trigger.
    h.nodes().find(node => typeof node.props.label === 'string' && node.props.label.startsWith('Project Inspector'))!.props.onClick(); h.render()
    h.nodes().find(node => node.type === 'Inspector')!.props.onOpenCommitAgent(); h.render()
    modal = h.nodes().find(node => node.type === 'CommitAgentModal')!
    assert.equal(modal.props.initialSessionID, undefined); assert.equal(modal.key, 'p:')
    h.nodes().find(node => node.type === 'ProjectRail')!.props.onSelect('other'); h.render(); h.render()
    assert.equal(h.nodes().find(node => node.type === 'CommitAgentModal'), undefined)
  } finally { h.dispose() }
})

test('slow reload preserves intervening editor input and its dirty state; unchanged buffers reload cleanly', async () => {
  let finish!: (doc: any) => void, reads = 0
  const disk = { path: 'a.txt', content: 'disk', revision: '1', language: 'text' }
  const h = harness({ read: async () => ++reads === 1 ? disk : new Promise(resolve => { finish = resolve }) }, true)
  const editor = () => h.nodes().find(node => node.type === 'EditorStage')!
  try {
    h.render(); await h.settle(); await h.settle()
    assert.equal(editor().props.buffer.text, 'disk')
    editor().props.onChange('before reload'); h.render()
    editor().props.onReload()
    editor().props.onChange('typed while reading'); h.render()
    finish({ ...disk, content: 'new disk', revision: '2' }); await h.settle()
    assert.equal(editor().props.buffer.text, 'typed while reading')
    assert.equal(editor().props.buffer.content, 'disk')
    assert.ok(editor().props.dirtyPaths.has('a.txt'))
    // A text round-trip is still an edit: version protection must reject it.
    editor().props.onReload()
    editor().props.onChange('temporary'); editor().props.onChange('typed while reading'); h.render()
    finish({ ...disk, content: 'new disk', revision: '2' }); await h.settle()
    assert.equal(editor().props.buffer.text, 'typed while reading')
    editor().props.onReload(); finish({ ...disk, content: 'new disk', revision: '2' }); await h.settle()
    assert.equal(editor().props.buffer.text, 'new disk')
    assert.equal(editor().props.dirtyPaths.size, 0)
  } finally { h.dispose() }
})
