import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { Inspector } from '../components/Inspector'
import { Icon } from '../components/Icon'
import * as primitives from '../components/Primitives'
import * as amekitUI from '../amekit-ui'
import * as scm from '../scm-commit'

const inspectorProps = {
  projectID: 'project', connected: true, tab: 'git' as const, generation: 0,
  git: { branch: 'main', changes: [{ path: 'file.ts', index: 'M', working: ' ' }] }, gitError: '',
  setTab() {}, refresh() {}, onOpen() {}, onRename() {}, onDelete() {}, onDiff() {}, onHide() {}, report() {},
}
const defaultTitle = 'Tạo thông điệp commit bằng AI từ thay đổi đã stage'
const skillTitle = (name: string) => `Tạo thông điệp commit bằng AI (Skill /${name})`
const installedSkill = (name: string) => ({ features: { commitEnhanceSkill: name } })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Exercise real component effects and handlers without introducing a DOM dependency.
function harness(component: 'Inspector' | 'Account', initialProps: object, api: Record<string, unknown>) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = []
  const pending: (() => void)[] = [], listeners = new Map<string, Set<() => void>>()
  let cursor = 0, effectIndex = 0, writes = 0, props = initialProps, tree: ReactNode
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => { writes++; slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(fn: unknown, deps: unknown[]) {
      const index = cursor++, old = slots[index] as { fn: unknown; deps: unknown[] } | undefined
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) slots[index] = { fn, deps }
      return (slots[index] as { fn: unknown }).fn
    },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const index = effectIndex++, old = effects[index]
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
    },
  }
  const window = {
    ame: { gitBranches: async () => ({ current: 'main', branches: [] }), ...api },
    addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn); if (!listeners.get(name)?.size) listeners.delete(name) },
    dispatchEvent(event: Event) { for (const fn of listeners.get(event.type) ?? []) fn(); return true },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL(`../components/${component}.tsx`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = { react: hooks, './Icon': { Icon }, './Primitives': primitives, './ProjectSearch': { ProjectSearch: () => null }, '../scm-commit': scm, '../amekit-ui': amekitUI }
  runInNewContext(code, { exports, Event, window, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports[component] as (props: object) => ReactNode
  function render(extra: object = {}) {
    props = { ...props, ...extra }; cursor = 0; effectIndex = 0
    tree = Component(props)
    while (isValidElement(tree) && typeof tree.type === 'function') tree = (tree.type as (props: unknown) => ReactNode)(tree.props)
    pending.splice(0).forEach(run => run())
    return renderToStaticMarkup(tree)
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  function find(predicate: (element: ReactElement<Record<string, unknown>>) => boolean) {
    const element = all(tree).find(predicate)
    assert.ok(element, 'expected rendered control')
    return element
  }
  function click(text: string) {
    const element = find(node => node.type === 'button' && node.props.children === text)
    ;(element.props.onClick as () => void)()
  }
  function change(label: string, value: string) {
    const element = find(node => node.props['aria-label'] === label || (node.type === 'input' && node.props.placeholder === label))
    ;(element.props.onChange as (event: unknown) => void)({ target: { value } })
  }
  return {
    render, click, change, find, window, listeners,
    async flush() { await tick(); return render() },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
    get writes() { return writes },
  }
}

test('Inspector SSR renders only an accessible wand in the commit input bar and preserves disabled guidance', () => {
  for (const [extra, title, disabled] of [
    [{}, defaultTitle, false],
    [{ connected: false }, 'Chưa kết nối OpenCode', true],
    [{ git: { branch: 'main', changes: [] } }, 'Stage ít nhất một tệp để tạo thông điệp commit', true],
  ] satisfies [Partial<Parameters<typeof Inspector>[0]>, string, boolean][]) {
    const html = renderToStaticMarkup(createElement(Inspector, { ...inspectorProps, ...extra }))
    const bar = html.match(/<div class="scm-commit-input-bar">([\s\S]*?)<\/div>/)![1]
    assert.match(bar, /class="scm-enhance-icon-btn"/)
    assert.match(bar, /data-testid="scm-enhance-btn"/)
    assert.ok(bar.includes(`title="${title}"`))
    assert.ok(bar.includes(`aria-label="${title}"`))
    assert.match(bar, /<svg[^>]*stroke-width="1.7"/)
    assert.ok(bar.includes('m15 4 5 5L7 22l-5-5Z'))
    assert.equal(bar.replace(/<[^>]*>/g, '').trim(), '')
    assert.doesNotMatch(html, /Skill \/git-commit/)
    assert.equal(bar.includes('disabled=""'), disabled)
  }
})

test('Inspector installed lookup updates dynamic title, refreshes on account changes and keeps Enhance usable', async () => {
  const requests: ReturnType<typeof deferred>[] = [], calls: unknown[][] = []
  const h = harness('Inspector', inspectorProps, {
    account(operation: string, payload: unknown) { calls.push([operation, payload]); const next = deferred(); requests.push(next); return next.promise },
    generateCommitMessage: async (project: string) => { assert.equal(project, 'project'); return { message: 'feat: use synced skill' } },
  })
  assert.ok(h.render().includes(`title="${defaultTitle}"`))
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['installed', { project: 'project' }]])
  requests[0].resolve(installedSkill('team-commit'))
  const html = await h.flush()
  assert.ok(html.includes(`title="${skillTitle('team-commit')}"`))
  assert.ok(html.includes(`aria-label="${skillTitle('team-commit')}"`))
  ;(h.find(node => node.props['data-testid'] === 'scm-enhance-btn').props.onClick as () => void)()
  assert.ok((await h.flush()).includes('feat: use synced skill'))
  h.window.dispatchEvent(new Event('ame-account-changed'))
  requests[1].resolve(installedSkill('updated-commit'))
  assert.ok((await h.flush()).includes(`title="${skillTitle('updated-commit')}"`))
  h.window.dispatchEvent(new Event('ame-account-changed'))
  requests[2].resolve(null)
  assert.ok((await h.flush()).includes(`title="${defaultTitle}"`))
  h.unmount()
  assert.equal(h.listeners.size, 0)
})

test('Inspector ignores stale installed responses, silently handles failures, and cleans up tab/unmount work', async () => {
  const requests: ReturnType<typeof deferred>[] = []
  let reports = 0
  const h = harness('Inspector', { ...inspectorProps, report() { reports++ } }, {
    account() { const next = deferred(); requests.push(next); return next.promise },
  })
  h.render({ tab: 'search' }); assert.equal(requests.length, 0)
  h.render({ tab: 'git' }); assert.equal(requests.length, 1)
  h.window.dispatchEvent(new Event('ame-account-changed'))
  requests[1].resolve(installedSkill('current'))
  assert.ok((await h.flush()).includes(skillTitle('current')))
  requests[0].resolve(installedSkill('stale'))
  assert.ok(!(await h.flush()).includes(skillTitle('stale')))
  h.window.dispatchEvent(new Event('ame-account-changed'))
  requests[2].reject(new Error('OPERATION_BUSY'))
  assert.ok((await h.flush()).includes(`title="${defaultTitle}"`))
  assert.equal(reports, 0)
  h.window.dispatchEvent(new Event('ame-account-changed'))
  h.render({ tab: 'search' }); assert.equal(h.listeners.size, 0)
  const writes = h.writes
  requests[3].resolve(installedSkill('after-tab-change')); await tick()
  assert.equal(h.writes, writes)
  h.render({ tab: 'git' }); h.unmount()
  const unmountedWrites = h.writes
  requests[4].resolve(installedSkill('after-unmount')); await tick()
  assert.equal(h.writes, unmountedWrites)
  for (const api of [{}, { account() { throw new Error('unavailable') } }]) {
    const absent = harness('Inspector', inspectorProps, api)
    absent.render(); assert.ok((await absent.flush()).includes(`title="${defaultTitle}"`)); absent.unmount()
  }
})

function accountHarness() {
  let skills = ['team-commit', 'review'], latestSkill = 'team-commit', latestError = ''
  const calls: { operation: string; payload?: Record<string, string> }[] = []
  const release = () => ({ releaseId: 'release', version: '1.0.0', manifest: { agents: 1, skills: 2, ...installedSkill(latestSkill) } })
  const h = harness('Account', { projectID: 'project', embedded: true, close() {} }, {
    async account(operation: string, payload?: Record<string, string>) {
      calls.push({ operation, payload })
      if (operation === 'status') return { account: { name: 'Admin', username: 'admin', role: 'admin' }, ready: true }
      if (operation === 'history') return { releases: [release()], active: { release_id: 'release', revision: 1 } }
      if (operation === 'latest') { if (latestError) throw new Error(latestError); return { release: release(), revision: 1 } }
      if (operation === 'installed') return { version: '1.0.0', agents: [], skills, ...installedSkill('installed-commit') }
      if (operation === 'import') return { folderName: 'bundle', agents: [], skills, files: [], issues: [], compatibilityMode: 'native' }
      if (operation === 'package') return { summary: { version: payload?.version, ...(payload?.commitEnhanceSkill ? installedSkill(payload.commitEnhanceSkill) : {}) }, size: 42, entries: 2, sha256: 'abc' }
      if (operation === 'logout') return null
      throw new Error(`Unexpected operation ${operation}`)
    },
  })
  return { ...h, calls, setSkills(value: string[]) { skills = value }, setLatest(value: string) { latestSkill = value }, failLatest(error: string) { latestError = error } }
}
async function openAdmin(h: ReturnType<typeof accountHarness>) {
  h.render(); await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
}
function submitPackage(h: ReturnType<typeof accountHarness>) {
  const form = h.find(node => node.type === 'form')
  ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
}

test('Admin selector uses imported skills, prefills active release, packages selection and invalidates prepared ZIP on change', async () => {
  const h = accountHarness()
  await openAdmin(h)
  assert.ok(!h.render().includes('aria-label="Skill cho Enhance (Commit message)"'))
  h.click('Chọn thư mục & nhập')
  await h.flush()
  const html = h.render()
  assert.match(html, /<select aria-label="Skill cho Enhance \(Commit message\)"/)
  assert.match(html, /<option value="">Mặc định \(Conventional Commits\)<\/option>/)
  assert.match(html, /<option value="team-commit" selected="">\/team-commit<\/option>/)
  assert.match(html, /<option value="review">\/review<\/option>/)
  assert.ok(!html.includes('value="git-commit"'))
  assert.ok(html.includes('Enhance: /team-commit'))
  h.change('1.0.0', '2.0.0'); h.render(); submitPackage(h); h.render()
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.disabled, true)
  const packaged = await h.flush()
  assert.ok(packaged.includes('Đã đóng gói v2.0.0'))
  assert.match(packaged, /amekit-package-summary[\s\S]*Enhance: \/team-commit/)
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call => call.operation === 'package')?.payload)), { version: '2.0.0', commitEnhanceSkill: 'team-commit' })
  h.change('Skill cho Enhance (Commit message)', 'review')
  assert.ok(!h.render().includes('Đã đóng gói v2.0.0'))
  submitPackage(h); await h.flush()
  assert.equal(h.calls.filter(call => call.operation === 'package').at(-1)?.payload?.commitEnhanceSkill, 'review')
  h.change('Skill cho Enhance (Commit message)', ''); h.render(); submitPackage(h); await h.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(call => call.operation === 'package').at(-1)?.payload)), { version: '2.0.0' })
  h.unmount()
})

test('Admin reimport clears unavailable/default skills and logout clears prior import and packaging state', async () => {
  const h = accountHarness()
  await openAdmin(h)
  h.click('Chọn thư mục & nhập'); await h.flush()
  h.change('Skill cho Enhance (Commit message)', 'review'); h.render()
  h.setSkills(['other']); h.click('Chọn thư mục & nhập'); await h.flush()
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
  h.setLatest(''); h.setSkills(['team-commit']); h.click('Chọn thư mục & nhập'); await h.flush()
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
  h.change('Skill cho Enhance (Commit message)', 'team-commit'); h.render()
  h.click('Tài khoản'); h.render(); h.click('Đăng xuất'); await h.flush()
  assert.ok(!h.render().includes('Quản trị'))
  assert.ok(!h.render().includes('aria-label="Skill cho Enhance (Commit message)"'))
  h.unmount()
})

test('Admin import remains usable with default selection when no active release or latest lookup fails', async () => {
  for (const error of ['NO_ACTIVE_RELEASE', 'NETWORK_ERROR']) {
    const h = accountHarness()
    await openAdmin(h)
    h.failLatest(error)
    h.click('Chọn thư mục & nhập')
    const html = await h.flush()
    assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
    assert.match(html, /<option value="review">\/review<\/option>/)
    assert.doesNotMatch(html, /role="alert"/)
    h.unmount()
  }
})

test('Account installed bundle displays synced Enhance skill independently of latest release', async () => {
  const h = accountHarness()
  h.render(); await h.flush(); h.click('Bundle'); h.render()
  const html = await h.flush()
  assert.match(html, /Bundle đang cài trong dự án[\s\S]*Enhance: \/installed-commit/)
  assert.match(html, /Bản phát hành trên máy chủ[\s\S]*Enhance: \/team-commit/)
  h.unmount()
})
