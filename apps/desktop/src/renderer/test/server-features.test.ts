import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { BundleFeatures } from '../../../../../packages/amekit/src/api'
import * as primitives from '../components/Primitives'
import * as amekitUI from '../amekit-ui'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const initialFeatures: BundleFeatures = { commitEnhanceSkill: 'review', commitEnhanceModel: 'enhance-model', androidTranslationSkill: 'translate', androidTranslationModel: 'android-model', buildNotesSkill: 'build-notes', buildNotesModel: 'qc-model' }
const labels = ['Skill máy chủ cho Enhance', 'Model máy chủ cho Enhance', 'Skill máy chủ cho Dịch Android', 'Model máy chủ cho Dịch Android', 'Skill máy chủ cho Mô tả bản build', 'Model máy chủ cho Mô tả bản build']

function accountHarness() {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  const calls: { operation: string; payload?: Record<string, string> }[] = [], events: string[] = []
  let cursor = 0, effectIndex = 0, tree: ReactNode
  let features: BundleFeatures = { ...initialFeatures }, version = '1.0.0', activeError = '', updateError = '', historyError = '', activationError = '', holdActive: Promise<void> | undefined
  const skills = ['review', 'translate', 'build-notes']
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
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
  const release = () => ({ releaseId: `release-${version}`, version, manifest: { agents: 2, skills: skills.length, features } })
  const window = {
    ame: {
      async account(operation: string, payload?: Record<string, string>) {
        calls.push({ operation, payload })
        if (operation === 'status' || operation === 'login') return { account: { name: 'Admin', username: 'admin', role: 'admin' }, ready: true, models: { default_model: 'api-default', active_models: ['enhance-model', 'android-model', 'qc-model', 'other-model'].map(id => ({ id, name: id })) } }
        if (operation === 'logout') return null
        if (operation === 'history') {
          if (historyError) throw new Error(historyError)
          return { releases: [release()], active: { release_id: release().releaseId, revision: 3 } }
        }
        if (operation === 'active-features') {
          const result = { release: release(), revision: 3, skills, features }
          await holdActive
          if (activeError) throw new Error(activeError)
          return result
        }
        if (operation === 'update-features') {
          if (updateError) throw new Error(updateError)
          const nextFeatures = Object.fromEntries(Object.entries(payload ?? {}).filter(([key]) => key !== 'version' && key !== 'activate'))
          const published = { releaseId: `release-${payload!.version}`, version: payload!.version, manifest: { agents: 2, skills: skills.length, features: nextFeatures } }
          if (!activationError) { features = nextFeatures; version = payload!.version }
          return { packaged: {}, release: published, activated: activationError ? null : { release: published, revision: 4 }, revision: 4, ...(activationError ? { activationError } : {}) }
        }
        throw new Error(`Unexpected operation ${operation}`)
      },
    },
    dispatchEvent(event: Event) { events.push(event.type); return true },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/Account.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = { react: hooks, './Primitives': primitives, '../amekit-ui': amekitUI }
  runInNewContext(code, { exports, Event, window, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Account = exports.Account as (props: object) => ReactNode
  function render() {
    cursor = 0; effectIndex = 0
    tree = Account({ embedded: true, close() {} })
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
  function click(text: string) { (find(node => node.type === 'button' && node.props.children === text).props.onClick as () => void)() }
  return {
    render, find, click, calls, events,
    control(label: string) { return find(node => node.props['aria-label'] === label).props },
    change(label: string, value: string) { (find(node => node.props['aria-label'] === label).props.onChange as (event: unknown) => void)({ target: { value } }) },
    save() { (find(node => node.props['data-testid'] === 'amekit-save-server-features-btn').props.onClick as () => void)() },
    saveDisabled() { return find(node => node.props['data-testid'] === 'amekit-save-server-features-btn').props.disabled },
    async flush() { await tick(); render(); return render() },
    failActive(value: string) { activeError = value },
    failUpdate(value: string) { updateError = value },
    failHistory(value: string) { historyError = value },
    failActivation(value: string) { activationError = value },
    setFeatures(value: BundleFeatures) { features = value },
    holdActive() { let resolve!: () => void; holdActive = new Promise<void>(done => { resolve = done }); return () => { holdActive = undefined; resolve() } },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

async function openAdmin(h: ReturnType<typeof accountHarness>) {
  h.render(); await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
  assert.equal(h.find(node => node.type === 'button' && node.props.children === 'Phát hành mới').props['aria-selected'], true)
}
async function openFeatures(h: ReturnType<typeof accountHarness>) { await openAdmin(h); h.click('Cấu hình Model'); h.render(); return h.flush() }
function lastPayload(h: ReturnType<typeof accountHarness>) { return JSON.parse(JSON.stringify(h.calls.filter(call => call.operation === 'update-features').at(-1)?.payload)) }

test('server feature tab loads all six selectors without importing and remains clean', async () => {
  const h = accountHarness()
  try {
    await openAdmin(h)
    assert.equal(h.calls.some(call => call.operation === 'active-features'), false)
    const resume = h.holdActive()
    h.click('Cấu hình Model'); h.render()
    assert.match(h.render(), /Đang tải cấu hình từ máy chủ…/)
    assert.doesNotMatch(h.render(), /Đang xử lý…/)
    resume()
    const html = await h.flush()
    assert.match(html, /Đang áp dụng: v1.0.0 · 2 agents · 3 skills/)
    labels.forEach((label, index) => assert.equal(h.control(label).value, Object.values(initialFeatures)[index]))
    for (const label of [labels[0], labels[2], labels[4]]) {
      const select = h.find(node => node.props['aria-label'] === label)
      assert.match(renderToStaticMarkup(select), /\/review[\s\S]*\/translate[\s\S]*\/build-notes/)
    }
    assert.equal(h.saveDisabled(), true)
    assert.equal(h.calls.some(call => call.operation === 'import'), false)
  } finally { h.unmount() }
})

test('server feature edits publish next version, update active summaries and notify account listeners', async () => {
  const h = accountHarness()
  try {
    await openFeatures(h)
    h.change(labels[5], 'other-model'); h.render()
    assert.equal(h.saveDisabled(), false)
    const eventCount = h.events.length
    h.save()
    const progress = h.render()
    assert.match(progress, /Đang đóng gói &amp; đẩy cấu hình lên máy chủ…/)
    assert.doesNotMatch(progress, /Đang xử lý…/)
    assert.equal(h.control(labels[0]).disabled, true)
    const html = await h.flush()
    assert.deepEqual(lastPayload(h), { version: '1.0.1', activate: 'true', ...initialFeatures, buildNotesModel: 'other-model' })
    assert.match(html, /Đang áp dụng: v1.0.1/)
    assert.match(html, /Build Notes: \/build-notes · other-model/)
    assert.match(html, /Đã đẩy cấu hình Skill &amp; Model v1.0.1 lên máy chủ và kích hoạt cho team/)
    assert.equal(h.saveDisabled(), true)
    assert.deepEqual(h.events.slice(eventCount), ['ame-account-changed'])
    assert.equal(h.calls.at(-1)?.operation, 'history')
    h.change(labels[0], 'translate'); h.render(); h.save(); await h.flush()
    assert.equal(lastPayload(h).version, '1.0.2')
    assert.equal(lastPayload(h).commitEnhanceSkill, 'translate')
  } finally { h.unmount() }
})

test('clearing overrides omits keys, permits default QC model and supports manual versions', async () => {
  const h = accountHarness()
  try {
    await openFeatures(h)
    labels.forEach(label => h.change(label, '')); h.render()
    assert.equal(h.control(labels[3]).disabled, true)
    assert.equal(h.control(labels[5]).disabled, false)
    h.click('Sửa phiên bản'); h.render(); h.change('Phiên bản cấu hình máy chủ', '   '); h.render()
    assert.equal(h.saveDisabled(), true)
    h.change('Phiên bản cấu hình máy chủ', ' 2.0.0 '); h.render(); h.save(); await h.flush()
    assert.deepEqual(lastPayload(h), { version: '2.0.0', activate: 'true' })
    assert.equal(h.saveDisabled(), true)
    assert.match(h.render(), /v2.0.1/)
    h.change(labels[5], 'other-model'); h.render(); h.save(); await h.flush()
    assert.deepEqual(lastPayload(h), { version: '2.0.1', activate: 'true', buildNotesModel: 'other-model' })
  } finally { h.unmount() }
})

test('no active release offers a route to the unchanged publish tab', async () => {
  const h = accountHarness()
  try {
    h.failActive('NO_ACTIVE_RELEASE')
    const html = await openFeatures(h)
    assert.match(html, /Máy chủ chưa có bản phát hành nào được kích hoạt/)
    assert.doesNotMatch(html, /amekit-save-server-features-btn/)
    h.click('Đi tới Phát hành mới')
    assert.match(h.render(), /amekit-import-btn/)
    assert.equal(h.find(node => node.type === 'button' && node.props.children === 'Phát hành mới').props['aria-selected'], true)
  } finally { h.unmount() }
})

test('refresh and update failures stay inside the server card without losing edits', async () => {
  const h = accountHarness()
  try {
    await openFeatures(h)
    h.change(labels[1], 'other-model'); h.render(); h.failActive('NETWORK_ERROR')
    h.click('Làm mới từ máy chủ'); h.render()
    assert.equal(h.saveDisabled(), true)
    let html = await h.flush()
    assert.match(html, /data-testid="amekit-server-features-card"[\s\S]*role="alert"[\s\S]*Không thể kết nối/)
    assert.equal(h.control(labels[1]).value, 'other-model')
    h.failUpdate('INVALID_PAYLOAD'); h.save(); html = await h.flush()
    assert.match(html, /data-testid="amekit-server-features-card"[\s\S]*Dữ liệu cấu hình không hợp lệ/)
    assert.equal(h.control(labels[1]).value, 'other-model')
    assert.equal(h.saveDisabled(), false)
    h.failUpdate(''); h.failActive(''); h.save(); await h.flush()
    h.click('Làm mới từ máy chủ'); html = await h.flush()
    assert.doesNotMatch(html, /Đã đẩy cấu hình|role="alert"/)
    assert.equal(h.saveDisabled(), true)
  } finally { h.unmount() }
})

test('activation failure preserves active configuration and provides history recovery', async () => {
  const h = accountHarness()
  try {
    await openFeatures(h)
    h.failActivation('ACTIVATION_CONFLICT')
    h.change(labels[5], 'other-model'); h.render(); h.save()
    const html = await h.flush()
    assert.match(html, /Đang áp dụng: v1.0.0/)
    assert.match(html, /Chưa kích hoạt: Revision kích hoạt đã thay đổi/)
    assert.equal(h.control(labels[5]).value, 'other-model')
    assert.equal(h.saveDisabled(), false)
    h.click('Tải lịch sử'); h.render(); await h.flush()
    assert.match(h.render(), /amekit-releases/)
  } finally { h.unmount() }
})

test('a history refresh failure does not erase successfully activated features', async () => {
  const h = accountHarness()
  try {
    await openFeatures(h)
    h.failHistory('NETWORK_ERROR')
    h.change(labels[1], 'other-model'); h.render(); h.save()
    const html = await h.flush()
    assert.match(html, /Đã đẩy cấu hình/)
    assert.match(html, /data-testid="amekit-server-features-card"[\s\S]*Không thể kết nối/)
    assert.equal(h.control(labels[1]).value, 'other-model')
    assert.equal(h.saveDisabled(), true)
  } finally { h.unmount() }
})

test('logout clears server edits, notices, version and cached configuration before login', async () => {
  const h = accountHarness()
  try {
    await openFeatures(h)
    h.change(labels[1], 'other-model'); h.render(); h.save(); await h.flush()
    h.click('Sửa phiên bản'); h.render(); h.change('Phiên bản cấu hình máy chủ', '9.0.0'); h.render()
    h.click('Tài khoản'); h.render(); h.click('Đăng xuất'); await h.flush()
    assert.doesNotMatch(h.render(), /Quản trị/)
    const form = h.find(node => node.type === 'form')
    ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
    await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
    assert.equal(h.find(node => node.type === 'button' && node.props.children === 'Phát hành mới').props['aria-selected'], true)
    h.setFeatures({}); const resume = h.holdActive()
    h.click('Cấu hình Model'); h.render()
    let html = h.render()
    assert.match(html, /Đang tải cấu hình từ máy chủ…/)
    assert.doesNotMatch(html, /Đang áp dụng|Đã đẩy cấu hình|9.0.0/)
    resume(); html = await h.flush()
    labels.forEach(label => assert.equal(h.control(label).value, ''))
    assert.equal(h.saveDisabled(), true)
    assert.doesNotMatch(html, /aria-label="Phiên bản cấu hình máy chủ"/)
  } finally { h.unmount() }
})

test('responses from an abandoned feature tab cannot repopulate the next load', async () => {
  const h = accountHarness()
  try {
    await openAdmin(h)
    const resume = h.holdActive()
    h.click('Cấu hình Model'); h.render(); await tick()
    h.click('Phát hành mới'); h.render(); resume(); await h.flush()
    h.setFeatures({}); h.click('Cấu hình Model'); h.render(); await h.flush()
    labels.forEach(label => assert.equal(h.control(label).value, ''))
    assert.equal(h.saveDisabled(), true)
  } finally { h.unmount() }
})

test('invalid server payload and release errors provide Vietnamese recovery guidance', () => {
  for (const code of ['INVALID_PAYLOAD', 'INVALID_RELEASE']) {
    const formatted = amekitUI.formatAmeKitError(new Error(code))
    assert.notEqual(formatted.title, code)
    assert.match(formatted.detail!, /Kiểm tra lại phiên bản/)
  }
})
