import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PetSettings, type PetSettingsProps } from "../components/PetSettings"
import type { PetHostState } from "../../../../../packages/amekit/src/pet-host"
import { petLabels, petStates } from "../../../../../packages/amekit/src/pet"

const state: PetHostState = { preferences: { enabled: true, scale: 0.25, position: null }, activity: "working", error: "", speech: { enabled: true, sound: true }, generating: false, dialogueModel: "", generatedAt: 0 }
function render(extra: Partial<PetSettingsProps> = {}) {
  return renderToStaticMarkup(createElement(PetSettings, { petState: state, onConfigure() {}, onSpeech() {}, onGenerateDialogue() {}, onTestSpeech() {}, ...extra }))
}
function button(markup: string, label: string) {
  const tag = markup.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0]
  assert.ok(tag, `Missing button: ${label}`)
  return tag
}

test("SSR renders Vietnamese labels, live plus seven poses and 25–200% slider without CSS/image loaders", () => {
  const html = render({ spriteUrl: "data:image/png;base64,iVBORw0KGgo=", selectedModel: "ame-model" })
  for (const label of ["Hiển thị pet trên desktop", "Kích thước", "Đặt lại vị trí", "Bong bóng lời thoại", "Âm báo ting", "Tạo lời thoại", "Thử lời thoại"]) assert.ok(html.includes(label))
  assert.match(button(html, "Live"), /aria-pressed="true"/)
  for (const pose of petStates) assert.match(button(html, petLabels[pose]), /aria-pressed="false"/)
  assert.equal((html.match(/role="switch"/g) ?? []).length, 3)
  assert.match(html, /type="range"[^>]*min="25" max="200" step="5"[^>]*value="25"/)
  assert.match(html, /background-position-y:87.5%/)
  assert.match(html, /25%–200%/)
  assert.doesNotMatch(button(html, "Tạo lời thoại"), /disabled/)
  assert.doesNotMatch(button(html, "Thử lời thoại"), /disabled/)
})

test("generation is disabled without selected model or while generating/loading/disconnected", () => {
  for (const selectedModel of [undefined, "", "   "]) assert.match(button(render({ selectedModel }), "Tạo lời thoại"), /disabled=""/)
  assert.match(button(render({ selectedModel: "m", petState: { ...state, generating: true } }), "Đang tạo…"), /disabled=""/)
  const loading = render({ selectedModel: "m", loading: true })
  assert.match(button(loading, "Tạo lời thoại"), /disabled=""/)
  assert.match(button(loading, "Đặt lại vị trí"), /disabled=""/)
  const disconnected = render({ petState: null, selectedModel: "m" })
  assert.match(button(disconnected, "Tạo lời thoại"), /disabled=""/)
  assert.match(disconnected, /Đang kết nối pet runtime…/)
  assert.match(button(render({ petState: { ...state, preferences: { ...state.preferences, enabled: false } } }), "Thử lời thoại"), /disabled=""/)
  assert.match(button(render({ petState: { ...state, speech: { enabled: false, sound: true } } }), "Thử lời thoại"), /disabled=""/)
})

test("SSR escapes supplied errors, model and sprite properties without raw HTML", () => {
  const html = render({ error: "<img src=x>error</img>", selectedModel: "<selected>", spriteUrl: 'x\" onerror=\"bad', petState: { ...state, dialogueModel: "<model>" } })
  assert.match(html, /role="alert">&lt;img src=x&gt;error&lt;\/img&gt;/)
  assert.match(html, /&lt;model&gt;/); assert.match(html, /&lt;selected&gt;/)
  assert.doesNotMatch(html, /<img|<model>|<selected>| onerror="bad/)
  assert.match(render({ petState: { ...state, error: "<host-error>" } }), /&lt;host-error&gt;/)
})
