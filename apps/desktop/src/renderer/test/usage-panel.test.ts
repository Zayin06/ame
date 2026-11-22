import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { buildUsagePanelModel, UsagePanel } from "../components/UsagePanel"
import { emptyTokens, summarizeUsage, type UsageNode } from "../../../../../packages/amekit/src/usage"

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
