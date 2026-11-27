import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { ChatItem, Session, SessionDiff } from '../../../../../packages/protocol/src/index'
import { describeRevertSummary, formatRevertError, partitionRevertedMessages, type RevertState } from '../chat-rewind'

const user = (id: string, text = id): ChatItem => ({ id, role: 'user', text })
const file: SessionDiff = { file: 'src/example.ts', patch: '', status: 'modified', additions: 3, deletions: 2 }
const items = [user('old'), { id: 'answer', role: 'assistant', text: 'Old answer' } as ChatItem, user('target', 'Original prompt'), user('later')]

test('partition preserves input, handles absent/missing targets and exact, part-prefix and execution IDs', () => {
  for (const revert of [undefined, { messageID: '' }, { messageID: 'missing' }]) {
    const result = partitionRevertedMessages(items, revert)
    assert.deepEqual(result, { active: items, reverted: [], revertedTurnCount: 0 })
    assert.notEqual(result.active, items)
  }
  const result = partitionRevertedMessages(items, { messageID: 'target' })
  assert.deepEqual(result.active, items.slice(0, 2)); assert.deepEqual(result.reverted, items.slice(2))
  assert.equal(result.revertedTurnCount, 2); assert.equal(result.targetPromptText, 'Original prompt')
  for (const target of [{ ...user('target:part'), text: 'Part prompt' }, { ...user('different'), executionID: 'target', text: 'Part prompt' }]) {
    assert.equal(partitionRevertedMessages([user('before'), target], { messageID: 'target' }).targetPromptText, 'Part prompt')
  }
  assert.equal(partitionRevertedMessages([{ id: 'target:tool', role: 'assistant', text: '' }], { messageID: 'target' }).targetPromptText, undefined)
  assert.equal(items.length, 4)
})

test('summary distinguishes restored, unavailable, unchanged and chat-only files honestly', () => {
  const restored = describeRevertSummary({ messageID: 'target', files: [file, { ...file, file: 'two' }] }, false)
  assert.equal(restored.mode, 'files-restored'); assert.equal(restored.totalAdditions, 6); assert.equal(restored.totalDeletions, 4)
  assert.match(restored.headline, /2 tệp/)
  assert.equal(describeRevertSummary({ messageID: 'target' }, true).mode, 'files-unavailable')
  assert.match(describeRevertSummary({ messageID: 'target' }, true).detail, /không có Git/)
  assert.equal(describeRevertSummary({ messageID: 'target', snapshot: 'snapshot' }, true).mode, 'files-unchanged')
  for (const requested of [false, undefined]) assert.equal(describeRevertSummary({ messageID: 'target' }, requested).mode, 'chat-only')
})

test('backend error codes and ordinary errors have actionable Vietnamese messages', () => {
  for (const code of ['SESSION_BUSY', 'Session is busy', 'REVERT_CHILD_UNSUPPORTED', 'TRANSLATION_SESSION_LOCKED', 'ANDROID_TRANSLATION_SESSION_REQUIRED', 'COMMIT_AGENT_LOCKED', 'OPENCODE_DISCONNECTED', 'SESSION_PROJECT_MISMATCH']) {
    assert.notEqual(formatRevertError(new Error(code)), code)
    assert.equal(formatRevertError({ code }), formatRevertError(new Error(code)))
  }
  assert.equal(formatRevertError(new Error('network failed')), 'network failed')
  assert.equal(formatRevertError('failure'), 'failure')
  assert.equal(formatRevertError(null), 'Không thể thực hiện quay lui.')
})

function harness(options: { revert?: RevertState; parentID?: string; locked?: 'translation' | 'commit'; running?: boolean } = {}) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode
  let session: Session & { revert?: RevertState } = { id: 'session', title: 'Chat', status: options.running ? 'running' : 'idle', parentID: options.parentID, revert: options.revert }
  let delay: Promise<unknown> | undefined, failure: unknown, promptFailure: unknown
  const calls: { method: string; args: unknown[] }[] = []
  const hooks = {
    memo: (component: unknown) => component,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (fn: unknown) => fn,
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next: unknown) => { const value = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(value, slots[index])) { slots[index] = value; writes++ } }] },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useId() { return `id-${cursor++}` },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot() },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) { const index = effectIndex++, old = effects[index]; if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } }) },
  }
  const api = {
    async stageRevert(...args: unknown[]) { calls.push({ method: 'stageRevert', args }); await delay; if (failure) throw failure; session = { ...session, revert: { messageID: String(args[2]) } } },
    async clearRevert(...args: unknown[]) { calls.push({ method: 'clearRevert', args }); await delay; if (failure) throw failure; session = { ...session, revert: undefined } },
    async prompt(...args: unknown[]) { calls.push({ method: 'prompt', args }); if (promptFailure) throw promptFailure; session = { ...session, revert: undefined } },
    async messages() { return items }, async permissions() { return [] }, async forms() { return [] },
    async sessionPermissionMode() { return 'default' }, async models() { return [{ id: 'default', providerID: 'amecode', name: 'Default' }] },
    async commands() { return [] }, async skills() { return [] }, onEvent() { return () => {} },
    async androidTranslationInfo() { return { lockedSessionIDs: options.locked === 'translation' ? ['session'] : [], translationSessionIDs: [] } },
    async commitAgentSessionState() { return { lockedSessionIDs: options.locked === 'commit' ? ['session'] : [], commitSessionIDs: [] } },
  }
  const marker = () => null, nativeRequire = createRequire(import.meta.url), exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync(new URL('../components/Chat.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, Error, setTimeout, clearTimeout, window: { ame: api, addEventListener() {}, removeEventListener() {} }, require(name: string) {
    if (name === 'react') return hooks
    if (name === '../chat-refresh') return { createChatRefresh: (load: () => Promise<void>) => ({ request() { void load() }, dispose() {} }) }
    if (name.startsWith('./')) return new Proxy({}, { get: (_, key) => key === 'errorText' ? String : marker })
    return nativeRequire(name)
  } })
  const Component = exports.Chat as (props: object) => ReactNode
  const props = { projectID: 'project', sessionID: 'session', connected: true, ready: true, accountRole: 'user', defaultModelID: 'default', modelLevels: {}, sessions: [session], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark', onActivity() {}, onOpenFile(path: string) { calls.push({ method: 'openFile', args: [path] }) }, onCreated() {}, onCreate() {}, report() {}, onOpenPanel() {}, onSelectSession() {} }
  function render(extra = {}) {
    Object.assign(props, { sessions: [session] }, extra)
    for (let pass = 0; pass < 15; pass++) { const before = writes; cursor = 0; effectIndex = 0; tree = Component(props); pending.splice(0).forEach(run => run()); if (writes === before) return renderToStaticMarkup(tree) }
    throw new Error('Effects did not settle')
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    if (typeof node.type === 'function' && node.type.name === 'ChatTurnView') return [node, ...all((node.type as any)(node.props))]
    return [node, ...all(node.props.children as ReactNode)]
  }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) { const node = all(tree).find(predicate); assert.ok(node, 'Expected element'); return node }
  const button = (text: string) => find(node => node.type === 'button' && renderToStaticMarkup(node.props.children as ReactNode).includes(text))
  function click(text: string) { const node = button(text); assert.ok(!node.props.disabled); (node.props.onClick as () => void)() }
  return { render, calls, button, click, find,
    async flush() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); render() } return render() },
    change(text: string) { (find(node => node.type === 'textarea').props.onChange as (event: unknown) => void)({ target: { value: text, selectionStart: text.length } }) },
    get text() { return find(node => node.type === 'textarea').props.value },
    submit() { (find(node => node.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} }) },
    update(value: Partial<Session> & { revert?: RevertState }) { session = { ...session, ...value } },
    delay(value: Promise<unknown>) { delay = value }, fail(value: unknown) { failure = value }, failPrompt(value: unknown) { promptFailure = value },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

test('eligible turns expose rewind; child and specialized sessions hide it; running disables it', async () => {
  for (const options of [{}, { parentID: 'parent' }, { locked: 'translation' as const }, { locked: 'commit' as const }, { running: true }]) {
    const h = harness(options)
    try { h.render(); const html = await h.flush(); if ('parentID' in options || options.locked) assert.doesNotMatch(html, /data-testid="rewind-trigger"/); else assert.equal(h.button('Quay lại từ đây').props.disabled, !!options.running) } finally { h.unmount() }
  }
})

test('chooser stages both chat-only and file rewinds, autofills empty draft and preserves unsaved draft', async () => {
  for (const files of [false, true]) for (const draft of ['', 'Unsaved draft']) {
    const h = harness()
    try {
      h.render(); await h.flush(); h.change(draft); h.render()
      // Select the target user turn rather than the first historical turn.
      const trigger = h.find(node => typeof node.type === 'function' && node.type.name === 'ChatTurnView' && String(node.key) === 'target')
      const findInSubtree = (node: ReactNode): ReactElement<Record<string, unknown>> | undefined => {
        if (Array.isArray(node)) { for (const child of node) { const hit = findInSubtree(child); if (hit) return hit } return undefined }
        if (!isValidElement<Record<string, unknown>>(node)) return undefined
        if (node.props['data-testid'] === 'rewind-trigger') return node
        return findInSubtree(node.props.children as ReactNode)
      }
      const rewindButton = findInSubtree((trigger.type as any)(trigger.props))!
      ;(rewindButton.props.onClick as () => void)()
      const html = h.render(); assert.match(html, /Chỉ quay lui hội thoại/); assert.match(html, /Quay lui hội thoại &amp; tệp/)
      h.click(files ? 'Quay lui hội thoại &amp; tệp' : 'Chỉ quay lui hội thoại'); await h.flush()
      assert.deepEqual(h.calls.find(call => call.method === 'stageRevert')?.args, ['project', 'session', 'target', files])
      assert.equal(h.text, draft || 'Original prompt')
      if (draft) { h.click('Nạp lại prompt đã quay lui'); h.render(); assert.equal(h.text, 'Original prompt') }
      if (files) assert.match(h.render(), /không có Git hoặc dữ liệu snapshot/)
    } finally { h.unmount() }
  }
})

test('existing rewind survives remount, hides reverted history/todos, lists files and cancels natively', async () => {
  const h = harness({ revert: { messageID: 'target', snapshot: 'snapshot', files: [file] } })
  try {
    h.render(); const html = await h.flush(); assert.match(html, /Đang quay lui · 2 lượt/); assert.match(html, /src\/example.ts/); assert.match(html, /\+3 −2/)
    assert.doesNotMatch(html, /Original prompt/)
    h.click(file.file); assert.deepEqual(h.calls.at(-1), { method: 'openFile', args: [file.file] })
    h.click('Hủy quay lui'); const restored = await h.flush(); assert.doesNotMatch(restored, /data-testid="rewind-banner"/)
    assert.deepEqual(h.calls.find(call => call.method === 'clearRevert')?.args, ['project', 'session'])
  } finally { h.unmount() }
})

test('in-flight actions reject duplicate clicks and preserve drafts typed during RPC', async () => {
  const h = harness(); let resolve!: () => void
  try {
    h.render(); await h.flush(); h.change(''); h.render(); h.delay(new Promise<void>(done => { resolve = done }))
    h.click('Quay lại từ đây'); h.render(); const action = h.button('Chỉ quay lui hội thoại').props.onClick as () => void
    action(); action(); h.render(); assert.equal(h.calls.filter(call => call.method === 'stageRevert').length, 1)
    assert.equal(h.button('Quay lại từ đây').props.disabled, true)
    h.change('Typed during RPC'); resolve(); await h.flush(); assert.equal(h.text, 'Typed during RPC'); assert.ok(h.button('Nạp lại prompt đã quay lui'))
  } finally { resolve?.(); h.unmount() }
})

test('backend errors retain existing rewind and draft; prompt submits directly without a commit API', async () => {
  const h = harness({ revert: { messageID: 'target' } })
  try {
    h.render(); await h.flush(); h.change('Continue here'); h.render(); h.fail(new Error('SESSION_BUSY')); h.click('Hủy quay lui')
    assert.match(await h.flush(), /Phiên đang chạy; hãy dừng phản hồi/); assert.match(h.render(), /data-testid="rewind-banner"/); assert.equal(h.text, 'Continue here')
    h.failPrompt(new Error('OPENCODE_DISCONNECTED')); h.submit(); assert.match(await h.flush(), /Chưa kết nối tới OpenCode/); assert.equal(h.text, 'Continue here')
    h.failPrompt(undefined); h.submit(); const html = await h.flush()
    assert.equal(h.calls.filter(call => call.method === 'prompt').length, 2); assert.equal(h.calls.filter(call => /commit/i.test(call.method)).length, 0)
    assert.equal(h.text, ''); assert.doesNotMatch(html, /data-testid="rewind-error"|data-testid="rewind-banner"/)
  } finally { h.unmount() }
})

test('failed staging keeps history and draft intact, then allows a retry', async () => {
  const h = harness()
  try {
    h.render(); await h.flush(); h.change('Keep my draft'); h.render()
    h.fail(new Error('REVERT_CHILD_UNSUPPORTED')); h.click('Quay lại từ đây'); h.render(); h.click('Chỉ quay lui hội thoại')
    const failed = await h.flush()
    assert.match(failed, /Không thể quay lui trực tiếp trên phiên con/)
    assert.doesNotMatch(failed, /data-testid="rewind-banner"/)
    assert.equal(h.text, 'Keep my draft')
    assert.equal(h.button('Quay lại từ đây').props.disabled, false)
    h.fail(undefined); h.click('Quay lại từ đây'); h.render(); h.click('Chỉ quay lui hội thoại')
    assert.match(await h.flush(), /data-testid="rewind-banner"/)
    assert.doesNotMatch(h.render(), /data-testid="rewind-error"/)
  } finally { h.unmount() }
})

test('running and session changes close the chooser; stale RPC completion cannot overwrite the new draft', async () => {
  const h = harness(); let resolve!: () => void
  try {
    h.render(); await h.flush(); h.change(''); h.render(); h.click('Quay lại từ đây'); h.render()
    h.update({ status: 'running' }); assert.doesNotMatch(h.render(), /data-testid="rewind-chooser"/)
    h.update({ status: 'idle' }); h.render(); h.click('Quay lại từ đây'); h.render()
    h.delay(new Promise<void>(done => { resolve = done })); h.click('Chỉ quay lui hội thoại')
    h.update({ id: 'other' }); h.render({ sessionID: 'other' }); h.change('Other session draft'); h.render()
    resolve(); await h.flush()
    assert.equal(h.text, 'Other session draft')
    assert.doesNotMatch(h.render(), /Nạp lại prompt đã quay lui|data-testid="rewind-chooser"/)
  } finally { resolve?.(); h.unmount() }
})

test('cancel also blocks duplicate RPCs until completion', async () => {
  const h = harness({ revert: { messageID: 'target' } }); let resolve!: () => void
  try {
    h.render(); await h.flush(); h.delay(new Promise<void>(done => { resolve = done }))
    const cancel = h.button('Hủy quay lui').props.onClick as () => void
    cancel(); cancel(); h.render()
    assert.equal(h.calls.filter(call => call.method === 'clearRevert').length, 1)
    assert.equal(h.button('Hủy quay lui').props.disabled, true)
    resolve(); assert.doesNotMatch(await h.flush(), /data-testid="rewind-banner"/)
  } finally { resolve?.(); h.unmount() }
})
