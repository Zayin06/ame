import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings } from '../components/Settings'
import { defaults } from '../state'

type Props = ComponentProps<typeof Settings>
function render(extra: Partial<Props> = {}) {
  return renderToStaticMarkup(createElement(Settings, {
    preferences: defaults(), setLayout() {}, theme: 'dark', setTheme() {},
    connection: { connected: true, url: 'http://127.0.0.1:4096', version: '2.3.2' },
    setConnection() {}, close() {}, pet: null, sprite: '', onPet() {}, ...extra,
  }))
}

test('general Settings has five appearance controls, one backend row and collapsed shortcuts', () => {
  const html = render()
  assert.match(html, /role="dialog"[^>]*aria-label="Cài đặt"/)
  assert.match(html, /class="settings-content settings-content--general"/)
  assert.deepEqual([...html.matchAll(/data-setting="([^"]+)"/g)].map(match => match[1]), ['theme', 'timeline-detail', 'chat-width', 'workspace-tint', 'layout-mode'])
  assert.equal((html.match(/class="setting-row(?: setting-row--backend)?"/g) ?? []).length, 6)
  assert.match(html, /<select class="settings-select" aria-label="Chủ đề"><option value="dark" selected="">Tối<\/option><option value="light">Sáng<\/option><\/select>/)
  for (const label of ['Software Eng', 'Knowledge Work', 'default', 'nord', 'everforest', 'Compact', 'Default', 'Wide', 'Gọn', 'Chi tiết', 'Đầy đủ']) assert.ok(html.includes(`>${label}</button>`), label)
  for (const button of html.matchAll(/<button[^>]*>/g)) {
    if (!button[0].includes('aria-label="Đóng"')) assert.match(button[0], /type="button"/)
  }
  const details = html.match(/<details[^>]*data-testid="settings-shortcuts"[^>]*>/)?.[0]
  assert.ok(details)
  assert.doesNotMatch(details, /\bopen(?:=|\s|>)/)
  assert.equal((html.match(/<dt>/g) ?? []).length, 10)
  assert.equal((html.match(/<dd>/g) ?? []).length, 10)
  assert.match(html, /Đã kết nối 2\.3\.2 · 127\.0\.0\.1:4096/)
  assert.doesNotMatch(html, /máy chủ bên ngoài|Nâng cao|xterm\.js|<form|role="alert"/)
})

test('backend disconnected status and errors are readable and safely escaped', () => {
  const html = render({ connection: { connected: false, url: 'https://localhost:4096', error: 'Không thể kết nối <backend>' } })
  assert.match(html, /Chưa kết nối · localhost:4096/)
  assert.match(html, /class="inline-error settings-inline-error" role="alert">Không thể kết nối &lt;backend&gt;<\/p>/)
  assert.match(html, /aria-label="Dùng hoặc thử lại backend tích hợp"[^>]*>Thử lại<\/button>/)
  assert.doesNotMatch(html, /<backend>|connection-dot connected/)
  const noURL = render({ connection: { connected: false, url: '' } })
  assert.match(noURL, /class="setting-row__desc">Chưa kết nối<\/div>/)
  assert.doesNotMatch(noURL, /role="alert"/)
})

test('theme, active presets and platform shortcuts reflect supplied preferences', () => {
  const html = render({ theme: 'light', isMac: true, preferences: { ...defaults(), timelineDetail: 'everything', tint: 'nord', chatWidth: 960, layoutMode: 'knowledge' } })
  assert.match(html, /<option value="light" selected="">Sáng<\/option>/)
  for (const label of ['Đầy đủ', 'nord', 'Wide', 'Knowledge Work']) assert.match(html, new RegExp(`aria-pressed="true" class="segmented__btn is-active">${label}</button>`))
  for (const shortcut of ['⌘S', '⌥⌘B', '⇧⌘E', '⌘Enter', '⌘,']) assert.ok(html.includes(`<kbd>${shortcut}</kbd>`), shortcut)
  assert.doesNotMatch(html, /Ctrl\+/)
  assert.match(render(), /<kbd>Ctrl\+S<\/kbd>/)
})

test('all existing tabs remain available and honor initialSection', () => {
  for (const [section, label, content] of [
    ['appearance', 'Giao diện &amp; hệ thống', 'settings-content--general'],
    ['amekit', 'AmeKit', 'amekit-core'],
    ['pairing', 'Pairing', 'pairing-settings'],
    ['pet', 'Desktop Pet', 'Hiển thị pet trên desktop'],
  ] as const) {
    const html = render({ initialSection: section })
    assert.match(html, new RegExp(`<button type="button" class="active">${label}</button>`))
    assert.ok(html.includes(content), section)
    for (const tab of ['Giao diện &amp; hệ thống', 'AmeKit', 'Pairing', 'Desktop Pet']) assert.ok(html.includes(`>${tab}</button>`), tab)
    if (section !== 'appearance') assert.doesNotMatch(html, /settings-content--general/)
  }
})
