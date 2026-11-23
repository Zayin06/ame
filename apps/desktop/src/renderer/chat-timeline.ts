import type { ChatItem } from '../../../../packages/protocol/src/index'
import type { TimelineDetailMode } from './state'

export type ToolClassification = {
  mode: 'explore' | 'edit' | 'run' | 'subagent' | 'tool'
  kind: 'read' | 'search' | 'skill' | 'edit' | 'run' | 'subagent' | 'other'
  hidden?: boolean
}

export type WorkSummary = {
  label: string
  stepCount: number
  errorCount: number
  subagentCount: number
  durationLabel: string
}

export type ExpandedWorkRow =
  | { kind: 'read-group'; id: string; items: ChatItem[]; targets: string[] }
  | { kind: 'tool'; id: string; item: ChatItem; classification: ToolClassification }
  | { kind: 'reasoning' | 'note'; id: string; item: ChatItem }

export type TimelineBlock =
  | { kind: 'work-group'; id: string; items: ChatItem[]; summary: WorkSummary; live?: boolean; defaultOpen?: boolean; workedMs?: number }
  | { kind: 'active-tools'; id: string; items: ChatItem[] }
  | { kind: 'text' | 'reasoning' | 'tool' | 'changes'; id: string; item: ChatItem }
  | { kind: 'live-status'; id: string; label: string }

export type ChatTurn = { id: string; user?: ChatItem; live: boolean; blocks: TimelineBlock[] }

export function classifyTool(name: string): ToolClassification {
  switch (name.trim().toLowerCase()) {
    case 'read': case 'read_file': case 'view_file': return { mode: 'explore', kind: 'read' }
    case 'glob': case 'grep': case 'search': case 'list': case 'webfetch': case 'websearch': return { mode: 'explore', kind: 'search' }
    case 'skill': return { mode: 'explore', kind: 'skill' }
    case 'edit': case 'edit_file': case 'write': case 'write_file': case 'patch': case 'apply_patch': return { mode: 'edit', kind: 'edit' }
    case 'shell': case 'bash': case 'execute': case 'run_command': case 'terminal': return { mode: 'run', kind: 'run' }
    case 'subagent': case 'task': return { mode: 'subagent', kind: 'subagent' }
    case 'todowrite': return { mode: 'tool', kind: 'other', hidden: true }
    default: return { mode: 'tool', kind: 'other' }
  }
}

export function toolTarget(item: ChatItem): string | undefined {
  if (typeof item.tool?.target === 'string' && item.tool.target.trim()) return item.tool.target
  const input = item.tool?.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  for (const key of ['filePath', 'file_path', 'path', 'command', 'cmd', 'pattern', 'query', 'description', 'target']) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export function formatAgentDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return ''
  if (durationMs < 1000) return '<1s'
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

function isText(item: ChatItem): boolean {
  return item.kind !== 'tool' && item.kind !== 'reasoning' && item.kind !== 'changes' && !!item.text.trim()
}

function isVisible(item: ChatItem): boolean {
  return item.kind !== 'tool' || !classifyTool(item.tool?.name ?? '').hidden
}

export function summarizeWorkItems(items: readonly ChatItem[], durationMs?: number): WorkSummary {
  const targets = { read: new Set<string>(), edit: new Set<string>() }
  const counts = { read: 0, edit: 0, search: 0, skill: 0, run: 0, subagent: 0, other: 0 }
  let reasoningCount = 0, noteCount = 0, stepCount = 0, errorCount = 0
  for (const item of items) {
    if (item.kind === 'tool') {
      const classification = classifyTool(item.tool?.name ?? '')
      if (classification.hidden) continue
      stepCount++
      if (item.tool?.status === 'error') errorCount++
      const kind = classification.kind
      if (kind === 'read' || kind === 'edit') {
        const target = toolTarget(item)
        if (target) {
          if (!targets[kind].has(target)) counts[kind]++
          targets[kind].add(target)
        } else counts[kind]++
      } else counts[kind]++
    } else if (item.kind === 'reasoning') {
      reasoningCount++
      stepCount++
    } else if (isText(item)) {
      noteCount++
      stepCount++
    }
  }
  const durationLabel = formatAgentDuration(durationMs)
  let primary: keyof typeof counts | undefined
  let label: string
  if (counts.edit) { primary = 'edit'; label = `Đã sửa ${counts.edit} tệp` }
  else if (counts.run) { primary = 'run'; label = `Đã chạy ${counts.run} lệnh` }
  else if (counts.subagent) { primary = 'subagent'; label = `Đã chạy ${counts.subagent} tác vụ con` }
  else if (counts.read) { primary = 'read'; label = `Đã đọc ${counts.read} tệp` }
  else if (counts.search) { primary = 'search'; label = `Đã tìm kiếm ${counts.search} lần` }
  else if (counts.skill) { primary = 'skill'; label = `Đã nạp ${counts.skill} skill` }
  else if (counts.other) { primary = 'other'; label = `Đã dùng ${counts.other} công cụ` }
  else label = durationLabel ? `Đã ${noteCount ? 'xử lý' : 'suy nghĩ'}` : `Đã ${noteCount ? 'xử lý' : 'suy nghĩ'} ${noteCount ? reasoningCount + noteCount : reasoningCount || 1} bước`
  if (durationLabel) label += ` trong ${durationLabel}`
  const secondary: [keyof typeof counts, string][] = [
    ['read', `đọc ${counts.read} tệp`], ['search', `tìm ${counts.search} lần`],
    ['run', `chạy ${counts.run} lệnh`], ['skill', `nạp ${counts.skill} skill`],
  ]
  const details = secondary.filter(([kind]) => counts[kind] && kind !== primary).map(([, clause]) => clause)
  if (details.length) label += ` · ${details.join(', ')}`
  return { label, stepCount, errorCount, subagentCount: counts.subagent, durationLabel }
}

export function groupExpandedWork(items: readonly ChatItem[]): ExpandedWorkRow[] {
  const rows: ExpandedWorkRow[] = []
  for (const item of items) {
    if (item.kind === 'tool') {
      const classification = classifyTool(item.tool?.name ?? '')
      if (classification.hidden) continue
      if (classification.kind === 'read' && item.tool?.status !== 'error') {
        const previous = rows.at(-1)
        const row = previous?.kind === 'read-group' ? previous : undefined
        const target = toolTarget(item)
        if (row) {
          row.items.push(item)
          if (target && !row.targets.includes(target)) row.targets.push(target)
        } else rows.push({ kind: 'read-group', id: item.id, items: [item], targets: target ? [target] : [] })
      } else rows.push({ kind: 'tool', id: item.id, item, classification })
    } else if (item.kind === 'reasoning') rows.push({ kind: 'reasoning', id: item.id, item })
    else if (isText(item)) rows.push({ kind: 'note', id: item.id, item })
  }
  return rows
}

function lastIndexWhere(items: readonly ChatItem[], predicate: (item: ChatItem) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index
  return -1
}

function workedDuration(user: ChatItem | undefined, items: readonly ChatItem[]): number | undefined {
  const explicit = items[lastIndexWhere(items, item => item.workedMs !== undefined)]?.workedMs
  if (explicit !== undefined) return explicit
  const last = items.at(-1)
  const end = last?.completedAt ?? last?.createdAt
  if (user?.createdAt !== undefined && end !== undefined && end >= user.createdAt) return end - user.createdAt
  const starts = items.flatMap(item => item.createdAt !== undefined && Number.isFinite(item.createdAt) ? [item.createdAt] : [])
  const ends = items.flatMap(item => {
    const value = item.completedAt ?? item.createdAt
    return value !== undefined && Number.isFinite(value) ? [value] : []
  })
  const elapsed = Math.max(...ends) - Math.min(...starts)
  if (starts.length && ends.length && elapsed > 0) return elapsed
  const toolMs = items.reduce((sum, item) => {
    const duration = item.tool?.durationMs
    return sum + (duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : 0)
  }, 0)
  return toolMs > 0 ? toolMs : undefined
}

function activeTool(item: ChatItem): boolean {
  return item.kind === 'tool' && (item.tool?.status === 'running' || item.tool?.status === 'streaming' || item.tool?.status === 'error')
}

function liveStatusLabel(items: readonly ChatItem[]): string {
  const active = items[lastIndexWhere(items, item => item.kind === 'tool' && (item.tool?.status === 'running' || item.tool?.status === 'streaming'))]
  if (active) {
    const kind = classifyTool(active.tool?.name ?? '').kind
    const verb = { read: 'Đang đọc', search: 'Đang tìm kiếm', skill: 'Đang nạp skill', edit: 'Đang sửa', run: 'Đang chạy', subagent: 'Đang chạy tác vụ con', other: 'Đang dùng công cụ' }[kind]
    const target = toolTarget(active)
    return `${verb}${target ? ` ${target}` : ''}…`
  }
  return items[lastIndexWhere(items, item => item.kind !== 'changes')]?.kind === 'reasoning' ? 'Đang suy nghĩ…' : 'Đang xử lý…'
}

export function projectChatTimeline(items: readonly ChatItem[], options: { running: boolean; mode: TimelineDetailMode }): ChatTurn[] {
  const turns: { id: string; user?: ChatItem; items: ChatItem[] }[] = []
  for (const item of items) {
    if (item.role === 'user') turns.push({ id: item.id, user: item, items: [] })
    else {
      if (!turns.length) turns.push({ id: item.id, items: [] })
      turns[turns.length - 1].items.push(item)
    }
  }
  return turns.map((turn, turnIndex) => {
    const assistantItems = turn.items
    const visible = assistantItems.filter(isVisible)
    const live = turnIndex === turns.length - 1 && (options.running || assistantItems.some(item => item.tool?.status === 'running' || item.tool?.status === 'streaming'))
    const workedMs = workedDuration(turn.user, assistantItems)
    const lastWorkIndex = lastIndexWhere(visible, item => item.kind === 'tool' || item.kind === 'reasoning')
    const commentary = new Set(visible.filter((item, index) => isText(item) && (item.phase === 'commentary' || item.phase !== 'final_answer' && index < lastWorkIndex)))
    if (!live && !visible.some(item => isText(item) && !commentary.has(item))) {
      const fallback = visible[lastIndexWhere(visible, isText)]
      if (fallback) commentary.delete(fallback)
    }
    const blocks: TimelineBlock[] = []
    const workGroup = (work: ChatItem[], id: string, groupLive: boolean, includeDuration = false) => {
      if (work.length) blocks.push({
        kind: 'work-group', id, items: work, summary: summarizeWorkItems(work, includeDuration ? workedMs : undefined),
        live: groupLive, defaultOpen: false, ...(includeDuration && workedMs !== undefined ? { workedMs } : {}),
      })
    }
    const individual = (item: ChatItem) => {
      if (item.kind === 'changes') {
        if (item.turn) blocks.push({ kind: 'changes', id: item.id, item })
      } else if (item.kind === 'tool' || item.kind === 'reasoning') blocks.push({ kind: item.kind, id: item.id, item })
      else if (isText(item) || options.mode !== 'compact') blocks.push({ kind: 'text', id: item.id, item })
    }
    if (options.mode === 'everything') visible.forEach(individual)
    else if (options.mode === 'detailed') {
      let work: ChatItem[] = []
      const flush = () => {
        workGroup(work, `${turn.id}:work:${work[0]?.id}`, live)
        work = []
      }
      for (const item of visible) {
        if (item.kind === 'tool' || item.kind === 'reasoning') work.push(item)
        else { flush(); individual(item) }
      }
      flush()
    } else if (!live) {
      workGroup(visible.filter(item => item.kind === 'tool' || item.kind === 'reasoning' || commentary.has(item)), `${turn.id}:work`, false, true)
      visible.filter(item => isText(item) && !commentary.has(item)).forEach(individual)
      const changes = visible[lastIndexWhere(visible, item => item.kind === 'changes' && !!item.turn)]
      if (changes) individual(changes)
    } else {
      const tail = lastIndexWhere(visible, item => item.kind === 'tool' || item.kind === 'reasoning' || isText(item))
      const firstActive = visible.findIndex(activeTool)
      const prior: ChatItem[] = []
      const inline: ChatItem[] = []
      visible.forEach((item, index) => {
        const completed = item.kind === 'tool' && item.tool?.status === 'completed' && (firstActive < 0 || index < firstActive)
        const beforeActive = firstActive < 0 || index < firstActive
        const earlierReasoning = item.kind === 'reasoning' && index !== tail && beforeActive
        const earlierCommentary = commentary.has(item) && index < lastWorkIndex && beforeActive
        if (completed || earlierReasoning || earlierCommentary) prior.push(item)
        else inline.push(item)
      })
      workGroup(prior, `${turn.id}:work-live`, true)
      for (const item of inline) {
        if (activeTool(item)) {
          const previous = blocks.at(-1)
          if (previous?.kind === 'active-tools') previous.items.push(item)
          else blocks.push({ kind: 'active-tools', id: `${item.id}:active`, items: [item] })
        } else individual(item)
      }
    }
    if (live) blocks.push({ kind: 'live-status', id: `${turn.id}:status`, label: liveStatusLabel(visible) })
    return { id: turn.id, ...(turn.user ? { user: turn.user } : {}), live, blocks }
  })
}
