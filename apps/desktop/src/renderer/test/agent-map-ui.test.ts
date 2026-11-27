import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { AgentMapNode, AgentMapView, IdeEvent, Session } from '../../../../../packages/protocol/src/index'
import * as model from '../agent-map-model'
import { AgentMap, type AgentMapProps } from '../components/AgentMap'
import { Icon } from '../components/Icon'
import { MessageContent } from '../components/MessageContent'
import { errorText, IconButton } from '../components/Primitives'
import { CopyButton } from '../components/ToolCard'

function node(id: string, depth = 0, parentID?: string, extra: Partial<AgentMapNode> = {}): AgentMapNode {
  return { id, depth, parentID, title: id, agent: 'coder', status: 'idle', outcome: 'succeeded', model: 'gpt-6.1-sol',
    tokens: { input: 1000, output: 200, reasoning: 50, cacheRead: 100, cacheWrite: 20, total: 1370 },
    prompt: 'Update layout', promptCount: 1, output: '', skills: [], tools: [], childIDs: [], historyComplete: true, durationMs: 61000, ...extra }
}
function view(nodes: AgentMapNode[]): AgentMapView { return { rootID: 'root', activeSessionID: 'a', nodes, limited: false, fetchedAt: 1 } }
const family = view([
  node('root', 0, undefined, { title: 'Main agent', childIDs: ['a', 'b'] }),
  node('a', 1, 'root', { title: 'Android layout', status: 'running', outcome: undefined, childIDs: ['a2'], skills: [{ name: 'android-dev', count: 2 }, { name: 'ui-layout', count: 1 }, { name: 'testing', count: 1 }, { name: 'extra', count: 1 }], latestPrompt: 'Verify changes', promptCount: 2,
    output: '**Verified** `src/app.ts:1`\n\n```ts\nconst ok = true\n```', tools: [{ name: 'edit_file', calls: 2, errors: 1, running: 1, durationMs: 2500 }], historyComplete: false }),
  node('b', 1, 'root', { outcome: 'failed', error: '<lint failed>' }), node('a2', 2, 'a', { childIDs: ['a3'] }), node('a3', 3, 'a2'),
])
const props: AgentMapProps = { projectID: 'project', sessionID: 'a', connected: false, initialView: family, onSelectSession() {}, onClose() {}, onOpenFile() {} }
const markup = (extra: Partial<AgentMapProps> = {}) => renderToStaticMarkup(createElement(AgentMap, { ...props, ...extra }))

function flatten(roots: model.AgentMapTreeNode[]): string[] { return roots.flatMap(branch => [branch.node.id, ...flatten(branch.children)]) }

test('session family resolves from deepest child without IPC and excludes unrelated sessions', () => {
  const sessions: Session[] = family.nodes.map(item => ({ id: item.id, title: item.title, parentID: item.parentID, status: item.status }))
  sessions.push({ id: 'other', title: 'Other', status: 'running' })
  const before = JSON.stringify(sessions)
  assert.deepEqual(model.familySummaryFromSessions(sessions, 'a3'), { rootID: 'root', totalAgents: 5, subagentCount: 4, runningCount: 1 })
  assert.deepEqual(model.familySummaryFromSessions(sessions), { totalAgents: 0, subagentCount: 0, runningCount: 0 })
  assert.deepEqual(model.familySummaryFromSessions(sessions, 'missing'), { rootID: 'missing', totalAgents: 0, subagentCount: 0, runningCount: 0 })
  assert.equal(JSON.stringify(sessions), before)
  assert.equal(model.familySummaryFromSessions([{ id: 'x', title: 'X', parentID: 'y' }, { id: 'y', title: 'Y', parentID: 'x' }], 'x').totalAgents, 2)
  assert.equal(model.familySummaryFromSessions([{ id: 'x', title: 'X', parentID: 'missing' }], 'x').rootID, 'x')
})

test('tree builds stable nested branches from shuffled BFS nodes, deduplicates and preserves malformed nodes', () => {
  const snapshot = JSON.stringify(family)
  const tree = model.buildAgentMapTree(family)
  assert.deepEqual(flatten(tree.roots), ['root', 'a', 'a2', 'a3', 'b'])
  assert.deepEqual(tree.summary, { totalAgents: 5, subagentCount: 4, runningCount: 1, failedCount: 1, maxDepth: 3 })
  assert.equal(tree.byID.get('a'), family.nodes[1])
  const shuffled = view([family.nodes[4], family.nodes[3], family.nodes[1], family.nodes[0], family.nodes[2], family.nodes[1]])
  assert.deepEqual(flatten(model.buildAgentMapTree(shuffled).roots), ['root', 'a', 'a2', 'a3', 'b'])
  const malformed = view([node('root'), node('x', 1, 'y'), node('y', 2, 'x'), node('self', 1, 'self'), node('orphan', 2, 'absent'), node('fallback', 1)])
  const ids = flatten(model.buildAgentMapTree(malformed).roots)
  assert.equal(ids.length, 6)
  assert.equal(new Set(ids).size, 6)
  assert.ok(model.buildAgentMapTree(malformed).roots[0].children.some(child => child.node.id === 'orphan'))
  assert.equal(JSON.stringify(family), snapshot)
  assert.deepEqual(model.buildAgentMapTree(view([])).summary, { totalAgents: 0, subagentCount: 0, runningCount: 0, failedCount: 0, maxDepth: 0 })
})

test('duration and token formatting cover boundaries and invalid durations', () => {
  for (const value of [undefined, NaN, Infinity, -1]) assert.equal(model.formatAgentDuration(value), '')
  for (const [value, text] of [[0, '<1s'], [999, '<1s'], [1000, '1s'], [59999, '59s'], [60000, '1m'], [61000, '1m 1s'], [3599999, '59m 59s'], [3600000, '1h 0m'], [7260000, '2h 1m']] as const) assert.equal(model.formatAgentDuration(value), text)
  for (const [value, text] of [[0, '0'], [999.4, '999'], [1000, '1k'], [1250, '1.3k'], [42200, '42.2k'], [100000, '100k'], [999999, '1000k'], [1000000, '1.0M'], [1250000, '1.3M']] as const) assert.equal(model.formatAgentTokens(value), text)
})

test('status prioritizes live running state over prior outcomes', () => {
  const labels = { succeeded: 'Hoàn tất', failed: 'Thất bại', interrupted: 'Đã dừng' } as const
  for (const outcome of ['succeeded', 'failed', 'interrupted'] as const) assert.deepEqual(model.agentStatusInfo(node('x', 0, undefined, { outcome })), { tone: outcome, label: labels[outcome] })
  assert.deepEqual(model.agentStatusInfo(node('x', 0, undefined, { status: 'running', outcome: 'failed' })), { tone: 'running', label: 'Đang chạy' })
  assert.deepEqual(model.agentStatusInfo(node('x', 0, undefined, { outcome: undefined })), { tone: 'idle', label: 'Đang chờ' })
})

test('map SSR renders depth cards, connectors, active state, compact skills and safe valid buttons', () => {
  const html = markup({ initialView: { ...family, limited: true } })
  assert.ok(html.includes('class="agent-map-dialog"'))
  assert.ok(!html.includes('agent-map-dialog--detail'))
  assert.ok(markup({ initialSelectedID: 'missing' }).includes('class="agent-map-dialog"'))
  for (const text of ['role="dialog"', 'aria-label="Agent map"', '4 subagent', '1 đang chạy', 'Hiển thị tối đa 200 tác nhân', 'agent-map-children', 'agent-map-child', '/android-dev ×2', '+1', 'Đang xem', 'data-depth="3"', 'data-status="failed"', 'aria-expanded="true"']) assert.ok(html.includes(text), text)
  assert.equal((html.match(/data-agent-node-id=/g) ?? []).length, 5)
  let open = false
  for (const tag of html.match(/<\/?button\b[^>]*>/g) ?? []) {
    if (tag.startsWith('</')) { assert.ok(open); open = false }
    else { assert.equal(open, false, 'buttons must never nest'); open = true }
  }
  assert.equal(open, false)
  const escaped = markup({ initialView: view([node('root', 0, undefined, { title: '<script>alert(1)</script>', skills: [{ name: '<img onerror=bad>', count: 1 }] })]) })
  assert.ok(escaped.includes('&lt;script&gt;'))
  assert.ok(escaped.includes('/&lt;img onerror=bad&gt;'))
  assert.ok(!escaped.includes('<script>'))
})

test('map SSR has deterministic initial loading, empty and disconnected retry states', () => {
  assert.ok(markup({ initialView: view([]) }).includes('Chưa có dữ liệu Agent map.'))
  assert.ok(markup({ initialView: undefined, connected: true }).includes('Đang tải Agent map…'))
  const offline = markup({ initialView: undefined })
  assert.ok(offline.includes('role="alert"'))
  assert.ok(offline.includes('Chưa kết nối máy chủ OpenCode.'))
  assert.ok(offline.includes('Thử lại'))
})

test('detail SSR renders parent/child navigation, prompts, Markdown file links, metrics and actions', () => {
  const html = markup({ initialSelectedID: 'a', sessionID: 'root', connected: true })
  assert.ok(html.includes('class="agent-map-dialog agent-map-dialog--detail"'))
  for (const text of ['Quay lại Agent map', 'M19 12H5m6 6-6-6 6-6', 'Android layout', 'Được gọi bởi', 'Main agent', 'Đã gọi subagent:', 'a2', 'Skills đã gọi', '/android-dev ×2', 'Prompt đầu vào', 'Update layout', 'Prompt gần nhất (2 lượt)', 'Verify changes', 'Kết quả đầu ra', '<strong>Verified</strong>', 'class="file-chip"', 'src/app.ts:1', 'Sao chép prompt', 'Sao chép kết quả', 'Công cụ đã dùng (1)', 'edit_file', 'Mở phiên', 'Dừng', 'In 1k', 'Out 200', 'Reasoning 50', 'Cache 120', 'subagent L1', 'Lịch sử chưa đầy đủ']) assert.ok(html.includes(text), text)
  assert.ok(markup({ initialSelectedID: 'a' }).includes('Đang mở'))
  assert.ok(markup({ initialSelectedID: 'root' }).includes('Tác nhân gốc (Main agent)'))
  const failed = markup({ initialSelectedID: 'b' })
  assert.ok(failed.includes('&lt;lint failed&gt;'))
  assert.ok(failed.includes('role="alert"'))
  assert.ok(!failed.includes('agent-map-action--danger'))
  const empty = markup({ initialSelectedID: 'a2' })
  for (const text of ['Không gọi skill nào', 'Chưa có phản hồi text từ agent này.']) assert.ok(empty.includes(text))
  const running = markup({ initialView: view([node('root', 0, undefined, { status: 'running', output: '', prompt: '' })]), initialSelectedID: 'root' })
  assert.ok(running.includes('Đang xử lý và tạo kết quả…'))
  assert.ok(running.includes('Chưa ghi nhận prompt đầu vào.'))
})

// Execute the real component effects with controlled hooks/timers, without adding a DOM dependency.
function liveHarness() {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = []
  let cursor = 0, effectIndex = 0, now = 0, writes = 0
  const pending: (() => void)[] = []
  const timers = new Map<number, { at: number; fn: () => void }>()
  let timerID = 0, subscription: ((event: IdeEvent) => void) | undefined, unsubscriptions = 0
  const requests: { project: string; session: string; resolve: (next: AgentMapView) => void; reject: (error: Error) => void }[] = []
  const listeners = new Map<string, (event: unknown) => void>()
  const nativeRequire = createRequire(import.meta.url)
  const react = {
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next: unknown) => { writes++; slots[index] = typeof next === 'function' ? next(slots[index]) : next }] },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) { const index = effectIndex++, old = effects[index]; if (!old || deps.some((dep, i) => dep !== old.deps[i])) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } }) },
  }
  const exports: Record<string, unknown> = {}
  const source = readFileSync(new URL('../components/AgentMap.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, require: (name: string) => {
    if (name === 'react') return react
    if (name === '../agent-map-model') return model
    if (name === './Icon') return { Icon }
    if (name === './MessageContent') return { MessageContent }
    if (name === './Primitives') return { errorText, IconButton }
    if (name === './ToolCard') return { CopyButton }
    return nativeRequire(name)
  }, document: { activeElement: null }, window: {
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name),
    ame: { agentMap: (project: string, session: string) => new Promise((resolve, reject) => requests.push({ project, session, resolve, reject })), onEvent: (fn: (event: IdeEvent) => void) => { subscription = fn; return () => { unsubscriptions++; subscription = undefined } } },
  }, setTimeout: (fn: () => void, delay: number) => { const id = ++timerID; timers.set(id, { fn, at: now + delay }); return id }, clearTimeout: (id: number) => timers.delete(id) })
  const Component = exports.AgentMap as typeof AgentMap
  let currentProps = { ...props, initialView: undefined, connected: true } as AgentMapProps
  function render(extra: Partial<AgentMapProps> = {}) {
    currentProps = { ...currentProps, ...extra }; cursor = 0; effectIndex = 0
    const result = Component(currentProps)
    pending.splice(0).forEach(run => run())
    return renderToStaticMarkup(result)
  }
  async function flush() { await new Promise<void>(resolve => setImmediate(resolve)); return render() }
  async function advance(ms: number) {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
    return flush()
  }
  return { render, flush, advance, requests, timers, listeners, event: (projectID: string, kind?: 'stream' | 'session') => subscription?.({ type: 'opencode', projectID, ...(kind ? { kind } : {}) } as IdeEvent), get unsubscriptions() { return unsubscriptions }, unmount: () => effects.forEach(effect => effect.cleanup?.()), get writes() { return writes } }
}

test('live effects debounce project events, poll only running nodes, retain view on failed refresh, and clean up', async () => {
  const h = liveHarness()
  h.render()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(family)
  assert.ok((await h.flush()).includes('Android layout'))
  h.event('other'); await h.advance(250)
  assert.equal(h.requests.length, 1)
  h.event('project', 'stream'); await h.advance(300)
  assert.equal(h.requests.length, 1, 'stream events must not trigger agent-map fetches')
  h.event('project'); await h.advance(100); h.event('project'); await h.advance(249)
  assert.equal(h.requests.length, 1)
  await h.advance(1)
  assert.equal(h.requests.length, 2)
  h.requests[1].reject(new Error('<refresh failed>'))
  const failed = await h.flush()
  assert.ok(failed.includes('Android layout'))
  assert.ok(failed.includes('&lt;refresh failed&gt;'))
  assert.ok(failed.includes('Thử lại'))
  await h.advance(2500)
  assert.equal(h.requests.length, 3)
  h.requests[2].resolve(view([node('root')]))
  await h.flush(); await h.advance(5000)
  assert.equal(h.requests.length, 3)
  h.event('project')
  assert.ok(h.timers.size > 0)
  h.unmount()
  assert.equal(h.timers.size, 0)
  assert.equal(h.unsubscriptions, 1)
  assert.equal(h.listeners.size, 0)
})

test('live effects discard stale success/failure on project/session changes and after unmount', async () => {
  const h = liveHarness()
  h.render()
  h.render({ projectID: 'next', sessionID: 'next-session' })
  assert.equal(h.unsubscriptions, 1)
  assert.deepEqual(h.requests.map(request => [request.project, request.session]), [['project', 'a'], ['next', 'next-session']])
  h.requests[1].resolve(view([node('new-view')]))
  assert.ok((await h.flush()).includes('new-view'))
  h.requests[0].resolve(view([node('stale-view')]))
  const html = await h.flush()
  assert.ok(html.includes('new-view')); assert.ok(!html.includes('stale-view'))
  h.render({ sessionID: 'third' })
  h.render({ sessionID: 'fourth' })
  h.requests[2].reject(new Error('stale-error'))
  assert.ok(!(await h.flush()).includes('stale-error'))
  h.unmount()
  const writes = h.writes
  h.requests[3].resolve(family)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.writes, writes, 'unmounted component must not update state')
  assert.equal(h.timers.size, 0)
  assert.equal(h.unsubscriptions, 4)
})

test('Escape returns from detail before closing map, and disconnected snapshots do not fetch', async () => {
  const h = liveHarness()
  let closes = 0
  const detail = h.render({ connected: false, initialView: family, initialSelectedID: 'a', onClose: () => { closes++ } })
  assert.ok(detail.includes('class="agent-map-dialog agent-map-dialog--detail"'))
  assert.equal(h.requests.length, 0)
  const escape = () => h.listeners.get('keydown')?.({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  escape()
  const html = await h.flush()
  assert.ok(html.includes('data-agent-node-id="a"'))
  assert.ok(html.includes('class="agent-map-dialog"'))
  assert.ok(!html.includes('agent-map-dialog--detail'))
  assert.equal(closes, 0)
  escape()
  assert.equal(closes, 1)
  h.unmount()
})
