import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { ChatItem, Session } from '../../../../../packages/protocol/src/index'
import { formatUserMessageTime, isLikelyLongUserText } from '../chat-timeline'

test('formatUserMessageTime and isLikelyLongUserText cover boundaries and invalid inputs', () => {
  const now = 1_700_000_000_000
  for (const invalid of [undefined, NaN, Infinity, -1, 0]) assert.equal(formatUserMessageTime(invalid, now), '')
  assert.equal(formatUserMessageTime(now + 5_000, now), 'Vừa xong')
  assert.equal(formatUserMessageTime(now - 59_999, now), 'Vừa xong')
  assert.equal(formatUserMessageTime(now - 8 * 60_000, now), '8 phút trước')
  assert.equal(formatUserMessageTime(now - 39 * 60_000, now), '39 phút trước')
  assert.equal(formatUserMessageTime(now - 3 * 3_600_000, now), '3 giờ trước')
  assert.equal(formatUserMessageTime(now - 2 * 86_400_000, now), '2 ngày trước')
  const old = now - 40 * 86_400_000
  assert.equal(formatUserMessageTime(old, now), new Date(old).toLocaleDateString('vi-VN'))

  assert.equal(isLikelyLongUserText('Run npm test'), false)
  assert.equal(isLikelyLongUserText('1\n2\n3\n4\n5\n6'), false)
  assert.equal(isLikelyLongUserText('1\n2\n3\n4\n5\n6\n7'), true)
  assert.equal(isLikelyLongUserText('a'.repeat(421)), true)
})

function harness(items: ChatItem[], options: { clipboard?: boolean } = {}) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  let cursor = 0, effectIndex = 0, writes = 0, tree: ReactNode
  let selectedText = ''
  const copied: string[] = []
  const session: Session = { id: 'session', title: 'Chat', status: 'idle' }
  let mockGroup: { contains: (target: unknown) => boolean } | null = null
  const hooks = {
    memo: (component: unknown) => component,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (fn: unknown) => fn,
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => { const value = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(value, slots[index])) { slots[index] = value; writes++ } }]
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useId() { return `id-${cursor++}` },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot() },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, old = effects[index]
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
    },
  }
  const api = {
    async messages() { return items },
    async permissions() { return [] },
    async forms() { return [] },
    async sessionPermissionMode() { return 'default' },
    async models() { return [{ id: 'default', providerID: 'amecode', name: 'Default' }] },
    async commands() { return [] },
    async skills() { return [] },
    onEvent() { return () => {} },
    async androidTranslationInfo() { return { lockedSessionIDs: [], translationSessionIDs: [] } },
    async commitAgentSessionState() { return { lockedSessionIDs: [], commitSessionIDs: [] } },
  }
  const marker = () => null, nativeRequire = createRequire(import.meta.url), exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync(new URL('../components/Chat.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports, Error, setTimeout, clearTimeout,
    navigator: options.clipboard === false ? {} : { clipboard: { writeText: async (value: string) => { copied.push(value) } } },
    window: {
      ame: api,
      getSelection: () => ({ toString: () => selectedText }),
      addEventListener(name: string, fn: (...args: any[]) => void) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name)!.add(fn)
      },
      removeEventListener(name: string, fn: (...args: any[]) => void) { listeners.get(name)?.delete(fn) },
    },
    require(name: string) {
      if (name === 'react') return hooks
      if (name === '../chat-refresh') return { createChatRefresh: (load: () => Promise<void>) => ({ request() { void load() }, dispose() {} }) }
      if (name.startsWith('./')) return new Proxy({}, { get: (_, key) => key === 'errorText' ? String : marker })
      return nativeRequire(name)
    },
  })
  const Component = exports.Chat as (props: object) => ReactNode
  const props = { projectID: 'project', sessionID: 'session', connected: true, ready: true, accountRole: 'user', defaultModelID: 'default', modelLevels: {}, sessions: [session], tabs: [], changes: 0, changesStatus: 'ready', theme: 'dark', onActivity() {}, onOpenFile() {}, onCreated() {}, onCreate() {}, report() {}, onOpenPanel() {}, onSelectSession() {} }
  function render() {
    for (let pass = 0; pass < 15; pass++) {
      const before = writes; cursor = 0; effectIndex = 0; tree = Component(props); pending.splice(0).forEach(run => run())
      if (writes === before) return renderToStaticMarkup(tree)
    }
    throw new Error('Effects did not settle')
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    if (typeof node.type === 'function' && node.type.name === 'ChatTurnView') return [node, ...all((node.type as any)(node.props))]
    return [node, ...all(node.props.children as ReactNode)]
  }
  const byTestID = (id: string) => all(tree).filter(node => node.props['data-testid'] === id)
  const setTimelineGroup = (group: { contains: (target: unknown) => boolean } | null) => {
    mockGroup = group
    const stream = all(tree).find(node => typeof node.props.className === 'string' && node.props.className.split(' ').includes('chat-stream'))
    const timelineRef = (stream?.props as any)?.ref ?? (stream as any)?.ref
    assert.ok(timelineRef && 'current' in timelineRef, 'Expected chat-stream ref')
    timelineRef.current = { querySelector: (selector: string) => selector.includes('data-user-group') ? mockGroup : null }
  }
  return {
    render, byTestID, copied, setSelection(value: string) { selectedText = value }, setTimelineGroup,
    emit(name: string, event: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(event) },
    async flush() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); render() } return render() },
    unmount() { effects.forEach(effect => effect.cleanup?.()); assert.equal([...listeners.values()].reduce((sum, set) => sum + set.size, 0), 0) },
  }
}

test('long user prompts collapse by default, expand on click, stay bounded/scrollable, and collapse on outside click or Escape', async () => {
  const longText = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: detail line`).join('\n')
  const shortText = 'Run npm test'
  const items: ChatItem[] = [
    { id: 'u-long', role: 'user', text: longText, createdAt: Date.now() - 8 * 60_000 },
    { id: 'a-1', role: 'assistant', text: 'Done' },
    { id: 'u-short', role: 'user', text: shortText, createdAt: Date.now() - 2 * 60_000 },
  ]
  const h = harness(items)
  try {
    h.render(); await h.flush()
    const bubbles = () => h.byTestID('msg-user')
    assert.equal(bubbles().length, 2)
    assert.match(String(bubbles()[0].props.className), /\bis-collapsible\b/)
    assert.doesNotMatch(String(bubbles()[0].props.className), /\bis-expanded\b/)
    assert.equal(bubbles()[0].props['aria-expanded'], false)
    assert.doesNotMatch(String(bubbles()[1].props.className), /\bis-collapsible\b/)
    assert.equal(bubbles()[1].props['aria-expanded'], undefined)

    // Text selection does not hijack click into expansion.
    h.setSelection('Line 1')
    ;(bubbles()[0].props.onClick as (event: unknown) => void)({ target: {} })
    h.render()
    assert.equal(bubbles()[0].props['aria-expanded'], false)

    // Clicking normally expands the bubble.
    h.setSelection('')
    ;(bubbles()[0].props.onClick as (event: unknown) => void)({ target: {} })
    h.render()
    assert.match(String(bubbles()[0].props.className), /\bis-expanded\b/)
    assert.equal(bubbles()[0].props['aria-expanded'], true)

    // Clicking inside the active group preserves expansion.
    const insideTarget = { tag: 'inside' }
    h.setTimelineGroup({ contains: target => target === insideTarget })
    h.emit('pointerdown', { target: insideTarget })
    h.render()
    assert.equal(bubbles()[0].props['aria-expanded'], true)

    // Clicking outside collapses back.
    h.emit('pointerdown', { target: { tag: 'outside' } })
    h.render()
    assert.equal(bubbles()[0].props['aria-expanded'], false)
    assert.doesNotMatch(String(bubbles()[0].props.className), /\bis-expanded\b/)

    // Re-expand via keyboard Enter and collapse via Escape.
    let prevented = false
    ;(bubbles()[0].props.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault() { prevented = true } })
    h.render()
    assert.equal(prevented, true)
    assert.equal(bubbles()[0].props['aria-expanded'], true)
    h.emit('keydown', { key: 'Escape', defaultPrevented: false })
    h.render()
    assert.equal(bubbles()[0].props['aria-expanded'], false)
  } finally { h.unmount() }
})

test('user message hover bar renders time, copy action, and rewind trigger', async () => {
  const items: ChatItem[] = [
    { id: 'u-1', role: 'user', text: 'Check prompt actions', createdAt: Date.now() - 8 * 60_000 },
  ]
  const h = harness(items)
  try {
    h.render(); await h.flush()
    const metas = h.byTestID('user-msg-meta')
    assert.equal(metas.length, 1)
    const metaHtml = renderToStaticMarkup(metas[0])
    assert.match(metaHtml, /8 phút trước/)
    assert.match(metaHtml, /data-testid="user-msg-copy"/)
    assert.match(metaHtml, /data-testid="rewind-trigger"/)

    const copyBtn = h.byTestID('user-msg-copy')[0]
    ;(copyBtn.props.onClick as () => void)()
    await h.flush()
    assert.deepEqual(h.copied, ['Check prompt actions'])
    assert.match(String(h.byTestID('user-msg-copy')[0].props.className), /\bis-active\b/)
    assert.equal(h.byTestID('user-msg-copy')[0].props['data-tooltip'], 'Đã sao chép')
  } finally { h.unmount() }
})


test('collapsible bubble has role=button, ignores Escape from composer/defaultPrevented, and copyUserTurn guards missing clipboard', async () => {
  const longText = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: detail line`).join('\n')
  const items: ChatItem[] = [
    { id: 'u-long', role: 'user', text: longText, createdAt: Date.now() - 8 * 60_000 },
  ]
  const h = harness(items, { clipboard: false })
  try {
    h.render(); await h.flush()
    const bubble = () => h.byTestID('msg-user')[0]
    assert.equal(bubble().props.role, 'button')
    assert.equal(bubble().props['aria-expanded'], false)

    // Expand bubble
    ;(bubble().props.onClick as (event: unknown) => void)({ target: {} })
    h.render()
    assert.equal(bubble().props['aria-expanded'], true)

    // Escape targeting TEXTAREA or defaultPrevented must NOT collapse expanded bubble
    h.emit('keydown', { key: 'Escape', defaultPrevented: false, target: { tagName: 'TEXTAREA' } })
    h.render()
    assert.equal(bubble().props['aria-expanded'], true)

    h.emit('keydown', { key: 'Escape', defaultPrevented: true })
    h.render()
    assert.equal(bubble().props['aria-expanded'], true)

    // copyUserTurn without navigator.clipboard does not falsely mark copied
    const copyBtn = h.byTestID('user-msg-copy')[0]
    await (copyBtn.props.onClick as () => Promise<void>)()
    await h.flush()
    assert.equal(h.byTestID('user-msg-copy')[0].props['data-tooltip'], 'Sao chép')
    assert.doesNotMatch(String(h.byTestID('user-msg-copy')[0].props.className), /\bis-active\b/)
  } finally { h.unmount() }
})
