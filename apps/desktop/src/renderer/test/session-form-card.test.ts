import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { isValidElement, type ReactNode, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { SessionForm } from '../../../../../packages/protocol/src/index'
import * as schema from '../../../../../packages/protocol/src/session-form'

const form: SessionForm = { id: 'f', sessionID: 's', title: 'Dịch strings', fields: [
  { key: 'locale', title: 'Ngôn ngữ', description: 'Chọn locale', type: 'string', required: true, options: [{ value: 'ja', label: 'Tiếng Nhật' }, { value: 'ko', label: 'Tiếng Hàn' }] },
  { key: 'files', title: 'Tệp', type: 'multiselect', required: true, options: [{ value: 'a', label: 'App' }, { value: 'b', label: 'Library' }] },
  { key: 'note', title: 'Ghi chú', type: 'string' },
  { key: 'confirm', title: 'Xác nhận', type: 'boolean', default: false },
  { key: 'count', title: 'Số lượng', type: 'integer', minimum: 1, default: 1 },
  { key: 'conditional', type: 'string', required: true, when: [{ key: 'locale', op: 'eq', value: 'ko' }] },
] }

function harness(inputForm: SessionForm = form) {
  const slots: unknown[] = []; let cursor = 0, tree: ReactNode, error = '', resolved = ''
  const calls: { method: string; args: unknown[] }[] = []
  const hooks = {
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
  }
  const exports: Record<string, any> = {}, require = createRequire(import.meta.url)
  const source = readFileSync(new URL('../components/SessionFormCard.tsx', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, window: { ame: Object.fromEntries(['replyForm', 'cancelForm', 'openExternal'].map(method => [method, async (...args: unknown[]) => { calls.push({ method, args }); if (error) throw new Error(error) }])) },
    navigator: { clipboard: { writeText: async (...args: unknown[]) => { calls.push({ method: 'writeText', args }); if (error) throw new Error(error) } } },
    require(id: string) { if (id === 'react') return hooks; if (id.endsWith('/session-form')) return schema; if (id === './Primitives') return { errorText: (e: unknown) => String(e) }; return require(id) },
  })
  const all = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(all) : isValidElement<{ children?: ReactNode }>(node) ? [node, ...all(node.props.children)] : []
  const find = (predicate: (element: ReactElement<any>) => boolean) => { const element = all(tree).find(predicate); assert.ok(element); return element }
    const render = () => { cursor = 0; tree = exports.SessionFormCard({ projectID: 'p', form: inputForm, onResolved: (id: string) => { resolved = id } }); return renderToStaticMarkup(tree) }
  return { render, calls, exports, find, get resolved() { return resolved }, fail(message: string) { error = message },
    submitNow() { find(el => el.type === 'form').props.onSubmit({ preventDefault() {} }); return render() },
    change(label: string, value: string | boolean | number) { find(el => el.props['aria-label'] === label && el.type === 'input').props.onChange({ target: { value: String(value), checked: value, valueAsNumber: value } }); render() },
    choose(name: string, index: number) { all(tree).filter(el => el.type === 'input' && el.props.name === `f-${name}`)[index].props.onChange(); render() },
    async submit() { find(el => el.type === 'form').props.onSubmit({ preventDefault() {} }); render(); for (let i = 0; i < 10; i++) await Promise.resolve(); return render() },
    async cancel() { find(el => el.type === 'button' && el.props.type === 'button' && el.props.children === 'Bỏ qua / Hủy câu hỏi').props.onClick(); render(); for (let i = 0; i < 10; i++) await Promise.resolve(); return render() },
  }
}

test('renders options, multiselect and free text; validates required and replies with typed answer map', async () => {
  const h = harness(); const html = h.render()
  assert.match(html, /Tiếng Nhật/); assert.match(html, /type="radio"/); assert.match(html, /type="checkbox"/); assert.match(html, /Ghi chú/)
  assert.match(await h.submit(), /Vui lòng kiểm tra câu trả lời: Ngôn ngữ/)
  assert.equal(h.calls.length, 0)
  h.choose('locale', 0); h.choose('files', 0); h.choose('files', 1); h.change('Ghi chú', 'Tự nhiên'); h.change('Số lượng', 3)
  await h.submit()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ method: 'replyForm', args: ['p', 's', 'f', { locale: 'ja', files: ['a', 'b'], note: 'Tự nhiên', confirm: false, count: 3 }] }])
  assert.equal(h.resolved, 'f')
})

test('cancel bypasses required validation; reply/cancel errors remain visible and retryable', async () => {
  const h = harness(); h.render(); h.fail('OFFLINE')
  assert.match(await h.cancel(), /OFFLINE/); assert.equal(h.resolved, '')
  h.fail(''); await h.cancel()
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { method: 'cancelForm', args: ['p', 's', 'f'] })
  assert.equal(h.resolved, 'f')
  const reply = harness(); reply.render(); reply.choose('locale', 0); reply.choose('files', 0); reply.fail('REPLY_FAILED')
  assert.match(await reply.submit(), /REPLY_FAILED/); assert.equal(reply.resolved, '')
})

test('submission disables the form and prevents duplicate replies while awaiting IPC', async () => {
  const h = harness(); h.render(); h.choose('locale', 0); h.choose('files', 0)
  assert.match(h.submitNow(), /fieldset disabled/)
  h.submitNow()
  assert.equal(h.calls.length, 1)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.doesNotMatch(h.render(), /fieldset disabled/)
})

test('when conditions, optional/custom options, false booleans and numeric boundaries are validated', () => {
  const { exports } = harness()
  assert.throws(() => exports.validateFormAnswer(form, { locale: 'ko', files: ['a'] }), /conditional/)
  assert.throws(() => exports.validateFormAnswer(form, { locale: 'ja', files: ['a'], count: 1.5 }), /Số lượng/)
  assert.throws(() => exports.validateFormAnswer(form, { locale: 'ja', files: ['a'], count: 0 }), /Số lượng/)
  assert.throws(() => exports.validateFormAnswer(form, { locale: 'unknown', files: ['a'] }), /Ngôn ngữ/)
  const custom = { ...form, fields: [{ ...form.fields[0], custom: true }] }
  assert.equal(exports.validateFormAnswer(custom, { locale: 'vi' }).locale, 'vi')
  const optional = { ...form, fields: [{ ...form.fields[0], required: false }] }
  assert.equal(exports.validateFormAnswer(optional, { locale: 'vi' }).locale, 'vi')
  const selection = { ...form, fields: [{ ...form.fields[1], custom: true, minItems: 1, maxItems: 2 }] }
  assert.deepEqual(JSON.parse(JSON.stringify(exports.validateFormAnswer(selection, { files: ['custom'] }))), { files: ['custom'] })
  assert.throws(() => exports.validateFormAnswer(selection, { files: ['a', 'b', 'c'] }), /Tệp/)
  assert.equal(exports.visibleFormField({ key: 'x', type: 'string', when: [{ key: 'confirm', op: 'neq', value: false }] }, { confirm: false }), false)
})

test('external fields open via IPC and copy the link with accessible feedback', async () => {
  const url = 'https://example.com/answer'
  const h = harness({ ...form, fields: [{ key: 'external', type: 'external', url }] })
  assert.doesNotMatch(h.render(), /target="_blank"/)
  await h.find(el => el.type === 'button' && el.props.children === 'Mở trang trả lời').props.onClick()
  await h.find(el => el.type === 'button' && el.props.children === 'Sao chép liên kết').props.onClick()
  assert.deepEqual(h.calls, [{ method: 'openExternal', args: [url] }, { method: 'writeText', args: [url] }])
  assert.match(h.render(), /role="status">Đã sao chép/)
  h.fail('CLIPBOARD_FAILED')
  await h.find(el => el.type === 'button' && el.props.children === 'Sao chép liên kết').props.onClick()
  assert.match(h.render(), /CLIPBOARD_FAILED/)
  assert.doesNotMatch(h.render(), /Đã sao chép/)
})

test('numeric defaults normalize to finite numbers shared by input and submission', async () => {
  for (const type of ['integer', 'number'] as const) {
    for (const value of [12, '12', 0, '0', '-3.5', '3.14', '', ' ', 'abc', 'NaN', 'Infinity', Infinity]) {
      const valid = value !== '' && value !== ' ' && Number.isFinite(Number(value)) && (type === 'number' || Number.isInteger(Number(value)))
      const inputForm: SessionForm = { ...form, fields: [{ key: 'count', title: 'Count', type, default: value, required: valid }] }
      const h = harness(inputForm)
      const initial = h.exports.initialFormAnswer(inputForm)
      assert.equal(initial.count, valid ? Number(value) : undefined, `${type}: ${JSON.stringify(value)}`)
      assert.equal(h.exports.validateFormAnswer(inputForm, initial).count, valid ? Number(value) : undefined)
      h.render()
      assert.equal(h.find(el => el.type === 'input').props.value, valid ? Number(value) : '')
      await h.submit()
      assert.equal(h.calls[0].method, 'replyForm')
      assert.equal((h.calls[0].args[3] as Record<string, unknown>).count, valid ? Number(value) : undefined)
    }
  }
})
