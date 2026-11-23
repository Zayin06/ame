import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as primitives from '../components/Primitives'
import * as amekitUI from '../amekit-ui'

const agent = 'agents/helper.md', skill = 'skills/review/SKILL.md', stray = 'notes (old).txt'
const issue = (path: string, reason = 'invalid metadata') => ({ path, severity: 'error', reason })
function preview(paths = [agent, skill], issues = paths.map(path => issue(path))) {
  return {
    folderName: 'bundle', agents: paths.includes(agent) ? ['helper'] : [], skills: paths.includes(skill) ? ['review'] : [],
    files: paths.map(path => ({ path, size: 128 })), issues, compatibilityMode: 'native',
    fixablePaths: [...new Set(issues.map(item => item.path).filter(path => [agent, skill].includes(path)))],
  }
}
const modelLevels = { default: 'resolved-model', haiku: 'fast-model', sonnet: 'balanced-model', opus: 'reasoning-model' }
const accountModels = { default_model: modelLevels.default, small_model: modelLevels.haiku, model_levels: modelLevels }
const fixed = (path: string) => ({ path, summary: `Đã sửa ${path}`, model: modelLevels.default, diff: '- [REDACTED_SECRET_1]\n+ <YOUR_PLACEHOLDER>' })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(yes => { resolve = yes })
  return { promise, resolve }
}

// Run actual component handlers/effects with the repository's dependency-free hook harness pattern.
function harness(component: 'Account' | 'Settings', initialProps: object, account: (operation: string, payload?: Record<string, string>) => Promise<unknown>) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  let cursor = 0, effectIndex = 0, writes = 0, props = initialProps, tree: ReactNode
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
  const AccountMarker = () => null
  const modules: Record<string, unknown> = {
    react: hooks, './Primitives': primitives, '../amekit-ui': amekitUI,
    './Account': { Account: AccountMarker }, './PetSettings': { PetSettings: () => null },
    './Pairing': { Pairing: () => null }, './Icon': { Icon: () => null }, '../platform': { formatShortcut: (value: string) => value },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const code = ts.transpileModule(readFileSync(new URL(`../components/${component}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(code, { exports, Event, window: { ame: { account }, dispatchEvent() {} }, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Component = exports[component] as (props: object) => ReactNode
  function render(extra: object = {}) {
    props = { ...props, ...extra }
    for (let pass = 0; pass < 10; pass++) {
      const before = writes
      cursor = 0; effectIndex = 0; tree = Component(props)
      pending.splice(0).forEach(run => run())
      if (writes === before) return renderToStaticMarkup(tree)
    }
    throw new Error('Component effects did not settle')
  }
  function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(all)
    if (!isValidElement<Record<string, unknown>>(node)) return []
    return [node, ...all(node.props.children as ReactNode)]
  }
  function find(predicate: (node: ReactElement<Record<string, unknown>>) => boolean) {
    const element = all(tree).find(predicate)
    assert.ok(element, 'expected rendered control')
    return element
  }
  function button(text: string, path?: string) {
    const root = path ? find(node => (node.props.className === 'amekit-fix-card' || node.props.className === 'amekit-issue-row') && all(node).some(child => child.type === 'code' && child.props.children === path)) : tree
    const element = all(root).find(node => node.type === 'button' && node.props.children === text)
    assert.ok(element, `expected ${text}${path ? ` for ${path}` : ''}`)
    return element
  }
  function click(text: string, path?: string) {
    const element = button(text, path)
    assert.ok(!element.props.disabled, `${text} must be enabled`)
    ;(element.props.onClick as () => void)()
  }
  function change(label: string, value: string) {
    const element = find(node => node.props['aria-label'] === label || node.props.placeholder === label)
    ;(element.props.onChange as (event: unknown) => void)({ target: { value } })
  }
  return { render, find, button, click, change, AccountMarker, async flush() { await tick(); return render() }, unmount() { effects.forEach(effect => effect.cleanup?.()) } }
}

function admin(options: { initial?: ReturnType<typeof preview>; role?: string; models?: { default_model?: string; small_model?: string; model_levels?: Partial<typeof modelLevels> } | null } = {}) {
  let imported = options.initial ?? preview(), current = imported, batchFailures: { path: string; code: string }[] = [], failure = '', nextFix: Promise<unknown> | undefined
  const calls: { operation: string; payload?: Record<string, string> }[] = []
  const loggedIn = { account: { name: 'Admin', username: 'admin', role: options.role ?? 'admin' }, ready: true, models: options.models === null ? undefined : options.models ?? accountModels }
  const h = harness('Account', { embedded: true, close() {} }, async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'status' || operation === 'login') return loggedIn
    if (operation === 'logout') return null
    if (operation === 'history') return { releases: [], active: { revision: 1 } }
    if (operation === 'latest') return { release: { features: { commitEnhanceSkill: 'review' } } }
    if (operation === 'import') { current = imported; return current }
    if (operation === 'package') return { summary: { version: payload?.version }, size: 100, entries: 2, sha256: 'abc' }
    if (operation === 'publish') return { releaseId: 'release', version: '1.0.0' }
    if (failure) throw new Error(failure)
    const path = payload?.path ?? ''
    if (operation === 'fix-import') {
      if (nextFix) { const value = nextFix; nextFix = undefined; return value }
      current = { ...current, issues: current.issues.filter(item => item.path !== path), fixablePaths: current.fixablePaths.filter(item => item !== path) }
      return { preview: current, fix: fixed(path) }
    }
    if (operation === 'fix-import-all') {
      const paths = current.fixablePaths.filter(path => !batchFailures.some(item => item.path === path)).slice(0, 10)
      current = { ...current, issues: current.issues.filter(item => !paths.includes(item.path)), fixablePaths: current.fixablePaths.filter(path => !paths.includes(path)) }
      return { preview: current, fixes: paths.map(fixed), failed: batchFailures }
    }
    if (operation === 'exclude-import-file') {
      current = preview(current.files.map(file => file.path).filter(item => item !== path), current.issues.filter(item => item.path !== path))
      return { preview: current, excluded: path }
    }
    if (operation === 'revert-import-fix') {
      const paths = [...new Set([...current.files.map(file => file.path), path])]
      current = preview(paths, [...current.issues.filter(item => item.path !== path), ...imported.issues.filter(item => item.path === path)])
      return { preview: current, reverted: path }
    }
    if (operation === 'save-import-fix') return { saved: path }
    throw new Error(`Unexpected operation ${operation}`)
  })
  return {
    ...h, calls,
    setImport(value: ReturnType<typeof preview>) { imported = value },
    failBatch(value: typeof batchFailures) { batchFailures = value },
    fail(value: string) { failure = value },
    delayFix(value: Promise<unknown>) { nextFix = value },
  }
}
async function openAdmin(h: ReturnType<typeof admin>) {
  h.render(); await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
  h.click('Chọn thư mục & nhập'); return h.flush()
}
function packageBundle(h: ReturnType<typeof admin>) {
  h.change('1.0.0', '1.0.0'); h.render()
  const form = h.find(node => node.type === 'form')
  ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
}
function payload(h: ReturnType<typeof admin>, operation: string) {
  return JSON.parse(JSON.stringify(h.calls.filter(call => call.operation === operation).at(-1)?.payload))
}

test('Admin single fix uses API default, gates busy actions, shows safe diff and unblocks packaging', async () => {
  const h = admin({ initial: preview([agent]) })
  let html = await openAdmin(h)
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.equal(h.find(node => node.props['data-testid'] === 'amekit-fix-model').props.className, 'amekit-pill')
  assert.match(html, /Model sửa lỗi \(agent &amp; skill\): default · resolved-model/)
  assert.match(html, /Sửa trực tiếp các tệp agent &amp; skill bị lỗi bằng model mặc định theo API \(<code>default<\/code>: <code>resolved-model<\/code>\)/)
  assert.match(html, /secret nhạy cảm được ẩn tự động/)
  assert.equal(h.button('Đóng gói').props.disabled, true)
  assert.ok(h.button('Sửa lỗi bằng AI'))
  const response = deferred()
  h.delayFix(response.promise); h.click('Sửa bằng AI', agent); h.render()
  for (const label of ['Sửa bằng AI', 'Bỏ tệp', 'Sửa lỗi bằng AI', 'Chọn thư mục & nhập']) assert.equal(h.button(label).props.disabled, true)
  response.resolve({ preview: preview([agent], []), fix: fixed(agent) })
  html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import'), { path: agent })
  assert.match(html, /Sẵn sàng đóng gói/)
  assert.match(html, /Đã sửa bởi AI · default \(resolved-model\)/)
  assert.match(html, /chưa ghi đè thư mục gốc/)
  assert.match(html, /<details><summary>Xem thay đổi \(diff\)<\/summary><pre class="amekit-fix-diff">- \[REDACTED_SECRET_1\]\n\+ &lt;YOUR_PLACEHOLDER&gt;/)
  assert.equal(h.find(node => node.props.id === 'amekit-issue-excluded').props['aria-selected'], true)
  assert.ok(!html.includes('amekit-fix-bar'))
  packageBundle(h); html = await h.flush()
  assert.match(html, /Đã đóng gói v1\.0\.0/)
  assert.equal(h.button('Xuất bản gói đã chuẩn bị').props.disabled, false)
  h.click('Lưu về thư mục gốc', agent); html = await h.flush()
  assert.deepEqual(payload(h, 'save-import-fix'), { path: agent })
  assert.equal(h.button('Đã lưu vào đĩa', agent).props.disabled, true)
  assert.equal(h.button('Xuất bản gói đã chuẩn bị').props.disabled, true)
  assert.doesNotMatch(html, /Đã đóng gói v/)
  h.click('Hoàn tác', agent); html = await h.flush()
  assert.deepEqual(payload(h, 'revert-import-fix'), { path: agent })
  assert.doesNotMatch(html, /amekit-fix-card/)
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.match(html, /tệp trên đĩa không thay đổi/)
  h.unmount()
})

test('batch fixing deduplicates file errors, reports partial failures and preserves previous successful cards', async () => {
  const h = admin({ initial: preview([agent, skill], [issue(agent), issue(agent, 'broken local link'), issue(skill)]) })
  let html = await openAdmin(h)
  assert.ok(h.button('Sửa tất cả lỗi bằng AI (2)'))
  h.failBatch([{ path: skill, code: 'AI_FIX_VALIDATION_FAILED' }])
  h.click('Sửa tất cả lỗi bằng AI (2)'); html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import-all'), {})
  assert.match(html, /Đã sửa 1 tệp bằng AI\. Không sửa được 1 tệp:/)
  assert.ok(html.includes(`${skill} — Bản sửa AI vẫn còn lỗi`))
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.ok(h.button('Hoàn tác', agent))
  assert.ok(h.button('Sửa lỗi bằng AI'))
  h.click('Sửa bằng AI', skill); html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import'), { path: skill })
  assert.equal((html.match(/Đã sửa bởi AI · default \(resolved-model\)/g) ?? []).length, 2)
  assert.equal((html.match(/class="amekit-fix-card"/g) ?? []).length, 2)
  assert.match(html, /Sẵn sàng đóng gói/)
  assert.doesNotMatch(html, /Không sửa được 1 tệp/)
  h.unmount()
})

test('excluding a skill clears stale Enhance selection, exposes only revert and leaves other fixes intact', async () => {
  const h = admin({ initial: preview([agent, skill, stray]) })
  await openAdmin(h)
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, 'review')
  h.click('Sửa bằng AI', agent); await h.flush()
  h.click('Bỏ tệp', skill); let html = await h.flush()
  assert.deepEqual(payload(h, 'exclude-import-file'), { path: skill })
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
  assert.match(html, /Đã bỏ khỏi gói/)
  assert.equal((html.match(/>Lưu về thư mục gốc<\/button>/g) ?? []).length, 1)
  assert.equal((html.match(/>Hoàn tác<\/button>/g) ?? []).length, 2)
  assert.ok(h.button('Bỏ tệp', stray))
  h.click('Bỏ tệp', stray); html = await h.flush()
  assert.match(html, /Sẵn sàng đóng gói/)
  h.click('Hoàn tác', skill); html = await h.flush()
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.ok(h.button('Sửa bằng AI', skill))
  assert.ok(h.button('Hoàn tác', agent))
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
  h.unmount()
})

test('failed fix/save/revert do not apply invalid state or mark a file as saved', async () => {
  const h = admin({ initial: preview([agent]) })
  await openAdmin(h)
  h.fail('AI_FIX_VALIDATION_FAILED'); h.click('Sửa bằng AI', agent)
  let html = await h.flush()
  assert.match(html, /role="alert"/)
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.doesNotMatch(html, /amekit-fix-card/)
  h.fail(''); h.click('Sửa bằng AI', agent); await h.flush()
  for (const code of ['SAVE_PATH_UNSAFE', 'CANCELLED']) {
    h.fail(code); h.click('Lưu về thư mục gốc', agent); html = await h.flush()
    assert.match(html, /role="alert"/)
    assert.ok(!h.button('Lưu về thư mục gốc', agent).props.disabled)
    assert.doesNotMatch(html, />Đã lưu vào đĩa<\/button>/)
  }
  h.fail('IMPORT_FILE_NOT_FOUND'); h.click('Hoàn tác', agent); html = await h.flush()
  assert.match(html, /Không tìm thấy tệp/)
  assert.ok(h.button('Hoàn tác', agent))
  assert.match(html, /Sẵn sàng đóng gói/)
  h.unmount()
})

test('reimport and logout reset applied fixes/notices, saved state, and packaged output', async () => {
  const h = admin({ initial: preview([agent]) })
  await openAdmin(h)
  h.click('Sửa bằng AI', agent); await h.flush()
  h.click('Lưu về thư mục gốc', agent); await h.flush()
  packageBundle(h); await h.flush()
  h.click('Xuất bản gói đã chuẩn bị'); let html = await h.flush()
  assert.match(html, /Đã xuất bản v1\.0\.0/)
  h.click('Hoàn tác', agent); html = await h.flush()
  assert.doesNotMatch(html, /Đã xuất bản v/)
  h.click('Sửa bằng AI', agent); await h.flush()
  h.click('Chọn thư mục & nhập'); html = await h.flush()
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.doesNotMatch(html, /amekit-fix-card|amekit-fix-notice|Đã đóng gói v|Đã lưu vào đĩa/)
  h.click('Sửa bằng AI', agent); await h.flush()
  h.click('Tài khoản'); h.render(); h.click('Đăng xuất'); html = await h.flush()
  assert.doesNotMatch(html, /Quản trị|amekit-fix-card|amekit-fix-notice/)
  const login = h.find(node => node.type === 'form')
  ;(login.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  await h.flush(); h.click('Quản trị'); h.render(); html = await h.flush()
  assert.doesNotMatch(html, /amekit-inspector|amekit-fix-card|amekit-fix-notice/)
  h.unmount()
})

test('only backend-advertised fixable error paths get AI actions; warnings and unsafe paths get no actions', async () => {
  const initial = preview([stray], [issue(stray), issue(''), issue('../outside.md'), issue('C:\\outside.md')])
  initial.issues.push({ path: agent, severity: 'warning', reason: 'legacy reference' })
  const h = admin({ initial })
  let html = await openAdmin(h)
  assert.doesNotMatch(html, />Sửa bằng AI<|>Sửa lỗi bằng AI</)
  assert.equal((html.match(/>Bỏ tệp<\/button>/g) ?? []).length, 1)
  const warnings = h.find(node => node.props.id === 'amekit-issue-warning')
  ;(warnings.props.onClick as () => void)(); html = h.render()
  const panel = html.match(/id="amekit-issue-panel"[\s\S]*?<\/ul>/)?.[0] ?? ''
  assert.match(panel, /legacy reference/)
  assert.doesNotMatch(panel, /amekit-issue-actions/)
  h.unmount()
  const member = admin({ role: 'member' })
  member.render(); html = await member.flush()
  assert.doesNotMatch(html, /Quản trị|Sửa bằng AI/)
  member.unmount()
})

test('single-file bulk button uses fix-import-all without a model override', async () => {
  const h = admin({ initial: preview([agent]) })
  await openAdmin(h)
  h.click('Sửa lỗi bằng AI'); const html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import-all'), {})
  assert.match(html, /Đã sửa 1 tệp bằng AI/)
  assert.match(html, /Sẵn sàng đóng gói/)
  h.unmount()
})

test('batch fixes explain the ten-file limit and keep remaining errors actionable', async () => {
  const paths = Array.from({ length: 11 }, (_, index) => `agents/helper-${index}.md`)
  const initial = { ...preview(paths), fixablePaths: paths }
  const h = admin({ initial })
  await openAdmin(h)
  h.click('Sửa tất cả lỗi bằng AI (11)'); const html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import-all'), {})
  assert.match(html, /Đã sửa 10 tệp bằng AI/)
  assert.match(html, /Mỗi lần sửa tối đa 10 tệp; chạy lại/)
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.equal((html.match(/class="amekit-fix-card"/g) ?? []).length, 10)
  assert.ok(h.button('Sửa bằng AI', paths[10]))
  h.unmount()
})

test('all-failed batch preserves the blocking preview without claiming a successful fix', async () => {
  const h = admin()
  await openAdmin(h)
  h.failBatch([{ path: agent, code: 'AI_FIX_PROVIDER_ERROR' }, { path: skill, code: 'AI_FIX_INVALID_RESPONSE' }])
  h.click('Sửa tất cả lỗi bằng AI (2)'); const html = await h.flush()
  assert.match(html, /Đã sửa 0 tệp bằng AI\. Không sửa được 2 tệp/)
  assert.match(html, /Bị chặn · 2 lỗi/)
  assert.doesNotMatch(html, /amekit-fix-card/)
  assert.ok(h.button('Sửa bằng AI', agent))
  assert.ok(h.button('Sửa bằng AI', skill))
  h.unmount()
})

test('Account shows all API tiers and prefers the default tier mapping over the catalog default', async () => {
  const h = admin({ models: { ...accountModels, default_model: 'legacy-default' } })
  h.render(); let html = await h.flush()
  assert.match(html, /<h4>Phân cấp Model từ API<\/h4>/)
  for (const [level, id] of Object.entries(modelLevels)) assert.ok(html.includes(`<dt><code>${level}</code></dt><dd><code>${id}</code></dd>`))
  h.click('Quản trị'); h.render(); await h.flush()
  h.click('Chọn thư mục & nhập'); html = await h.flush()
  assert.match(html, /Model sửa lỗi \(agent &amp; skill\): default · resolved-model/)
  assert.doesNotMatch(html, /legacy-default/)
  h.unmount()
})

test('Account displays legacy API tier fallbacks and uses default_model for the fix bar', async () => {
  const h = admin({ models: { default_model: 'legacy-default', small_model: 'legacy-small' } })
  h.render(); const html = await h.flush()
  for (const [level, id] of Object.entries({ default: 'legacy-default', haiku: 'legacy-small', sonnet: 'legacy-default', opus: 'legacy-default' })) {
    assert.ok(html.includes(`<dt><code>${level}</code></dt><dd><code>${id}</code></dd>`))
  }
  assert.match(await openAdmin(h), /Model sửa lỗi \(agent &amp; skill\): default · legacy-default/)
  h.unmount()
})

test('Account without catalog metadata keeps the default fix explanation and omits the tier card', async () => {
  const h = admin({ models: null })
  h.render(); assert.doesNotMatch(await h.flush(), /Phân cấp Model từ API/)
  const html = await openAdmin(h)
  assert.match(html, /Model sửa lỗi \(agent &amp; skill\): default<\/span>/)
  assert.match(html, /API \(<code>default<\/code>\); secret/)
  assert.doesNotMatch(html, /undefined|null/)
  h.unmount()
})

test('Settings forwards project and embedded to Account without leaking its selected model', () => {
  const h = harness('Settings', {
    initialSection: 'amekit', preferences: { project: 'project' }, theme: 'dark', connection: { connected: true },
    close() {}, setLayout() {}, setTheme() {}, setConnection() {}, onPet() {}, pet: null, sprite: '', selectedModel: 'current-model',
  }, async () => null)
  h.render()
  let account = h.find(node => node.type === h.AccountMarker)
  assert.equal(Object.hasOwn(account.props, 'selectedModel'), false)
  assert.equal(account.props.projectID, 'project')
  assert.equal(account.props.embedded, true)
  h.render({ selectedModel: 'changed-model' })
  account = h.find(node => node.type === h.AccountMarker)
  assert.equal(Object.hasOwn(account.props, 'selectedModel'), false)
  assert.equal(account.props.projectID, 'project')
  assert.equal(account.props.embedded, true)
  h.unmount()
})
