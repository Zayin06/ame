import { useId, useState } from 'react'
import type { ChatItem } from '../../../../../packages/protocol/src/index'
import { classifyTool, formatAgentDuration, groupExpandedWork, toolTarget, type WorkSummary } from '../chat-timeline'
import { resolveWorkspaceFilePath } from '../workspace-paths'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'
import { CopyButton, summarizeToolCall } from './ToolCard'

type WorkActions = {
  projectDirectory?: string
  onOpenFile?: (path: string, line?: number) => void
  onOpenAgentMap?: () => void
}

function FileChip({ target, projectDirectory, onOpenFile }: WorkActions & { target?: string }) {
  const file = target ? resolveWorkspaceFilePath(target, projectDirectory) : null
  return file && onOpenFile ? <button type="button" className="file-chip" title={`Mở tệp: ${target}`} aria-label={`Mở tệp ${target}`} onClick={() => onOpenFile(file.path, file.line)}>{file.path.split('/').pop()}</button> : null
}

function inputText(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return '[Không thể hiển thị input JSON]' }
}

function ToolPanels({ item }: { item: ChatItem }) {
  const call = item.tool
  const panels = [
    { label: 'Input', text: call?.input !== undefined ? inputText(call.input) : undefined },
    { label: 'Output', text: call?.output ?? (!call ? item.text : undefined) },
    { label: 'Error', text: call?.error },
  ]
  return <div className="work-row__panels">{panels.filter(panel => panel.text !== undefined).map(panel => <section key={panel.label} className={`work-row__panel work-row__panel--${panel.label.toLowerCase()}`}><header><span>{panel.label}</span><CopyButton text={panel.text!} label={`Sao chép ${panel.label} công cụ`} /></header><pre>{panel.text}</pre></section>)}</div>
}

function CompactToolRow({ item, ...actions }: WorkActions & { item: ChatItem }) {
  const call = item.tool
  const classification = classifyTool(call?.name ?? '')
  const summary = summarizeToolCall(call?.name ?? 'Công cụ', call?.input)
  const target = toolTarget(item)
  const isFile = classification.kind === 'read' || classification.kind === 'edit'
  const hasFileChip = isFile && !!actions.onOpenFile && !!target && !!resolveWorkspaceFilePath(target, actions.projectDirectory)
  const icon = classification.kind === 'run' ? 'terminal' : classification.kind === 'search' ? 'search' : classification.kind === 'subagent' ? 'agents' : isFile ? 'file' : 'sparkles'
  const status = call?.status ?? 'completed'
  const duration = call?.durationMs
  const durationLabel = duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration < 1000 ? formatAgentDuration(duration) : `${Number((duration / 1000).toFixed(1))}s` : ''
  return <div className={`work-row work-row--tool work-row--${status}`}>
    <div className="work-row__line">
      <details className="work-row-details work-row__tool-details"><summary><Icon name={icon} /><span className="work-row__main"><span className="work-row__label">{summary.label}</span>{target && !hasFileChip && <span className="work-row__target" title={target}>{target}</span>}</span>{status === 'completed' ? durationLabel && <span className="work-row__duration">{durationLabel}</span> : <span className={`turn-work__pill ${status === 'error' ? 'turn-work__pill--error' : ''}`}>{status === 'error' ? 'Lỗi' : 'Đang chạy'}{durationLabel && ` · ${durationLabel}`}</span>}</summary><ToolPanels item={item} /></details>
      <div className="work-row__actions">{isFile && <FileChip target={target} {...actions} />}{classification.kind === 'subagent' && actions.onOpenAgentMap && <button type="button" className="file-chip" onClick={actions.onOpenAgentMap}>Agent map</button>}</div>
    </div>
    {status === 'error' && call?.error && <div className="work-row__error" title={call.error}>{call.error.split(/\r?\n/)[0]}</div>}
  </div>
}

export function TurnWorkGroup({ id, items, summary, live, defaultOpen = false, ...actions }: WorkActions & {
  id: string
  items: readonly ChatItem[]
  summary: WorkSummary
  live?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const listID = useId()
  return <section className="turn-work" data-work-id={id} data-live={live || undefined}>
    <button type="button" className="turn-work__trigger" title={`${summary.label}${summary.subagentCount ? ` · ${summary.subagentCount} subagent` : ''}${summary.errorCount ? ` · ${summary.errorCount} lỗi` : ''}`} aria-expanded={open} aria-controls={listID} data-testid="turn-work-toggle" onClick={() => setOpen(value => !value)}><Icon name="chevron" /><span className="turn-work__summary" title={summary.label}>{summary.label}</span>{summary.errorCount > 0 && <span className="turn-work__pill turn-work__pill--error">{summary.errorCount} lỗi</span>}{summary.subagentCount > 0 && <span className="turn-work__pill">{summary.subagentCount} subagent</span>}</button>
    {open && <div className="turn-work__list" id={listID}>{groupExpandedWork(items).map(row => {
      if (row.kind === 'tool') return <CompactToolRow key={row.id} item={row.item} {...actions} />
      if (row.kind === 'reasoning') return <details key={row.id} className="work-row work-row-details"><summary>Suy nghĩ</summary><MessageContent text={row.item.text} onOpenFile={actions.onOpenFile} /></details>
      if (row.kind === 'note') return <div key={row.id} className="work-row work-row--note"><MessageContent text={row.item.text} onOpenFile={actions.onOpenFile} /></div>
      if (row.kind !== 'read-group') return null
      const textTargets = row.targets.filter(target => !actions.onOpenFile || !resolveWorkspaceFilePath(target, actions.projectDirectory))
      const names = textTargets.map(target => target.split(/[\\/]/).pop()).join(', ')
      return <div key={row.id} className="work-row work-row--read-group"><div className="work-row__line"><details className="work-row-details work-row__tool-details"><summary><Icon name="file" /><span className="work-row__read-label" title={textTargets.join(', ')}>Đã đọc{names ? ` ${names}` : !row.targets.length ? ` ${row.items.length} tệp` : ''}</span></summary>{row.items.map(item => <CompactToolRow key={item.id} item={item} {...actions} />)}</details><div className="work-row__actions">{row.targets.map(target => <FileChip key={target} target={target} {...actions} />)}</div></div></div>
    })}</div>}
  </section>
}

export function ActiveToolsView({ items, ...actions }: WorkActions & { items: readonly ChatItem[] }) {
  return <div className="turn-active-tools">{items.map(item => <CompactToolRow key={item.id} item={item} {...actions} />)}</div>
}

export function LiveTurnStatus({ label }: { label: string }) {
  return <div className="turn-live-status" role="status"><span className="turn-live-status__dot" aria-hidden="true" /><span>{label}</span></div>
}
