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

const skillLabel = 'Skill cho Mô tả bản build'
const modelLabel = 'Model cho Mô tả bản build'
const skillPath = 'skills/build-notes/SKILL.md'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

// Run real Account handlers and effects without a DOM dependency, like commit-enhance.test.ts.
function accountHarness(initialFeatures: BundleFeatures = { buildNotesSkill: 'build-notes', buildNotesModel: 'qc-model' }, excludeIssue = false) {
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [], pending: (() => void)[] = []
  const calls: { operation: string; payload?: Record<string, string> }[] = []
  const listeners = new Map<string, Set<() => void>>()
  let cursor = 0, effectIndex = 0, tree: ReactNode, skills = ['build-notes', 'review'], features = initialFeatures, latestError = ''
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
  const release = () => ({ releaseId: 'release', version: '1.0.0', manifest: { agents: 1, skills: skills.length, features } })
  const preview = () => ({ folderName: 'bundle', agents: ['helper'], skills, files: [], issues: excludeIssue && skills.includes('build-notes') ? [{ path: skillPath, severity: 'error', reason: 'invalid skill' }] : [], compatibilityMode: 'native' })
  const window = {
    ame: {
      async account(operation: string, payload?: Record<string, string>) {
        calls.push({ operation, payload })
        if (operation === 'status' || operation === 'login') return { account: { name: 'Admin', username: 'admin', role: 'admin' }, ready: true, models: { default_model: 'api-default', active_models: [{ id: 'qc-model', name: 'QC model' }, { id: 'other-model', name: 'Other model' }] } }
        if (operation === 'history') return { releases: [release()], active: { release_id: 'release', revision: 1 } }
        if (operation === 'latest') { if (latestError) throw new Error(latestError); return { release: release(), revision: 1 } }
        if (operation === 'installed') return { version: '0.9.0', releaseId: 'installed', agents: [], skills, features: { buildNotesModel: 'installed-model' } }
        if (operation === 'legacy-installed') return null
        if (operation === 'import') return preview()
        if (operation === 'exclude-import-file') { assert.equal(payload?.path, skillPath); skills = skills.filter(skill => skill !== 'build-notes'); return { preview: preview(), excluded: skillPath } }
        if (operation === 'package') return { summary: { version: payload?.version, features: { ...(payload?.buildNotesSkill ? { buildNotesSkill: payload.buildNotesSkill } : {}), ...(payload?.buildNotesModel ? { buildNotesModel: payload.buildNotesModel } : {}) } }, size: 42, entries: 2, sha256: 'abc' }
        if (operation === 'release') return { release: { ...release(), version: payload?.version }, activated: null }
        if (operation === 'logout') return null
        throw new Error(`Unexpected operation ${operation}`)
      },
    },
    addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) },
    dispatchEvent(event: Event) { for (const fn of listeners.get(event.type) ?? []) fn(); return true },
  }
  const exports: Record<string, unknown> = {}, nativeRequire = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/Account.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const modules: Record<string, unknown> = { react: hooks, './Primitives': primitives, '../amekit-ui': amekitUI }
  runInNewContext(code, { exports, Event, window, require: (name: string) => modules[name] ?? nativeRequire(name) })
  const Account = exports.Account as (props: object) => ReactNode
  function render() {
    cursor = 0; effectIndex = 0
    tree = Account({ projectID: 'project', embedded: true, close() {} })
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
  function change(label: string, value: string) { (find(node => node.props['aria-label'] === label).props.onChange as (event: unknown) => void)({ target: { value } }) }
  return {
    render, find, click, change, calls,
    async flush() { await tick(); render(); return render() },
    setSkills(value: string[]) { skills = value },
    setFeatures(value: BundleFeatures) { features = value },
    failLatest(value: string) { latestError = value },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

async function openAdmin(h: ReturnType<typeof accountHarness>) {
  h.render(); await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
}
async function importBundle(h: ReturnType<typeof accountHarness>) { h.click('Chọn thư mục & nhập'); return h.flush() }
function control(h: ReturnType<typeof accountHarness>, label: string) { return h.find(node => node.props['aria-label'] === label).props }
function lastPayload(h: ReturnType<typeof accountHarness>, operation: string) { return JSON.parse(JSON.stringify(h.calls.filter(call => call.operation === operation).at(-1)?.payload)) }

test('Build Notes admin prefills active configuration and forwards changed skill/model to package and release', async () => {
  const h = accountHarness()
  try {
    await openAdmin(h)
    assert.doesNotMatch(h.render(), /aria-label="Skill cho Mô tả bản build"/)
    const html = await importBundle(h)
    assert.match(html, /<legend>Mô tả bản build \(QC Build Notes\)<\/legend>/)
    assert.match(html, /<option value="">Mặc định \(Mô tả bản build QC\)<\/option>/)
    assert.equal(control(h, skillLabel).value, 'build-notes')
    assert.equal(control(h, modelLabel).value, 'qc-model')
    h.click('Chỉ đóng gói thử'); h.render()
    assert.equal(control(h, skillLabel).disabled, true)
    assert.equal(control(h, modelLabel).disabled, true)
    assert.match(await h.flush(), /amekit-package-summary[\s\S]*Build Notes: \/build-notes · qc-model/)
    assert.deepEqual(lastPayload(h, 'package'), { version: '1.0.1', buildNotesSkill: 'build-notes', buildNotesModel: 'qc-model' })
    h.change(skillLabel, 'review')
    assert.doesNotMatch(h.render(), /Đã đóng gói v/)
    h.click('Chỉ đóng gói thử'); await h.flush()
    assert.equal(lastPayload(h, 'package').buildNotesSkill, 'review')
    h.change(modelLabel, 'other-model')
    assert.doesNotMatch(h.render(), /Đã đóng gói v/)
    h.click('Phát hành & kích hoạt v1.0.1'); await h.flush()
    assert.deepEqual(lastPayload(h, 'release'), { version: '1.0.1', activate: 'true', buildNotesSkill: 'review', buildNotesModel: 'other-model' })
  } finally { h.unmount() }
})

test('Build Notes model remains selectable and is forwarded with no custom skill', async () => {
  const h = accountHarness({ buildNotesModel: 'retired-model' })
  try {
    await openAdmin(h)
    const html = await importBundle(h)
    assert.equal(control(h, skillLabel).value, '')
    assert.equal(control(h, modelLabel).value, 'retired-model')
    assert.equal(control(h, modelLabel).disabled, false)
    assert.match(html, /retired-model · Không còn hoạt động/)
    h.change(modelLabel, 'qc-model'); h.render()
    h.click('Chỉ đóng gói thử')
    assert.match(await h.flush(), /Build Notes: Mặc định QC · qc-model/)
    assert.deepEqual(lastPayload(h, 'package'), { version: '1.0.1', buildNotesModel: 'qc-model' })
    h.click('Phát hành & kích hoạt v1.0.1'); await h.flush()
    assert.deepEqual(lastPayload(h, 'release'), { version: '1.0.1', activate: 'true', buildNotesModel: 'qc-model' })
    h.change(skillLabel, 'review'); h.render(); h.change(skillLabel, ''); h.render()
    assert.equal(control(h, modelLabel).value, 'qc-model')
    assert.equal(control(h, modelLabel).disabled, false)
    h.change(modelLabel, ''); h.render(); h.click('Chỉ đóng gói thử'); await h.flush()
    assert.deepEqual(lastPayload(h, 'package'), { version: '1.0.1' })
  } finally { h.unmount() }
})

test('Build Notes exclusion clears a stale skill without clearing the fixed model', async () => {
  const h = accountHarness(undefined, true)
  try {
    await openAdmin(h); await importBundle(h)
    assert.equal(control(h, skillLabel).value, 'build-notes')
    h.click('Bỏ tệp'); await h.flush()
    assert.equal(control(h, skillLabel).value, '')
    assert.equal(control(h, modelLabel).value, 'qc-model')
    assert.equal(control(h, modelLabel).disabled, false)
    h.click('Chỉ đóng gói thử'); await h.flush()
    assert.deepEqual(lastPayload(h, 'package'), { version: '1.0.1', buildNotesModel: 'qc-model' })
  } finally { h.unmount() }
})

test('Build Notes reimport drops unavailable selections and logout resets feature state', async () => {
  const h = accountHarness()
  try {
    await openAdmin(h); await importBundle(h)
    h.setSkills(['review']); h.click('Đổi thư mục'); await h.flush()
    assert.equal(control(h, skillLabel).value, '')
    assert.equal(control(h, modelLabel).value, 'qc-model')
    h.setFeatures({}); h.click('Đổi thư mục'); await h.flush()
    assert.equal(control(h, modelLabel).value, '')
    h.change(skillLabel, 'review'); h.change(modelLabel, 'other-model'); h.render()
    h.click('Tài khoản'); h.render(); h.click('Đăng xuất'); await h.flush()
    assert.doesNotMatch(h.render(), /Quản trị/)
    const form = h.find(node => node.type === 'form')
    ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} })
    await h.flush(); h.click('Quản trị'); h.render(); await h.flush()
    assert.doesNotMatch(h.render(), /aria-label="Skill cho Mô tả bản build"/)
    await importBundle(h); h.click('Chỉ đóng gói thử'); await h.flush()
    assert.deepEqual(lastPayload(h, 'package'), { version: '1.0.1' })
  } finally { h.unmount() }
})

test('Build Notes summaries show installed, server and history configuration including default QC', async () => {
  for (const features of [{ buildNotesSkill: 'build-notes', buildNotesModel: 'qc-model' }, { buildNotesModel: 'qc-model' }, { buildNotesSkill: 'build-notes' }]) {
    const h = accountHarness(features)
    try {
      h.render(); await h.flush(); h.click('Bundle'); h.render()
      const html = await h.flush()
      assert.match(html, /Đang dùng:[\s\S]*Build Notes: Mặc định QC · installed-model/)
      const summary = `Build Notes: ${features.buildNotesSkill ? '/build-notes' : 'Mặc định QC'} · ${features.buildNotesModel || 'default'}`
      assert.ok(html.includes(summary))
      h.click('Quản trị'); h.render(); await h.flush(); h.click('Lịch sử (1)')
      assert.ok(h.render().includes(summary))
    } finally { h.unmount() }
  }
})

test('Build Notes import stays usable when latest lookup fails', async () => {
  for (const error of ['NO_ACTIVE_RELEASE', 'NETWORK_ERROR']) {
    const h = accountHarness()
    try {
      await openAdmin(h); h.failLatest(error)
      assert.doesNotMatch(await importBundle(h), /role="alert"/)
      assert.equal(control(h, skillLabel).value, '')
      assert.equal(control(h, modelLabel).value, '')
      assert.equal(control(h, modelLabel).disabled, false)
    } finally { h.unmount() }
  }
})

test('Build Notes errors provide Vietnamese recovery guidance', () => {
  for (const [code, title] of [
    ['UNKNOWN_BUILD_NOTES_SKILL', 'Skill Mô tả bản build không nằm trong gói đã nhập'],
    ['NO_BUILD_CHANGES', 'Không có thay đổi nào để tạo mô tả bản build'],
    ['INVALID_BUILD_BASE_COMMIT', 'Mốc commit gốc không thuộc nhánh hiện tại'],
    ['EMPTY_BUILD_NOTES', 'AI chưa trả về nội dung mô tả bản build'],
  ]) {
    const error = amekitUI.formatAmeKitError(new Error(code))
    assert.equal(error.title, title)
    assert.ok(error.detail)
  }
})
