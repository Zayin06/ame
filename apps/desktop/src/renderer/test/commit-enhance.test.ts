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
import * as gitUI from '../git-ui'
import * as scmDisplay from '../scm-display'
import { FileTypeIcon } from '../components/FileTypeIcon'
import { WORKSPACE_DRAG_MIME } from '../composer-mentions'

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
  const modules: Record<string, unknown> = { react: hooks, './Icon': { Icon }, './Primitives': primitives, './ProjectSearch': { ProjectSearch: () => null }, '../scm-commit': scm, '../amekit-ui': amekitUI, '../git-ui': gitUI, '../scm-display': scmDisplay, '../components/FileTypeIcon': { FileTypeIcon }, '../composer-mentions': { WORKSPACE_DRAG_MIME } }
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
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['installed', {}]])
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

test('Enhance shows an icon-only spinner, guards concurrent mutations and restores the wand on success', async () => {
  const request = deferred()
  let generated = 0, committed = 0
  const h = harness('Inspector', inspectorProps, {
    generateCommitMessage() { generated++; return request.promise },
    async commit() { committed++ },
  })
  h.render(); await h.flush()
  h.change('Thông điệp commit', 'draft'); h.render()
  const enhance = h.find(node => node.props['data-testid'] === 'scm-enhance-btn').props.onClick as () => void
  enhance(); enhance()
  const html = h.render()
  assert.equal(generated, 1)
  const button = h.find(node => node.props['data-testid'] === 'scm-enhance-btn')
  assert.equal(button.props['aria-busy'], true)
  assert.equal(button.props.title, 'Đang tạo thông điệp commit…')
  assert.equal(button.props['aria-label'], button.props.title)
  assert.equal(button.props.className, 'scm-enhance-icon-btn is-loading')
  assert.equal(button.props.disabled, true)
  assert.match(renderToStaticMarkup(button), /<span class="amekit-spinner" aria-hidden="true"><\/span>/)
  const bar = html.match(/<div class="scm-commit-input-bar">([\s\S]*?)<\/div>/)![1]
  assert.equal(bar.replace(/<[^>]*>/g, '').trim(), '')
  const form = h.find(node => node.type === 'form')
  ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  assert.equal(committed, 0)
  request.resolve({ message: 'feat: generated' })
  const completed = await h.flush()
  assert.doesNotMatch(completed, /amekit-spinner|aria-busy="true"/)
  assert.match(completed, /feat: generated/)
  assert.equal(h.find(node => node.props['data-testid'] === 'scm-enhance-btn').props.className, 'scm-enhance-icon-btn')
  h.unmount()
})

test('Enhance and Commit failures stay in the commit dock and clear on edit, retry or tab change', async () => {
  for (const operation of ['enhance', 'commit']) {
    let reports = 0
    const requests: ReturnType<typeof deferred>[] = []
    const action = () => { const request = deferred(); requests.push(request); return request.promise }
    const h = harness('Inspector', { ...inspectorProps, report() { reports++ } }, {
      generateCommitMessage: action, commit: action,
    })
    h.render(); await h.flush()
    const submit = () => {
      if (operation === 'enhance') (h.find(node => node.props['data-testid'] === 'scm-enhance-btn').props.onClick as () => void)()
      else (h.find(node => node.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
    }
    h.change('Thông điệp commit', 'draft'); h.render(); submit()
    requests[0].reject(new Error(`${operation} failed`))
    let html = await h.flush()
    assert.equal(reports, 0)
    assert.match(html, /class="scm-commit-dock is-visible"[\s\S]*data-testid="scm-commit-error" role="alert"/)
    assert.equal(h.find(node => node.props['data-testid'] === 'scm-commit-error').props.children, `${operation} failed`)
    assert.doesNotMatch(html, /amekit-spinner|aria-busy="true"/)
    h.change('Thông điệp commit', 'edited')
    assert.doesNotMatch(h.render(), /data-testid="scm-commit-error"/)
    submit(); requests[1].reject(new Error('retry failed')); await h.flush()
    submit(); assert.doesNotMatch(h.render(), /data-testid="scm-commit-error"/)
    requests[2].reject(new Error('another failure')); await h.flush()
    h.render({ tab: 'search' }); h.render({ tab: 'git' })
    assert.doesNotMatch(h.render(), /data-testid="scm-commit-error"/)
    assert.equal(reports, 0)
    h.unmount()
  }
})

test('Inspector controlled drafts, Enhance, commits and workspace shortcuts notify the parent', async () => {
  const drafts: string[] = [], tabs: string[] = [], commits: string[] = [], skills: string[] = []
  const h = harness('Inspector', {
    ...inspectorProps, commitMessage: 'parent draft',
    onCommitMessageChange(value: string) { drafts.push(value) },
    onOpenGitWorkspace(tab: string) { tabs.push(tab) },
    onCommitEnhanceSkillChange(skill: string) { skills.push(skill) },
  }, {
    async account() { return installedSkill('team-commit') },
    async generateCommitMessage() { return { message: 'feat: generated' } },
    async commit(project: string, message: string) { assert.equal(project, 'project'); commits.push(message) },
  })
  assert.match(h.render(), /parent draft/)
  await h.flush()
  assert.deepEqual(skills, ['', 'team-commit'])
  h.change('Thông điệp commit', 'typed draft')
  assert.deepEqual(drafts, ['typed draft'])
  assert.match(h.render(), /parent draft/)
  assert.match(h.render({ commitMessage: 'typed draft' }), /typed draft/)
  ;(h.find(node => node.props['data-testid'] === 'scm-enhance-btn').props.onClick as () => void)()
  await h.flush()
  assert.equal(drafts.at(-1), 'feat: generated')
  h.render({ commitMessage: '  feat: generated  ' })
  ;(h.find(node => node.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  await h.flush()
  assert.deepEqual(commits, ['feat: generated'])
  assert.equal(drafts.at(-1), '')
  for (const label of ['scm-expand-commit-btn', 'Lịch sử commit', 'Quản lý Stash', 'Mô tả bản build (QC)']) {
    const button = h.find(node => node.props['data-testid'] === label || node.props.label === label)
    ;(button.props.onClick as () => void)()
  }
  assert.deepEqual(tabs, ['commit', 'history', 'stash', 'build-notes'])
  const syncBar = renderToStaticMarkup(h.find(node => node.props['data-testid'] === 'scm-sync-bar'))
  assert.match(syncBar, /aria-label="Mô tả bản build \(QC\)"/)
  const commitBar = h.render().match(/<div class="scm-commit-input-bar">([\s\S]*?)<\/div>/)![1]
  assert.doesNotMatch(commitBar, /Mô tả bản build/)
  assert.equal((commitBar.match(/<button/g) ?? []).length, 2)
  assert.equal(commitBar.replace(/<[^>]*>/g, '').trim(), '')
  h.render({ gitWorkspaceOpen: true, connected: false, git: { branch: 'main', changes: [] } })
  const expand = h.find(node => node.props['data-testid'] === 'scm-expand-commit-btn')
  assert.equal(expand.props['aria-pressed'], true)
  assert.equal(expand.props['aria-label'], 'Thu gọn khu soạn commit')
  assert.notEqual(expand.props.disabled, true)
  h.unmount()
})

test('Inspector sync guards pending operations, formats failures, refreshes and publishes with upstream', async () => {
  const requests: ReturnType<typeof deferred>[] = [], calls: unknown[][] = []
  let refreshed = 0, reports = 0
  const action = (...args: unknown[]) => { calls.push(args); const request = deferred(); requests.push(request); return request.promise }
  const h = harness('Inspector', {
    ...inspectorProps, git: { ...inspectorProps.git, hasRemote: true, tracking: 'origin/main', ahead: 2, behind: 3 },
    refresh() { refreshed++ }, report() { reports++ },
  }, {
    gitFetch: (project: string) => action('fetch', project),
    gitPull: (project: string) => action('pull', project),
    gitPush: (project: string, options: unknown) => action('push', project, options),
    async commit() { throw new Error('GIT_CONFLICT') },
  })
  h.render(); await h.flush()
  const press = (id: string) => (h.find(node => node.props['data-testid'] === `scm-${id}-btn`).props.onClick as () => void)()
  press('fetch'); press('pull')
  h.render()
  assert.equal(calls.length, 1)
  for (const id of ['fetch', 'pull', 'push']) assert.equal(h.find(node => node.props['data-testid'] === `scm-${id}-btn`).props.disabled, true)
  requests[0].reject(new Error('NO_REMOTE_CONFIGURED'))
  await h.flush()
  assert.equal(h.find(node => node.props['data-testid'] === 'scm-commit-error').props.children, 'Chưa cấu hình remote Git: Thêm remote origin hoặc mở Terminal để gắn repository từ xa.')
  press('pull'); requests[1].resolve({ summary: 'pulled' })
  assert.doesNotMatch(await h.flush(), /data-testid="scm-commit-error"/)
  assert.equal(refreshed, 1)
  press('push'); requests[2].reject(new Error('GIT_PUSH_REJECTED_NON_FF'))
  assert.match(await h.flush(), /Push bị từ chối do remote có commit mới: Hãy Pull về trước rồi thử Push lại\./)
  h.render({ git: { ...inspectorProps.git, hasRemote: true } })
  press('push'); requests[3].resolve({ summary: 'published' }); await h.flush()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['fetch', 'project'], ['pull', 'project'], ['push', 'project', null], ['push', 'project', { setUpstream: true }]])
  assert.equal(refreshed, 2)
  h.change('Thông điệp commit', 'draft'); h.render()
  ;(h.find(node => node.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  assert.match(await h.flush(), /Phát sinh xung đột \(merge conflict\)/)
  h.render({ git: { ...inspectorProps.git, hasRemote: false } })
  press('fetch'); assert.equal(calls.length, 4)
  assert.equal(reports, 0)
  h.unmount()
})

test('Inspector renders remote branches, checks them out and deletes only a selected non-current local branch', async () => {
  const checkedOut: string[][] = [], deleted: string[][] = []
  const request = deferred()
  const branches = {
    current: 'main', branches: [{ name: 'main', current: true }, { name: 'feature', current: false }],
    remoteBranches: [{ name: 'origin/remote-feature', current: false }],
  }
  const h = harness('Inspector', inspectorProps, {
    async gitBranches() { return branches },
    async checkoutBranch(...args: string[]) { checkedOut.push(args) },
    gitDeleteBranch(...args: string[]) { deleted.push(args); return request.promise },
  })
  h.render()
  const html = await h.flush()
  assert.match(html, /<optgroup label="Nhánh cục bộ">/)
  assert.match(html, /<optgroup label="Nhánh từ xa \(Remote\)"><option value="origin\/remote-feature">origin\/remote-feature<\/option><\/optgroup>/)
  h.change('Git branch', 'origin/remote-feature'); await h.flush()
  assert.deepEqual(checkedOut, [['project', 'origin/remote-feature']])
  ;(h.find(node => node.props.label === 'Xóa nhánh').props.onClick as () => void)()
  h.render()
  const selector = () => h.find(node => node.props['aria-label'] === 'Nhánh cần xóa')
  const cancel = h.find(node => node.props['aria-label'] === 'Hủy xóa nhánh')
  assert.equal(cancel.props.type, 'button')
  ;(cancel.props.onClick as () => void)()
  assert.doesNotMatch(h.render(), /aria-label="Nhánh cần xóa"/)
  assert.equal(deleted.length, 0)
  ;(h.find(node => node.props.label === 'Xóa nhánh').props.onClick as () => void)()
  h.render()
  assert.doesNotMatch(renderToStaticMarkup(selector()), /value="main"|origin\/remote-feature/)
  const submit = () => (h.find(node => node.props['aria-label'] === 'Xóa nhánh cục bộ').props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  h.change('Nhánh cần xóa', 'main'); h.render(); submit()
  assert.equal(deleted.length, 0)
  h.change('Nhánh cần xóa', 'feature'); h.render(); submit(); submit()
  h.render()
  assert.deepEqual(deleted, [['project', 'feature']])
  assert.equal(selector().props.disabled, true)
  request.resolve(undefined)
  assert.doesNotMatch(await h.flush(), /aria-label="Nhánh cần xóa"/)
  branches.branches = [branches.branches[0]]
  h.render({ generation: 1 }); await h.flush()
  assert.equal(h.find(node => node.props.label === 'Xóa nhánh').props.disabled, true)
  h.unmount()
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
      if (operation === 'legacy-installed') return null
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
  h.click('Chỉ đóng gói thử')
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
  h.click('Lịch sử (1)')
  assert.ok(h.render().includes('Enhance: /team-commit'))
  h.click('Phát hành mới'); h.render()
  h.click('Sửa phiên bản'); h.render()
  h.change('Phiên bản', '2.0.0'); h.render(); submitPackage(h); h.render()
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
  h.setSkills(['other']); h.click('Đổi thư mục'); await h.flush()
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
  h.setLatest(''); h.setSkills(['team-commit']); h.click('Đổi thư mục'); await h.flush()
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
  assert.match(html, /Đang dùng:[\s\S]*Enhance: \/installed-commit/)
  assert.match(html, /Trên máy chủ:[\s\S]*Enhance: \/team-commit/)
  h.unmount()
})
