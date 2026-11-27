import { useEffect, useId, useRef, useState } from "react"
import { aggregateUsageTree, cacheHitLevel, formatCacheHitRate, formatTokenCount, formatUsageCost, usageDiagnostics, type UsageNode, type UsageTreeSummary } from "../../../../../packages/amekit/src/usage"
import { tokenValues, type UsageTokens } from "../../../../../packages/amekit/src/usage-pricing"
import { Icon } from "./Icon"

export type UsagePanelRow = {
  node: UsageNode; label: string; depthBadge: string; costText: string; totalTokens: number; hasChildren: boolean
  cacheHitText: string; cacheHitLevel: ReturnType<typeof cacheHitLevel>
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
        totalTokens: tokenValues(node.tokens).reduce((sum, value) => sum + value, 0), hasChildren: descendants.length > 0,
        cacheHitText: formatCacheHitRate(node.tokens), cacheHitLevel: cacheHitLevel(node.tokens) })
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

const incompleteNotice = "Chưa đầy đủ: có lịch sử chưa tải hoặc model chưa có bảng giá — Unknown không đồng nghĩa miễn phí"
const compactCost = (text: string) => text.replace(/^Partial · /, "")
const durationText = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
const tokenTitle = (tokens: UsageTokens) => `Input ${tokens.input} · Output ${tokens.output} · Reasoning ${tokens.reasoning} · Cache đọc ${tokens.cache.read} / ghi ${tokens.cache.write}`
const groupLabel = (group: UsageNode["groups"][number]) => `${group.agent} · ${group.model || group.provider}${group.variant && group.variant !== "default" ? ` · ${group.variant}` : ""}`

function TokenDetails({ tokens }: { tokens: UsageTokens }) {
  return <span className="usage-token-breakdown">
    <span title="Input"><Icon name="arrowDown" />{formatTokenCount(tokens.input)}</span>
    <span title="Output"><Icon name="arrowUp" />{formatTokenCount(tokens.output)}</span>
    {tokens.reasoning > 0 && <span title="Reasoning"><Icon name="sparkles" />{formatTokenCount(tokens.reasoning)}</span>}
  </span>
}

function RequestBadges({ errors, pending, retries = 0, pendingLabel = "đang chờ" }: { errors: number; pending: number; retries?: number; pendingLabel?: string }) {
  return <>
    {errors > 0 && <span className="usage-diag-badge usage-diag-danger" title={`${errors} lỗi`}><Icon name="xCircle" />{errors}</span>}
    {pending > 0 && <span className="usage-diag-badge usage-diag-warn" title={`${pending} ${pendingLabel}`}><Icon name="clock" />{pending}</span>}
    {retries > 0 && <span className="usage-diag-badge usage-diag-muted" title={`${retries} thử lại`}><Icon name="refresh" />{retries}</span>}
  </>
}

function CacheBadge({ tokens }: { tokens: UsageTokens }) {
  return <span title="Cache Hit" className={`usage-cache-badge usage-cache-hit usage-cache-hit-${cacheHitLevel(tokens)}`}><Icon name="zap" />{formatCacheHitRate(tokens)}</span>
}

export function UsagePanel({ nodes, loading = false, error, origin, selectedSessionID, onSelectSession, onRefresh }: UsagePanelProps) {
  // Load styles only on mount so the pure model is also usable in Node without a CSS loader.
  useEffect(() => { void import("../usage-panel.css") }, [])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [infoOpen, setInfoOpen] = useState(false)
  const infoRef = useRef<HTMLDivElement>(null)
  const infoID = useId()
  useEffect(() => {
    if (!infoOpen) return
    const dismiss = (event: PointerEvent) => { if (!infoRef.current?.contains(event.target as Node)) setInfoOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setInfoOpen(false) }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("keydown", escape)
    }
  }, [infoOpen])
  const { summary, totalCostText, rows } = buildUsagePanelModel(nodes, collapsed)
  const infoTitle = [origin && `Bảng giá: ${origin}`, "Giá ước tính theo bảng giá API, không phải hóa đơn; skill/tool thuộc lượt gọi model; chỉ thống kê lịch sử đã tải", summary.incomplete && incompleteNotice].filter(Boolean).join("\n")
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return <section className="usage-panel" aria-label="Phân tích Usage & Chi phí" aria-busy={loading}>
    <header className="usage-header">
      <h2>Usage</h2>
      <div className="usage-info" ref={infoRef}>
        <button className="usage-icon-button" type="button" aria-label="Thông tin usage" aria-description={infoTitle} aria-expanded={infoOpen} aria-controls={infoOpen ? infoID : undefined} title={infoTitle} onClick={() => setInfoOpen(open => !open)}><Icon name="info" /></button>
        {infoOpen && <div className="usage-info-popover" id={infoID} role="note">{infoTitle}</div>}
      </div>
      <button className={`usage-icon-button${loading ? " usage-refresh-loading" : ""}`} type="button" aria-label="Làm mới" title="Làm mới" disabled={loading || !onRefresh} onClick={onRefresh}><Icon name="refresh" /></button>
    </header>
    <div className="usage-kpis">
      <div className="usage-kpi" aria-label="Chi phí"><div className="usage-kpi-value"><Icon name="dollar" /><strong>{compactCost(totalCostText).replace(/^\$/, "")}</strong>{summary.incomplete && <span className="usage-warning" title={incompleteNotice} aria-label={incompleteNotice}><Icon name="alert" /></span>}</div><small>USD</small></div>
      <div className="usage-kpi" aria-label="Token"><div className="usage-kpi-value"><Icon name="layers" /><strong>{formatTokenCount(tokenValues(summary.tokens).reduce((sum, value) => sum + value, 0))}</strong></div><TokenDetails tokens={summary.tokens} /></div>
      <div className="usage-kpi" aria-label="Cache Hit"><div className="usage-kpi-value"><Icon name="zap" /><strong className={`usage-cache-hit usage-cache-hit-${cacheHitLevel(summary.tokens)}`}>{formatCacheHitRate(summary.tokens)}</strong></div><small title="Cache đọc / tổng prompt">{formatTokenCount(summary.tokens.cache.read)} / {formatTokenCount(summary.tokens.input + summary.tokens.cache.read + summary.tokens.cache.write)}{summary.tokens.cache.write > 0 && ` · +ghi ${formatTokenCount(summary.tokens.cache.write)}`}{summary.cacheMissDrops > 0 && <span className="usage-diag-badge usage-diag-warn" title="Số lần tụt cache"><Icon name="arrowDown" />{summary.cacheMissDrops} tụt</span>}</small></div>
      <div className="usage-kpi" aria-label="Cây & API"><div className="usage-kpi-value" title={`${summary.nodeCount} phiên · tối đa L${summary.maxDepth}${summary.maxPromptTokens > 0 ? ` · Max context ${formatTokenCount(summary.maxPromptTokens)}` : ""}`}><Icon name="agents" /><strong>{summary.nodeCount} · L{summary.maxDepth}</strong></div><small>{summary.requests} req<RequestBadges errors={summary.errors} pending={summary.pending} />{summary.maxPromptTokens > 0 && <span>· ctx {formatTokenCount(summary.maxPromptTokens)}</span>}</small></div>
    </div>
    {loading && <p role="status">Đang tải dữ liệu usage…</p>}
    {error && <p className="usage-error" role="alert">Không thể làm mới usage: {error}</p>}
    {!rows.length && <p className="usage-empty">Chưa có dữ liệu usage.</p>}
    <div className="usage-nodes">
      {rows.map(({ node, label, depthBadge, costText, totalTokens, hasChildren }) => {
        const diagnostics = usageDiagnostics(node)
        const totals = node.groups.reduce((sum, group) => ({ duration: sum.duration + group.duration, errors: sum.errors + group.errors, pending: sum.pending + group.pending, retries: sum.retries + group.retries }), { duration: 0, errors: 0, pending: 0, retries: 0 })
        const sources = [...new Set(node.groups.flatMap(group => group.sources))]
        const warning = ["Breakdown chưa đầy đủ", node.unknown > 0 && `${node.unknown} lượt chưa rõ giá / token`, ...sources].filter(Boolean).join(" · ")
        const collapseLabel = collapsed.has(node.id) ? "Mở rộng" : "Thu gọn"
        return <article
          className={`usage-node${node.id === selectedSessionID ? " usage-node-selected" : ""}`}
          key={node.id} style={{ marginInlineStart: node.depth * 14 }}>
          <header className="usage-node-header">
            {hasChildren && <button className="usage-icon-button" type="button" aria-expanded={!collapsed.has(node.id)} aria-label={collapseLabel} title={collapseLabel} onClick={() => toggle(node.id)}><Icon name={collapsed.has(node.id) ? "chevron" : "down"} /></button>}
            <span className="usage-depth">{depthBadge}</span><h3 title={node.id}>{label}</h3>
            <button className="usage-icon-button" type="button" aria-label="Mở session" title="Mở session" disabled={!onSelectSession} aria-current={node.id === selectedSessionID ? "true" : undefined} onClick={() => onSelectSession?.(node.id)}><Icon name="externalLink" /></button>
          </header>
          <div className="usage-node-meta">
            {node.groups.length === 1 && <span className="usage-model-label" title={`${groupLabel(node.groups[0])} · ${node.groups[0].provider}`}>{groupLabel(node.groups[0])}</span>}
            {totals.duration >= 100 && <span title="Tổng thời lượng"><Icon name="clock" />{durationText(totals.duration)}</span>}
            <span>{node.requests} req</span><RequestBadges {...totals} />
          </div>
          <div className="usage-node-summary">
            <strong className="usage-cost" title={sources.join("\n")}>{compactCost(costText)}{(node.partial || node.unassigned || node.unknown > 0) && <span className="usage-warning" title={warning} aria-label={warning}><Icon name="alert" /></span>}</strong>
            <span className="usage-node-tokens" title={tokenTitle(node.tokens)}><Icon name="layers" />{formatTokenCount(totalTokens)} (<TokenDetails tokens={node.tokens} />)</span>
            <CacheBadge tokens={node.tokens} />
            {diagnostics.highContext && <span className="usage-diag-badge usage-diag-danger">≥272K ({formatTokenCount(node.maxPromptTokens)})</span>}
            {diagnostics.cacheDropWarning && <span className="usage-diag-badge usage-diag-warn">{node.cacheMissDrops} tụt cache</span>}
            {diagnostics.lowSampleShortSession && <span className="usage-diag-badge usage-diag-muted" title={`Phiên ngắn (${node.requests} bước)`}>Ngắn ({node.requests}b)</span>}
          </div>
          {node.groups.length > 1 && <div className="usage-groups">{node.groups.map(group => <div className="usage-group" title={[`Provider: ${group.provider}`, tokenTitle(group.tokens), ...group.sources].join("\n")} key={JSON.stringify([group.agent, group.provider, group.model, group.variant])}>
            <strong className="usage-model-label">{groupLabel(group)}</strong>
            <span>{compactCost(formatUsageCost(group.knownCost, group.priced, node.partial || node.unassigned || group.unknown > 0))}{(node.partial || node.unassigned || group.unknown > 0) && <span className="usage-warning" title={`Breakdown chưa đầy đủ${group.unknown > 0 ? ` · ${group.unknown} lượt chưa rõ giá / token` : ""}`} aria-label="Breakdown chưa đầy đủ"><Icon name="alert" /></span>}</span>
            <span>{group.requests} req</span><RequestBadges {...group} />
            <CacheBadge tokens={group.tokens} />
            {group.duration >= 100 && <span><Icon name="clock" />{durationText(group.duration)}</span>}
          </div>)}</div>}
          <div className="usage-pills" aria-label="Skill và tool đã quan sát">
            {node.skills.filter(skill => skill.count > 0).map(skill => <span className="usage-pill" key={`skill:${skill.name}`}><Icon name="sparkles" />{skill.name} ×{skill.count}</span>)}
            {node.tools.filter(tool => tool.calls > 0).map(tool => <span className="usage-pill" key={`tool:${tool.name}`}>{tool.name} ×{tool.calls}<RequestBadges errors={tool.errors} pending={tool.running} pendingLabel="đang chạy" />{tool.duration >= 100 && <span>· {durationText(tool.duration)}</span>}</span>)}
          </div>
        </article>
      })}
    </div>
  </section>
}
