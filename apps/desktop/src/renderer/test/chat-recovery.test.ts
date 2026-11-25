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
  return [node, ...elements((node.props as any).children)]
}

// Execute the real component and its effects with deterministic hook lifecycles.
function harness(overrides: Record<string, any> = {}) {
  const filename = new URL('../components/Chat.tsx', import.meta.url)
  const nativeRequire = createRequire(filename)
  let slots: any[] = [], cursor = 0, effects: (() => void)[] = []
  const cleanups: (() => void)[] = []
  const api: any = {
    agents: () => { throw new Error('Composer must not load agents') },
    models: async () => [{ id: 'm', providerID: 'amecode', modelID: 'm', name: 'Model' }],
    commands: async () => [], skills: async () => [], onEvent: () => () => {},
    messages: async () => [], permissions: async () => [], forms: async () => [],
    sessionPermissionMode: async () => 'ask', prompt: async () => {},
    createSession: async () => ({ id: 'created', title: 'Created' }), ...overrides,
  }
  const hooks = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useId: () => 'test-id',
    useSyncExternalStore(_subscribe: any, snapshot: any) { return snapshot() },
    useEffect(effect: any, deps: any[]) {
      const index = cursor++, old = slots[index]
      if (old && deps && deps.length === old.length && deps.every((value, i) => Object.is(value, old[i]))) return
      slots[index] = deps
      effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() })
    },
  }
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports, window: { ame: api, addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout, requestAnimationFrame: () => {},
    require: (name: string) => {
      if (name === 'react') return hooks
      if (name.startsWith('./')) return new Proxy({}, { get: (_target, key) => key === 'errorText' ? (e: any) => e.message : () => null })
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
    tree = exports.Chat(props)
    const pending = effects; effects = []; pending.forEach(effect => effect())
    return tree
  }
  return {
    api, render,
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
