import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { ChatItem, CommitAgentInfo, IdeEvent, Permission, Session, SessionForm } from '../../../../../packages/protocol/src/index'
import * as timeline from '../chat-timeline'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function harness(resume = false, overrides: Partial<CommitAgentInfo> = {}) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode
  let closed = 0, refreshed = 0
  let info: CommitAgentInfo = { configured: false, effectiveModelID: 'default', fallbackToDefault: false, stagedCount: 2, workingCount: 3, branch: 'main', commitSessionIDs: resume ? ['commit-1'] : [], lockedSessionIDs: [], ...overrides }
  let sessions: Session[] = resume ? [{ id: 'commit-1', title: 'Commit', status: 'idle' }] : []
  let items: ChatItem[] = [], forms: SessionForm[] = [], permissions: Permission[] = []
  let formsError = '', lockError = ''
  const calls: { method: string; args: unknown[] }[] = [], applied: string[] = []
  const events = new Set<(event: IdeEvent) => void>(), listeners = new Map<string, Set<() => void>>()
  const hooks = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { const value = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(slots[i], value)) { slots[i] = value; writes++ } }] },
    useRef(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) { const i = effectIndex++, old = effects[i]; if (!old || deps.some((dep, j) => !Object.is(dep, old.deps[j]))) pending.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: run() } }) },
  }
  const api = {
    async commitAgentInfo() { return info },
    async commitAgentPrompt(...args: unknown[]) {
      calls.push({ method: 'prompt', args })
      sessions = [{ id: 'commit-1', title: 'Commit', status: 'running' }]
      info = { ...info, commitSessionIDs: ['commit-1'] }
      items = [{ id: 'user', role: 'user', text: String(args[2]) }]
      return { session: sessions[0], model: { id: 'default', name: 'Default', providerID: 'amecode' }, locked: false }
    },
    async commitAgentLock(...args: unknown[]) { calls.push({ method: 'lock', args }); if (lockError) throw new Error(lockError); info = { ...info, lockedSessionIDs: [String(args[1])] }; return info },
    async messages() { return items }, async sessions() { return sessions }, async permissions() { return permissions },
    async forms() { if (formsError) throw new Error(formsError); return forms },
    async models() { return [] }, async agentMap() { return { nodes: [] } },
    async replyPermission(...args: unknown[]) { calls.push({ method: 'permission', args }); permissions = [] },
    async cancel(...args: unknown[]) { calls.push({ method: 'cancel', args }); sessions = sessions.map(session => ({ ...session, status: 'idle' })); forms = [] },
    onEvent(fn: (event: IdeEvent) => void) { events.add(fn); return () => events.delete(fn) },
  }
  const marker = () => null
  const modules: Record<string, unknown> = {
    react: hooks, '../chat-timeline': timeline,
    './Icon': { Icon: marker }, './MessageContent': { MessageContent: ({ text }: { text: string }) => text },
    './Primitives': { errorText: (e: unknown) => String(e).replace(/^Error: /, ''), IconButton: marker },
    './SessionChanges': { TurnChanges: marker }, './ToolCard': { ToolCard: marker },
    './SessionFormCard': { SessionFormCard: ({ form }: { form: SessionForm }) => `Pending form: ${form.title}` },
    './TurnWorkGroup': { TurnWorkGroup: marker, ActiveToolsView: ({ items }: { items: ChatItem[] }) => `Active tools: ${items.map(item => item.tool?.name).join(', ')}`, LiveTurnStatus: ({ label }: { label: string }) => label },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const code = ts.transpileModule(readFileSync(new URL('../components/CommitAgentModal.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, Event, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, document: { activeElement: null }, window: {
    ame: api, addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) }, dispatchEvent(event: Event) { listeners.get(event.type)?.forEach(fn => fn()) },
  }, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports.CommitAgentModal as (props: object) => ReactNode
  const props = { projectID: 'project', projectName: 'App', connected: true, theme: 'dark', onClose() { closed++ }, onActivity() {}, onGitRefresh() { refreshed++ }, onApplyCommitMessage(message: string) { applied.push(message) }, onOpenFile() {} }
  function render(extra: object = {}) { Object.assign(props, extra); for (let pass = 0; pass < 10; pass++) { const before = writes; cursor = 0; effectIndex = 0; tree = Component(props); pending.splice(0).forEach(run => run()); if (before === writes) return renderToStaticMarkup(tree) } throw new Error('Effects did not settle') }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement<Record<string, unknown>>(node)) return []; return [node, ...all(node.props.children as ReactNode)] }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) { const node = all(tree).find(predicate); assert.ok(node, 'Expected element'); return node }
  function button(text: string) { return find(node => node.type === 'button' && renderToStaticMarkup(node.props.children as ReactNode).includes(text)) }
  return {
    render, find, button, calls, applied,
    click(text: string) { const node = button(text); assert.ok(!node.props.disabled, `${text} enabled`); (node.props.onClick as () => void)() },
    async flush() { for (let i = 0; i < 4; i++) { await tick(); render() } return render() },
    update(value: { session?: Partial<Session>; items?: ChatItem[]; forms?: SessionForm[]; permissions?: Permission[]; formsError?: string; lockError?: string }) { if (value.session) sessions = [{ id: 'commit-1', title: 'Commit', ...value.session }]; if (value.items) items = value.items; if (value.forms) forms = value.forms; if (value.permissions) permissions = value.permissions; if (value.formsError !== undefined) formsError = value.formsError; if (value.lockError !== undefined) lockError = value.lockError },
    emit() { events.forEach(fn => fn({ type: 'opencode', projectID: 'project', sessionID: 'commit-1' })) },
    get closed() { return closed }, get refreshed() { return refreshed },
    unmount() { effects.forEach(effect => effect.cleanup?.()); assert.equal(events.size, 0) },
  }
}

test('all three presets use dedicated commit prompts without requiring a configured skill', async () => {
  for (const [title, mode, pattern] of [['Phân tích &amp; đề xuất', 'analyze', /question/], ['Phân tích &amp; thực thi', 'split', /UTF-8/], ['Viết 1 thông điệp', 'single', /không cắt 64KB/]] as const) {
    const h = harness()
    try { h.render(); const html = await h.flush(); assert.match(html, /Conventional Commits/); assert.match(html, /2 staged · 3 chưa stage/); h.click(title); await h.flush(); assert.equal(h.calls[0].method, 'prompt'); assert.deepEqual(h.calls[0].args.slice(0, 2), ['project', undefined]); assert.equal(h.calls[0].args[3], mode); assert.match(String(h.calls[0].args[2]), pattern) } finally { h.unmount() }
  }
})

test('question forms render, block finishing, and resolve through SessionFormCard', async () => {
  const h = harness(true)
  try {
    h.update({ items: [{ id: 'q', role: 'assistant', kind: 'tool', text: '', tool: { name: 'question', status: 'running' } }], forms: [{ id: 'f', sessionID: 'commit-1', title: 'Tách 8 commit hay gộp?', fields: [{ key: 'choice', type: 'string' }] }] })
    h.render(); const html = await h.flush(); assert.match(html, /Pending form: Tách 8 commit hay gộp/); assert.match(html, /Đang chờ bạn trả lời/); assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
    const form = h.find(node => !!node.props.form)
    assert.equal(form.props.projectID, 'project'); assert.equal(form.props.disabled, false)
    h.update({ forms: [] }); (form.props.onResolved as (id: string) => void)('f'); assert.doesNotMatch(await h.flush(), /Pending form:/)
  } finally { h.unmount() }
})

test('permission cards support once, always and reject replies', async () => {
  for (const [title, response] of [['Cho phép một lần', 'once'], ['Luôn cho phép', 'always'], ['Từ chối', 'reject']]) {
    const h = harness(true)
    try { h.update({ permissions: [{ id: 'permission', sessionID: 'commit-1', title: 'git commit' }] }); h.render(); await h.flush(); h.click(title); await h.flush(); assert.deepEqual(h.calls[0], { method: 'permission', args: ['project', 'permission', response] }); assert.doesNotMatch(h.render(), /Yêu cầu quyền/) } finally { h.unmount() }
  }
})

test('new session stays enabled during running and while awaiting a question', async () => {
  for (const waiting of [false, true]) {
    const h = harness(true)
    try { h.update({ session: { status: waiting ? 'idle' : 'running' }, items: [{ id: 'old', role: 'user', text: 'Old request' }], forms: waiting ? [{ id: 'f', sessionID: 'commit-1', title: 'Chọn cách tách', fields: [{ key: 'choice', type: 'string' }] }] : [] }); h.render(); await h.flush(); assert.equal(h.button('Phiên mới').props.disabled, false); h.click('Phiên mới'); assert.doesNotMatch(h.render(), /Old request|Pending form/); h.click('Viết 1 thông điệp'); await h.flush(); assert.equal(h.calls[0].args[1], undefined); assert.equal(h.refreshed, 0) } finally { h.unmount() }
  }
})

test('commit message buttons apply the exact UTF-8 message and announce success', async () => {
  for (const count of [1, 8]) {
    const h = harness(true), messages = Array.from({ length: count }, (_, i) => `feat(git): thay đổi ${i}\n\nNội dung UTF-8`)
    try { h.update({ items: [{ id: 'answer', role: 'assistant', text: messages.map(message => `\`\`\`commit\n${message}\n\`\`\``).join('\n') }] }); h.render(); await h.flush(); h.click(count === 1 ? 'Điền vào ô Commit' : 'Điền commit #8'); assert.deepEqual(h.applied, [messages[count - 1]]); assert.match(h.render(), /Đã điền vào ô Commit/) } finally { h.unmount() }
  }
})

test('running to idle refreshes Git exactly once; stopping reloads immediately', async () => {
  const h = harness(true)
  try { h.update({ session: { status: 'running' } }); h.render(); await h.flush(); assert.equal(h.refreshed, 0); h.click('Dừng phản hồi'); await h.flush(); assert.deepEqual(h.calls[0], { method: 'cancel', args: ['project', 'commit-1'] }); assert.equal(h.refreshed, 1); assert.doesNotMatch(h.render(), /Dừng phản hồi/); h.emit(); await h.flush(); assert.equal(h.refreshed, 1) } finally { h.unmount() }
})

test('event-driven running to idle refreshes Git even without stopping', async () => {
  const h = harness(true)
  try { h.update({ session: { status: 'running' } }); h.render(); await h.flush(); h.update({ session: { status: 'idle' } }); h.emit(); await h.flush(); assert.equal(h.refreshed, 1) } finally { h.unmount() }
})

test('failed outcome surfaces timeline errors in every detail mode and hides completion banner', async () => {
  for (const timelineDetail of ['compact', 'detailed', 'everything']) {
    const h = harness(true)
    try { h.update({ session: { status: 'idle', outcome: 'failed' }, items: [{ id: 'error', role: 'assistant', kind: 'error', text: 'Compaction token limit exceeded' }] }); h.render({ timelineDetail }); const html = await h.flush(); assert.match(html, /role="alert">Compaction token limit exceeded/); assert.match(html, /Ngữ cảnh phiên vượt giới hạn token/); assert.match(html, /Lượt commit gần nhất gặp lỗi/); assert.doesNotMatch(html, /Đã xong\?/); h.click('Phiên mới'); assert.doesNotMatch(h.render(), /Compaction token limit/) } finally { h.unmount() }
  }
})

test('finish locks the dedicated session, refreshes Git and closes; failures keep it open', async () => {
  const h = harness(true)
  try { h.render(); await h.flush(); h.update({ lockError: 'LOCK_FAILED' }); h.click('✓ Hoàn tất'); assert.match(await h.flush(), /LOCK_FAILED/); assert.equal(h.closed, 0); h.update({ lockError: '' }); h.click('✓ Hoàn tất'); await h.flush(); assert.deepEqual(h.calls.at(-1), { method: 'lock', args: ['project', 'commit-1'] }); assert.equal(h.closed, 1); assert.equal(h.refreshed, 1); assert.match(h.render(), /khóa vĩnh viễn/); assert.doesNotMatch(h.render(), /<textarea/) } finally { h.unmount() }
})

test('partial forms failures retain history and idle interrupted questions release composer', async () => {
  const h = harness(true)
  try { h.update({ session: { status: 'idle' }, formsError: 'FORMS_UNAVAILABLE', items: [{ id: 'answer', role: 'assistant', text: 'History retained' }, { id: 'q', role: 'assistant', kind: 'tool', text: '', tool: { name: 'question', status: 'running' } }] }); h.render(); const html = await h.flush(); assert.match(html, /History retained/); assert.match(html, /FORMS_UNAVAILABLE/); assert.match(html, /Câu hỏi trước đó đã bị gián đoạn/); assert.equal(h.find(node => node.type === 'textarea').props.disabled, false) } finally { h.unmount() }
})

test('disconnected or missing model prevents prompts', async () => {
  for (const offline of [false, true]) {
    const h = harness(false, offline ? {} : { effectiveModelID: undefined })
    try { h.render({ connected: !offline }); await h.flush(); assert.equal(h.find(node => node.type === 'textarea').props.disabled, true) } finally { h.unmount() }
  }
})

// Integration coverage executes Chat's real effects, with the bridge optional for older clients.
function chatHarness(apiOverrides: Record<string, unknown> = {}) {
  const slots: any[] = [], cleanups: (() => void)[] = []
  let cursor = 0, pending: (() => void)[] = [], tree: ReactNode
  const listeners = new Map<string, Set<() => void>>()
  const api = {
    models: async () => [{ id: 'm', providerID: 'amecode', name: 'Model' }],
    commands: async () => [], skills: async () => [], messages: async () => [],
    permissions: async () => [], forms: async () => [], sessionPermissionMode: async () => 'default',
    onEvent: () => () => {}, ...apiOverrides,
  }
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial } },
    useId: () => 'commit-chat-test',
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot() },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const i = cursor++, old = slots[i]
      if (old && deps.length === old.length && deps.every((dep, j) => Object.is(dep, old[j]))) return
      slots[i] = deps; pending.push(() => { cleanups[i]?.(); const cleanup = run(); if (cleanup) cleanups[i] = cleanup })
    },
  }
  const filename = new URL('../components/Chat.tsx', import.meta.url), nativeRequire = createRequire(filename)
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports, setTimeout, clearTimeout, requestAnimationFrame() {},
    window: {
      ame: api,
      addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
      removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) },
    },
    require: (name: string) => name === 'react' ? hooks : name.startsWith('./') ? new Proxy({}, { get: (_target, key) => key === 'errorText' ? (e: Error) => e.message : () => null }) : nativeRequire(name),
  })
  let opened = 0, created = 0
  let props = {
    projectID: 'project', sessionID: 'commit-1', connected: true, ready: true,
    accountRole: 'admin', defaultModelID: 'm', modelLevels: {}, sessions: [], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark',
    onCreated() {}, onCreate() { created++ }, onOpenCommitAgent() { opened++ }, report() {}, onActivity() {}, onOpenPanel() {}, onOpenFile() {}, onSelectSession() {},
  }
  function render(patch: object = {}) { props = { ...props, ...patch }; cursor = 0; tree = exports.Chat(props); const effects = pending; pending = []; effects.forEach(run => run()); return tree }
  function all(node: ReactNode): ReactElement<Record<string, any>>[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...all(node.props.children)] }
  return {
    render, nodes: () => all(tree),
    emit() { listeners.get('ame-commit-agent-changed')?.forEach(fn => fn()) },
    async flush() { for (let i = 0; i < 3; i++) { await tick(); render() } },
    click(label: string) { const button = all(tree).find(node => node.type === 'button' && node.props.children === label); assert.ok(button); button.props.onClick() },
    get opened() { return opened }, get created() { return created },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); assert.equal([...listeners.values()].reduce((sum, set) => sum + set.size, 0), 0) },
  }
}

test('Chat redirects dedicated commit sessions to the modal, reacts to locks, and restores normal sessions', async () => {
  let lockedSessionIDs: string[] = []
  const h = chatHarness({ commitAgentInfo: async () => ({ commitSessionIDs: ['commit-1'], lockedSessionIDs }) })
  try {
    h.render(); await h.flush()
    const banner = () => h.nodes().find(node => node.props['data-testid'] === 'commit-agent-locked-banner')
    assert.ok(banner()); assert.match(renderToStaticMarkup(banner()), /Đây là phiên Trợ lý Commit AI riêng/)
    assert.equal(h.nodes().some(node => node.type === 'textarea'), false)
    h.click('Trợ lý Commit AI'); h.click('Cuộc trò chuyện mới')
    assert.equal(h.opened, 1); assert.equal(h.created, 1)
    lockedSessionIDs = ['commit-1']; h.emit(); await h.flush()
    assert.match(renderToStaticMarkup(banner()), /đã hoàn tất và được khóa/)
    h.click('Trợ lý Commit AI'); assert.equal(h.opened, 2)
    h.render({ connected: false }); await h.flush()
    assert.ok(banner(), 'disconnect must not unlock a known commit session')
    h.render({ connected: true, sessionID: 'normal' }); await h.flush()
    assert.equal(banner(), undefined); assert.ok(h.nodes().some(node => node.type === 'textarea'))
    h.render({ projectID: 'other', connected: false, sessionID: 'commit-1' })
    assert.equal(banner(), undefined, 'commit metadata cannot leak between projects')
  } finally { h.unmount() }
})

test('Chat remains compatible when commitAgentInfo is absent or rejects', async () => {
  for (const overrides of [{}, { commitAgentInfo: async () => { throw new Error('unavailable') } }]) {
    const h = chatHarness(overrides)
    try { h.render(); await h.flush(); assert.ok(h.nodes().some(node => node.type === 'textarea')); assert.equal(h.nodes().some(node => node.props['data-testid'] === 'commit-agent-locked-banner'), false) } finally { h.unmount() }
  }
})
