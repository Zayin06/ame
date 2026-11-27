import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript'
import type { ChatItem, TodoItem } from '../../../../../packages/protocol/src/index'
import { extractValidTodos, projectSessionTodos, type ExecutionTodoSnapshot } from '../chat-todo'
import { TodoProgressCard } from '../components/TodoProgressCard'
import { Icon } from '../components/Icon'
import { formatAgentDuration } from '../chat-timeline'

const todo = (content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({ content, status })
const message = (id: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id, role: 'assistant', text: id, ...extra })
const user = (id: string, executionID?: string) => message(id, { role: 'user', executionID })
const write = (id: string, todos: TodoItem[], extra: Partial<ChatItem> = {}): ChatItem => message(id, {
  kind: 'tool', tool: { name: 'todowrite', status: 'completed' }, todos, ...extra,
})
const project = (messages: readonly ChatItem[], running = false) => projectSessionTodos(messages, { running })
const snapshot = (todos: TodoItem[], active = false, outcome?: ExecutionTodoSnapshot['outcome']): ExecutionTodoSnapshot => {
  const value = projectSessionTodos([user('user', 'execution'), write('write', todos, { executionID: 'execution' })], { running: active, sessionOutcome: outcome }).composer
  assert.ok(value)
  return value
}
const mixed = [todo('Read context', 'completed'), todo('Implement', 'in_progress'), todo('Verify', 'in_progress'), todo('Document'), todo('Old scope', 'cancelled')]

test('completed normalized todowrite extracts all four statuses, trims content and preserves order and duplicates', () => {
  const todos = [todo('  First  '), todo('Work', 'in_progress'), todo('Work', 'in_progress'), todo('Done', 'completed'), todo('Dropped', 'cancelled')]
  const item = write('write', todos, { tool: { name: ' ToDoWrItE ', status: 'completed' } })
  assert.deepEqual(extractValidTodos(item), [todo('First'), ...todos.slice(1)])
  assert.deepEqual(extractValidTodos(write('empty', [])), [])
})

test('only completed todowrite tool items are authoritative, never text, output or running/error tools', () => {
  for (const status of ['streaming', 'running', 'error'] as const) {
    assert.equal(extractValidTodos(write(status, mixed, { tool: { name: 'todowrite', status } })), undefined)
  }
  for (const name of ['todo', 'todoread', 'namespace.todowrite', 'todowrite_extra', 'task', '']) {
    assert.equal(extractValidTodos(write(name, mixed, { tool: { name, status: 'completed' } })), undefined)
  }
  for (const kind of [undefined, 'reasoning', 'error', 'changes']) {
    assert.equal(extractValidTodos(write('not-tool', mixed, { kind })), undefined)
  }
  assert.equal(extractValidTodos(message('missing', { kind: 'tool', todos: mixed })), undefined)
  assert.equal(extractValidTodos(message('prose', { text: JSON.stringify({ todos: mixed }) })), undefined)
  assert.equal(extractValidTodos(message('output', { kind: 'tool', tool: { name: 'todowrite', status: 'completed', output: JSON.stringify({ todos: mixed }) } })), undefined)
})

test('item.todos takes precedence including explicit empty and invalid values; fallback requires plain-object input', () => {
  const input = { todos: [todo('Fallback')] }
  const item = write('write', [todo('Preferred')], { tool: { name: 'todowrite', status: 'completed', input } })
  assert.deepEqual(extractValidTodos(item), [todo('Preferred')])
  assert.deepEqual(extractValidTodos({ ...item, todos: [] }), [])
  for (const todos of [null, '[]', {}, [todo('Bad', 'unknown' as TodoItem['status'])]]) {
    assert.equal(extractValidTodos({ ...item, todos } as ChatItem), undefined)
  }
  for (const fallback of [input, Object.assign(Object.create(null), input)]) {
    assert.deepEqual(extractValidTodos({ ...item, todos: undefined, tool: { ...item.tool!, input: fallback } }), input.todos)
  }
  class WrappedInput { todos = input.todos }
  for (const fallback of [undefined, null, [], JSON.stringify(input), 1, new WrappedInput(), Object.assign([], input), new Map([['todos', input.todos]])]) {
    assert.equal(extractValidTodos({ ...item, todos: undefined, tool: { ...item.tool!, input: fallback } }), undefined)
  }
})

test('validation rejects the entire snapshot for malformed entries, blank content or inexact statuses', () => {
  class WrappedTodo { content = 'Wrapped'; status = 'pending' }
  for (const invalid of [null, undefined, [], 'task', 3, {}, { content: 'Task' }, { status: 'pending' },
    { content: '', status: 'pending' }, { content: ' \n\t ', status: 'pending' }, { content: 42, status: 'pending' },
    ...['PENDING', ' pending', 'in-progress', 'done', 'canceled', '', null, 1].map(status => ({ content: 'Task', status })), new WrappedTodo()]) {
    assert.equal(extractValidTodos(write('invalid', [todo('Valid'), invalid] as TodoItem[])), undefined)
  }
  assert.deepEqual(extractValidTodos(write('null-prototype', [Object.assign(Object.create(null), todo('Valid'))])), [todo('Valid')])
})

test('execution projection keeps the latest valid replacement list and counts multiple simultaneous in-progress items', () => {
  const items = [user('u', 'e'), write('initial', [todo('Superseded')], { executionID: 'e' }), write('latest', mixed, { executionID: 'e' }),
    write('running', [todo('Not committed')], { executionID: 'e', tool: { name: 'todowrite', status: 'running' } }),
    write('bad', [todo('Invalid', 'done' as TodoItem['status'])], { executionID: 'e' })]
  const view = project(items, true)
  assert.deepEqual(view.composer, { executionID: 'e', anchorTurnID: 'u', todos: mixed, completedCount: 1, inProgressCount: 2, pendingCount: 1, cancelledCount: 1, totalCount: 5, active: true, outcome: undefined })
  assert.equal(view.byTurnID.u, view.composer)
  assert.deepEqual(project([]), { composer: undefined, byTurnID: {} })
})

test('markdown checkboxes and prose never create a structured todo list', () => {
  for (const text of ['- [ ] Implement\n- [x] Read context', 'Plan: implement, verify, then document.', 'Todo: finish the requested work']) {
    const view = project([user('u'), message('plan', { text })], true)
    assert.equal(view.composer, undefined)
    assert.deepEqual(view.byTurnID, {})
  }
})

test('incremental completed writes update counts without changing the execution or history anchor', () => {
  const items = [user('u', 'e')]
  for (let completed = 0; completed <= 3; completed++) {
    const todos = ['Implement', 'Verify', 'Document'].map((content, index) => todo(content, index < completed ? 'completed' : index === completed ? 'in_progress' : 'pending'))
    items.push(write(`update-${completed}`, todos, { executionID: 'e' }))
    const view = project(items, completed < 3)
    assert.equal(view.composer?.executionID, 'e')
    assert.equal(view.composer?.anchorTurnID, 'u')
    assert.equal(view.composer?.completedCount, completed)
    assert.equal(view.composer?.totalCount, 3)
    assert.equal(view.composer?.inProgressCount, completed < 3 ? 1 : 0)
    assert.equal(view.composer?.pendingCount, Math.max(0, 2 - completed))
    assert.deepEqual(view.composer?.todos, todos)
    assert.deepEqual(Object.keys(view.byTurnID), ['u'])
  }
})

test('running, streaming and failed writes preserve the last committed list, including attempted empty clears', () => {
  for (const status of ['running', 'streaming', 'error'] as const) for (const todos of [[], [todo('Uncommitted replacement', 'completed')]]) {
    const items = [user('u', 'e'), write('committed', mixed, { executionID: 'e' }), write('uncommitted', todos, { executionID: 'e', tool: { name: 'todowrite', status } })]
    const view = project(items, true)
    assert.deepEqual(view.composer?.todos, mixed)
    assert.equal(view.composer?.completedCount, 1)
    assert.equal(view.composer?.totalCount, 5)
    assert.equal(view.byTurnID.u, view.composer)
  }
})

test('explicit execution IDs retain follow-up user messages in one list and anchor history at the first user', () => {
  const items = [user('first', 'e1'), write('initial', [todo('Initial')], { executionID: 'e1' }), user('followup', 'e1'),
    write('updated', [todo('Updated', 'completed')], { executionID: 'e1' }), message('done', { executionID: 'e1', executionOutcome: 'succeeded' }),
    user('next', 'e2'), write('next-list', [todo('Next')], { executionID: 'e2' })]
  const view = project(items, true)
  assert.deepEqual(Object.keys(view.byTurnID), ['first', 'next'])
  assert.equal(view.byTurnID.first.executionID, 'e1')
  assert.deepEqual(view.byTurnID.first.todos, [todo('Updated', 'completed')])
  assert.equal(view.byTurnID.first.active, false)
  assert.equal(view.byTurnID.first.outcome, 'succeeded')
  assert.equal(view.byTurnID.followup, undefined)
  assert.equal(view.composer, view.byTurnID.next)
  assert.equal(view.composer?.active, true)
})

test('legacy user boundaries start fresh executions and leading assistant items have a stable history anchor', () => {
  const view = project([write('leading', [todo('Leading')]), user('first'), write('first-list', [todo('First')]), user('second'), write('second-list', [todo('Second')])], true)
  assert.deepEqual(Object.keys(view.byTurnID), ['leading', 'first', 'second'])
  assert.deepEqual(Object.values(view.byTurnID).map(value => value.executionID), ['legacy:leading', 'legacy:first', 'legacy:second'])
  assert.deepEqual(Object.values(view.byTurnID).map(value => [value.anchorTurnID, value.active]), [['leading', false], ['first', false], ['second', true]])
  assert.deepEqual(view.composer?.todos, [todo('Second')])
})

test('a new execution without todos or with an empty list clears the composer without resurrecting historical lists', () => {
  for (const explicit of [false, true]) {
    const previous = [user('old', explicit ? 'old-execution' : undefined), write('old-list', [todo('Keep history', 'completed')], { executionID: explicit ? 'old-execution' : undefined })]
    const next = user('new', explicit ? 'new-execution' : undefined)
    for (const tail of [[], [write('empty', [], { executionID: next.executionID })], [write('invalid', [todo('Bad', 'unknown' as TodoItem['status'])], { executionID: next.executionID })]]) {
      const view = project([...previous, next, ...tail], true)
      assert.equal(view.composer, undefined)
      assert.deepEqual(Object.keys(view.byTurnID), ['old'])
      assert.deepEqual(view.byTurnID.old.todos, [todo('Keep history', 'completed')])
    }
  }
})

test('an explicit empty update clears the current execution, and later invalid or unfinished updates do not undo the clear', () => {
  const items = [user('u', 'e'), write('list', mixed, { executionID: 'e' }), write('clear', [], { executionID: 'e' })]
  for (const tail of [[], [write('bad', [todo('Bad', 'done' as TodoItem['status'])])], [write('pending', mixed, { tool: { name: 'todowrite', status: 'running' } })]]) {
    const view = project([...items, ...tail], true)
    assert.equal(view.composer, undefined)
    assert.deepEqual(view.byTurnID, {})
  }
  assert.deepEqual(project([...items, write('recreate', [todo('New scope')])], true).composer?.todos, [todo('New scope')])
})

test('execution outcomes override session fallback, latest explicit outcome wins and running ignores stale session outcomes', () => {
  for (const outcome of ['succeeded', 'failed', 'interrupted'] as const) {
    const items = [user('u', 'e'), write('list', mixed, { executionID: 'e' })]
    const settled = projectSessionTodos(items, { running: false, sessionOutcome: outcome }).composer!
    assert.equal(settled.outcome, outcome)
    assert.equal(settled.active, false)
    assert.deepEqual(settled.todos, mixed, 'settling never fabricates completed tasks')
    const active = projectSessionTodos(items, { running: true, sessionOutcome: outcome }).composer!
    assert.equal(active.active, true)
    assert.equal(active.outcome, undefined)
    for (const running of [false, true]) {
      const explicit = projectSessionTodos([...items, message('failed', { executionID: 'e', executionOutcome: 'failed' }), message('terminal', { executionID: 'e', executionOutcome: outcome })], { running, sessionOutcome: outcome === 'failed' ? 'succeeded' : 'failed' }).composer!
      assert.equal(explicit.outcome, outcome)
      assert.equal(explicit.active, false)
      assert.deepEqual(explicit.todos, mixed)
    }
  }
  const historical = projectSessionTodos([user('old', 'old'), write('old-list', mixed, { executionID: 'old' }), user('new', 'new')], { running: false, sessionOutcome: 'failed' })
  assert.equal(historical.byTurnID.old.outcome, undefined, 'session outcome belongs only to the newest execution')
})

test('child sessions never expose a composer or historical master list', () => {
  for (const running of [false, true]) {
    assert.deepEqual(projectSessionTodos([user('u', 'e'), write('list', mixed, { executionID: 'e' })], { running, isChildSession: true, sessionOutcome: 'failed' }), { byTurnID: {} })
  }
})

test('extraction and projection do not mutate frozen messages, tools, inputs or todo arrays', () => {
  const todos = mixed.map(value => Object.freeze({ ...value }))
  Object.freeze(todos)
  const items = [user('u', 'e'), write('list', todos, { executionID: 'e', todos: undefined, tool: { name: 'todowrite', status: 'completed', input: Object.freeze({ todos }) } })]
  for (const item of items) { if (item.tool) Object.freeze(item.tool); Object.freeze(item) }
  Object.freeze(items)
  const before = JSON.stringify(items)
  assert.deepEqual(extractValidTodos(items[1]), mixed)
  for (const running of [false, true]) assert.deepEqual(project(items, running).composer?.todos, mixed)
  assert.equal(JSON.stringify(items), before)
})

test('settled executions use the latest finite non-negative explicit workedMs, including zero', () => {
  const items = [message('u', { role: 'user', createdAt: 100 }), write('list', mixed, { workedMs: 1234 }), message('latest', { workedMs: 300000 }), message('invalid', { workedMs: NaN })]
  assert.equal(project(items).composer?.workedMs, 300000)
  assert.equal(project([...items, message('negative', { workedMs: -1 }), message('infinite', { workedMs: Infinity })]).composer?.workedMs, 300000)
  assert.equal(project([...items, message('zero', { workedMs: 0 })]).composer?.workedMs, 0)
})

test('settled executions calculate user-to-last elapsed time using completion or creation time', () => {
  for (const last of [message('last', { createdAt: 301000 }), message('last', { createdAt: 2000, completedAt: 301000 })]) {
    const items = [message('u', { role: 'user', createdAt: 1000 }), write('list', mixed), last]
    const view = project(items)
    assert.equal(view.composer?.workedMs, 300000)
    assert.equal(view.byTurnID.u, view.composer)
  }
  assert.equal(project([message('u', { role: 'user', createdAt: 1000 }), write('list', mixed, { createdAt: 1000 })]).composer?.workedMs, 0)
})

test('settled elapsed time falls back to finite execution bounds and omits unavailable durations', () => {
  const items = [write('list', mixed, { createdAt: 500, completedAt: 2500 }), message('earlier', { createdAt: 100 }), message('invalid', { createdAt: NaN, completedAt: Infinity })]
  assert.equal(project(items).composer?.workedMs, 2400)
  assert.equal(project([message('u', { role: 'user', createdAt: 5000 }), write('list', mixed, { createdAt: 100, completedAt: 1000 })]).composer?.workedMs, 4900)
  for (const extra of [{}, { createdAt: NaN }, { createdAt: 100, completedAt: 100 }, { workedMs: -1 }]) {
    assert.equal(Object.hasOwn(project([write('list', mixed, extra)]).composer!, 'workedMs'), false)
  }
})

test('active executions omit the workedMs own property even with explicit or elapsed timing', () => {
  const items = [message('u', { role: 'user', createdAt: 1000 }), write('list', mixed, { createdAt: 2000, completedAt: 301000, workedMs: 300000 })]
  const view = project(items, true)
  assert.equal(Object.hasOwn(view.composer!, 'workedMs'), false)
  assert.equal(view.byTurnID.u, view.composer)
  const historical = project([...items, user('next')], true)
  assert.equal(historical.byTurnID.u.workedMs, 300000)
  assert.equal(historical.byTurnID.u.active, false)
})

type CardProps = Parameters<typeof TodoProgressCard>[0]
const markup = (props: CardProps) => renderToStaticMarkup(createElement(TodoProgressCard, props))

test('card renders completed/total counts, concurrent live tasks, every status and escaped content', () => {
  const html = markup({ snapshot: snapshot([...mixed, todo('<script>unsafe</script>')], true) })
  assert.match(html, /data-testid="chat-todo-turn"/)
  assert.match(html, /data-active="true"/)
  assert.match(html, /Đang thực hiện/)
  assert.match(html, /todo-progress__status--live/)
  assert.match(html, /todo-progress__ring--live/)
  assert.match(html, /data-execution-id="execution"/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /1\/6 bước/)
  assert.match(html, /2 đang chạy/)
  assert.equal((html.match(/todo-item--in_progress is-live/g) ?? []).length, 2)
  for (const status of ['pending', 'in_progress', 'completed', 'cancelled']) assert.ok(html.includes(`todo-item--${status}`))
  for (const label of ['Hoàn tất', 'Đang chạy', 'Đã hủy', 'Chờ thực hiện']) assert.ok(html.includes(`role="img" aria-label="${label}"`))
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
  assert.ok(controls)
  assert.ok(html.includes(`<ul id="${controls}"`))
})

test('inactive unfinished tasks are paused on interruption, failure and idle success without live styling', () => {
  for (const outcome of [undefined, 'interrupted', 'failed', 'succeeded'] as const) {
    const html = markup({ snapshot: snapshot(mixed, false, outcome), defaultOpen: true })
    assert.match(html, /data-testid="chat-todo-turn"/)
    assert.match(html, /data-active="false"/)
    assert.match(html, /data-execution-id="execution"/)
    assert.match(html, /Tiến độ/)
    assert.match(html, /1\/5 bước/)
    assert.match(html, outcome === 'failed' ? /Lỗi · 2 chưa xong/ : /Đã dừng · 2 chưa xong/)
    assert.match(html, /todo-progress__status--paused/)
    assert.match(html, /todo-progress__ring--paused/)
    assert.equal((html.match(/todo-item--in_progress is-paused/g) ?? []).length, 2)
    assert.doesNotMatch(html, /is-live|status--live|đang chạy/)
  }
})

test('cancelled items remain in the denominator and are not reported as completed', () => {
  const html = markup({ snapshot: snapshot([todo('Done', 'completed'), todo('Cancelled', 'cancelled'), todo('Also cancelled', 'cancelled')]), defaultOpen: true })
  assert.match(html, /1\/3 bước/)
  assert.match(html, /2 đã hủy/)
  assert.match(html, /todo-progress__status--cancelled/)
  assert.match(html, /todo-progress__ring--idle/)
  assert.equal((html.match(/todo-item--cancelled/g) ?? []).length, 2)
  assert.doesNotMatch(html, /is-live|is-paused/)
  const complete = markup({ snapshot: snapshot([todo('Done', 'completed')]) })
  assert.match(complete, /1\/1 bước/)
  assert.match(complete, /todo-progress__ring--done/)
  assert.doesNotMatch(complete, /status--live|status--paused|status--cancelled/)
  assert.match(complete, /aria-expanded="false"/)
  assert.doesNotMatch(complete, /<ul/)
})

test('settled cards default collapsed, active cards open, and defaultOpen overrides both defaults', () => {
  for (const active of [false, true]) {
    const value = snapshot(mixed, active)
    const html = markup({ snapshot: value })
    assert.match(html, new RegExp(`aria-expanded="${active}"`))
    assert.equal(html.includes('<ul'), active)
    for (const defaultOpen of [false, true]) {
      const explicit = markup({ snapshot: value, defaultOpen })
      assert.match(explicit, new RegExp(`aria-expanded="${defaultOpen}"`))
      assert.equal(explicit.includes('<ul'), defaultOpen)
    }
  }
})

function cardHarness(initial: CardProps) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, tree: ReactNode, props = initial
  const hooks = {
    useState(initialValue: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initialValue: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initialValue }; return slots[index] },
    useId() { const index = cursor++; if (!(index in slots)) slots[index] = `todo-list-${index}`; return slots[index] },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, old = effects[index]
      if (!old || deps.length !== old.deps.length || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
      }
    },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/TodoProgressCard.tsx', import.meta.url), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = { react: hooks, './Icon': { Icon }, '../chat-timeline': { formatAgentDuration } }
  runInNewContext(code, { exports, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports.TodoProgressCard as (props: CardProps) => ReactNode
  function render(next: Partial<CardProps> = {}) {
    props = { ...props, ...next }; cursor = 0; effectIndex = 0; tree = Component(props)
    pending.splice(0).forEach(run => run())
    return renderToStaticMarkup(tree)
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  return {
    render,
    click() {
      const button = all(tree).find(node => node.type === 'button' && 'aria-expanded' in node.props)
      assert.ok(button, 'expected accessible todo toggle')
      ;(button.props.onClick as () => void)()
    },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

test('toggle clicks expand and collapse the list without changing counts or the controlled list ID', () => {
  const h = cardHarness({ snapshot: snapshot(mixed) })
  const collapsed = h.render(), controls = collapsed.match(/aria-controls="([^"]+)"/)?.[1]
  assert.match(collapsed, /aria-expanded="false"/)
  h.click()
  const expanded = h.render()
  assert.match(expanded, /aria-expanded="true"/)
  assert.ok(expanded.includes(`<ul id="${controls}"`))
  assert.match(expanded, /1\/5 bước/)
  h.click()
  assert.doesNotMatch(h.render(), /<ul/)
  h.unmount()
})

test('card preserves manual collapse through active updates and reopens on a false-to-true activation', () => {
  const h = cardHarness({ snapshot: snapshot(mixed, true) })
  assert.match(h.render(), /aria-expanded="true"/)
  h.click()
  assert.match(h.render(), /aria-expanded="false"/)
  assert.match(h.render({ snapshot: snapshot([...mixed, todo('Scope update')], true) }), /aria-expanded="false"/)
  assert.match(h.render({ snapshot: snapshot(mixed, false, 'interrupted') }), /aria-expanded="false"/)
  h.render({ snapshot: snapshot(mixed, true) })
  assert.match(h.render(), /aria-expanded="true"/)
  h.click()
  assert.match(h.render({ snapshot: snapshot(mixed, true) }), /aria-expanded="false"/)
  h.unmount()
})

test('finishing auto-collapses an expanded list and activation auto-expands it again', () => {
  const h = cardHarness({ snapshot: snapshot(mixed, true) })
  assert.match(h.render(), /aria-expanded="true"/)
  h.render({ snapshot: snapshot(mixed, false, 'succeeded') })
  assert.match(h.render(), /aria-expanded="false"/)
  assert.doesNotMatch(h.render(), /<ul/)
  h.render({ snapshot: snapshot(mixed, true) })
  assert.match(h.render(), /aria-expanded="true"/)
  h.unmount()
})

test('settled cards preserve manual expansion and collapse across intermediate todo updates', () => {
  const h = cardHarness({ snapshot: snapshot(mixed) })
  h.render()
  h.click()
  assert.match(h.render({ snapshot: snapshot([...mixed, todo('Scope update')]) }), /aria-expanded="true"/)
  h.click()
  assert.match(h.render({ snapshot: snapshot(mixed) }), /aria-expanded="false"/)
  h.unmount()
})

test('settled duration heading uses the shared formatter and active headings ignore duration', () => {
  const value = { ...snapshot(mixed), workedMs: 300000 }
  assert.equal(formatAgentDuration(value.workedMs), '5m 0s')
  assert.match(markup({ snapshot: value }), /Đã làm 5m 0s/)
  assert.match(markup({ snapshot: snapshot(mixed) }), /class="todo-progress__label">Tiến độ</)
  const active = markup({ snapshot: { ...value, active: true } })
  assert.match(active, /Đang thực hiện/)
  assert.doesNotMatch(active, /Đã làm/)
})

test('ring renders proportional progress and handles an empty snapshot without NaN', () => {
  const html = markup({ snapshot: snapshot([todo('Done', 'completed'), todo('Next')]) })
  const dasharray = Number(html.match(/stroke-dasharray="([^"]+)"/)?.[1])
  const offset = Number(html.match(/stroke-dashoffset="([^"]+)"/)?.[1])
  assert.ok(Number.isFinite(dasharray) && dasharray > 0)
  assert.equal(offset, dasharray / 2)
  const empty = markup({ snapshot: { ...snapshot(mixed), todos: [], totalCount: 0, completedCount: 0, inProgressCount: 0, pendingCount: 0, cancelledCount: 0 } })
  assert.match(empty, /todo-progress__ring--idle/)
  assert.doesNotMatch(empty, /NaN|Infinity/)
})

test('Chat renders one inline per-turn Todo above blocks for live and historical turns, never in the composer dock', () => {
  const source = readFileSync(new URL('../components/Chat.tsx', import.meta.url), 'utf8')
  const turnBody = source.slice(source.indexOf('<div className="msg-turn-body">'), source.indexOf('{turn.blocks.map'))
  assert.match(turnBody, /^<div className="msg-turn-body">\{todo && <TodoProgressCard\b[^>]*snapshot=\{todo\}\s*\/>\}$/)
  assert.doesNotMatch(turnBody, /!turn\.live|variant=/)
  const turnView = source.match(/<ChatTurnView\b[^>]*\/>/)?.[0]
  assert.ok(turnView, 'Chat renders the extracted turn component')
  assert.match(turnView, /\btodo=\{todoView\.byTurnID\[turn\.id\]\}/)
  assert.doesNotMatch(turnView, /!turn\.live/)
  const dock = source.slice(source.indexOf('<div className="composer-dock">'))
  assert.doesNotMatch(dock, /TodoProgressCard|todoView\.composer/)
  assert.equal((source.match(/<TodoProgressCard\b/g) ?? []).length, 1)
})
