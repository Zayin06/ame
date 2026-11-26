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
function harness(component: 'Account' | 'Settings', initialProps: object, account: (operation: string, payload?: Record<string, string>) => Promise<unknown>, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
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
  const events = new EventTarget(), dispatched: string[] = []
  const dispatchEvent = (event: Event) => { dispatched.push(event.type); return events.dispatchEvent(event) }
  runInNewContext(code, { exports, Event, window: { ame: { account }, localStorage: storage, dispatchEvent, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) }, require: (name: string) => modules[name] ?? nativeRequire(name) })
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
  return { render, find, button, click, change, AccountMarker, dispatchEvent, dispatched, async flush() { await tick(); return render() }, unmount() { effects.forEach(effect => effect.cleanup?.()) } }
}

function admin(options: { storage?: Pick<Storage, 'getItem' | 'setItem'>; serverVersion?: string; initial?: ReturnType<typeof preview>; role?: string; features?: { commitEnhanceSkill?: string; commitEnhanceModel?: string; androidTranslationSkill?: string; androidTranslationModel?: string }; models?: { default_model?: string; small_model?: string; model_levels?: Partial<typeof modelLevels>; active_models?: { id: string; name: string; vision?: boolean; reasoning?: boolean }[] } | null } = {}) {
  let imported = options.initial ?? preview(), current = imported, batchFailures: { path: string; code: string; detail?: string }[] = [], failure = '', nextFix: Promise<unknown> | undefined
  let nextImport: Promise<unknown> | undefined, nextBatch: Promise<unknown> | undefined, nextHistory: Promise<unknown> | undefined
  let activationError = '', historyError = '', activeID = '', revision = 1, nextRelease: Promise<unknown> | undefined
  let releases = options.serverVersion ? [{ releaseId: 'previous', version: options.serverVersion }] : []
  const calls: { operation: string; payload?: Record<string, string> }[] = []
  const loggedIn = { account: { name: 'Admin', username: 'admin', role: options.role ?? 'admin' }, ready: true, models: options.models === null ? undefined : options.models ?? accountModels }
  const h = harness('Account', { embedded: true, close() {} }, async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'status' || operation === 'login') return loggedIn
    if (operation === 'logout') return null
    if (operation === 'history') {
      if (nextHistory) { const value = nextHistory; nextHistory = undefined; return value }
      if (historyError) throw new Error(historyError)
      return { releases, active: { revision, release_id: activeID } }
    }
    if (operation === 'latest') return { release: { version: options.serverVersion, features: options.features ?? { commitEnhanceSkill: 'review' } } }
    if (operation === 'import') {
      if (nextImport) { const value = nextImport; nextImport = undefined; return value }
      if (failure) throw new Error(failure)
      current = imported; return current
    }
    if (failure) throw new Error(failure)
    if (operation === 'release') {
      if (nextRelease) { const value = nextRelease; nextRelease = undefined; return value }
      const release = { releaseId: `release-${payload?.version}`, version: payload?.version ?? '' }
      releases = [release, ...releases]
      if (payload?.activate === 'true' && !activationError) { activeID = release.releaseId; revision++ }
      return { release, activated: payload?.activate === 'true' && !activationError ? { release, revision } : null, activationError }
    }
    if (operation === 'activate') {
      activeID = payload?.id ?? ''; revision++
      return { release: releases.find(release => release.releaseId === activeID), revision }
    }
    if (operation === 'package') return { summary: { version: payload?.version, features: Object.fromEntries(Object.entries(payload ?? {}).filter(([key]) => key !== 'version')) }, size: 100, entries: 2, sha256: 'abc' }
    if (operation === 'publish') return { releaseId: 'release', version: '1.0.0' }
    if (failure) throw new Error(failure)
    const path = payload?.path ?? ''
    if (operation === 'fix-import') {
      if (nextFix) { const value = nextFix; nextFix = undefined; return value }
      current = { ...current, issues: current.issues.filter(item => item.path !== path), fixablePaths: current.fixablePaths.filter(item => item !== path) }
      return { preview: current, fix: fixed(path) }
    }
    if (operation === 'fix-import-all') {
      if (nextBatch) { const value = nextBatch; nextBatch = undefined; return value }
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
  }, options.storage)
  return {
    ...h, calls,
    failActivation(value: string) { activationError = value },
    failHistory(value: string) { historyError = value },
    delayHistory(value: Promise<unknown>) { nextHistory = value },
    delayRelease(value: Promise<unknown>) { nextRelease = value },
    setImport(value: ReturnType<typeof preview>) { imported = value },
    failBatch(value: typeof batchFailures) { batchFailures = value },
    fail(value: string) { failure = value },
    delayFix(value: Promise<unknown>) { nextFix = value },
    delayImport(value: Promise<unknown>) { nextImport = value },
    delayBatch(value: Promise<unknown>) { nextBatch = value },
  }
}
async function openAdmin(h: ReturnType<typeof admin>) {
  h.render(); await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
  h.click('Chọn thư mục & nhập'); return h.flush()
}
function packageBundle(h: ReturnType<typeof admin>) {
  if (!h.render().includes('aria-label="Phiên bản"')) { h.click('Sửa phiên bản'); h.render() }
  h.change('Phiên bản', '1.0.0'); h.render(); h.click('Chỉ đóng gói thử')
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
  assert.equal(h.button('Chỉ đóng gói thử').props.disabled, true)
  assert.ok(h.button('Sửa lỗi bằng AI'))
  const response = deferred()
  h.delayFix(response.promise); h.click('Sửa bằng AI', agent); h.render()
  for (const label of ['Đang sửa…', 'Bỏ tệp', 'Sửa lỗi bằng AI', 'Đổi thư mục']) assert.equal(h.button(label).props.disabled, true)
  const bar = h.find(node => node.props.className === 'amekit-fix-bar')
  assert.ok((bar.props.children as ReactNode[]).some(child => isValidElement<{ className?: string }>(child) && child.props.className === 'amekit-busy-inline'))
  assert.match(h.render(), /amekit-spinner.*Đang sửa agents\/helper.md.*model default.*resolved-model/s)
  assert.doesNotMatch(h.render(), />Đang xử lý…</)
  response.resolve({ preview: preview([agent], []), fix: fixed(agent) })
  html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import'), { path: agent })
  assert.match(html, /Sẵn sàng phát hành/)
  assert.match(html, /Đã sửa bởi AI · default \(resolved-model\)/)
  assert.match(html, /chưa ghi đè thư mục gốc/)
  assert.match(html, /<details><summary>Xem thay đổi \(diff\)<\/summary><pre class="amekit-fix-diff">- \[REDACTED_SECRET_1\]\n\+ &lt;YOUR_PLACEHOLDER&gt;/)
  assert.equal(h.find(node => node.props.id === 'amekit-issue-excluded').props['aria-selected'], true)
  assert.ok(!html.includes('amekit-fix-bar'))
  packageBundle(h); html = await h.flush()
  assert.match(html, /Đã đóng gói v1\.0\.0/)
  assert.equal(h.button('Xuất bản gói đã nén').props.disabled, false)
  h.click('Lưu về thư mục gốc', agent); html = await h.flush()
  assert.deepEqual(payload(h, 'save-import-fix'), { path: agent })
  assert.equal(h.button('Đã lưu vào đĩa', agent).props.disabled, true)
  assert.doesNotMatch(html, />Xuất bản gói đã nén</)
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
  h.failBatch([{ path: skill, code: 'AI_FIX_VALIDATION_FAILED', detail: 'missing/unsafe local reference: guide.md' }])
  h.click('Sửa tất cả lỗi bằng AI (2)'); html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import-all'), {})
  assert.match(html, /Đã sửa 1 tệp bằng AI\. Không sửa được 1 tệp:/)
  assert.ok(html.includes(`${skill} — Bản sửa AI vẫn còn lỗi sau khi kiểm tra lại: missing/unsafe local reference: guide.md`))
  assert.match(html, /<\/div><p class="amekit-alert amekit-alert--error" role="alert">Đã sửa 1 tệp/)
  assert.ok(html.indexOf('Không sửa được 1 tệp') < html.indexOf('amekit-issue-tabs'))
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.ok(h.button('Hoàn tác', agent))
  assert.ok(h.button('Sửa lỗi bằng AI'))
  h.click('Sửa bằng AI', skill); html = await h.flush()
  assert.deepEqual(payload(h, 'fix-import'), { path: skill })
  assert.equal((html.match(/Đã sửa bởi AI · default \(resolved-model\)/g) ?? []).length, 2)
  assert.equal((html.match(/class="amekit-fix-card"/g) ?? []).length, 2)
  assert.match(html, /Sẵn sàng phát hành/)
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
  assert.match(html, /Sẵn sàng phát hành/)
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
  assert.match(html, /Sẵn sàng phát hành/)
  h.unmount()
})

test('reimport and logout reset applied fixes/notices, saved state, and packaged output', async () => {
  const h = admin({ initial: preview([agent]) })
  await openAdmin(h)
  h.click('Sửa bằng AI', agent); await h.flush()
  h.click('Lưu về thư mục gốc', agent); await h.flush()
  packageBundle(h); await h.flush()
  h.click('Xuất bản gói đã nén'); let html = await h.flush()
  assert.match(html, /Đã xuất bản v1\.0\.0/)
  h.click('Hoàn tác', agent); html = await h.flush()
  assert.doesNotMatch(html, /Đã xuất bản v/)
  h.click('Sửa bằng AI', agent); await h.flush()
  h.click('Đổi thư mục'); html = await h.flush()
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

test('pending, canceled and failed reimports retain preview, staged fixes, features and package', async () => {
  const h = admin({ initial: preview() })
  await openAdmin(h)
  h.click('Sửa tất cả lỗi bằng AI (2)'); await h.flush()
  packageBundle(h); await h.flush()
  const pending = deferred()
  h.delayImport(pending.promise); h.click('Đổi thư mục')
  let html = h.render()
  assert.equal(h.button('Đang quét thư mục…').props.disabled, true)
  for (const text of ['amekit-inspector', 'amekit-fix-card', 'Đã đóng gói v1.0.0', 'Đã sửa 2 tệp bằng AI']) assert.ok(html.includes(text), text)
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, 'review')
  pending.resolve(null); html = await h.flush()
  assert.match(html, /amekit-fix-card|Đã đóng gói v1\.0\.0/)
  assert.equal(h.button('Xuất bản gói đã nén').props.disabled, false)
  h.fail('AI_FIX_PROVIDER_ERROR: HTTP 400: unsupported model setting')
  h.click('Đổi thư mục'); html = await h.flush()
  assert.match(html, /amekit-inspector/)
  assert.match(html, /Đã đóng gói v1\.0\.0/)
  assert.equal((html.match(/unsupported model setting/g) ?? []).length, 1)
  const source = renderToStaticMarkup(h.find(node => node.props['data-testid'] === 'amekit-source-card'))
  assert.match(source, /role="alert".*unsupported model setting/s)
  assert.ok(html.indexOf('role="alert"') > html.indexOf('amekit-source-card'))
  h.fail(''); h.setImport(preview([agent])); h.click('Đổi thư mục'); html = await h.flush()
  assert.match(html, /Bị chặn · 1 lỗi/)
  assert.doesNotMatch(html, /amekit-fix-card|Đã đóng gói v|unsupported model setting/)
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Enhance (Commit message)').props.value, '')
  h.unmount()
})

test('batch progress is inline and restores actions after provider diagnostics', async () => {
  const h = admin()
  await openAdmin(h)
  const pending = deferred()
  h.delayBatch(pending.promise); h.click('Sửa tất cả lỗi bằng AI (2)')
  let html = h.render()
  assert.equal(h.button('Đang sửa bằng AI…').props.disabled, true)
  assert.match(html, /amekit-busy-inline" role="status"/)
  assert.match(html, /amekit-spinner/)
  assert.doesNotMatch(html, />Đang xử lý…</)
  pending.resolve({ preview: preview(), fixes: [], failed: [{ path: agent, code: 'AI_FIX_PROVIDER_ERROR', detail: 'HTTP 400: unsupported parameter' }] })
  html = await h.flush()
  assert.match(html, /role="alert">Đã sửa 0 tệp.*HTTP 400: unsupported parameter/)
  assert.doesNotMatch(html, /amekit-busy-inline|amekit-spinner/)
  assert.equal(h.button('Sửa tất cả lỗi bằng AI (2)').props.disabled, false)
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
  assert.match(html, /Sẵn sàng phát hành/)
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

test('version formatters normalize catalog and semver versions and preserve missing values', () => {
  for (const [input, expected] of [['registry.22', 'v22'], ['REGISTRY.5', 'v5'], ['catalog-42', 'catalog-42'], [undefined, '—'], ['', '—'], ['  registry.22  ', 'v22'], ['   ', '—']] as const) {
    assert.equal(amekitUI.formatCatalogVersion(input), expected)
  }
  for (const [input, expected] of [['1.0.3', 'v1.0.3'], ['v1.0.7', 'v1.0.7'], ['V2.0.0', 'v2.0.0'], [undefined, '—'], ['', '—'], ['  V2.0.0  ', 'v2.0.0'], ['   ', '—']] as const) {
    assert.equal(amekitUI.formatSemverVersion(input), expected)
  }
})

test('version summary combines model, orchestrator and optional bundle versions', () => {
  assert.equal(amekitUI.formatVersionSummaryLine({ modelVersion: 'registry.22', orchestratorVersion: '1.0.3', bundleVersion: '1.0.7' }), 'Model v22 · Điều phối v1.0.3 · Bundle v1.0.7')
  assert.equal(amekitUI.formatVersionSummaryLine({ modelVersion: 'registry.22', orchestratorVersion: '1.0.3' }), 'Model v22 · Điều phối v1.0.3 · Bundle Chưa cài')
  assert.equal(amekitUI.formatVersionSummaryLine({ bundleVersion: '   ' }), 'Model — · Điều phối — · Bundle Chưa cài')
})

test('Account displays snapshot catalog, installed/latest bundle versions, refresh epoch and background sync warning', async () => {
  const refreshedAt = new Date('2026-11-26T08:09:10Z').getTime()
  const h = harness('Account', { embedded: true, close() {} }, async operation => {
    assert.equal(operation, 'status')
    return {
      account: { name: 'User', username: 'user' }, ready: true, models: { ...accountModels, version: 'catalog-42' },
      orchestrator: { id: 'ame-orchestrator', version: '1.0.3' },
      refreshedAt, bundle: { installedVersion: '1.2.0', latestVersion: '1.3.0' }, bundleAutoSyncError: 'NETWORK_ERROR',
    }
  })
  h.render(); const html = await h.flush()
  const versions = renderToStaticMarkup(h.find(node => node.props['data-testid'] === 'amekit-account-versions'))
  assert.match(versions, /<h4>Cấu hình AME<\/h4>/)
  assert.match(versions, /class="amekit-pill amekit-readiness--blocked" data-testid="amekit-version-status">Có bản cập nhật mới/)
  const details = h.find(node => node.props['data-testid'] === 'amekit-version-details')
  assert.equal(details.type, 'details')
  assert.equal(details.props.open, undefined)
  assert.match(renderToStaticMarkup(details), /<summary>Chi tiết phiên bản \(Model catalog-42 · Điều phối v1\.0\.3 · Bundle v1\.2\.0\)<\/summary>/)
  assert.match(versions, /<dt>Model \(Catalog API\)<\/dt><dd>catalog-42<\/dd>/)
  assert.match(versions, /<dt>Agent điều phối<\/dt><dd>v1\.0\.3<\/dd>/)
  assert.match(versions, /<dt>Bundle đã cài<\/dt><dd>v1\.2\.0<\/dd>/)
  assert.match(versions, /<dt>Bundle mới nhất<\/dt><dd>v1\.3\.0<\/dd>/)
  assert.match(versions, /<time dateTime="2026-11-26T08:09:10\.000Z">/)
  assert.ok(versions.includes(new Date(refreshedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })))
  assert.match(html, /amekit-alert--warning" role="status"><strong>Tự đồng bộ nền chưa thể áp dụng bundle:/)
  assert.ok(html.includes(amekitUI.formatAmeKitError('NETWORK_ERROR').title))
  assert.match(html, /Mở Bundle để thử Đồng bộ \/ Cập nhật ngay/)
  assert.doesNotMatch(html, /Đã làm mới phiên lúc/)
  h.unmount()
})

test('Account uses loaded installed bundle as a fallback and omits matching latest versions', async () => {
  for (const installedVersion of [undefined, '2.0.0']) {
    const h = harness('Account', { embedded: true, close() {} }, async operation => {
      if (operation === 'status') return { account: { name: 'User', username: 'user' }, ready: true, bundle: { installedVersion, latestVersion: '2.0.0' } }
      if (operation === 'installed') return { version: '2.0.0', releaseId: 'active' }
      if (operation === 'latest') return { release: { version: '2.0.0', releaseId: 'active' } }
      throw new Error(`Unexpected operation ${operation}`)
    })
    h.render(); let html = await h.flush()
    assert.match(html, /<dt>Model \(Catalog API\)<\/dt><dd>—<\/dd>/)
    assert.match(html, /<dt>Agent điều phối<\/dt><dd>—<\/dd>/)
    assert.match(html, /Chưa làm mới/)
    if (!installedVersion) assert.match(html, /<dt>Bundle đã cài<\/dt><dd>Chưa cài<\/dd>/)
    h.click('Bundle'); h.render(); await h.flush(); h.click('Tài khoản'); html = h.render()
    assert.match(html, /<dt>Bundle đã cài<\/dt><dd>v2\.0\.0<\/dd>/)
    assert.match(html, /class="amekit-pill amekit-readiness--ready" data-testid="amekit-version-status">Đã mới nhất/)
    assert.match(html, /<summary>Chi tiết phiên bản \(Model — · Điều phối — · Bundle v2\.0\.0\)<\/summary>/)
    assert.doesNotMatch(html, /Bundle mới nhất|undefined|null/)
    h.unmount()
  }
})

test('Account refresh banner waits for completion, reports returned versions and clears on logout', async () => {
  const refresh = deferred(), calls: string[] = []
  const loggedIn = { account: { name: 'User', username: 'user' }, ready: true, models: { ...accountModels, version: 'old-catalog' }, orchestrator: { id: 'ame-orchestrator', version: '1.0.2' }, bundle: { installedVersion: '1.0.0' } }
  const h = harness('Account', { embedded: true, close() {} }, async operation => {
    calls.push(operation)
    if (operation === 'status' || operation === 'login') return loggedIn
    if (operation === 'refresh') return refresh.promise
    if (operation === 'logout') return null
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Làm mới phiên')
  let html = h.render()
  assert.equal(h.button('Làm mới phiên').props.disabled, true)
  assert.doesNotMatch(html, /Đã làm mới phiên lúc/)
  const refreshedAt = new Date('2026-11-26T12:34:56Z').getTime()
  refresh.resolve({ ...loggedIn, models: { ...accountModels, version: 'registry.22' }, orchestrator: { id: 'ame-orchestrator', version: '1.0.3' }, bundle: { installedVersion: '2.0.0', latestVersion: '2.0.0' }, refreshedAt })
  html = await h.flush()
  const notice = h.find(node => node.props['data-testid'] === 'amekit-refresh-notice')
  assert.equal(notice.props.role, 'status')
  assert.equal(notice.props.className, 'amekit-alert amekit-alert--success')
  assert.equal(notice.props.children, `Đã làm mới phiên lúc ${new Date(refreshedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} · Model v22 · Điều phối v1.0.3 · Bundle v2.0.0`)
  assert.match(html, /data-testid="amekit-version-status">Đã mới nhất/)
  assert.match(html, /<summary>Chi tiết phiên bản \(Model v22 · Điều phối v1\.0\.3 · Bundle v2\.0\.0\)<\/summary>/)
  assert.match(html, /<dt>Agent điều phối<\/dt><dd>v1\.0\.3<\/dd>/)
  assert.doesNotMatch(html, /old-catalog|v1\.0\.0|Bundle mới nhất/)
  assert.equal(h.button('Làm mới phiên').props.disabled, false)
  assert.deepEqual(calls, ['status', 'refresh'])
  h.click('Đăng xuất'); html = await h.flush()
  assert.doesNotMatch(html, /Đã làm mới phiên lúc|amekit-account-versions/)
  const login = h.find(node => node.type === 'form')
  ;(login.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
  html = await h.flush()
  assert.match(html, /old-catalog/)
  assert.doesNotMatch(html, /Đã làm mới phiên lúc|Model v22/)
  h.unmount()
})

test('Account failed refresh does not claim success or replace displayed versions', async () => {
  const h = harness('Account', { embedded: true, close() {} }, async operation => {
    if (operation === 'status') return { account: { name: 'User', username: 'user' }, ready: true, models: { version: 'catalog-42' }, orchestrator: { id: 'ame-orchestrator', version: 'V1.0.3' }, bundle: { installedVersion: '1.0.0' }, bundleAutoSyncError: 'NETWORK_ERROR' }
    throw new Error('NETWORK_ERROR')
  })
  h.render(); await h.flush(); h.click('Làm mới phiên'); const html = await h.flush()
  assert.match(html, /role="alert"/)
  assert.match(html, /catalog-42/)
  assert.match(html, /v1\.0\.0/)
  assert.match(html, /class="amekit-pill" data-testid="amekit-version-status">Cần kiểm tra đồng bộ/)
  assert.match(html, /<summary>Chi tiết phiên bản \(Model catalog-42 · Điều phối v1\.0\.3 · Bundle v1\.0\.0\)<\/summary>/)
  assert.match(html, /<dt>Agent điều phối<\/dt><dd>v1\.0\.3<\/dd>/)
  assert.doesNotMatch(html, /Đã làm mới phiên lúc/)
  assert.equal(h.button('Làm mới phiên').props.disabled, false)
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
  h.render(); assert.doesNotMatch(await h.flush(), /Phân cấp Model từ API|amekit-active-models/)
  const html = await openAdmin(h)
  assert.match(html, /Model sửa lỗi \(agent &amp; skill\): default<\/span>/)
  assert.match(html, /API \(<code>default<\/code>\); secret/)
  assert.doesNotMatch(html, /undefined|null/)
  h.unmount()
})

test('Android feature failures provide actionable Vietnamese account messages', () => {
  for (const code of ['UNKNOWN_ANDROID_TRANSLATION_SKILL', 'ANDROID_TRANSLATION_NOT_CONFIGURED', 'TRANSLATION_SESSION_LOCKED', 'TRANSLATION_MODEL_UNAVAILABLE', 'ANDROID_TRANSLATION_SESSION_REQUIRED']) {
    const result = amekitUI.formatAmeKitError(new Error(code))
    assert.equal(result.code, code)
    assert.notEqual(result.title, code)
    assert.ok(result.detail)
  }
})

test('Account lists every active API model with capabilities for user accounts', async () => {
  const h = admin({ role: 'user', models: { ...accountModels, active_models: [
    { id: modelLevels.default, name: 'Default' },
    { id: 'gemini-active', name: 'Gemini Active', vision: true, reasoning: true },
  ] } })
  h.render(); const html = await h.flush()
  assert.match(html, /<details class="amekit-details amekit-active-models" data-testid="amekit-active-models"><summary>/)
  const disclosure = h.find(node => node.props['data-testid'] === 'amekit-active-models')
  assert.equal(disclosure.type, 'details')
  assert.ok(!disclosure.props.open)
  for (const action of ['Làm mới phiên', 'Đăng xuất']) {
    assert.ok(html.indexOf(action) < html.indexOf('Phân cấp Model từ API'))
    assert.ok(html.indexOf(action) < html.indexOf('amekit-active-models'))
  }
  assert.ok(html.includes('Tất cả Model đang hoạt động từ API (2)'))
  assert.match(html, /Gemini Active/)
  assert.match(html, /gemini-active/)
  assert.match(html, />Vision</)
  assert.match(html, />Reasoning</)
  assert.doesNotMatch(html, />Quản trị</)
  h.unmount()
})

test('Admin prefills all feature fields, selects direct active models and packages four options', async () => {
  const features = { commitEnhanceSkill: 'review', commitEnhanceModel: 'inactive-model', androidTranslationSkill: 'review', androidTranslationModel: 'gemini-active' }
  const h = admin({ initial: preview([agent, skill], []), features, models: { ...accountModels, active_models: [{ id: 'gemini-active', name: 'Gemini' }, { id: 'commit-active', name: 'Commit' }] } })
  let html = await openAdmin(h)
  for (const [label, value] of [
    ['Skill cho Enhance (Commit message)', features.commitEnhanceSkill], ['Model cho Enhance (Commit message)', features.commitEnhanceModel],
    ['Skill cho Dịch Android', features.androidTranslationSkill], ['Model cho Dịch Android', features.androidTranslationModel],
  ]) assert.equal(h.find(node => node.props['aria-label'] === label).props.value, value)
  assert.match(html, /inactive-model · Không còn hoạt động/)
  h.change('Model cho Enhance (Commit message)', 'commit-active'); h.render()
  packageBundle(h); html = await h.flush()
  assert.ok(html.includes('Enhance: /review · commit-active'))
  assert.ok(html.includes('Dịch Android: /review · gemini-active'))
  assert.deepEqual(payload(h, 'package'), { version: '1.0.0', ...features, commitEnhanceModel: 'commit-active' })
  h.change('Skill cho Dịch Android', ''); html = h.render()
  assert.equal(h.find(node => node.props['aria-label'] === 'Model cho Dịch Android').props.disabled, true)
  assert.doesNotMatch(html, />Xuất bản gói đã nén</)
  h.unmount()
})

test('Bundle installed and release history summaries retain both feature models', async () => {
  const features = { commitEnhanceSkill: 'review', commitEnhanceModel: 'commit-active', androidTranslationSkill: 'android-strings-translation', androidTranslationModel: 'gemini-active' }
  const h = harness('Account', { embedded: true, projectID: 'project', close() {} }, async operation => {
    if (operation === 'status') return { account: { name: 'Admin', username: 'admin', role: 'admin' }, models: accountModels, ready: true }
    if (operation === 'installed') return { version: '1.0.0', releaseId: 'installed', features }
    if (operation === 'legacy-installed') return null
    if (operation === 'latest') return { release: { releaseId: 'latest', version: '2.0.0', manifest: { features } } }
    if (operation === 'history') return { releases: [{ releaseId: 'latest', version: '2.0.0', manifest: { features } }], active: { revision: 1 } }
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle'); h.render()
  let html = await h.flush()
  assert.equal((html.match(/Enhance: \/review · commit-active/g) ?? []).length, 2)
  assert.equal((html.match(/Dịch Android: \/android-strings-translation · gemini-active/g) ?? []).length, 2)
  h.click('Quản trị'); h.render(); await h.flush(); h.click('Lịch sử (1)'); html = h.render()
  assert.ok(html.includes('Enhance: /review · commit-active'))
  assert.ok(html.includes('Dịch Android: /android-strings-translation · gemini-active'))
  h.unmount()
})

test('Bundle retains installed, latest and same-project legacy state while refreshing on tab reentry', async () => {
  const refreshInstalled = deferred(), refreshLatest = deferred()
  let installedCalls = 0, latestCalls = 0
  const h = harness('Account', { embedded: true, projectID: 'project', close() {} }, async operation => {
    if (operation === 'status') return { account: { name: 'User', username: 'user' }, ready: true }
    if (operation === 'installed') return ++installedCalls === 1 ? { version: '1.0.0', releaseId: 'installed' } : refreshInstalled.promise
    if (operation === 'latest') return ++latestCalls === 1 ? { release: { version: '2.0.0', releaseId: 'latest' } } : refreshLatest.promise
    if (operation === 'legacy-installed') return { projectName: 'Legacy workspace', fileCount: 2, hasConfigDir: true, hasManagedDir: true }
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle'); h.render(); await h.flush()
  h.click('Tài khoản'); h.render(); h.click('Bundle')
  const assertRetained = (html: string) => {
    assert.match(html, /Đang dùng: v1\.0\.0/)
    assert.match(html, /Trên máy chủ: v2\.0\.0/)
    assert.match(html, /Có bản mới v2\.0\.0/)
    assert.match(html, /Legacy workspace/)
    assert.doesNotMatch(html, /Ứng dụng chưa đồng bộ bundle nào|Đang kiểm tra trạng thái bundle…|>Đang xử lý…</)
    assert.equal(h.button('Gỡ bundle').props.disabled, false)
    assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, false)
  }
  assertRetained(h.render())
  assertRetained(await h.flush())
  assert.equal(installedCalls, 2)
  refreshInstalled.resolve({ version: '1.0.0', releaseId: 'installed' })
  assertRetained(await h.flush())
  assert.equal(latestCalls, 2)
  refreshLatest.resolve({ release: { version: '3.0.0', releaseId: 'new' } })
  const html = await h.flush()
  assert.match(html, /Đang dùng: v1\.0\.0/)
  assert.match(html, /Trên máy chủ: v3\.0\.0/)
  assert.doesNotMatch(html, /Ứng dụng chưa đồng bộ bundle nào|>Đang xử lý…</)
  h.unmount()
})

test('first empty Bundle load shows local progress, ignores canceled results and preserves no-release state on refresh', async () => {
  const canceled = deferred(), installed = deferred(), latest = deferred(), refresh = deferred()
  let installedCalls = 0, latestCalls = 0
  const h = harness('Account', { embedded: true, close() {} }, async operation => {
    if (operation === 'status') return { account: { name: 'User', username: 'user' }, ready: true }
    if (operation === 'installed') return [canceled.promise, installed.promise, refresh.promise][installedCalls++]
    if (operation === 'latest') {
      latestCalls++
      if (latestCalls === 1) await latest.promise
      throw new Error('NO_ACTIVE_RELEASE')
    }
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle')
  const assertLoading = (html: string) => {
    assert.match(html, /role="status">Đang kiểm tra trạng thái bundle…</)
    assert.doesNotMatch(html, /Ứng dụng chưa đồng bộ bundle nào|>Đang xử lý…</)
  }
  assertLoading(h.render()); assertLoading(await h.flush())
  h.click('Tài khoản')
  assert.doesNotMatch(h.render(), /Đang kiểm tra trạng thái bundle…|>Đang xử lý…</)
  h.click('Bundle'); assertLoading(h.render())
  canceled.resolve({ version: 'stale', releaseId: 'stale' })
  let html = await h.flush()
  assertLoading(html)
  assert.doesNotMatch(html, /Đang dùng: vstale/)
  assert.equal(installedCalls, 2)
  installed.resolve(null); assertLoading(await h.flush())
  latest.resolve(null); html = await h.flush()
  assert.match(html, /Ứng dụng chưa đồng bộ bundle nào/)
  assert.match(html, /Máy chủ chưa có bản phát hành nào được kích hoạt/)
  assert.doesNotMatch(html, /Đang kiểm tra trạng thái bundle…|>Đang xử lý…</)
  assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, true)
  h.click('Tài khoản'); h.render(); h.click('Bundle'); html = h.render()
  assert.match(html, /Ứng dụng chưa đồng bộ bundle nào/)
  assert.match(html, /Máy chủ chưa có bản phát hành nào được kích hoạt/)
  assert.doesNotMatch(html, /Đang kiểm tra trạng thái bundle…|>Đang xử lý…</)
  assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, true)
  refresh.resolve(null); await h.flush()
  h.unmount()
})

test('Admin numbers visible steps consecutively and keeps controls enabled during background history loads', async () => {
  const h = admin({ initial: preview([agent], []) }), history = deferred(), refresh = deferred()
  h.delayHistory(history.promise)
  h.render(); await h.flush(); h.click('Quản trị')
  let html = h.render()
  assert.match(html, /<h3>2\. Phát hành cho team<\/h3>/)
  assert.doesNotMatch(html, /Tính năng tích hợp|3\. Phát hành cho team|>Đang xử lý…</)
  for (const label of ['Chọn thư mục & nhập', 'Sửa phiên bản']) assert.equal(h.button(label).props.disabled, false)
  assert.equal(h.find(node => node.props['aria-label'] === 'Chế độ tương thích').props.disabled, false)
  h.click('Sửa phiên bản'); h.render()
  assert.equal(h.find(node => node.props['aria-label'] === 'Phiên bản').props.disabled, false)
  h.click('Lịch sử (0)'); html = await h.flush()
  assert.match(html, /role="status">Đang tải lịch sử phát hành…</)
  assert.doesNotMatch(html, /Chưa có bản phát hành nào trên máy chủ|>Đang xử lý…</)
  assert.equal(h.button('Làm mới').props.disabled, false)
  history.resolve({ releases: [] }); html = await h.flush()
  assert.match(html, /Chưa có bản phát hành nào trên máy chủ/)
  assert.doesNotMatch(html, /Đang tải lịch sử phát hành…|>Đang xử lý…</)
  h.click('Phát hành mới'); h.render(); h.click('Chọn thư mục & nhập'); html = await h.flush()
  assert.match(html, /<h3>2\. Tính năng tích hợp \(tùy chọn\)<\/h3>/)
  assert.match(html, /<h3>3\. Phát hành cho team<\/h3>/)
  assert.doesNotMatch(html, /<h3>2\. Phát hành cho team<\/h3>/)
  h.click('Tài khoản'); h.render(); h.delayHistory(refresh.promise); h.click('Quản trị'); html = h.render()
  assert.match(html, /<h3>3\. Phát hành cho team<\/h3>/)
  assert.equal(h.button('Đổi thư mục').props.disabled, false)
  assert.equal(h.button('Chỉ đóng gói thử').props.disabled, false)
  h.click('Lịch sử (0)'); html = await h.flush()
  assert.match(html, /Chưa có bản phát hành nào trên máy chủ/)
  assert.doesNotMatch(html, /Đang tải lịch sử phát hành…|>Đang xử lý…</)
  refresh.resolve({ releases: [{ releaseId: 'new', version: '1.0.0' }] }); html = await h.flush()
  assert.match(html, /Lịch sử \(1\)/)
  assert.match(html, /<strong>v1\.0\.0<\/strong>/)
  h.unmount()
})

test('Global Bundle sync and uninstall use app-wide payloads without a project and clear notices on tab changes', async () => {
  const calls: { operation: string; payload?: Record<string, string> }[] = []
  const bundle = { version: '2.0.0', releaseId: 'active', verification: 'runtime-ready', agents: ['helper'], skills: ['review'], fileCount: 3 }
  let installed: typeof bundle | null = null, synced = false
  const sync = deferred()
  const h = harness('Account', { embedded: true, projectID: undefined, close() {} }, async (operation, payload) => {
    calls.push({ operation, payload: payload && { ...payload } })
    if (operation === 'status') return { account: { name: 'User', username: 'user' }, ready: true, bundleAutoSyncError: synced ? undefined : 'NETWORK_ERROR' }
    if (operation === 'installed') return installed
    if (operation === 'latest') return { release: { releaseId: 'active', version: '2.0.0' } }
    if (operation === 'sync') { await sync.promise; synced = true; return installed = bundle }
    if (operation === 'uninstall') { installed = null; return {} }
    if (operation === 'logout') return null
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle'); h.render()
  let html = await h.flush()
  assert.match(html, /data-testid="amekit-global-bundle"/)
  assert.match(html, /Ứng dụng chưa đồng bộ bundle nào/)
  assert.match(html, /Tự đồng bộ nền chưa thể áp dụng bundle/)
  assert.doesNotMatch(html, /Chọn dự án trước|Cho phép raw compatibility|Kiểm tra tệp đã cài \(offline\)|Bản mới nhất|Kiểm tra đã cài|type="checkbox"|>Gỡ bundle</)
  assert.deepEqual(calls.filter(call => call.operation === 'installed'), [{ operation: 'installed', payload: {} }])
  assert.equal(calls.some(call => call.operation === 'legacy-installed'), false)
  assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, false)
  h.click('Đồng bộ / Cập nhật ngay'); h.render(); await tick()
  assert.equal(h.button('Đang đồng bộ…').props.disabled, true)
  sync.resolve(bundle); html = await h.flush()
  assert.deepEqual(calls.find(call => call.operation === 'sync')?.payload, {})
  assert.match(html, /Đã đồng bộ AmeKit v2\.0\.0 toàn ứng dụng\./)
  assert.match(html, /Sẵn sàng OpenCode · 1 agents · 1 skills · 3 tệp/)
  assert.match(html, /<details class="amekit-details"><summary>Danh sách Agents \(1\) &amp; Skills \(1\)/)
  assert.doesNotMatch(html, /Tự đồng bộ nền chưa thể áp dụng bundle|amekit-server-release/)
  h.click('Gỡ bundle'); html = await h.flush()
  assert.deepEqual(calls.find(call => call.operation === 'uninstall')?.payload, {})
  assert.deepEqual(calls.filter(call => call.operation === 'installed').map(call => call.payload), [{}, {}])
  assert.match(html, /Đã gỡ bundle khỏi cấu hình toàn ứng dụng\./)
  assert.doesNotMatch(html, /Đang dùng:|>Gỡ bundle</)
  h.click('Tài khoản'); h.render(); h.click('Bundle'); h.render(); html = await h.flush()
  assert.doesNotMatch(html, /Đã gỡ bundle khỏi/)
  h.click('Tài khoản'); h.render(); h.click('Đăng xuất'); html = await h.flush()
  assert.match(html, />Đăng nhập</)
  assert.doesNotMatch(html, /Đã đồng bộ AmeKit|Đã gỡ bundle/)
  h.unmount()
})

test('Global Bundle suppresses matching server summaries but preserves changed versions or feature settings', async () => {
  const features = { commitEnhanceModel: 'commit-model' }
  for (const [version, serverFeatures, differs] of [
    ['1.0.0', features, false], ['1.0.1', features, true], ['1.0.0', { commitEnhanceModel: 'new-model' }, true],
  ] as const) {
    const h = harness('Account', { embedded: true, close() {} }, async operation => {
      if (operation === 'status') return { account: { name: 'User', username: 'user' } }
      if (operation === 'installed') return { version: '1.0.0', releaseId: 'same', features }
      if (operation === 'latest') return { release: { releaseId: 'same', version, manifest: { features: serverFeatures } } }
      throw new Error(`Unexpected operation ${operation}`)
    })
    h.render(); await h.flush(); h.click('Bundle'); h.render(); const html = await h.flush()
    assert.equal(html.includes('amekit-server-release'), differs)
    assert.match(html, /Đang dùng: v1\.0\.0/)
    h.unmount()
  }
})

test('Bundle listens for background updates only while open and recovers from no active release silently', async () => {
  const calls: string[] = []
  let active = false, failure = false
  const h = harness('Account', { embedded: true, close() {} }, async operation => {
    calls.push(operation)
    if (operation === 'status') return { account: { name: 'User', username: 'user' } }
    if (operation === 'installed') {
      if (failure) throw new Error('NETWORK_ERROR')
      return active ? { version: '2.0.0', releaseId: 'new' } : null
    }
    if (operation === 'latest') {
      if (failure) throw new Error('NETWORK_ERROR')
      if (!active) throw new Error('NO_ACTIVE_RELEASE')
      return { release: { version: '2.0.0', releaseId: 'new' } }
    }
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle'); h.render()
  assert.match(await h.flush(), /Máy chủ chưa có bản phát hành nào được kích hoạt/)
  assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, true)
  active = true; h.dispatchEvent(new Event('ame-bundle-updated'))
  let html = await h.flush()
  assert.match(html, /Đang dùng: v2\.0\.0/)
  assert.match(html, /Đã mới nhất/)
  assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, false)
  failure = true; h.dispatchEvent(new Event('ame-bundle-updated')); html = await h.flush()
  assert.match(html, /Đang dùng: v2\.0\.0/)
  assert.doesNotMatch(html, /role="alert"/)
  h.click('Tài khoản'); h.render()
  const count = calls.length
  h.dispatchEvent(new Event('ame-bundle-updated')); await h.flush()
  assert.equal(calls.length, count)
  h.unmount()
  h.dispatchEvent(new Event('ame-bundle-updated')); await tick()
  assert.equal(calls.length, count)
})

test('Legacy cleanup is project-specific, clears its card on completion and dispatches the cleanup event', async () => {
  const calls: { operation: string; payload?: Record<string, string> }[] = []
  const cleanup = deferred()
  const h = harness('Account', { embedded: true, projectID: 'project', close() {} }, async (operation, payload) => {
    calls.push({ operation, payload: payload && { ...payload } })
    if (operation === 'status') return { account: { name: 'User', username: 'user' } }
    if (operation === 'installed') return null
    if (operation === 'latest') return { release: { releaseId: 'active', version: '1.0.0' } }
    if (operation === 'legacy-installed') return { projectName: 'Legacy workspace', fileCount: 4, hasConfigDir: true, hasManagedDir: true, modified: true, error: 'OWNED_FILE_CHANGED' }
    if (operation === 'clean-legacy') return cleanup.promise
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle'); h.render()
  let html = await h.flush()
  assert.match(html, /data-testid="amekit-legacy-cleanup"/)
  assert.match(html, /Phát hiện bundle cũ trong dự án Legacy workspace/)
  assert.match(html, /4 tệp cấu hình cũ/)
  assert.match(html, /có thay đổi cục bộ hoặc trạng thái cần kiểm tra/)
  assert.ok(html.includes(amekitUI.formatAmeKitError('OWNED_FILE_CHANGED').title))
  assert.deepEqual(calls.filter(call => call.operation === 'installed').map(call => call.payload), [{}])
  assert.deepEqual(calls.find(call => call.operation === 'legacy-installed')?.payload, { project: 'project' })
  h.click('Dọn bundle cũ khỏi dự án'); h.render(); await tick()
  assert.equal(h.button('Đang dọn…').props.disabled, true)
  assert.deepEqual(calls.find(call => call.operation === 'clean-legacy')?.payload, { project: 'project' })
  cleanup.resolve({ removedFiles: 3 }); html = await h.flush()
  assert.doesNotMatch(html, /data-testid="amekit-legacy-cleanup"/)
  assert.match(html, /Đã dọn 3 tệp AmeKit cũ khỏi dự án\./)
  assert.equal(h.dispatched.filter(type => type === 'ame-legacy-cleaned').length, 1)
  h.unmount()
})

test('Legacy detection hides absent or canceled results without replacing global errors', async () => {
  for (const canceled of [false, true]) {
    const h = harness('Account', { embedded: true, projectID: 'project', close() {} }, async operation => {
      if (operation === 'status') return { account: { name: 'User', username: 'user' } }
      if (operation === 'installed') throw new Error('NETWORK_ERROR')
      if (operation === 'latest') return { release: { releaseId: 'active' } }
      if (operation === 'legacy-installed') { if (canceled) throw new Error('CANCELLED'); return null }
      throw new Error(`Unexpected operation ${operation}`)
    })
    h.render(); await h.flush(); h.click('Bundle'); h.render(); const html = await h.flush()
    assert.doesNotMatch(html, /amekit-legacy-cleanup|đã hủy hộp thoại/)
    assert.match(html, /role="alert"/)
    assert.ok(html.includes(amekitUI.formatAmeKitError('NETWORK_ERROR').title))
    h.unmount()
  }
})

test('Changing projects discards stale legacy results and clearing the project removes the cleanup card', async () => {
  const stale = deferred(), calls: string[] = []
  const h = harness('Account', { embedded: true, projectID: 'old', close() {} }, async (operation, payload) => {
    if (operation === 'status') return { account: { name: 'User', username: 'user' } }
    if (operation === 'installed') return { releaseId: 'global', version: '1.0.0' }
    if (operation === 'latest') return { release: { releaseId: 'global', version: '1.0.0' } }
    if (operation === 'legacy-installed') {
      calls.push(payload!.project)
      if (payload?.project === 'old') return stale.promise
      return null
    }
    throw new Error(`Unexpected operation ${operation}`)
  })
  h.render(); await h.flush(); h.click('Bundle'); h.render(); await h.flush()
  h.render({ projectID: 'new' })
  stale.resolve({ projectName: 'Old project', fileCount: 2, hasConfigDir: true, hasManagedDir: true })
  let html = await h.flush()
  assert.deepEqual(calls, ['old', 'new'])
  assert.doesNotMatch(html, /amekit-legacy-cleanup|Old project/)
  html = h.render({ projectID: undefined }); html = await h.flush()
  assert.doesNotMatch(html, /amekit-legacy-cleanup/)
  assert.equal(h.button('Đồng bộ / Cập nhật ngay').props.disabled, false)
  h.unmount()
})

test('Admin can package a commit model without a skill and omit cleared feature overrides', async () => {
  const h = admin({ initial: preview([agent, skill], []), features: {}, models: { ...accountModels, active_models: [{ id: 'commit-active', name: 'Commit' }] } })
  await openAdmin(h)
  assert.equal(h.find(node => node.props['aria-label'] === 'Model cho Dịch Android').props.disabled, true)
  h.change('Model cho Enhance (Commit message)', 'commit-active'); h.render()
  packageBundle(h); await h.flush()
  assert.deepEqual(payload(h, 'package'), { version: '1.0.0', commitEnhanceModel: 'commit-active' })
  h.change('Model cho Enhance (Commit message)', ''); h.render()
  packageBundle(h); await h.flush()
  assert.deepEqual(payload(h, 'package'), { version: '1.0.0' })
  h.unmount()
})

test('Android feature selection clears when its imported skill is excluded', async () => {
  const h = admin({ initial: preview([agent, skill], []), features: { androidTranslationSkill: 'review', androidTranslationModel: 'gemini' } })
  await openAdmin(h)
  h.setImport(preview([agent], []))
  h.click('Đổi thư mục'); await h.flush()
  assert.equal(h.find(node => node.props['aria-label'] === 'Skill cho Dịch Android').props.value, '')
  assert.equal(h.find(node => node.props['aria-label'] === 'Model cho Dịch Android').props.disabled, true)
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


const cardMarkup = (h: ReturnType<typeof admin>, id: string) => renderToStaticMarkup(h.find(node => node.props['data-testid'] === id))
function setActivateNow(h: ReturnType<typeof admin>, checked: boolean) {
  const checkbox = h.find(node => node.type === 'input' && node.props.type === 'checkbox')
  ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked } })
  h.render()
}

test('Admin defaults to raw-adapt, suggests the next server version and toggles manual version editing', async () => {
  const h = admin({ initial: preview([agent], []), serverVersion: '1.0.3' })
  h.render(); await h.flush(); h.click('Quản trị'); h.render()
  let html = await h.flush()
  assert.equal(h.find(node => node.props['aria-label'] === 'Chế độ tương thích').props.value, 'raw-adapt')
  assert.match(html, /amekit-version-badge">v1\.0\.4/)
  assert.equal(h.button('Phát hành & kích hoạt v1.0.4').props.disabled, true)
  h.click('Chọn thư mục & nhập'); await h.flush()
  assert.deepEqual(payload(h, 'import'), { compatibilityMode: 'raw', adaptClaudeAgents: 'true' })
  h.click('Sửa phiên bản'); html = h.render()
  assert.equal(h.find(node => node.props['aria-label'] === 'Phiên bản').props.value, '1.0.4')
  h.change('Phiên bản', ' 2.0.0 '); h.render()
  assert.ok(h.button('Phát hành & kích hoạt v2.0.0'))
  h.change('Phiên bản', ' '); h.render()
  assert.equal(h.button('Chỉ đóng gói thử').props.disabled, true)
  h.click('Dùng tự động (v1.0.4)'); html = h.render()
  assert.doesNotMatch(html, /aria-label="Phiên bản"/)
  assert.equal(h.button('Phát hành & kích hoạt v1.0.4').props.disabled, false)
  h.unmount()
})

test('compatibility mode persists valid choices and safely falls back when storage is invalid or throws', async () => {
  for (const saved of ['native', 'raw-adapt', 'raw', 'invalid', null]) {
    const writes: [string, string][] = []
    const h = admin({ storage: { getItem(key) { assert.equal(key, 'ame.amekit.importMode'); return saved }, setItem(key, value) { writes.push([key, value]) } } })
    await openAdmin(h)
    assert.equal(h.find(node => node.props['aria-label'] === 'Chế độ tương thích').props.value, saved && saved !== 'invalid' ? saved : 'raw-adapt')
    h.change('Chế độ tương thích', 'raw'); h.render()
    assert.deepEqual(writes, [['ame.amekit.importMode', 'raw']])
    h.click('Đổi thư mục'); await h.flush()
    assert.deepEqual(payload(h, 'import'), { compatibilityMode: 'raw' })
    h.unmount()
  }
  const h = admin({ storage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } } })
  await openAdmin(h)
  assert.equal(h.find(node => node.props['aria-label'] === 'Chế độ tương thích').props.value, 'raw-adapt')
  h.change('Chế độ tương thích', 'native'); h.render()
  assert.equal(h.find(node => node.props['aria-label'] === 'Chế độ tương thích').props.value, 'native')
  h.unmount()
})

test('one-click release forwards all features, activates the release and advances the automatic version', async () => {
  const features = { commitEnhanceSkill: 'review', commitEnhanceModel: 'commit', androidTranslationSkill: 'review', androidTranslationModel: 'android' }
  const h = admin({ initial: preview([agent, skill], []), serverVersion: '1.0.3', features })
  await openAdmin(h)
  h.click('Phát hành & kích hoạt v1.0.4'); let html = await h.flush()
  assert.deepEqual(payload(h, 'release'), { version: '1.0.4', activate: 'true', ...features })
  assert.match(html, /Đã xuất bản v1\.0\.4\. Đã kích hoạt cho team/)
  assert.ok(h.button('Phát hành & kích hoạt v1.0.5'))
  assert.doesNotMatch(html, /Đã đóng gói v/)
  h.click('Xem lịch sử'); html = h.render()
  assert.match(html, /Có bản đang kích hoạt/)
  const active = h.find(node => node.props.className === 'amekit-release' && renderToStaticMarkup(node).includes('v1.0.4'))
  assert.match(renderToStaticMarkup(active), /Đang kích hoạt/)
  assert.doesNotMatch(renderToStaticMarkup(active), />Kích hoạt</)
  h.unmount()
})

test('draft release skips activation and history supports one-click activation without technical clutter', async () => {
  const h = admin({ initial: preview([agent], []), serverVersion: '1.0.3' })
  await openAdmin(h); setActivateNow(h, false)
  h.click('Xuất bản nháp v1.0.4'); let html = await h.flush()
  assert.deepEqual(payload(h, 'release'), { version: '1.0.4', activate: 'false' })
  assert.match(html, /Đã xuất bản v1\.0\.4/)
  assert.doesNotMatch(html, /Đã kích hoạt cho team/)
  h.click('Lịch sử (2)'); html = h.render()
  assert.match(html, /Chưa kích hoạt bản nào/)
  assert.match(html, /v1\.0\.4/)
  assert.doesNotMatch(html, /amekit-source-card|amekit-release-card|Revision hiện tại|amekit-activation|Chi tiết kỹ thuật \(JSON\)/)
  h.click('Kích hoạt'); html = await h.flush()
  assert.deepEqual(payload(h, 'activate'), { id: 'release-1.0.4', revision: '1' })
  assert.match(html, /Đã kích hoạt v1\.0\.4 cho team/)
  assert.match(html, /Đang kích hoạt/)
  h.unmount()
})

test('activation failure and background history failure preserve the published notice and allow retry', async () => {
  const h = admin({ initial: preview([agent], []), serverVersion: '1.0.3' })
  await openAdmin(h)
  h.failActivation('ACTIVATION_CONFLICT'); h.failHistory('NETWORK_ERROR')
  h.click('Phát hành & kích hoạt v1.0.4'); let html = await h.flush()
  assert.match(html, /Đã xuất bản v1\.0\.4/)
  assert.match(html, /Chưa kích hoạt:.*Mở lịch sử để thử Kích hoạt lại/)
  assert.match(html, /class="amekit-alert amekit-alert--warning" role="status"/)
  assert.match(html, /Không thể kết nối tới máy chủ AmeCode/)
  assert.equal(h.calls.filter(call => call.operation === 'release').length, 1)
  h.click('Xem lịch sử'); html = h.render()
  assert.match(html, /v1\.0\.4/)
  assert.doesNotMatch(html, /role="alert"/)
  h.failHistory(''); h.click('Kích hoạt'); html = await h.flush()
  assert.match(html, /Đã kích hoạt v1\.0\.4 cho team/)
  h.unmount()
})

test('release, package and publish errors stay inside release card, source operations stay inside source card', async () => {
  const h = admin({ initial: preview([agent], []) })
  await openAdmin(h)
  for (const action of ['Phát hành & kích hoạt v1.0.0', 'Chỉ đóng gói thử']) {
    h.fail('ZIP_EXCEEDS_32_MIB'); h.click(action); let html = await h.flush()
    assert.match(cardMarkup(h, 'amekit-release-card'), /role="alert".*32 MiB/s)
    assert.doesNotMatch(cardMarkup(h, 'amekit-source-card'), /role="alert"/)
    assert.equal((html.match(/role="alert"/g) ?? []).length, 1)
    h.fail(''); h.click('Chỉ đóng gói thử'); html = await h.flush()
    assert.doesNotMatch(html, /role="alert"/)
  }
  h.fail('RELEASE_CONFLICT'); h.click('Xuất bản gói đã nén'); await h.flush()
  assert.match(cardMarkup(h, 'amekit-release-card'), /role="alert".*đã tồn tại/s)
  h.fail('IMPORT_REQUIRED'); h.click('Đổi thư mục'); await h.flush()
  assert.match(cardMarkup(h, 'amekit-source-card'), /role="alert".*Chưa có dữ liệu nhập/s)
  assert.doesNotMatch(cardMarkup(h, 'amekit-release-card'), /role="alert"/)
  h.click('Lịch sử (0)'); assert.doesNotMatch(h.render(), /role="alert"/)
  h.click('Phát hành mới'); h.render()
  h.fail(''); h.setImport(preview([agent])); h.click('Đổi thư mục'); await h.flush()
  h.fail('AI_FIX_PROVIDER_ERROR'); h.click('Sửa bằng AI', agent); await h.flush()
  assert.match(cardMarkup(h, 'amekit-source-card'), /role="alert".*máy chủ AI/s)
  assert.doesNotMatch(cardMarkup(h, 'amekit-release-card'), /role="alert"/)
  h.click('Tài khoản'); assert.doesNotMatch(h.render(), /role="alert"/)
  h.unmount()
})

test('inventory and nonblocking checks are collapsed while blocking fixes remain expanded', async () => {
  const initial = preview([agent, skill], [{ path: agent, severity: 'warning', reason: 'legacy' }])
  initial.skills = Array.from({ length: 91 }, (_, index) => `skill-${index}`)
  const h = admin({ initial })
  let html = await openAdmin(h)
  const inventory = h.find(node => node.type === 'details' && node.props.className === 'amekit-details' && renderToStaticMarkup(node).includes('Danh sách Agents'))
  assert.ok(!inventory.props.open)
  assert.match(renderToStaticMarkup(inventory), /Danh sách Agents \(1\) &amp; Skills \(91\)/)
  const checks = h.find(node => node.type === 'details' && node.props.className === 'amekit-details' && renderToStaticMarkup(node).includes('Chi tiết kiểm tra'))
  assert.ok(!checks.props.open)
  assert.match(renderToStaticMarkup(checks), /1 cảnh báo · 0 chuyển đổi · 0 loại trừ/)
  assert.doesNotMatch(html, /amekit-fix-bar/)
  h.setImport(preview([agent])); h.click('Đổi thư mục'); html = await h.flush()
  assert.match(html, /amekit-fix-bar/)
  assert.doesNotMatch(html, /<summary>Chi tiết kiểm tra/)
  assert.equal(h.find(node => node.props.id === 'amekit-issue-error').props['aria-selected'], true)
  assert.equal(h.button('Phát hành & kích hoạt v1.0.0').props.disabled, true)
  h.unmount()
})

test('initial history failure is visible on publish, and history retry errors stay visible in history', async () => {
  const h = admin()
  h.failHistory('NETWORK_ERROR')
  h.render(); await h.flush(); h.click('Quản trị'); h.render()
  let html = await h.flush()
  assert.ok(html.indexOf('role="alert"') < html.indexOf('amekit-source-card'))
  h.click('Lịch sử (0)'); html = h.render()
  assert.doesNotMatch(html, /role="alert"/)
  h.click('Làm mới'); html = await h.flush()
  assert.match(html, /role="alert".*Không thể kết nối/s)
  h.failHistory(''); h.click('Làm mới'); html = await h.flush()
  assert.doesNotMatch(html, /role="alert"/)
  h.unmount()
})

test('pending release shows inline progress, disables actions and resets manual version after success', async () => {
  const h = admin({ initial: preview([agent], []) })
  await openAdmin(h)
  h.click('Sửa phiên bản'); h.render(); h.change('Phiên bản', ' 2.0.0 '); h.render()
  const pending = deferred(); h.delayRelease(pending.promise)
  h.click('Phát hành & kích hoạt v2.0.0'); h.render()
  const card = cardMarkup(h, 'amekit-release-card')
  assert.match(card, /amekit-busy-inline.*amekit-spinner/s)
  assert.equal(h.button('Đang phát hành…').props.disabled, true)
  assert.equal(h.button('Chỉ đóng gói thử').props.disabled, true)
  pending.resolve({ release: { releaseId: 'manual', version: '2.0.0' }, activated: { release: { releaseId: 'manual', version: '2.0.0' }, revision: 2 } })
  const html = await h.flush()
  assert.equal(payload(h, 'release').version, '2.0.0')
  assert.doesNotMatch(html, /aria-label="Phiên bản"|amekit-spinner/)
  assert.ok(h.button('Phát hành & kích hoạt v2.0.1'))
  h.unmount()
})
