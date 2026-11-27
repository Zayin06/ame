import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { isValidElement, type ReactNode, type ReactElement } from "react"
import ts from "typescript"
import { buildUsagePanelModel, UsagePanel } from "../components/UsagePanel"
import { emptyTokens, summarizeUsage, type UsageNode } from "../../../../../packages/amekit/src/usage"
import type { UsageTokens } from "../../../../../packages/amekit/src/usage-pricing"

function node(id: string, depth: number, parentID?: string): UsageNode {
  const result = summarizeUsage({ id, depth, messages: [{ id: `${id}-message`, type: "assistant", agent: "coder",
    model: { providerID: "amecode", id: "model" }, content: [], time: { created: 0, completed: 10 },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
  }], prices: {}, historyComplete: true })
  return { ...result, parentID, unknown: 0, knownCost: 0.25, priced: 1,
    groups: result.groups.map(group => ({ ...group, unknown: 0, knownCost: 0.25, priced: 1 })) }
}
const tree = [node("root", 0), node("a", 1, "root"), node("b", 1, "root"), node("a2", 2, "a"), node("b2", 2, "b"), node("a3", 3, "a2")]

test("panel model rolls up four levels and turns BFS input into stable parent-first rows", () => {
  const before = JSON.stringify(tree)
  const model = buildUsagePanelModel(tree)
  assert.equal(model.summary.nodeCount, 6)
  assert.equal(model.summary.maxDepth, 3)
  assert.equal(model.summary.requests, 6)
  assert.equal(model.summary.knownCost, 1.5)
  assert.deepEqual(model.summary.tokens, { input: 600, output: 120, reasoning: 30, cache: { read: 60, write: 12 } })
  assert.equal(model.totalCostText, "$1.500000")
  assert.deepEqual(model.rows.map(row => [row.node.id, row.depthBadge, row.hasChildren]), [
    ["root", "L0", true], ["a", "L1", true], ["a2", "L2", true], ["a3", "L3", false], ["b", "L1", true], ["b2", "L2", false],
  ])
  assert.equal(model.rows[3].totalTokens, 137)
  assert.equal(model.rows[3].costText, "$0.250000")
  assert.equal(model.rows[3].cacheHitText, "8.9%")
  assert.equal(model.rows[3].cacheHitLevel, "low")
  assert.equal(JSON.stringify(tree), before)
})

test("collapse hides only descendants, keeps sibling branches and never changes full-tree totals", () => {
  const collapsed = new Set(["a"])
  const model = buildUsagePanelModel(tree, collapsed)
  assert.deepEqual(model.rows.map(row => row.node.id), ["root", "a", "b", "b2"])
  assert.equal(model.rows[1].hasChildren, true)
  assert.equal(model.totalCostText, "$1.500000")
  assert.equal(model.summary.nodeCount, 6)
  assert.deepEqual([...collapsed], ["a"])
  assert.deepEqual(buildUsagePanelModel(tree, new Set(["a2"])).rows.map(row => row.node.id), ["root", "a", "a2", "b", "b2"])
  assert.deepEqual(buildUsagePanelModel(tree, new Set(["root", "a2"])).rows.map(row => row.node.id), ["root"])
  assert.deepEqual(buildUsagePanelModel(tree, new Set(["a3", "absent"])).rows.map(row => row.node.id), ["root", "a", "a2", "a3", "b", "b2"])
  assert.equal(buildUsagePanelModel(tree, new Set()).rows.length, 6)
})

test("preorder depth-only lists, shuffled parent IDs, missing parents and cycles remain well-defined", () => {
  const preorder = [node("root", 0), node("a", 1), node("a2", 2), node("a3", 3), node("b", 1), node("other", 0)]
  assert.deepEqual(buildUsagePanelModel(preorder, new Set(["a"])).rows.map(row => row.node.id), ["root", "a", "b", "other"])
  const shuffled = [tree[5], tree[4], tree[1], tree[0], tree[2], tree[3]]
  assert.deepEqual(buildUsagePanelModel(shuffled, new Set(["a"])).rows.map(row => row.node.id), ["root", "a", "b", "b2"])
  const malformed = [node("a", 1, "b"), node("b", 2, "a"), node("orphan", 2, "missing"), node("self", 0, "self")]
  const rows = buildUsagePanelModel(malformed).rows
  assert.equal(rows.length, 4)
  assert.equal(new Set(rows.map(row => row.node.id)).size, 4)
})

test("model labels prefer title then agent and preserve Unknown, partial and free semantics", () => {
  const info = { id: "title", projectID: "project", title: "Phiên chính", agent: "architect", cost: 900,
    tokens: emptyTokens(), time: { created: 0, updated: 0 }, location: { directory: "C:\\workspace" } }
  const titled = { ...node("title", 0), info }
  assert.equal(buildUsagePanelModel([titled]).rows[0].label, "Phiên chính")
  assert.equal(buildUsagePanelModel([{ ...titled, info: { ...info, title: undefined } }]).rows[0].label, "architect")
  assert.equal(buildUsagePanelModel([node("id", 0)]).rows[0].label, "id")
  const partial = buildUsagePanelModel([node("root", 0), { ...node("child", 1, "root"), unassigned: true }], new Set(["root"]))
  assert.equal(partial.totalCostText, "Partial · $0.500000")
  assert.equal(partial.summary.incomplete, true)
  const unknown = { ...node("unknown", 0), priced: 0, knownCost: 0, unknown: 1 }
  assert.equal(buildUsagePanelModel([unknown]).totalCostText, "Unknown")
  assert.equal(buildUsagePanelModel([{ ...unknown, id: "free", unknown: 0, priced: 1 }]).totalCostText, "$0.000000")
  assert.deepEqual(buildUsagePanelModel([]).rows, [])
  assert.equal(buildUsagePanelModel([]).totalCostText, "Unknown")
})

test("compact markup keeps accessible icons, state notices, indentation and escaped metadata", () => {
  const root = { ...node("root", 0), partial: true, skills: [{ name: "<testing>", count: 2 }],
    tools: [{ name: "shell", calls: 3, errors: 1, running: 1, duration: 2500 }] }
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes: [root, node("child", 1, "root")],
    loading: true, error: "<failed>", origin: "<catalog>", selectedSessionID: "child", onRefresh() {}, onSelectSession() {},
  }))
  for (const text of ["Usage", "Làm mới", "Chưa đầy đủ", "Unknown không đồng nghĩa miễn phí", "Mở session", "Thu gọn", "&lt;testing&gt; ×2", "shell ×3", "2.5s", "margin-inline-start:14px", "usage-node-selected", 'aria-expanded="true"', 'role="alert"', 'role="status"', "&lt;failed&gt;", "&lt;catalog&gt;"])
    assert.ok(markup.includes(text), `Missing ${text}`)
  const doc = new JSDOM(markup).window.document
  assert.equal(doc.querySelectorAll(".usage-kpi").length, 4)
  assert.equal(doc.querySelector("h2")?.textContent, "Usage")
  for (const label of ["Làm mới", "Mở session", "Thu gọn"]) {
    const button = doc.querySelector(`button[aria-label="${label}"]`)!
    assert.equal(button.getAttribute("title"), label)
    assert.equal(button.textContent, "")
    assert.ok(button.querySelector('svg[stroke-width="1.7"]'))
  }
  assert.equal(doc.querySelector("h3")?.title, "root")
  assert.ok(doc.querySelector(".usage-refresh-loading"))
  assert.ok(doc.querySelector('[aria-current="true"]'))
  assert.ok(doc.querySelector('[aria-label="Thông tin usage"]')?.getAttribute("title")?.includes("<catalog>"))
  for (const removed of ["Partial · ", "Phiên hiện tại và toàn bộ cây subagent", "Skill:", "Tool:", "equivalent_api_estimate"]) assert.ok(!doc.body.textContent?.includes(removed))
  assert.equal(doc.querySelector("footer, .usage-session-id, .usage-node-notice, .usage-origin, .usage-notice"), null)
  assert.ok(!doc.body.textContent?.includes("không phải hóa đơn"))
  assert.ok(!markup.includes("<testing>"))
  const empty = renderToStaticMarkup(createElement(UsagePanel, { nodes: [] }))
  assert.ok(empty.includes("Chưa có dữ liệu usage."))
  assert.equal(new JSDOM(empty).window.document.querySelector('[aria-label="Chi phí"] strong')?.textContent, "Unknown")
})

test("cache hit KPI is prompt-weighted and single-group cards never duplicate token or cache badges", () => {
  const withTokens = (id: string, depth: number, tokens: UsageTokens, parentID?: string) => {
    const source = node(id, depth, parentID)
    return { ...source, tokens, groups: source.groups.map(group => ({ ...group, tokens })) }
  }
  const nodes = [
    withTokens("root", 0, { input: 10, output: 900, reasoning: 300, cache: { read: 60, write: 30 } }),
    withTokens("child", 1, { input: 77990, output: 20, reasoning: 5, cache: { read: 332440, write: 0 } }, "root"),
    withTokens("cold", 1, { ...emptyTokens(), input: 100 }, "root"),
    withTokens("empty", 1, emptyTokens(), "root"),
  ]
  const model = buildUsagePanelModel(nodes, new Set(["root"]))
  assert.equal(model.rows.length, 1)
  assert.equal(model.summary.tokens.cache.read, 332500)
  assert.equal(model.rows[0].cacheHitText, "60%")
  assert.equal(model.rows[0].cacheHitLevel, "warn")
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes }))
  const doc = new JSDOM(markup).window.document
  const kpi = doc.querySelector('[aria-label="Cache Hit"]')!
  assert.equal(kpi.querySelector("strong")?.textContent, "81%")
  assert.equal(kpi.querySelector("small")?.textContent, "332.5K / 410.6K · +ghi 30")
  assert.equal(doc.querySelectorAll(".usage-kpi").length, 4)
  for (const [id, text, level] of [["root", "60%", "warn"], ["child", "81%", "good"], ["cold", "0%", "low"], ["empty", "—", "none"]]) {
    const article = doc.querySelector(`h3[title="${id}"]`)?.closest("article")!
    assert.ok(article, `Missing session ${id}`)
    assert.equal(article.querySelectorAll(".usage-cache-badge").length, 1)
    assert.equal(article.querySelector(".usage-cache-badge")?.textContent, text)
    assert.ok(article.querySelector(`.usage-cache-hit-${level}`))
    assert.equal(article.querySelectorAll(".usage-token-breakdown").length, 1)
    assert.equal(article.querySelector(".usage-groups"), null)
  }
})

test("cache hit KPI handles an empty prompt and omits writes when zero", () => {
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes: [] }))
  const doc = new JSDOM(markup).window.document
  const kpi = doc.querySelector('[aria-label="Cache Hit"]')!
  assert.equal(kpi.querySelector("strong")?.textContent, "—")
  assert.equal(kpi.querySelector("small")?.textContent, "0 / 0")
  assert.ok(!markup.includes("+ghi"))
  assert.equal(doc.querySelector('[aria-label="Token"] [title="Reasoning"]'), null)
})

test("summarizeUsage and UsagePanel surface step counts, cache drops, high context (>=272K) and short sessions", () => {
  const highCtx = {
    ...summarizeUsage({
      id: "res", depth: 1,
      messages: [
        { id: "m1", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 0, completed: 10 }, tokens: { input: 20_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
        { id: "m2", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 10, completed: 20 }, tokens: { input: 302_000, output: 100, reasoning: 0, cache: { read: 20_000, write: 0 } } },
        { id: "m3", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 20, completed: 30 }, tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 5_000, write: 0 } } },
      ],
      prices: {}, historyComplete: true,
    }),
    parentID: "root",
  }
  assert.equal(highCtx.requests, 3)
  assert.equal(highCtx.maxPromptTokens, 322_000)
  assert.equal(highCtx.cacheMissDrops, 1)

  const shortNode = {
    ...summarizeUsage({
      id: "glue", depth: 1,
      messages: [
        { id: "g1", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 0, completed: 10 }, tokens: { input: 1_500, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
        { id: "g2", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 10, completed: 20 }, tokens: { input: 900, output: 50, reasoning: 0, cache: { read: 1_400, write: 0 } } },
        { id: "g3", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 20, completed: 30 }, tokens: { input: 13_800, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
        { id: "g4", type: "assistant", agent: "ame-explorer", model: { providerID: "amecode", id: "gpt-6-luna" }, content: [], time: { created: 30, completed: 40 }, tokens: { input: 9_400, output: 50, reasoning: 0, cache: { read: 13_600, write: 0 } } },
      ],
      prices: {}, historyComplete: true,
    }),
    parentID: "root",
  }
  assert.equal(shortNode.requests, 4)
  assert.equal(shortNode.cacheMissDrops, 1)

  const root = { ...node("root", 0), requests: 6 }
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes: [root, highCtx, shortNode] }))
  assert.match(markup, /Max context 322K/)
  assert.match(markup, /2 tụt/)
  assert.match(markup, /3 req/)
  assert.match(markup, /≥272K \(322K\)/)
  assert.match(markup, /1 tụt cache/)
  assert.match(markup, /title="Phiên ngắn \(4 bước\)">Ngắn \(4b\)/)
})

test("costs preserve six decimals and warnings carry breakdown and sources only in tooltips", () => {
  const source = node("priced", 0)
  const priced = { ...source, partial: true, unknown: 12, knownCost: 0.057257,
    groups: source.groups.map(group => ({ ...group, sources: ["equivalent_api_estimate · catalog"] })) }
  const free = { ...node("free", 0), knownCost: 0 }
  const unknown = { ...node("unknown", 0), knownCost: 0, priced: 0, unknown: 1 }
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes: [priced, free, unknown] }))
  const doc = new JSDOM(markup).window.document
  assert.equal(doc.querySelector('h3[title="priced"]')?.closest("article")?.querySelector(".usage-cost")?.textContent, "$0.057257")
  assert.equal(doc.querySelector('[aria-label="Chi phí"] strong')?.textContent, "0.057257")
  assert.equal(doc.querySelector('h3[title="free"]')?.closest("article")?.querySelector(".usage-cost")?.textContent, "$0.000000")
  assert.equal(doc.querySelector('h3[title="unknown"]')?.closest("article")?.querySelector(".usage-cost")?.textContent, "Unknown")
  assert.ok(doc.querySelector('.usage-cost .usage-warning')?.getAttribute("title")?.includes("12 lượt chưa rõ giá / token · equivalent_api_estimate · catalog"))
  assert.ok(!markup.includes("Partial · "))
  assert.ok(!doc.body.textContent?.includes("equivalent_api_estimate"))
})

test("multiple model groups remain one-line breakdowns while single group metadata is merged", () => {
  const source = node("multi", 0)
  const first = { ...source.groups[0], variant: "default", duration: 259_000, sources: ["catalog-source"], errors: 1, pending: 2, retries: 3 }
  const second = { ...first, agent: "reviewer", model: "other", variant: "high", duration: 36_900 }
  const nodes = [{ ...source, groups: [first, second] }, { ...node("single", 0), groups: [first] }]
  const doc = new JSDOM(renderToStaticMarkup(createElement(UsagePanel, { nodes }))).window.document
  const groups = doc.querySelectorAll(".usage-group")
  assert.equal(groups.length, 2)
  assert.ok(groups[0].textContent?.includes("coder · model"))
  assert.ok(groups[1].textContent?.includes("reviewer · other · high"))
  for (const group of groups) {
    assert.ok(group.getAttribute("title")?.includes("Provider: amecode"))
    assert.ok(group.textContent?.includes("$0.250000"))
    assert.equal(group.querySelectorAll(".usage-cache-badge").length, 1)
    assert.ok(group.getAttribute("title")?.includes("Cache đọc 10 / ghi 2\ncatalog-source"))
    for (const title of ["1 lỗi", "2 đang chờ", "3 thử lại"]) assert.ok(group.querySelector(`[title="${title}"]`))
  }
  const single = doc.querySelector('h3[title="single"]')!.closest("article")!
  assert.ok(single.querySelector(".usage-node-meta")?.textContent?.includes("coder · model"))
  assert.ok(single.textContent?.includes("4m 19s"))
  assert.ok(doc.body.textContent?.includes("36.9s"))
  assert.ok(!doc.body.textContent?.includes("amecode /"))
  assert.ok(!doc.body.textContent?.includes("· default"))
})

test("compact layout uses container breakpoints and keeps metrics on one horizontal row", () => {
  const css = readFileSync(new URL("../usage-panel.css", import.meta.url), "utf8")
  assert.match(css, /\.usage-kpis\s*\{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(css, /@container \(max-width: 719px\)\s*\{\s*\.usage-kpis\s*\{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /@container \(max-width: 320px\)\s*\{\s*\.usage-kpis\s*\{ grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(css, /\.usage-node-summary\s*\{[^}]*overflow-x: auto; white-space: nowrap/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})

test("tool pills omit zero counters and sub-100ms durations but retain active counters and timings", () => {
  const source = { ...node("tools", 0), tools: [
    { name: "read", calls: 6, errors: 0, running: 0, duration: 0 },
    { name: "fast", calls: 1, errors: 0, running: 0, duration: 99 },
    { name: "patch", calls: 5, errors: 1, running: 0, duration: 100 },
    { name: "shell", calls: 7, errors: 0, running: 2, duration: 72_000 },
  ] }
  const doc = new JSDOM(renderToStaticMarkup(createElement(UsagePanel, { nodes: [source] }))).window.document
  const pills = [...doc.querySelectorAll(".usage-pill")]
  assert.equal(pills[0].textContent, "read ×6")
  assert.equal(pills[1].textContent, "fast ×1")
  assert.ok(pills[2].querySelector('[title="1 lỗi"]'))
  assert.ok(pills[2].textContent?.includes("0.1s"))
  assert.ok(pills[3].querySelector('[title="2 đang chạy"]'))
  assert.equal(pills[3].querySelector('[title="2 đang chờ"]'), null)
  assert.ok(pills[3].textContent?.includes("1m 12s"))
  for (const text of ["0 lỗi", "0 đang chạy", "0.0s", "Tool:"]) assert.ok(!doc.body.textContent?.includes(text))
})

test("info popover toggles, dismisses outside or on Escape, and cleans up listeners", () => {
  const filename = new URL("../components/UsagePanel.tsx", import.meta.url)
  const nativeRequire = createRequire(filename)
  const dom = new JSDOM('<div id="inside"></div><div id="outside"></div>')
  const doc = dom.window.document
  const slots: any[] = [], cleanups: any[] = []
  let cursor = 0, effects: (() => void)[] = []
  const hooks = {
    useId: () => "usage-info-test",
    useRef: () => ({ current: doc.querySelector("#inside") }),
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value }]
    },
    useEffect(effect: () => any, deps: unknown[]) {
      const index = cursor++, old = slots[index]
      if (old && deps.every((value, i) => Object.is(value, old[i]))) return
      slots[index] = deps
      effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() })
    },
  }
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, { exports, document: doc, require: (name: string) => name === "react" ? hooks : name.endsWith(".css") ? {} : nativeRequire(name) })
  const elements = (node: ReactNode): ReactElement<any>[] => {
    if (Array.isArray(node)) return node.flatMap(elements)
    if (!isValidElement<any>(node)) return []
    return [node, ...elements((node.props as any).children)]
  }
  let tree: ReactNode
  const render = () => { cursor = 0; tree = exports.UsagePanel({ nodes: [], origin: "catalog" }); const pending = effects; effects = []; pending.forEach(effect => effect()) }
  const button = () => elements(tree).find(node => node.props["aria-label"] === "Thông tin usage")!
  const popover = () => elements(tree).find(node => node.props.className === "usage-info-popover")
  const click = () => { button().props.onClick(); render() }
  try {
    render(); assert.equal(popover(), undefined); assert.equal(button().props["aria-expanded"], false)
    click(); assert.equal(button().props["aria-expanded"], true)
    assert.equal(button().props["aria-controls"], popover()!.props.id)
    assert.equal(popover()!.props.children, button().props.title)
    assert.match(popover()!.props.children, /Bảng giá: catalog/)
    doc.querySelector("#inside")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); render(); assert.ok(popover())
    click(); assert.equal(popover(), undefined)
    click(); doc.querySelector("#outside")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); render(); assert.equal(popover(), undefined)
    click(); doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" })); render(); assert.ok(popover())
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); render(); assert.equal(popover(), undefined)
  } finally { cleanups.forEach(cleanup => cleanup?.()); dom.window.close() }
})
