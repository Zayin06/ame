import type { ChatItem, TodoItem, TodoStatus } from '../../../../packages/protocol/src/index'

export type ExecutionTodoSnapshot = {
  executionID: string
  anchorTurnID: string
  todos: TodoItem[]
  completedCount: number
  inProgressCount: number
  pendingCount: number
  cancelledCount: number
  totalCount: number
  active: boolean
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  workedMs?: number
}

const statuses: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function extractValidTodos(item: ChatItem): TodoItem[] | undefined {
  if (item.kind !== 'tool' || item.tool?.name?.trim().toLowerCase() !== 'todowrite' || item.tool.status !== 'completed') return undefined
  const candidate: unknown = item.todos !== undefined ? item.todos : isPlainObject(item.tool.input) ? item.tool.input.todos : undefined
  if (!Array.isArray(candidate)) return undefined
  const todos: TodoItem[] = []
  for (const value of candidate) {
    if (!isPlainObject(value) || typeof value.content !== 'string' || !value.content.trim() || !statuses.includes(value.status as TodoStatus)) return undefined
    todos.push({ content: value.content.trim(), status: value.status as TodoStatus })
  }
  return todos
}

function executionWorkedMs(items: readonly ChatItem[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const value = items[index].workedMs
    if (value !== undefined && Number.isFinite(value) && value >= 0) return value
  }
  const user = items.find(item => item.role === 'user')
  const last = items.at(-1)
  const end = last?.completedAt ?? last?.createdAt
  if (user?.createdAt !== undefined && Number.isFinite(user.createdAt) && end !== undefined && Number.isFinite(end) && end >= user.createdAt) return end - user.createdAt
  const starts = items.flatMap(item => item.createdAt !== undefined && Number.isFinite(item.createdAt) ? [item.createdAt] : [])
  const ends = items.flatMap(item => {
    const value = item.completedAt ?? item.createdAt
    return value !== undefined && Number.isFinite(value) ? [value] : []
  })
  const elapsed = Math.max(...ends) - Math.min(...starts)
  return starts.length && ends.length && elapsed > 0 ? elapsed : undefined
}

export function projectSessionTodos(messages: readonly ChatItem[], options: { running: boolean; sessionOutcome?: 'succeeded' | 'failed' | 'interrupted'; isChildSession?: boolean }): { composer?: ExecutionTodoSnapshot; byTurnID: Record<string, ExecutionTodoSnapshot> } {
  if (options.isChildSession) return { byTurnID: {} }
  const groups: { executionID: string; items: ChatItem[] }[] = []
  const executions = new Map<string, typeof groups[number]>()
  let current: typeof groups[number] | undefined
  for (const item of messages) {
    if (item.executionID !== undefined) {
      current = executions.get(item.executionID)
      if (!current) {
        current = { executionID: item.executionID, items: [] }
        executions.set(item.executionID, current)
        groups.push(current)
      }
    } else if (!current || item.role === 'user') {
      current = { executionID: `legacy:${item.id}`, items: [] }
      groups.push(current)
    }
    current.items.push(item)
  }
  const byTurnID: Record<string, ExecutionTodoSnapshot> = {}
  let composer: ExecutionTodoSnapshot | undefined
  groups.forEach((group, index) => {
    let latestTodos: TodoItem[] | undefined
    let outcome: ExecutionTodoSnapshot['outcome']
    for (const item of group.items) {
      const todos = extractValidTodos(item)
      if (todos !== undefined) latestTodos = todos
      if (item.executionOutcome !== undefined) outcome = item.executionOutcome
    }
    if (!latestTodos?.length) return
    const isLast = index === groups.length - 1
    const anchorTurnID = (group.items.find(item => item.role === 'user') ?? group.items[0]).id
    const active = isLast && options.running && outcome === undefined
    const workedMs = active ? undefined : executionWorkedMs(group.items)
    const snapshot: ExecutionTodoSnapshot = {
      executionID: group.executionID, anchorTurnID, todos: latestTodos,
      completedCount: latestTodos.filter(todo => todo.status === 'completed').length,
      inProgressCount: latestTodos.filter(todo => todo.status === 'in_progress').length,
      pendingCount: latestTodos.filter(todo => todo.status === 'pending').length,
      cancelledCount: latestTodos.filter(todo => todo.status === 'cancelled').length,
      totalCount: latestTodos.length,
      active,
      outcome: outcome ?? (isLast && !options.running ? options.sessionOutcome : undefined),
      ...(workedMs !== undefined ? { workedMs } : {}),
    }
    Object.defineProperty(byTurnID, anchorTurnID, { value: snapshot, enumerable: true, configurable: true, writable: true })
    if (isLast) composer = snapshot
  })
  return { composer, byTurnID }
}
