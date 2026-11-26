import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { PairingSettings } from '../../../../../packages/protocol/src/index'
import { errorText } from '../components/Primitives'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const settings: PairingSettings = {
  enabled: true, keepScreenActive: false, publicURL: 'https://pair.example', port: 4096,
  devices: [
    { id: 'phone-1', label: 'Điện thoại', createdAt: 1700000000000, lastUsedAt: 1700000100000 },
    { id: 'tablet-2', label: 'Máy tính bảng', createdAt: 1700000200000, lastUsedAt: 1700000300000 },
  ],
}

function render(initial: PairingSettings | undefined = settings, options: { error?: string; pending?: Promise<PairingSettings> } = {}) {
  const require = createRequire(import.meta.url), exports: Record<string, any> = {}
  const slots: unknown[] = [], refs: { current: unknown }[] = []
  const calls: { method: string; args: unknown[] }[] = []
  let cursor = 0, refCursor = 0, writes = 0
  const noop = () => {}
  const result = (devices: PairingSettings['devices']) => {
    if (options.error) return Promise.reject(new Error(options.error))
    return options.pending ?? Promise.resolve({ ...settings, devices })
  }
  const source = readFileSync(new URL('../components/Pairing.tsx', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, Date,
    window: { ame: {
      pairingRevokeDevice(deviceID: string) { calls.push({ method: 'pairingRevokeDevice', args: [deviceID] }); return result(settings.devices?.filter(device => device.id !== deviceID)) },
      pairingRevokeAll() { calls.push({ method: 'pairingRevokeAll', args: [] }); return result([]) },
    } },
    require(id: string) {
      if (id === 'react') return {
        useEffect: noop,
        useRef(current: unknown) { const index = refCursor++; return refs[index] ??= { current } },
        useState(value: unknown) {
          const index = cursor++
          if (!(index in slots)) slots[index] = index === 0 ? initial : value
          return [slots[index], (next: unknown) => { slots[index] = next; writes++ }]
        },
      }
      if (id === './Primitives') return { errorText }
      if (id === '../qr') return { renderSVG: noop }
      return require(id)
    },
  })
  const view = () => {
    cursor = 0; refCursor = 0
    const tree = exports.Pairing()
    return { tree, html: renderToStaticMarkup(tree) }
  }
  return { ...view(), view, calls, writes: () => writes, unmount: () => { refs[1].current = false } }
}

function findElements(tree: any, matches: (element: any) => boolean): any[] {
  if (Array.isArray(tree)) return tree.flatMap(child => findElements(child, matches))
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [...(matches(tree) ? [tree] : []), ...findElements(tree.props.children, matches)]
}

function button(tree: any, label: string) {
  const [found] = findElements(tree, element => element.type === 'button' && element.props.children === label)
  assert.ok(found, `Missing button: ${label}`)
  return found
}

test('empty paired devices show persistent auto-reconnect guidance without disconnect controls', () => {
  for (const devices of [[], undefined]) {
    const { html, tree } = render({ ...settings, devices })
    assert.match(html, /<section class="pairing-devices" aria-label="Thiết bị đã ghép nối">/)
    assert.match(html, /Thiết bị đã ghép nối \(0\)/)
    assert.match(html, /Chưa có thiết bị nào được ghép nối\. Sau khi quét mã QR, thiết bị sẽ tự kết nối lại mỗi khi Ame IDE đang mở\./)
    assert.doesNotMatch(html, /Ngắt tất cả|pairing-device-list/)
    assert.equal(findElements(tree, element => element.props.className === 'pairing-revoke-btn').length, 0)
  }
})

test('paired devices render count, labels, Vietnamese timestamps and disconnection controls', () => {
  const { html, tree } = render()
  assert.match(html, /Thiết bị đã ghép nối \(2\)/)
  const rows = findElements(tree, element => element.props.className === 'pairing-device-row')
  assert.equal(rows.length, 2)
  settings.devices!.forEach((device, index) => {
    assert.equal(rows[index].key, device.id)
    assert.ok(html.includes(device.label))
    assert.ok(html.includes(`Ghép nối ${new Date(device.createdAt).toLocaleString('vi-VN')} · Hoạt động ${new Date(device.lastUsedAt).toLocaleString('vi-VN')}`))
    assert.equal(button(rows[index], 'Ngắt kết nối').props.disabled, false)
  })
  assert.equal(button(tree, 'Ngắt tất cả').props.disabled, false)
  assert.ok(html.indexOf('class="pairing-options"') < html.indexOf('class="pairing-devices"'))
  assert.ok(html.indexOf('class="pairing-devices"') < html.indexOf('class="muted pairing-warning"'))
})

test('disconnecting a device calls pairingRevokeDevice with its ID and updates settings', async () => {
  const harness = render()
  const buttons = findElements(harness.tree, element => element.type === 'button' && element.props.children === 'Ngắt kết nối')
  buttons[1].props.onClick()
  assert.deepEqual(harness.calls, [{ method: 'pairingRevokeDevice', args: ['tablet-2'] }])
  const busy = harness.view().tree
  assert.ok(findElements(busy, element => element.props.className === 'pairing-revoke-btn').every(element => element.props.disabled))
  await tick()
  const { html, tree } = harness.view()
  assert.match(html, /Thiết bị đã ghép nối \(1\)/)
  assert.ok(html.includes('Điện thoại'))
  assert.ok(!html.includes('Máy tính bảng'))
  assert.equal(button(tree, 'Ngắt tất cả').props.disabled, false)
})

test('disconnecting all devices calls pairingRevokeAll without arguments and updates settings', async () => {
  const harness = render()
  button(harness.tree, 'Ngắt tất cả').props.onClick()
  assert.deepEqual(harness.calls, [{ method: 'pairingRevokeAll', args: [] }])
  await tick()
  assert.match(harness.view().html, /Thiết bị đã ghép nối \(0\)/)
  assert.doesNotMatch(harness.view().html, /Ngắt tất cả/)
})

test('pairing warning describes persistent pairing and a non-destructive Remote access toggle', () => {
  const { tree } = render()
  const [warning] = findElements(tree, element => element.props.className === 'muted pairing-warning')
  assert.equal(warning.props.children, 'Chỉ chia sẻ mã với thiết bị của bạn: thiết bị ghép nối có toàn quyền OpenCode và được lưu kết nối vĩnh viễn cho tới khi bạn bấm Ngắt kết nối. Tắt Remote access sẽ tạm chặn mọi truy cập từ xa mà không xóa danh sách thiết bị.')
})

test('revoke failures surface errors, ignore canceled confirmation and always clear busy', async () => {
  for (const label of ['Ngắt kết nối', 'Ngắt tất cả']) {
    for (const error of ['Action canceled', 'USER_CANCELED', "Error invoking remote method 'pairingRevokeAll': Error: Action canceled", 'Unable to disconnect']) {
      const harness = render(settings, { error })
      button(harness.tree, label).props.onClick()
      await tick()
      const { html, tree } = harness.view()
      assert.match(html, /Thiết bị đã ghép nối \(2\)/)
      assert.equal(button(tree, label).props.disabled, false)
      if (error === 'Unable to disconnect') assert.match(html, /role="alert">Unable to disconnect/)
      else assert.doesNotMatch(html, /role="alert"/)
    }
  }
})

test('revoke completion does not update state after unmount', async () => {
  for (const label of ['Ngắt kết nối', 'Ngắt tất cả']) {
    for (const error of [undefined, 'Unable to disconnect']) {
      const harness = render(settings, { error })
      button(harness.tree, label).props.onClick()
      harness.unmount()
      const writes = harness.writes()
      await tick()
      assert.equal(harness.writes(), writes)
    }
  }
})
