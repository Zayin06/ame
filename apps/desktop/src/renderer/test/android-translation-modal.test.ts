import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { AndroidTranslationInfo, ChatItem, IdeEvent, Model, Permission, Session, SessionForm, SkillSummary } from '../../../../../packages/protocol/src/index'
import { extractCommitMessagesFromText, extractUserDisplayText, projectChatTimeline } from '../chat-timeline'
import { projectSessionTodos } from '../chat-todo'
import * as modelSelection from '../model-selection'
import * as amekitUI from '../amekit-ui'
import { detectComposerTrigger, filterSlashEntries } from '../composer-mentions'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const model = { id: 'gemini', modelID: 'gemini', providerID: 'amecode', name: 'Gemini Translation' }
const baseInfo: AndroidTranslationInfo = { configured: true, isAndroid: true, skill: 'android-strings-translation', effectiveModelID: 'gemini', effectiveModelName: 'Gemini Translation', fallbackToDefault: false, stringsFiles: ['app/src/main/res/values/strings.xml'], translationSessionIDs: [], lockedSessionIDs: [] }

function harness(options: { info?: Partial<AndroidTranslationInfo>; component?: 'AndroidTranslationModal' | 'CommitAgentModal' | 'Chat'; props?: Record<string, unknown>; onSubscribe?: (emit: (event: IdeEvent) => void) => void } = {}) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode, closed = 0, activity = 0, focused = 0
  let info = { ...baseInfo, ...options.info }, items: ChatItem[] = [], permissions: Permission[] = [], sessions: Session[] = []
  const calls: { method: string; args: unknown[] }[] = [], listeners = new Map<string, Set<(event: Event) => void>>(), events = new Set<(event: IdeEvent) => void>()
  let promptError = '', lockError = '', formsError = '', nextPrompt: Promise<unknown> | undefined
  let sessionModel: string | undefined
  let models: Model[] = [{ id: 'default', providerID: 'amecode', name: 'Default' }, model]
  let infoLoads = 0, modelLoads = 0, agentMapLoads = 0
  let forms: SessionForm[] = []
  let skills: SkillSummary[] = [], skillsLoads = 0
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (!Object.is(value, slots[index])) { slots[index] = value; writes++ }
      }]
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useId() { return `test-${cursor++}` },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot() },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, old = effects[index]
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
    },
  }
  const api = {
    async androidTranslationInfo() { infoLoads++; return info },
    async commitAgentInfo() { infoLoads++; return { ...info, commitSessionIDs: options.component === 'CommitAgentModal' ? info.translationSessionIDs : [], lockedSessionIDs: options.component === 'CommitAgentModal' ? info.lockedSessionIDs : [] } },
    async commitAgentPrompt(...args: unknown[]) { return api.androidTranslationPrompt(...args) },
    async androidTranslationPrompt(...args: unknown[]) {
      calls.push({ method: 'prompt', args })
      if (nextPrompt) return nextPrompt
      if (promptError) throw new Error(promptError)
      const id = args[1] as string | undefined || 'translation-1'
      info = { ...info, translationSessionIDs: [...new Set([...info.translationSessionIDs, id])] }
      sessions = [{ id, title: 'Android Strings', status: 'idle' }]
      items = [...items, { id: `user-${items.length}`, role: 'user', text: String(args[2]) }, { id: `assistant-${items.length}`, role: 'assistant', text: 'Đã đồng bộ locale.' }]
      return { session: sessions[0], model, locked: false }
    },
    async androidTranslationLock(...args: unknown[]) {
      calls.push({ method: 'lock', args })
      if (lockError) throw new Error(lockError)
      info = { ...info, lockedSessionIDs: [...info.lockedSessionIDs, String(args[1])] }
      return { translationSessionIDs: info.translationSessionIDs, lockedSessionIDs: info.lockedSessionIDs }
    },
    async messages() { return items },
    async permissions() { return permissions },
    async forms() { if (formsError) throw new Error(formsError); return forms },
    async sessionPermissionMode() { return 'default' },
    async sessions() { return sessions },
    async agentMap(_projectID: string, sessionID: string) { agentMapLoads++; return { nodes: sessionModel ? [{ id: sessionID, model: sessionModel, providerID: 'amecode' }] : [] } },
    async replyPermission(...args: unknown[]) { calls.push({ method: 'permission', args }); permissions = []; return undefined },
    async cancel(...args: unknown[]) { calls.push({ method: 'cancel', args }); sessions = sessions.map(session => session.id === args[1] ? { ...session, status: 'idle' } : session); forms = [] },
    onEvent(fn: (event: IdeEvent) => void) { events.add(fn); options.onSubscribe?.(fn); return () => events.delete(fn) },
    async account() { return { account: { role: 'user' }, models: { default_model: 'default' } } },
    async models() { modelLoads++; return models },
    async agents() { return [] }, async commands() { return [] }, async skills() { skillsLoads++; return skills },
    async prompt(...args: unknown[]) { calls.push({ method: 'regularPrompt', args }) },
  }
  const windowMock = {
    ame: api,
    addEventListener(name: string, fn: (event: Event) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
    removeEventListener(name: string, fn: (event: Event) => void) { listeners.get(name)?.delete(fn) },
    dispatchEvent(event: Event) { listeners.get(event.type)?.forEach(fn => fn(event)); return true },
  }
  const marker = () => null
  const modules: Record<string, unknown> = {
    react: hooks,
    './Icon': { Icon: marker }, './MessageContent': { MessageContent: ({ text }: { text: string }) => text },
    './Primitives': { errorText: (e: unknown) => String(e).replace(/^Error: /, ''), IconButton: marker, Empty: marker },
    './SessionChanges': { TurnChanges: marker }, './ToolCard': { ToolCard: marker },
    './TodoProgressCard': { TodoProgressCard: marker },
    './SessionFormCard': { SessionFormCard: ({ form }: { form: SessionForm }) => `Pending form: ${form.title}` },
    './TurnWorkGroup': { TurnWorkGroup: marker, ActiveToolsView: ({ items }: { items: ChatItem[] }) => `Active tools: ${items.map(item => item.tool?.name).join(', ')}`, LiveTurnStatus: ({ label }: { label: string }) => label },
    '../chat-timeline': { extractCommitMessagesFromText, extractUserDisplayText, projectChatTimeline }, '../model-selection': modelSelection, '../amekit-ui': amekitUI,
    '../chat-todo': { projectSessionTodos },
    './AgentList': { AgentList: marker }, './AgentMap': { AgentMap: marker },
    '../agent-map-model': { familySummaryFromSessions: () => ({ runningCount: 0, subagentCount: 0 }) },
    './ArtifactViewer': { ArtifactViewer: marker },
    '../chat-submit': { chatSubmit: () => async (...args: unknown[]) => { calls.push({ method: 'regularPrompt', args }); return true } },
    './ComposerAttachments': { ComposerAttachmentStrip: marker, ComposerDropOverlay: marker, MessageAttachmentList: marker },
    '../composer-mentions': {
      applyComposerCompletion: (text: string) => ({ text, cursor: text.length }),
      composePromptWithAttachments: (text: string) => text,
      filterFileMentions: () => [],
      filterSlashEntries,
      detectComposerTrigger,
      WORKSPACE_DRAG_MIME: 'application/x-ame-workspace-path',
      MAX_PROMPT_FILES: 8,
      readBrowserFileAttachment: async () => null,
      splitComposerAttachments: (text: string) => ({ text, files: [], truncatedCount: 0 }),
    },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url), component = options.component ?? 'AndroidTranslationModal'
  const code = ts.transpileModule(readFileSync(new URL(`../components/${component}.tsx`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, Event, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, window: windowMock, document: { activeElement: null }, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports[component] as (props: object) => ReactNode
  const props = { projectID: 'project', projectName: 'Android App', connected: true, ready: true, theme: 'dark', onClose() { closed++ }, onActivity() { activity++ }, onOpenFile() {}, onCreate() {}, report() {}, onCreated() {}, onOpenPanel() {}, onSelectSession() {}, sessions: [], tabs: [], changes: 0, changesStatus: 'ready', accountRole: 'user', defaultModelID: 'default', modelLevels: {}, ...options.props }
  function render(extra: object = {}) {
    Object.assign(props, extra)
    for (let pass = 0; pass < 10; pass++) {
      const before = writes
      cursor = 0; effectIndex = 0; tree = Component(props)
      pending.splice(0).forEach(run => run())
      if (writes === before) return renderToStaticMarkup(tree)
    }
    throw new Error('Effects did not settle')
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) { const result = all(tree).find(predicate); assert.ok(result, 'Expected element'); return result }
  function button(text: string) { return find(node => node.type === 'button' && renderToStaticMarkup(node.props.children as ReactNode).includes(text)) }
  function click(text: string) { const element = button(text); assert.ok(!element.props.disabled, `${text} enabled`); (element.props.onClick as () => void)() }
  return {
    render, find, button, click, calls, exports,
    async flush() { for (let i = 0; i < 4; i++) { await tick(); render() } return render() },
    change(text: string) { (find(node => node.type === 'textarea').props.onChange as (e: unknown) => void)({ target: { value: text, selectionStart: text.length } }) },
    submit() { (find(node => node.type === 'form').props.onSubmit as (e: unknown) => void)({ preventDefault() {} }) },
    focusInput() { const input = find(node => node.type === 'textarea'); (input.props.ref as { current: unknown }).current = { focus() { focused++ } } },
    emit(event: IdeEvent) { events.forEach(fn => fn(event)) },
    dispatch(name: string) { windowMock.dispatchEvent(new Event(name)) },
    key(event: Record<string, unknown>) { listeners.get('keydown')?.forEach(fn => fn(event as unknown as Event)) },
    updateInfo(value: Partial<AndroidTranslationInfo>) { info = { ...info, ...value } },
    updateSession(value: Session) { sessions = [value] },
    updateSessionModel(value: string) { sessionModel = value },
    updateModels(value: Model[]) { models = value },
    get loads() { return { info: infoLoads, models: modelLoads, agentMap: agentMapLoads } },
    updateMessages(value: ChatItem[]) { items = value },
    updatePermissions(value: Permission[]) { permissions = value },
    updateForms(value: SessionForm[]) { forms = value },
    failForms(value: string) { formsError = value },
    updateSkills(value: SkillSummary[]) { skills = value },
    get skillsLoads() { return skillsLoads },
    get eventListeners() { return events.size },
    failPrompt(value: string) { promptError = value }, failLock(value: string) { lockError = value },
    delayPrompt(value: Promise<unknown>) { nextPrompt = value },
    get closed() { return closed }, get activity() { return activity }, get focused() { return focused },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

test('translation and Chat user bubbles display only the original request without changing history', async () => {
  for (const component of ['AndroidTranslationModal', 'Chat'] as const) {
    const h = harness({ component, info: { translationSessionIDs: ['translation-display'] }, props: { sessionID: 'translation-display' } })
    const request = 'file tạo ở đâu rồi?'
    const wrapped = `[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY]\nSKILL.md\n${'instructions '.repeat(1500)}\n\nUser request:\n[Translation mode: full]\n${request}`
    const item: ChatItem = { id: 'user', role: 'user', text: wrapped }
    try {
      h.updateSession({ id: 'translation-display', title: 'Translation', status: 'idle' })
      h.updateMessages([item])
      h.render(); const html = await h.flush()
      const bubble = h.find(node => node.type === 'article' && node.props.className === 'msg-user')
      assert.equal(renderToStaticMarkup(bubble.props.children as ReactNode), request)
      assert.doesNotMatch(html, /\[STRICT SCOPE: ANDROID STRINGS TRANSLATION ONLY\]|\[Translation mode: full\]|SKILL\.md/)
      assert.equal(item.text, wrapped, 'display cleanup must not mutate backend history')
    } finally { h.unmount() }
  }
})

test('failed translation surfaces compaction errors and a new-session action instead of the finish banner', async () => {
  for (const component of ['AndroidTranslationModal', 'Chat'] as const) for (const timelineDetail of ['compact', 'detailed', 'everything']) {
    const h = harness({ component, info: { translationSessionIDs: ['translation-failed'] }, props: { sessionID: 'translation-failed', timelineDetail } })
    try {
      h.updateSession({ id: 'translation-failed', title: 'Translation', status: 'idle', outcome: 'failed' })
      h.updateMessages([
        { id: 'user', role: 'user', text: 'Dịch sang ja' },
        { id: 'compaction', role: 'assistant', kind: 'error', text: 'Compaction summary reached the output token limit' },
        { id: 'tool', role: 'assistant', kind: 'tool', text: '', tool: { name: 'read', status: 'completed' } },
      ])
      h.render(); const html = await h.flush()
      const alert = h.find(node => node.props.role === 'alert' && renderToStaticMarkup(node.props.children as ReactNode).includes('Compaction summary'))
      assert.equal(alert.props.className, 'inline-error')
      assert.match(renderToStaticMarkup(alert), /Compaction summary reached the output token limit/)
      assert.match(renderToStaticMarkup(alert), /Ngữ cảnh phiên đã quá dài khiến bước tóm tắt bị vượt giới hạn token\. Hãy bấm Phiên dịch mới \(hoặc tạo cuộc trò chuyện mới\) để tiếp tục\./)
      assert.doesNotMatch(html, /Đã dịch xong\?/)
      if (component === 'AndroidTranslationModal') {
        const banner = h.find(node => node.props.role === 'alert' && renderToStaticMarkup(node.props.children as ReactNode).includes('Lượt dịch gần nhất gặp lỗi'))
        assert.match(renderToStaticMarkup(banner), /Lượt dịch gần nhất gặp lỗi và chưa hoàn tất\. Hãy xem chi tiết lỗi ở trên hoặc bấm Phiên dịch mới để chạy lại\./)
        const button = (banner.props.children as ReactElement<Record<string, unknown>>[]).find(node => node.type === 'button')
        assert.ok(button)
        assert.equal(renderToStaticMarkup(button.props.children as ReactNode), 'Phiên dịch mới')
        assert.equal(button.props.disabled, false)
        ;(button.props.onClick as () => void)()
        assert.doesNotMatch(h.render(), /Compaction summary|Lượt dịch gần nhất gặp lỗi/)
        assert.match(h.render(), /Chỉ dịch Android Strings/)
      }
    } finally { h.unmount() }
  }
})

test('Chat shows the responsive Android translation trigger only for Android projects', async () => {
  for (const isAndroid of [false, true]) {
    let opened = 0
    const h = harness({ component: 'Chat', info: { configured: true, isAndroid }, props: { onOpenAndroidTranslation() { opened++ } } })
    h.render(); const html = await h.flush()
    if (isAndroid) {
      assert.match(html, /data-testid="android-translate-trigger" title="Dịch Android"/)
      assert.match(html, /<span class="pill-btn__label">Dịch Android<\/span>/)
      h.click('Dịch Android'); assert.equal(opened, 1)
    } else assert.doesNotMatch(html, /data-testid="android-translate-trigger"/)
    h.unmount()
  }
  const css = readFileSync(new URL('../parity.css', import.meta.url), 'utf8')
  assert.match(css, /@container chat-header[^\{]*\{\s*\.android-translate-trigger \.pill-btn__label\s*\{[^}]*display:\s*none/)
})

test('Chat focuses its composer once per positive focusNonce change', async () => {
  const h = harness({ component: 'Chat', props: { focusNonce: 0 } })
  h.render(); await h.flush(); h.focusInput()
  h.render(); assert.equal(h.focused, 0)
  h.render({ focusNonce: 1 }); assert.equal(h.focused, 1)
  h.render({ focusNonce: 1 }); assert.equal(h.focused, 1)
  h.render({ focusNonce: 2 }); assert.equal(h.focused, 2)
  h.render({ focusNonce: 0 }); assert.equal(h.focused, 2)
  h.unmount()
})

test('Chat reloads cold skills on scoped and broadcast catalog updates with an 80ms debounce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness({ component: 'Chat' })
  try {
    h.render(); await h.flush(); h.change('/'); h.render()
    assert.equal(h.skillsLoads, 1)
    assert.match(h.render(), /Không có kết quả/)
    h.updateSkills([{ id: 'loaded-skill', name: 'Loaded skill', path: 'SKILL.md' }])
    h.emit({ type: 'catalog', projectID: 'other' })
    t.mock.timers.tick(100); await h.flush()
    assert.equal(h.skillsLoads, 1, 'other projects do not invalidate the cold cache')
    assert.doesNotMatch(h.render(), /Loaded skill/)
    h.emit({ type: 'catalog', projectID: 'project' })
    t.mock.timers.tick(40)
    h.emit({ type: 'catalog', projectID: 'project' })
    t.mock.timers.tick(79); await h.flush()
    assert.equal(h.skillsLoads, 1, 'bursts wait until 80ms after the last update')
    t.mock.timers.tick(1); await h.flush()
    assert.equal(h.skillsLoads, 2)
    assert.match(h.render(), /\/Loaded skill/)
    h.updateSkills([{ id: 'global-skill', name: 'Global skill', path: 'SKILL.md' }])
    h.emit({ type: 'catalog' })
    t.mock.timers.tick(79); await h.flush()
    assert.equal(h.skillsLoads, 2)
    t.mock.timers.tick(1); await h.flush()
    assert.equal(h.skillsLoads, 3)
    assert.match(h.render(), /\/Global skill/)
    assert.doesNotMatch(h.render(), /Loaded skill/)
    h.emit({ type: 'catalog', projectID: 'project' })
  } finally { h.unmount() }
  assert.equal(h.eventListeners, 0)
  t.mock.timers.tick(80); await tick()
  h.emit({ type: 'catalog' }); t.mock.timers.tick(80); await tick()
  assert.equal(h.skillsLoads, 3, 'unmount cancels pending reloads and subscriptions')
})

test('Chat accepts a synchronous catalog subscription callback and cancels its pending reload on unmount', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness({ component: 'Chat', onSubscribe: emit => emit({ type: 'catalog' }) })
  try {
    h.render(); await h.flush()
    assert.equal(h.skillsLoads, 1)
    h.updateSkills([{ id: 'sync-skill', name: 'Synchronous skill', path: 'SKILL.md' }])
    t.mock.timers.tick(80); await h.flush()
    assert.equal(h.skillsLoads, 2)
    h.change('/'); assert.match(h.render(), /\/Synchronous skill/)
    h.emit({ type: 'catalog' })
  } finally { h.unmount() }
  t.mock.timers.tick(80); await tick()
  assert.equal(h.skillsLoads, 2)
  assert.equal(h.eventListeners, 0)
})

test('wide isolated dialog shows skill, pinned model, detected files and full-width composer styles', async () => {
  const h = harness(); h.render(); const html = await h.flush()
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Dịch Android Strings"/)
  assert.match(html, /translation-modal-backdrop/); assert.match(html, /translation-modal__timeline/)
  assert.match(html, /Skill: \/android-strings-translation/); assert.match(html, /Gemini Translation/)
  assert.match(html, /1 tệp strings.xml/); assert.match(html, /Android App/)
  const css = readFileSync(new URL('../parity.css', import.meta.url), 'utf8')
  assert.match(css, /\.translation-modal \{[^}]*--chat-max-w: 100%[^}]*width: min\(1280px, 95vw\)[^}]*height: min\(880px, 92vh\)/)
  assert.match(css, /\.translation-modal \.translation-composer__input \{[^}]*width: 100%; max-width: none; min-height: 76px/)
  h.unmount()
})

test('Update sends isolated feature prompt, loads live timeline and finish locks then closes', async () => {
  const h = harness(); h.render(); await h.flush()
  h.click('Cập nhật string mới'); h.render(); await h.flush()
  assert.equal(h.calls[0].method, 'prompt'); assert.equal(h.calls[0].args[0], 'project'); assert.equal(h.calls[0].args[1], undefined); assert.equal(h.calls[0].args[3], 'update')
  assert.match(String(h.calls[0].args[2]), /Chạy chế độ Update/)
  assert.match(h.render(), /Đã đồng bộ locale/); assert.match(h.render(), /translation-finish-banner/)
  h.click('✓ Hoàn tất'); await h.flush()
  assert.deepEqual(h.calls.at(-1), { method: 'lock', args: ['project', 'translation-1'] })
  assert.equal(h.closed, 1); assert.equal(h.activity, 2)
  assert.doesNotMatch(h.render(), /<textarea/); assert.match(h.render(), /khóa vĩnh viễn/)
  h.click('Phiên dịch mới'); h.render(); assert.match(h.render(), /<textarea/)
  h.unmount()
})

test('Full pre-fills and focuses textarea; follow-up and new session use correct IDs', async () => {
  const h = harness(); h.render(); await h.flush(); h.focusInput()
  h.click('Thêm ngôn ngữ mới'); h.render()
  assert.equal(h.focused, 1); assert.match(String(h.find(node => node.type === 'textarea').props.value), /nhập mã locale/)
  assert.equal(h.calls.length, 0)
  h.change('Dịch sang ja'); h.render(); h.submit(); await h.flush()
  assert.equal(h.calls[0].args[3], 'full')
  h.change('Kiểm tra placeholder'); h.render(); h.submit(); await h.flush()
  assert.equal(h.calls[1].args[1], 'translation-1'); assert.equal(h.calls[1].args[3], 'custom')
  h.click('Phiên dịch mới'); h.render(); h.click('Quét key thiếu'); await h.flush()
  assert.equal(h.calls[2].args[1], undefined); assert.equal(h.calls[2].args[3], 'scan'); assert.match(String(h.calls[2].args[2]), /scan và pending/)
  h.unmount()
})

test('resumes only an unlocked translation session, streams permission and blocks finish while running', async () => {
  const h = harness({ info: { translationSessionIDs: ['old-locked', 'translation-2'], lockedSessionIDs: ['old-locked'] } })
  h.updateSession({ id: 'translation-2', title: 'Existing', status: 'running' })
  h.updateMessages([{ id: 'user', role: 'user', text: 'Scan locale' }])
  h.updatePermissions([{ id: 'python', sessionID: 'translation-2', title: 'python strings_tool.py scan' }])
  h.render(); let html = await h.flush()
  assert.match(html, /python strings_tool.py scan/); assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
  h.click('Cho phép một lần'); await h.flush()
  assert.deepEqual(h.calls[0], { method: 'permission', args: ['project', 'python', 'once'] })
  h.updateSession({ id: 'translation-2', title: 'Existing', status: 'idle' })
  h.updateMessages([{ id: 'user', role: 'user', text: 'Scan locale' }, { id: 'answer', role: 'assistant', text: 'Scan complete' }])
  h.emit({ type: 'opencode', projectID: 'project', sessionID: 'translation-2' }); html = await h.flush()
  assert.match(html, /Scan complete/); assert.equal(h.button('✓ Hoàn tất').props.disabled, false)
  h.unmount()
})

test('new translation remains usable while the previous session is running or awaiting forms', async () => {
  for (const pendingForm of [false, true]) {
    const h = harness({ info: { translationSessionIDs: ['old'] } })
    try {
      h.updateSession({ id: 'old', title: 'Old translation', status: pendingForm ? 'idle' : 'running' })
      h.updateMessages([{ id: 'old-user', role: 'user', text: 'Old request' }])
      if (pendingForm) h.updateForms([{ id: 'form', sessionID: 'old', title: 'Locale', fields: [{ key: 'locale', type: 'string' }] }])
      h.render(); await h.flush()
      assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
      assert.equal(h.button('Phiên dịch mới').props.disabled, false)
      h.click('Phiên dịch mới'); const html = h.render()
      assert.match(html, /Chỉ dịch Android Strings/)
      assert.doesNotMatch(html, /Old request|Pending form:/)
      assert.equal(h.find(node => node.type === 'textarea').props.disabled, false)
      h.click('Quét key thiếu'); await h.flush()
      assert.equal(h.calls.find(call => call.method === 'prompt')?.args[1], undefined)
    } finally { h.unmount() }
  }
})

test('idle interrupted questions release the composer, new session and finish actions in every detail mode', async () => {
  for (const timelineDetail of ['compact', 'detailed', 'everything']) for (const status of ['running', 'streaming'] as const) {
    const h = harness({ info: { translationSessionIDs: ['old'] }, props: { timelineDetail } })
    try {
      h.updateSession({ id: 'old', title: 'Old translation', status: 'idle' })
      h.updateMessages([{ id: 'user', role: 'user', text: 'Dịch sang ja' }, { id: 'question', role: 'assistant', kind: 'tool', text: '', tool: { name: 'question', status } }])
      h.render(); const html = await h.flush()
      assert.doesNotMatch(html, /Đang chờ bạn trả lời câu hỏi…|Active tools: question/)
      assert.match(html, /role="status">Câu hỏi trước đó đã bị gián đoạn và không còn hiệu lực\./)
      assert.equal(h.find(node => node.type === 'textarea').props.disabled, false)
      assert.equal(h.button('Phiên dịch mới').props.disabled, false)
      assert.equal(h.button('✓ Hoàn tất').props.disabled, false)
      h.change('Tiếp tục dịch'); h.render(); h.submit(); await h.flush()
      assert.equal(h.calls.find(call => call.method === 'prompt')?.args[1], 'old')
    } finally { h.unmount() }
  }
})

test('forms failures preserve loaded history and successful session status updates', async () => {
  const h = harness({ info: { translationSessionIDs: ['old'] } })
  try {
    h.updateSession({ id: 'old', title: 'Old translation', status: 'running' })
    h.updateMessages([{ id: 'answer', role: 'assistant', text: 'Lịch sử dịch vẫn hiển thị' }])
    h.failForms('FORMS_UNAVAILABLE')
    h.render(); let html = await h.flush()
    assert.match(html, /Lịch sử dịch vẫn hiển thị/)
    assert.match(html, /role="alert">Không tải được một phần dữ liệu phiên dịch: FORMS_UNAVAILABLE/)
    assert.doesNotMatch(html, /Đang tải phiên dịch…/)
    assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
    h.updateSession({ id: 'old', title: 'Old translation', status: 'idle' })
    h.emit({ type: 'opencode', projectID: 'project', sessionID: 'old' }); html = await h.flush()
    assert.match(html, /Lịch sử dịch vẫn hiển thị/)
    assert.equal(h.button('✓ Hoàn tất').props.disabled, false)
  } finally { h.unmount() }
})

test('stopping a response immediately reloads session status without a timer or event', async () => {
  const h = harness({ info: { translationSessionIDs: ['old'] } })
  try {
    h.updateSession({ id: 'old', title: 'Old translation', status: 'running' })
    h.updateMessages([{ id: 'question', role: 'assistant', kind: 'tool', text: '', tool: { name: 'question', status: 'running' } }])
    h.render(); assert.match(await h.flush(), /Đang chờ bạn trả lời câu hỏi…/)
    h.click('Dừng phản hồi'); const html = await h.flush()
    assert.deepEqual(h.calls.at(-1), { method: 'cancel', args: ['project', 'old'] })
    assert.doesNotMatch(html, /Đang chờ bạn trả lời câu hỏi…|Dừng phản hồi/)
    assert.match(html, /Câu hỏi trước đó đã bị gián đoạn/)
    assert.equal(h.button('✓ Hoàn tất').props.disabled, false)
  } finally { h.unmount() }
})

test('fallback and missing configuration are visible; disconnected and unconfigured cannot submit', async () => {
  const h = harness({ info: { configured: false, skill: undefined, fallbackToDefault: true, effectiveModelName: 'Default Model' } })
  h.render(); const html = await h.flush()
  assert.match(html, /Cài đặt → AmeKit/); assert.match(html, /model mặc định từ API: Default Model/)
  assert.equal(h.button('Cập nhật string mới').props.disabled, true)
  h.change('Dịch'); h.render(); h.submit(); await h.flush(); assert.equal(h.calls.length, 0)
  h.unmount()
  const offline = harness({ props: { connected: false } }); offline.render(); offline.change('Dịch'); offline.render(); offline.submit(); await offline.flush()
  assert.equal(offline.calls.length, 0); assert.match(offline.render(), /Chưa kết nối OpenCode/); offline.unmount()
})

test('pending session forms are rendered by Chat and translation and prevent finishing translation', async () => {
  for (const component of ['AndroidTranslationModal', 'Chat'] as const) {
    const h = harness({ component, info: { translationSessionIDs: ['translation-form'] }, props: component === 'Chat' ? { sessionID: 'translation-form' } : {} })
    h.updateForms([{ id: 'f', sessionID: 'translation-form', title: 'Chọn locale', fields: [{ key: 'locale', type: 'string' }] }])
    h.render(); const html = await h.flush()
    assert.match(html, /Pending form: Chọn locale/)
    if (component === 'AndroidTranslationModal') assert.equal(h.button('✓ Hoàn tất').props.disabled, true)
    h.unmount()
  }
})

test('lock failures do not close, and server locked rejection switches to read-only', async () => {
  const h = harness(); h.render(); await h.flush(); h.click('Quét key thiếu'); await h.flush()
  h.failLock('SAVE_FAILED'); h.click('✓ Hoàn tất'); await h.flush()
  assert.equal(h.closed, 0); assert.match(h.render(), /SAVE_FAILED/)
  h.failPrompt('TRANSLATION_SESSION_LOCKED'); h.change('Tiếp tục'); h.render(); h.submit(); await h.flush()
  assert.doesNotMatch(h.render(), /<textarea/); assert.match(h.render(), /khóa vĩnh viễn/)
  h.unmount()
})

test('double submission is gated and Escape closes without locking or cancelling', async () => {
  const h = harness(); h.render(); await h.flush()
  let resolve!: (value: unknown) => void
  h.delayPrompt(new Promise(yes => { resolve = yes })); h.change('Dịch'); h.render(); h.submit(); h.submit()
  assert.equal(h.calls.length, 1)
  h.key({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(h.closed, 1)
  h.unmount(); resolve({ session: { id: 'translation-1', title: 'Translation' }, model, locked: false }); await tick()
  assert.equal(h.calls.filter(call => ['lock', 'cancel'].includes(call.method)).length, 0)
})

test('resumed sessions display their pinned model rather than a changed feature default', async () => {
  const h = harness({ info: { translationSessionIDs: ['translation-old'], effectiveModelID: 'new-default', effectiveModelName: 'New default' } })
  h.updateSessionModel('previous-pinned-model')
  h.updateModels([{ id: 'previous-pinned-model', name: 'previous-pinned-model', providerID: 'amecode' }])
  h.render(); const html = await h.flush()
  assert.match(html, /Model: previous-pinned-model/)
  assert.doesNotMatch(html, /Model: New default/)
  h.unmount()
})

test('feature modals refresh info and active session pins on account and bundle updates without blocking continuation', async () => {
  for (const component of ['AndroidTranslationModal', 'CommitAgentModal'] as const) for (const event of ['ame-account-changed', 'ame-bundle-updated']) {
    const h = harness({ component, info: { translationSessionIDs: ['old'], effectiveModelID: 'default', effectiveModelName: 'Default' } })
    try {
      h.updateSession({ id: 'old', title: 'Existing', status: 'idle' })
      h.updateSessionModel('gemini')
      h.render(); let html = await h.flush()
      assert.match(html, /Model: Gemini Translation/)
      assert.doesNotMatch(html, /Model trước đó của phiên/)
      const before = h.loads
      // A matching ID from another provider must not keep the disabled pin alive.
      h.updateModels([{ ...model, providerID: 'external' }, { id: 'replacement', providerID: 'amecode', name: 'Replacement' }])
      h.updateInfo({ effectiveModelID: 'replacement', effectiveModelName: 'Replacement' })
      h.dispatch(event); html = await h.flush()
      assert.equal(h.loads.info, before.info + 1)
      assert.equal(h.loads.models, before.models + 1)
      assert.equal(h.loads.agentMap, before.agentMap + 1)
      assert.match(html, /Model: Replacement/)
      assert.doesNotMatch(html, /Model: Gemini Translation|Model: gemini/)
      assert.match(html, /role="status">Model trước đó của phiên đã bị vô hiệu hóa từ API\. Lượt tiếp theo sẽ tự động dùng model đang hoạt động: Replacement/)
      assert.equal(h.find(node => node.type === 'textarea').props.disabled, false)
      h.change('Tiếp tục'); h.render(); h.submit(); await h.flush()
      assert.equal(h.calls.find(call => call.method === 'prompt')?.args[1], 'old')
    } finally { h.unmount() }
    const after = h.loads
    h.dispatch(event); await tick()
    assert.deepEqual(h.loads, after, 'unmount removes info and model refresh listeners')
  }
})

test('active pins survive refreshes and missing pins use the effective model ID when its name is absent', async () => {
  for (const component of ['AndroidTranslationModal', 'CommitAgentModal'] as const) {
    const h = harness({ component, info: { translationSessionIDs: ['old'], effectiveModelID: 'replacement', effectiveModelName: undefined } })
    try {
      h.updateSessionModel('gemini')
      h.render(); await h.flush()
      h.dispatch('ame-bundle-updated'); let html = await h.flush()
      assert.match(html, /Model: Gemini Translation/)
      assert.doesNotMatch(html, /Model trước đó của phiên/)
      h.updateSessionModel('disabled-id')
      h.dispatch('ame-bundle-updated'); html = await h.flush()
      assert.match(html, /Model: replacement/)
      assert.doesNotMatch(html, /disabled-id/)
      h.click(component === 'AndroidTranslationModal' ? 'Phiên dịch mới' : 'Phiên mới')
      assert.doesNotMatch(h.render(), /Model trước đó của phiên/)
    } finally { h.unmount() }
  }
})

test('unlocked translation session hides regular composer and routes continuation back to translation', async () => {
  let opened = 0, created = 0
  const h = harness({ component: 'Chat', props: { sessionID: 'translation-open', onOpenAndroidTranslation() { opened++ }, onCreate() { created++ } }, info: { translationSessionIDs: ['translation-open'] } })
  h.render(); const html = await h.flush()
  assert.match(html, /Đây là phiên Dịch Android riêng/)
  assert.doesNotMatch(html, /<textarea/)
  h.click('Dịch Android'); assert.equal(opened, 1)
  const btw = h.find(node => node.type === 'button' && node.props['aria-label'] === '/btw')
  ;(btw.props.onClick as () => void)(); h.render()
  assert.doesNotMatch(h.render(), /<textarea/)
  h.click('Cuộc trò chuyện mới'); assert.equal(created, 1)
  h.unmount()
})

test('regular Chat filters authorized feature models and renders locked translation banner without composer', async () => {
  const h = harness({ component: 'Chat', props: { sessionID: 'translation-locked' }, info: { lockedSessionIDs: ['translation-locked'], translationSessionIDs: ['translation-locked'] } })
  h.render(); const html = await h.flush()
  assert.match(html, /translation-locked-banner/); assert.match(html, /được khóa để tránh dùng nhầm model/)
  assert.doesNotMatch(html, /<textarea/); assert.match(html, /android-translate-trigger/)
  const filter = h.exports.chatModelsForPolicy as (models: unknown[], role?: string, defaultModel?: string) => { id: string }[]
  const models = [{ id: 'default', providerID: 'amecode' }, model, { id: 'other', providerID: 'external' }]
  assert.deepEqual(Array.from(filter(models, 'user', 'default'), item => item.id), ['default'])
  assert.equal(filter([model], 'user', 'missing').length, 0)
  assert.equal(filter(models, 'user', undefined).length, 0)
  assert.deepEqual(Array.from(filter(models, 'admin'), item => item.id), ['default', 'gemini'])
  h.unmount()
})
