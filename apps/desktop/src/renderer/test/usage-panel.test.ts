import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
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

test("React markup renders Vietnamese KPIs, state notices, depth indentation and escaped metadata without a DOM", () => {
  const root = { ...node("root", 0), partial: true, skills: [{ name: "<testing>", count: 2 }],
    tools: [{ name: "shell", calls: 3, errors: 1, running: 1, duration: 2500 }] }
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes: [root, node("child", 1, "root")],
    loading: true, error: "<failed>", origin: "<catalog>", selectedSessionID: "child", onRefresh() {}, onSelectSession() {},
  }))
  for (const text of ["Phân tích Usage &amp; Chi phí", "Làm mới", "Ước tính chi phí USD", "Tổng Token", "Cây Subagent", "Lượt gọi API", "Chưa đầy đủ", "Unknown không đồng nghĩa miễn phí", "Mở session", "Thu gọn", "Skill: &lt;testing&gt;", "Tool: shell", "2.5s", "margin-inline-start:14px", "usage-node-selected", 'aria-expanded="true"', 'role="alert"', 'role="status"', "&lt;failed&gt;", "&lt;catalog&gt;"])
    assert.ok(markup.includes(text), `Missing ${text}`)
  assert.ok(!markup.includes("<testing>"))
  const empty = renderToStaticMarkup(createElement(UsagePanel, { nodes: [] }))
  assert.ok(empty.includes("Chưa có dữ liệu usage."))
})

test("cache hit KPI is prompt-weighted across the tree and badges identify each node and model group", () => {
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
  assert.match(markup, /<span>Cache Hit<\/span><strong class="usage-cache-hit usage-cache-hit-good">81%<\/strong><small>Đọc 332.5K \/ 410.6K prompt · Ghi 30<\/small>/)
  assert.equal((markup.match(/class="usage-kpi"/g) ?? []).length, 5)
  for (const [id, text, level] of [["root", "60%", "warn"], ["child", "81%", "good"], ["cold", "0%", "low"], ["empty", "—", "none"]]) {
    const article = markup.split('<article').find(part => part.includes(`<p class="usage-session-id">${id}</p>`))!
    assert.ok(article, `Missing session ${id}`)
    const [session, group] = article.split('<div class="usage-group"')
    for (const part of [session, group]) {
      assert.ok(part.includes(`usage-cache-hit-${level}`))
      assert.ok(part.includes(`Cache hit ${text}`))
      assert.ok(part.includes(`Hit ${text}`))
    }
  }
})

test("cache hit KPI handles an empty prompt and omits writes when zero", () => {
  const markup = renderToStaticMarkup(createElement(UsagePanel, { nodes: [] }))
  assert.match(markup, /<span>Cache Hit<\/span><strong class="usage-cache-hit usage-cache-hit-none">—<\/strong><small>Đọc 0 \/ 0 prompt<\/small>/)
  assert.ok(!markup.includes("· Ghi"))
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
  assert.match(markup, /Max context 322K · 2 tụt cache/)
  assert.match(markup, /3 bước/)
  assert.match(markup, /Context lớn 322K \(≥272K\)/)
  assert.match(markup, /1 lần tụt cache/)
  assert.match(markup, /Phiên ngắn \(4 bước\)/)
})
