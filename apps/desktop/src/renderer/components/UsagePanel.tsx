import { useEffect, useState } from "react"
import { aggregateUsageTree, formatTokenCount, formatUsageCost, type UsageNode, type UsageTreeSummary } from "../../../../../packages/amekit/src/usage"
import { tokenValues, type UsageTokens } from "../../../../../packages/amekit/src/usage-pricing"

export type UsagePanelRow = {
  node: UsageNode; label: string; depthBadge: string; costText: string; totalTokens: number; hasChildren: boolean
}

export function buildUsagePanelModel(nodes: readonly UsageNode[], collapsed: ReadonlySet<string> = new Set()): {
  summary: UsageTreeSummary; totalCostText: string; rows: UsagePanelRow[]
} {
  const summary = aggregateUsageTree(nodes)
  const byID = new Map(nodes.map(node => [node.id, node]))
  const children = new Map<string, UsageNode[]>()
  const roots: UsageNode[] = [], ancestors: UsageNode[] = []
  for (const node of nodes) {
    while (ancestors.length && ancestors[ancestors.length - 1].depth >= node.depth) ancestors.pop()
    // Explicit parent IDs take precedence, including for breadth-first SDK family lists.
    const parentID = node.parentID ?? ancestors[ancestors.length - 1]?.id
    if (parentID && parentID !== node.id && byID.has(parentID)) {
      const siblings = children.get(parentID) ?? []
      siblings.push(node)
      children.set(parentID, siblings)
    } else roots.push(node)
    ancestors.push(node)
  }
  const rows: UsagePanelRow[] = [], seen = new Set<string>()
  const visit = (root: UsageNode) => {
    const stack = [{ node: root, hidden: false }]
    while (stack.length) {
      const { node, hidden } = stack.pop()!
      if (seen.has(node.id)) continue
      seen.add(node.id)
      const descendants = children.get(node.id) ?? []
      if (!hidden) rows.push({ node, label: node.info?.title ?? node.info?.agent ?? node.id,
        depthBadge: `L${node.depth}`, costText: formatUsageCost(node.knownCost, node.priced, node.partial || node.unassigned || node.unknown > 0),
        totalTokens: tokenValues(node.tokens).reduce((sum, value) => sum + value, 0), hasChildren: descendants.length > 0 })
      for (let index = descendants.length - 1; index >= 0; index--)
        stack.push({ node: descendants[index], hidden: hidden || collapsed.has(node.id) })
    }
  }
  for (const root of roots) visit(root)
  // Malformed cycles remain visible once rather than hanging or dropping every node.
  for (const node of nodes) if (!seen.has(node.id)) visit(node)
  return { summary, totalCostText: formatUsageCost(summary.knownCost, summary.priced, summary.incomplete), rows }
}

export type UsagePanelProps = {
  nodes: readonly UsageNode[]
  loading?: boolean
  error?: string
  origin?: string | null
  selectedSessionID?: string
  onSelectSession?: (sessionID: string) => void
  onRefresh?: () => void
}

function TokenBreakdown({ tokens }: { tokens: UsageTokens }) {
  return <span className="usage-token-breakdown">In {formatTokenCount(tokens.input)} · Out {formatTokenCount(tokens.output)} · Reasoning {formatTokenCount(tokens.reasoning)} · Cache đọc {formatTokenCount(tokens.cache.read)} / ghi {formatTokenCount(tokens.cache.write)}</span>
}

export function UsagePanel({ nodes, loading = false, error, origin, selectedSessionID, onSelectSession, onRefresh }: UsagePanelProps) {
  // Load styles only on mount so the pure model is also usable in Node without a CSS loader.
  useEffect(() => { void import("../usage-panel.css") }, [])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const { summary, totalCostText, rows } = buildUsagePanelModel(nodes, collapsed)
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return <section className="usage-panel" aria-label="Phân tích Usage & Chi phí" aria-busy={loading}>
    <header className="usage-header">
      <div><h2>Phân tích Usage & Chi phí</h2><p>Phiên hiện tại và toàn bộ cây subagent</p></div>
      <button type="button" disabled={loading || !onRefresh} onClick={onRefresh}>Làm mới</button>
    </header>
    <div className="usage-kpis">
      <div className="usage-kpi"><span>Ước tính chi phí USD</span><strong>{totalCostText}</strong><small>Ước tính API, không phải hóa đơn</small></div>
      <div className="usage-kpi"><span>Tổng Token</span><strong>{formatTokenCount(tokenValues(summary.tokens).reduce((sum, value) => sum + value, 0))}</strong><TokenBreakdown tokens={summary.tokens} /></div>
      <div className="usage-kpi"><span>Cây Subagent</span><strong>{summary.nodeCount} phiên · tối đa L{summary.maxDepth}</strong></div>
      <div className="usage-kpi"><span>Lượt gọi API</span><strong>{summary.requests} req · {summary.errors} lỗi</strong><small>{summary.pending} đang chờ</small></div>
    </div>
    {origin && <p className="usage-origin">Bảng giá: {origin}</p>}
    {loading && <p role="status">Đang tải dữ liệu usage…</p>}
    {error && <p className="usage-error" role="alert">Không thể làm mới usage: {error}</p>}
    {summary.incomplete && <p className="usage-notice">Chưa đầy đủ: có lịch sử chưa tải hoặc model chưa có bảng giá — Unknown không đồng nghĩa miễn phí</p>}
    {!rows.length && <p className="usage-empty">Chưa có dữ liệu usage.</p>}
    <div className="usage-nodes">
      {rows.map(({ node, label, depthBadge, costText, totalTokens, hasChildren }) => <article
        className={`usage-node${node.id === selectedSessionID ? " usage-node-selected" : ""}`}
        key={node.id} style={{ marginInlineStart: node.depth * 14 }}>
        <header className="usage-node-header">
          {hasChildren && <button type="button" aria-expanded={!collapsed.has(node.id)} aria-label={`${collapsed.has(node.id) ? "Mở rộng" : "Thu gọn"} ${label}`} onClick={() => toggle(node.id)}>{collapsed.has(node.id) ? "Mở rộng" : "Thu gọn"}</button>}
          <span className="usage-depth">{depthBadge}</span><h3>{label}</h3>
          <button type="button" disabled={!onSelectSession} aria-current={node.id === selectedSessionID ? "true" : undefined} onClick={() => onSelectSession?.(node.id)}>Mở session</button>
        </header>
        <p className="usage-session-id">{node.id}</p>
        <p><strong>{costText}</strong> · {formatTokenCount(totalTokens)} token</p>
        <TokenBreakdown tokens={node.tokens} />
        {(node.partial || node.unassigned || node.unknown > 0) && <p className="usage-node-notice">Breakdown chưa đầy đủ · {node.unknown} lượt chưa rõ giá / token</p>}
        <div className="usage-groups">{node.groups.map(group => <div className="usage-group" key={JSON.stringify([group.agent, group.provider, group.model, group.variant])}>
          <strong>{group.agent} · {group.provider} / {group.model}{group.variant ? ` · ${group.variant}` : ""}</strong>
          <p>{formatUsageCost(group.knownCost, group.priced, node.partial || node.unassigned || group.unknown > 0)} · {group.requests} req · {group.errors} lỗi · {group.pending} đang chờ · {group.retries} thử lại</p>
          <TokenBreakdown tokens={group.tokens} />
          <small>Thời gian hoàn tất: {(group.duration / 1000).toFixed(1)}s (tổng)</small>
          {group.sources.map(source => <small key={source}>{source}</small>)}
        </div>)}</div>
        <div className="usage-pills" aria-label="Skill và tool đã quan sát">
          {node.skills.map(skill => <span className="usage-pill" key={`skill:${skill.name}`}>Skill: {skill.name} ×{skill.count}</span>)}
          {node.tools.map(tool => <span className="usage-pill" key={`tool:${tool.name}`}>Tool: {tool.name} ×{tool.calls} · {tool.errors} lỗi · {tool.running} đang chạy · {(tool.duration / 1000).toFixed(1)}s</span>)}
        </div>
      </article>)}
    </div>
    <footer>Giá ước tính theo bảng giá hiện tại. Skill/tool thuộc lượt gọi model, không cộng phí trùng. Chỉ thống kê lịch sử đã tải.</footer>
  </section>
}
