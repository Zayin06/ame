import { useEffect, useRef, useState } from 'react'
import { resolveWorkspaceFilePath } from '../workspace-paths'

export type ToolCallView = {
  name: string
  status: 'streaming' | 'running' | 'completed' | 'error'
  target?: string
  input?: unknown
  output?: string
  error?: string
  durationMs?: number
}

const shellTools = new Set(['bash', 'shell', 'run_command', 'terminal'])
const readTools = new Set(['read', 'read_file', 'view_file'])
const writeTools = new Set(['write', 'write_file', 'edit', 'edit_file', 'patch'])
const searchTools = new Set(['glob', 'grep', 'search', 'list'])
const agentTools = new Set(['task', 'subagent'])

export function summarizeToolCall(name: string, input?: unknown, metadata?: Record<string, unknown>): { label: string; target?: string; isFile?: boolean } {
  const tool = name.trim().toLowerCase()
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
  const pick = (keys: string[]) => {
    for (const source of [record, metadata]) {
      for (const key of keys) {
        const value = source?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return typeof input === 'string' && input.trim() ? input.trim() : undefined
  }
  if (shellTools.has(tool)) return { label: 'Chạy lệnh', target: pick(['command', 'cmd']), isFile: false }
  if (readTools.has(tool) || writeTools.has(tool)) return { label: readTools.has(tool) ? 'Đọc tệp' : 'Sửa tệp', target: pick(['filePath', 'file_path', 'path']), isFile: true }
  if (searchTools.has(tool)) return { label: tool === 'list' ? 'Liệt kê' : 'Tìm kiếm', target: pick(['pattern', 'query', 'path']), isFile: false }
  if (agentTools.has(tool)) return { label: 'Tác vụ', target: pick(['description', 'role']), isFile: false }
  return { label: name.trim() || 'Công cụ', target: pick(['description', 'target']), isFile: false }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [feedback, setFeedback] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++; clearTimeout(timer.current) }, [])
  useEffect(() => {
    generation.current++
    clearTimeout(timer.current)
    setFeedback('')
  }, [text])
  const copy = async () => {
    const current = ++generation.current
    clearTimeout(timer.current)
    let result = 'Đã sao chép'
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
    } catch { result = 'Không thể sao chép' }
    if (generation.current !== current) return
    setFeedback(result)
    timer.current = setTimeout(() => setFeedback(''), 1500)
  }
  return <button type="button" className="chat-copy" aria-label={label} onClick={() => void copy()}><span role="status">{feedback || 'Copy'}</span></button>
}

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) ?? String(input) } catch { return '[Không thể hiển thị input JSON]' }
}

const statusLabels: Record<ToolCallView['status'], string> = {
  streaming: 'Đang chuẩn bị…', running: 'Đang chạy…', completed: 'Hoàn tất', error: 'Lỗi',
}

export function ToolCard({ call, onOpenFile, projectDirectory }: { call: ToolCallView; onOpenFile?: (path: string, line?: number) => void; projectDirectory?: string }) {
  const summary = summarizeToolCall(call.name, call.input)
  const target = call.target || summary.target
  const tool = call.name.trim().toLowerCase()
  const icon = shellTools.has(tool) ? '>_' : summary.isFile ? '▤' : searchTools.has(tool) ? '⌕' : agentTools.has(tool) ? '◇' : '⚙'
  const file = summary.isFile && target ? resolveWorkspaceFilePath(target, projectDirectory) : null
  return <section className="tool-card tool-card--rich" aria-label={`${summary.label}: ${statusLabels[call.status]}`}>
    <div className="tool-card__header">
      <div className="tool-card__left">
        <span className="tool-card__icon" aria-hidden="true">{icon}</span>
        <span className="tool-card__label">{summary.label}</span>
        {target && <span className="tool-card__target" title={target}>{file?.path ?? target}</span>}
      </div>
      <div className="tool-card__actions">
        <span className={`tool-status tool-status--${call.status}`}>{statusLabels[call.status]}</span>
        {call.durationMs !== undefined && Number.isFinite(call.durationMs) && call.durationMs >= 0 && <span className="tool-card__duration">{call.durationMs < 1000 ? `${Math.round(call.durationMs)} ms` : `${(call.durationMs / 1000).toFixed(1)} s`}</span>}
        {file !== null && onOpenFile && <button type="button" className="file-chip" onClick={() => onOpenFile(file.path, file.line)}>Mở tệp</button>}
      </div>
    </div>
    <details className="tool-card-details">
      <summary>Chi tiết công cụ</summary>
      {call.input !== undefined && <section className="tool-card__panel"><h4>Input</h4><pre>{formatInput(call.input)}</pre></section>}
      {call.output !== undefined && <section className="tool-card__panel"><div className="tool-card__panel-header"><h4>Output</h4><CopyButton text={call.output} label="Sao chép output công cụ" /></div><pre>{call.output}</pre></section>}
      {call.error !== undefined && <section className="tool-card__panel tool-card__panel--error"><div className="tool-card__panel-header"><h4>Error</h4><CopyButton text={call.error} label="Sao chép lỗi công cụ" /></div><pre>{call.error}</pre></section>}
    </details>
  </section>
}
