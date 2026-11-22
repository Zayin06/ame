import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { filterAndGroupProblems, ProblemsPanel } from "../components/ProblemsPanel"
import { DebugPanel, formatDebugStatus, type DebugPanelProps } from "../components/DebugPanel"
import type { LspDiagnostic } from "../../../../../packages/ide-core/src/ts-lsp"
import type { DebugSessionSnapshot, DebugStatus } from "../../../../../packages/ide-core/src/debugger"

function problem(path: string, severity: LspDiagnostic["severity"], line: number, column = 1, message = "Type mismatch"): LspDiagnostic {
  return { path, severity, line, column, endLine: line, endColumn: column + 1, code: 2322, message, source: "ts" }
}

function debugProps(status: DebugStatus = "idle", overrides: Partial<DebugPanelProps> = {}): DebugPanelProps {
  const snapshot: DebugSessionSnapshot = { status, frames: [], variables: [], breakpoints: [] }
  return {
    snapshot, output: [], entry: "src/app.ts", onEntryChange() {}, onStart() {}, onStop() {}, onContinue() {},
    onPause() {}, onStepOver() {}, onStepInto() {}, onStepOut() {}, onSelectFrame() {}, onOpenLocation() {},
    onRemoveBreakpoint() {}, onEvaluate: async () => ({ value: "13", type: "number" }), ...overrides,
  }
}

function assertButton(markup: string, label: string, disabled: boolean) {
  const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  const button = buttons.find(match => match[2] === label)
  assert.ok(button, `Missing button: ${label}`)
  assert.equal(/\bdisabled=""/.test(button[1]), disabled, `${label} disabled state`)
}

test("problems helper groups and sorts file locations without mutating diagnostics", () => {
  const items = [problem("src/b.ts", "error", 5), problem("src/a.ts", "warning", 7, 3),
    problem("src/a.ts", "info", 2), problem("src/a.ts", "error", 7, 1)]
  const before = JSON.stringify(items)
  Object.freeze(items)
  items.forEach(Object.freeze)
  const model = filterAndGroupProblems(items, { severity: "all", query: "" })
  assert.deepEqual(model.counts, { all: 4, error: 2, warning: 1, info: 1 })
  assert.deepEqual(model.groups.map(group => [group.path, group.items.map(item => [item.line, item.column])]), [
    ["src/a.ts", [[2, 1], [7, 1], [7, 3]]], ["src/b.ts", [[5, 1]]],
  ])
  assert.equal(model.groups[0].items[0], items[2])
  assert.equal(JSON.stringify(items), before)
})

test("problem severity and trimmed case-insensitive search combine while counts stay global", () => {
  const items = [problem("src/App.ts", "error", 2, 1, "Không tìm thấy kiểu"),
    problem("src/App.ts", "warning", 4, 1, "Unused value"), problem("src/other.ts", "info", 1)]
  const byPath = filterAndGroupProblems(items, { severity: "warning", query: "  SRC/APP  " })
  assert.deepEqual(byPath.groups, [{ path: "src/App.ts", items: [items[1]] }])
  assert.deepEqual(byPath.counts, { all: 3, error: 1, warning: 1, info: 1 })
  assert.equal(filterAndGroupProblems(items, { severity: "all", query: "KHÔNG TÌM" }).groups[0].items[0], items[0])
  assert.equal(filterAndGroupProblems(items, { severity: "all", query: "TS2322" }).groups.length, 2)
  assert.deepEqual(filterAndGroupProblems(items, { severity: "error", query: "unused" }).groups, [])
  assert.equal(filterAndGroupProblems(items, { severity: "all", query: "   " }).groups.length, 2)
  assert.deepEqual(filterAndGroupProblems([], { severity: "all", query: "" }), {
    groups: [], counts: { all: 0, error: 0, warning: 0, info: 0 },
  })
})

test("ProblemsPanel SSR renders Vietnamese counts, accessible groups and escaped diagnostics", () => {
  const markup = renderToStaticMarkup(createElement(ProblemsPanel, {
    problems: [problem("src/<script>.ts", "error", 4, 8, '<script>alert("problem")</script>'),
      problem("src/<script>.ts", "warning", 8), problem("src/other.ts", "info", 1)],
    onOpenLocation() {}, onRefresh() {},
  }))
  for (const text of ['aria-label="Vấn đề"', 'aria-label="Lọc theo mức độ"', 'aria-pressed="true"',
    "Tất cả <span>3</span>", "Lỗi <span>1</span>", "Cảnh báo <span>1</span>", "Thông tin <span>1</span>",
    "Tìm kiếm vấn đề...", "src/&lt;script&gt;.ts", "&lt;script&gt;alert(&quot;problem&quot;)&lt;/script&gt;", "ts(2322) · 4:8"])
    assert.ok(markup.includes(text), `Missing ${text}`)
  assert.equal((markup.match(/class="problems-group"/g) ?? []).length, 2)
  assert.equal((markup.match(/class="problems-row"/g) ?? []).length, 3)
  assert.ok(!markup.includes("<script>"))
  assertButton(markup, "Làm mới", false)
})

test("ProblemsPanel SSR handles empty and loading states and refresh availability", () => {
  const empty = renderToStaticMarkup(createElement(ProblemsPanel, { problems: [], onOpenLocation() {} }))
  assert.ok(empty.includes("Không có vấn đề."))
  assertButton(empty, "Làm mới", true)
  const loading = renderToStaticMarkup(createElement(ProblemsPanel, { problems: [], loading: true, onOpenLocation() {}, onRefresh() {} }))
  assert.ok(loading.includes('aria-busy="true"'))
  assert.ok(loading.includes('role="status">Đang tải vấn đề…'))
  assert.ok(!loading.includes("Không có vấn đề."))
  assertButton(loading, "Làm mới", true)
})

test("debug status helper covers all states with distinct active tones", () => {
  assert.deepEqual(formatDebugStatus("idle"), { label: "Chưa chạy", tone: "muted" })
  assert.deepEqual(formatDebugStatus("running"), { label: "Đang chạy", tone: "success" })
  assert.deepEqual(formatDebugStatus("paused"), { label: "Tạm dừng", tone: "warning" })
  assert.deepEqual(formatDebugStatus("exited"), { label: "Đã kết thúc", tone: "muted" })
})

test("DebugPanel SSR disables start, stop and step actions according to all session states", () => {
  for (const state of ["idle", "running", "paused", "exited"] as const) {
    const markup = renderToStaticMarkup(createElement(DebugPanel, debugProps(state)))
    const active = state === "running" || state === "paused"
    assert.ok(markup.includes(formatDebugStatus(state).label))
    assertButton(markup, "Bắt đầu", active)
    assertButton(markup, "Dừng", !active)
    assertButton(markup, "Tiếp tục", state !== "paused")
    assertButton(markup, "Tạm dừng", state !== "running")
    for (const step of ["Bước qua", "Bước vào", "Bước ra"]) assertButton(markup, step, state !== "paused")
    assertButton(markup, "Đánh giá", true)
    assertButton(markup, "Xóa đầu ra", true)
    const entry = markup.match(/<input[^>]*placeholder="src\/app.ts"[^>]*>/)?.[0]
    assert.ok(entry)
    assert.equal(entry.includes('disabled=""'), active)
  }
  const blank = renderToStaticMarkup(createElement(DebugPanel, debugProps("idle", { entry: "   " })))
  assertButton(blank, "Bắt đầu", true)
})

test("DebugPanel SSR renders paused frames, variables, breakpoint states and HTML-safe output", () => {
  const props = debugProps("paused", {
    snapshot: { status: "paused", entry: "src/app.ts", frames: [
      { callFrameId: "top", functionName: "<script>calc</script>", path: "src/app.ts", line: 4, column: 3 },
      { callFrameId: "caller", functionName: "", path: "src/<script>.ts", line: 8, column: 1 },
    ], variables: [{ name: "<variable>", value: "<script>13</script>", type: "number" }], breakpoints: [
      { path: "src/app.ts", line: 4, verified: true }, { path: "src/<script>.ts", line: 8, verified: false },
    ] }, selectedFrameId: "caller", entry: '<script>entry</script>',
    output: [{ stream: "stdout", text: '<script>alert("output")</script>\n' },
      { stream: "stderr", text: "<error>" }, { stream: "console", text: "<console>" }], onClearOutput() {},
  })
  const markup = renderToStaticMarkup(createElement(DebugPanel, props))
  for (const text of ["Ngăn xếp lời gọi", "Biến cục bộ", "Điểm dừng", "Bảng điều khiển đầu ra", "Biểu thức",
    "&lt;script&gt;calc&lt;/script&gt;", "&lt;variable&gt;", "&lt;script&gt;13&lt;/script&gt;", "src/app.ts:4:3",
    "src/&lt;script&gt;.ts:8:1", "Đã xác minh", "Chưa xác minh", 'aria-current="true"',
    'aria-label="Xóa điểm dừng src/app.ts:4"', 'role="log"', "debug-output-stdout", "debug-output-stderr",
    "debug-output-console", "&lt;script&gt;alert(&quot;output&quot;)&lt;/script&gt;", "&lt;script&gt;entry&lt;/script&gt;", "(ẩn danh)"])
    assert.ok(markup.includes(text), `Missing ${text}`)
  assert.ok(!markup.includes("<script>"))
  assert.ok(/<button[^>]*aria-current="true"[^>]*>.*src\/&lt;script&gt;.ts:8:1/.test(markup))
  assertButton(markup, "Xóa đầu ra", false)
})

test("DebugPanel SSR empty and exited snapshots remain useful and stale frames cannot be selected", () => {
  const empty = renderToStaticMarkup(createElement(DebugPanel, debugProps()))
  for (const text of ["Chưa có khung gọi.", "Chưa có biến cục bộ.", "Chưa có điểm dừng.", "Chưa có đầu ra."])
    assert.ok(empty.includes(text))
  const exited = renderToStaticMarkup(createElement(DebugPanel, debugProps("exited", {
    snapshot: { status: "exited", exitCode: 0, frames: [{ callFrameId: "stale", functionName: "calc", path: "src/app.ts", line: 3, column: 1 }],
      variables: [], breakpoints: [] }, output: [{ stream: "stdout", text: "RES=13\n" }],
  })))
  assert.ok(exited.includes("Mã thoát: 0"))
  assert.ok(exited.includes("RES=13\n"))
  assert.ok(/<button[^>]*disabled=""[^>]*><strong>calc<\/strong>/.test(exited))
  assertButton(exited, "Xóa đầu ra", true)
  const defaultSelection = renderToStaticMarkup(createElement(DebugPanel, debugProps("paused", {
    snapshot: { status: "paused", frames: [{ callFrameId: "top", functionName: "calc", path: "src/app.ts", line: 3, column: 1 }], variables: [], breakpoints: [] },
  })))
  assert.ok(/<button[^>]*aria-current="true"[^>]*><strong>calc<\/strong>/.test(defaultSelection))
})
