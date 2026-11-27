import { useEffect, useRef, useState } from 'react'
import type { AgentMapNode, AgentMapSkill, AgentMapView } from '../../../../../packages/protocol/src/index'
import { agentStatusInfo, buildAgentMapTree, formatAgentDuration, formatAgentTokens, type AgentMapTreeNode } from '../agent-map-model'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'
import { errorText, IconButton } from './Primitives'
import { CopyButton } from './ToolCard'

export type AgentMapProps = {
  projectID: string
  sessionID: string
  connected: boolean
  initialView?: AgentMapView
  initialSelectedID?: string
  onSelectSession: (id: string) => void
  onOpenFile?: (path: string, line?: number) => void
  onClose: () => void
}

function Skills({ skills, compact = false }: { skills: AgentMapSkill[]; compact?: boolean }) {
  return <span className="agent-map-skill-list">{(compact ? skills.slice(0, 3) : skills).map(skill => <span className="agent-map-skill" key={skill.name}>/{skill.name}{skill.count > 1 ? ` ×${skill.count}` : ''}</span>)}{compact && skills.length > 3 && <span className="agent-map-skill">+{skills.length - 3}</span>}</span>
}

function Branch({ branch, sessionID, collapsed, onToggle, onSelect }: { branch: AgentMapTreeNode; sessionID: string; collapsed: ReadonlySet<string>; onToggle: (id: string) => void; onSelect: (id: string) => void }) {
  const { node, children } = branch, status = agentStatusInfo(node)
  const duration = formatAgentDuration(node.durationMs), tokens = `${formatAgentTokens(node.tokens.total)} tokens`
  const meta = (node.depth === 0 ? [node.model || node.agent, tokens, duration] : [duration, tokens, node.agent]).filter(Boolean).join(' · ')
  return <div className="agent-map-branch">
    <div className="agent-map-node-shell">
      <button type="button" className={`agent-map-card${node.id === sessionID ? ' is-active' : ''}`} data-agent-node-id={node.id} data-depth={node.depth} data-status={status.tone} onClick={() => onSelect(node.id)}>
        <span className="agent-map-card__top"><span className={`agent-map-dot agent-map-dot--${status.tone}`} aria-label={status.label} /><strong className="truncate" title={node.title}>{node.title}</strong>{node.id === sessionID && <span className="agent-map-current">Đang xem</span>}</span>
        <span className="agent-map-card__meta">{meta}</span>
        {node.skills.length > 0 && <Skills skills={node.skills} compact />}
      </button>
      {children.length > 0 && <button type="button" className="agent-map-collapse" aria-label={`${collapsed.has(node.id) ? 'Mở rộng' : 'Thu gọn'} ${node.title}`} aria-expanded={!collapsed.has(node.id)} onClick={() => onToggle(node.id)}><Icon name={collapsed.has(node.id) ? 'plus' : 'minus'} /></button>}
    </div>
    {!collapsed.has(node.id) && children.length > 0 && <div className="agent-map-children">{children.map(child => <div className="agent-map-child" key={child.node.id}><Branch branch={child} sessionID={sessionID} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} /></div>)}</div>}
  </div>
}

export function AgentMap({ projectID, sessionID, connected, initialView, initialSelectedID, onSelectSession, onOpenFile, onClose }: AgentMapProps) {
  const [view, setView] = useState(initialView)
  const [selectedID, setSelectedID] = useState<string | null>(initialSelectedID ?? null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [loading, setLoading] = useState(!initialView && connected)
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const refresh = useRef<() => void>(() => {})
  const scope = useRef(0)
  const context = JSON.stringify([projectID, sessionID, connected])
  const currentContext = useRef(context); currentContext.current = context
  const dialog = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  const selectedRef = useRef(selectedID); selectedRef.current = selectedID
  const { roots, byID, summary } = buildAgentMapTree(view ?? { rootID: sessionID, activeSessionID: sessionID, nodes: [], limited: false, fetchedAt: 0 })
  const selected = selectedID ? byID.get(selectedID) : undefined
  const runningRef = useRef(summary.runningCount > 0); runningRef.current = summary.runningCount > 0

  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (selectedRef.current) setSelectedID(null)
        else closeRef.current()
      }
      if (event.key !== 'Tab') return
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,[tabindex="0"]') ?? []).filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (!items.length) { event.preventDefault(); dialog.current?.focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown, { capture: true })
    return () => { window.removeEventListener('keydown', keydown, { capture: true }); if (prior?.isConnected) prior.focus() }
  }, [])
  useEffect(() => { dialog.current?.focus() }, [selectedID])

  useEffect(() => {
    const generation = ++scope.current
    let alive = true, inFlight = false, queued = false
    const isCurrent = () => alive && scope.current === generation && currentContext.current === context
    let debounce: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setTimeout> | undefined
    setView(initialView); setSelectedID(initialSelectedID ?? null); setCollapsed(new Set()); setError(''); setCancelling(false)
    if (!connected || !projectID || !sessionID || typeof window === 'undefined') { setLoading(false); return () => { scope.current++ } }
    const load = async () => {
      if (!isCurrent()) return
      if (inFlight) { queued = true; return }
      inFlight = true
      clearTimeout(debounce); clearTimeout(poll)
      setLoading(true)
      let running = false
      try {
        const next = await window.ame.agentMap(projectID, sessionID)
        if (!isCurrent()) return
        running = next.nodes.some(node => node.status === 'running')
        setView(next); setError('')
      } catch (cause) {
        if (isCurrent()) setError(errorText(cause))
        running = runningRef.current
      } finally {
        inFlight = false
        if (isCurrent()) {
          setLoading(false)
          if (queued) { queued = false; debounce = setTimeout(() => void load(), 250) }
          else if (running) poll = setTimeout(() => void load(), 2500)
        }
      }
    }
    const request = () => { if (!isCurrent()) return; clearTimeout(debounce); debounce = setTimeout(() => void load(), 250) }
    refresh.current = () => { void load() }
    const unsubscribe = window.ame.onEvent(event => { if (event.type === 'opencode' && event.kind !== 'stream' && event.projectID === projectID) request() })
    void load()
    return () => { alive = false; scope.current++; clearTimeout(debounce); clearTimeout(poll); unsubscribe(); refresh.current = () => {} }
  }, [projectID, sessionID, connected, initialView, initialSelectedID])
  const toggle = (id: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const cancelNode = async (node: AgentMapNode) => {
    const generation = scope.current
    const isCurrent = () => scope.current === generation && currentContext.current === context
    setCancelling(true)
    try { await window.ame.cancel(projectID, node.id); if (isCurrent()) refresh.current() }
    catch (cause) { if (isCurrent()) setError(errorText(cause)) }
    finally { if (isCurrent()) setCancelling(false) }
  }
  const status = selected ? agentStatusInfo(selected) : undefined
  const parent = selected?.parentID ? byID.get(selected.parentID) : undefined
  return <div className="agent-map-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className={`agent-map-dialog${selected && status ? ' agent-map-dialog--detail' : ''}`} role="dialog" aria-modal="true" aria-label="Agent map" aria-busy={loading} tabIndex={-1}>
      {selected && status ? <>
        <header className="agent-map-detail__header">
          <IconButton label="Quay lại Agent map" onClick={() => setSelectedID(null)}><Icon name="arrowLeft" /></IconButton>
          <span className={`agent-map-dot agent-map-dot--${status.tone}`} aria-hidden="true" />
          <h2 className="agent-map-detail__title truncate">{selected.title}</h2>
          <div className="agent-map__actions">
            {selected.status === 'running' && <button type="button" className="agent-map-action agent-map-action--danger" disabled={!connected || cancelling} onClick={() => void cancelNode(selected)}>{cancelling ? 'Đang dừng…' : 'Dừng'}</button>}
            <button type="button" className="agent-map-action" disabled={selected.id === sessionID} onClick={() => onSelectSession(selected.id)}>{selected.id === sessionID ? 'Đang mở' : 'Mở phiên'}</button>
            <IconButton label="Đóng Agent map" onClick={onClose}><Icon name="close" /></IconButton>
          </div>
        </header>
        {error && <div className="agent-map-notice" role="alert">{error}<button type="button" className="agent-map-link" onClick={() => refresh.current()}>Thử lại</button></div>}
        <div className="agent-map-detail__body">
          <div className="agent-map-detail__meta">
            <p>{status.label} · {selected.agent} · {selected.model || 'Mặc định'} · {selected.depth === 0 ? 'main agent' : `subagent L${selected.depth}`}</p>
            <p>{parent ? <>Được gọi bởi <button type="button" className="agent-map-link" onClick={() => setSelectedID(parent.id)}>{parent.title}</button></> : selected.depth === 0 ? 'Tác nhân gốc (Main agent)' : `Được gọi bởi ${selected.spawnedByTitle || 'tác nhân cha'}`}</p>
            <p>{[formatAgentDuration(selected.durationMs), `${formatAgentTokens(selected.tokens.total)} tokens`].filter(Boolean).join(' · ')}</p>
            <p className="muted">In {formatAgentTokens(selected.tokens.input)} · Out {formatAgentTokens(selected.tokens.output)} · Reasoning {formatAgentTokens(selected.tokens.reasoning)} · Cache {formatAgentTokens(selected.tokens.cacheRead + selected.tokens.cacheWrite)}</p>
            {selected.childIDs.length > 0 && <div className="agent-map-child-links">Đã gọi subagent: {selected.childIDs.map(id => byID.get(id)).filter((node): node is AgentMapNode => !!node).map(child => <button type="button" className="agent-map-child-link" key={child.id} onClick={() => setSelectedID(child.id)}>{child.title}</button>)}</div>}
          </div>
          {!selected.historyComplete && <p className="muted">Lịch sử chưa đầy đủ; chỉ hiển thị các tin nhắn đã tải.</p>}
          <section className="agent-map-section"><h3>Skills đã gọi</h3>{selected.skills.length ? <Skills skills={selected.skills} /> : <p className="muted">Không gọi skill nào</p>}</section>
          <section className="agent-map-section">
            <div className="agent-map-section__heading"><h3>Prompt đầu vào</h3>{selected.prompt && <CopyButton text={selected.prompt} label="Sao chép prompt" />}</div>
            <pre className="agent-map-prompt">{selected.prompt || 'Chưa ghi nhận prompt đầu vào.'}</pre>
            {selected.latestPrompt && <details className="agent-map-subdetails"><summary>Prompt gần nhất ({selected.promptCount} lượt)</summary><pre className="agent-map-prompt">{selected.latestPrompt}</pre></details>}
          </section>
          <section className="agent-map-section">
            <div className="agent-map-section__heading"><h3>Kết quả đầu ra</h3>{selected.output && <CopyButton text={selected.output} label="Sao chép kết quả" />}</div>
            {selected.error && <div className="agent-map-error-box" role="alert">{selected.error}</div>}
            {selected.output ? <div className="agent-map-output"><MessageContent text={selected.output} onOpenFile={onOpenFile} /></div> : selected.status === 'running' ? <p className="muted">Đang xử lý và tạo kết quả…</p> : !selected.error && <p className="muted">Chưa có phản hồi text từ agent này.</p>}
          </section>
          {selected.tools.length > 0 && <details className="agent-map-subdetails"><summary>Công cụ đã dùng ({selected.tools.length})</summary><div className="agent-map-tool-list">{selected.tools.map(tool => <span className="agent-map-tool" key={tool.name}><strong>{tool.name}</strong> ×{tool.calls} · {tool.errors} lỗi · {tool.running} đang chạy{formatAgentDuration(tool.durationMs) && ` · ${formatAgentDuration(tool.durationMs)}`}</span>)}</div></details>}
        </div>
      </> : <>
        <header className="agent-map__header"><div><h2>Agent map</h2><p className="agent-map__subtitle">{summary.subagentCount > 0 ? `${summary.subagentCount} subagent · nhấp vào agent để xem chi tiết` : 'Chưa có subagent · nhấp vào agent để xem chi tiết'}{summary.runningCount > 0 && ` · ${summary.runningCount} đang chạy`}{view?.limited && ' · Hiển thị tối đa 200 tác nhân'}</p></div><div className="agent-map__actions"><IconButton label="Làm mới Agent map" disabled={!connected || loading} onClick={() => refresh.current()}><Icon name="refresh" /></IconButton><IconButton label="Đóng Agent map" onClick={onClose}><Icon name="close" /></IconButton></div></header>
        {loading && !view && <p className="agent-map-notice" role="status">Đang tải Agent map…</p>}
        {(error || !connected && !view) && <div className="agent-map-notice" role="alert">{error || 'Chưa kết nối máy chủ OpenCode.'}<button type="button" className="agent-map-link" disabled={!connected} onClick={() => refresh.current()}>Thử lại</button></div>}
        <div className="agent-map__canvas">{roots.map(branch => <Branch key={branch.node.id} branch={branch} sessionID={sessionID} collapsed={collapsed} onToggle={toggle} onSelect={setSelectedID} />)}{!roots.length && !loading && <p className="muted">Chưa có dữ liệu Agent map.</p>}</div>
      </>}
    </div>
  </div>
}
