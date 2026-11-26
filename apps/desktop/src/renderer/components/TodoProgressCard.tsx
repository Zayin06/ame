import { useEffect, useId, useRef, useState } from 'react'
import type { ExecutionTodoSnapshot } from '../chat-todo'
import { formatAgentDuration } from '../chat-timeline'
import { Icon } from './Icon'

export function TodoProgressCard({ snapshot, defaultOpen }: { snapshot: ExecutionTodoSnapshot; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? snapshot.active)
  const wasActive = useRef(snapshot.active)
  const listID = useId()
  useEffect(() => {
    if (snapshot.active && !wasActive.current) setOpen(true)
    else if (!snapshot.active && wasActive.current) setOpen(false)
    wasActive.current = snapshot.active
  }, [snapshot.active])
  const ringState = !snapshot.active && snapshot.completedCount === snapshot.totalCount && snapshot.totalCount > 0 ? 'done' : snapshot.active ? 'live' : snapshot.inProgressCount > 0 ? 'paused' : 'idle'
  const progress = snapshot.totalCount > 0 ? snapshot.completedCount / snapshot.totalCount : 0
  const circumference = 2 * Math.PI * 6
  const durationText = !snapshot.active ? formatAgentDuration(snapshot.workedMs) : ''
  const headingLabel = snapshot.active ? 'Đang thực hiện' : durationText ? `Đã làm ${durationText}` : 'Tiến độ'
  const status = snapshot.inProgressCount > 0
    ? snapshot.active
      ? { modifier: 'live', label: `${snapshot.inProgressCount} đang chạy` }
      : { modifier: 'paused', label: `${snapshot.outcome === 'failed' ? 'Lỗi' : 'Đã dừng'} · ${snapshot.inProgressCount} chưa xong` }
    : snapshot.cancelledCount > 0 && snapshot.completedCount + snapshot.cancelledCount === snapshot.totalCount
      ? { modifier: 'cancelled', label: `${snapshot.cancelledCount} đã hủy` }
      : undefined
  return <section className={`todo-progress${snapshot.active ? ' is-active' : ''}`} data-testid="chat-todo-turn" data-execution-id={snapshot.executionID} data-active={snapshot.active ? 'true' : 'false'} aria-label="Tiến độ công việc">
    <button type="button" className="todo-progress__trigger" aria-expanded={open} aria-controls={listID} onClick={() => setOpen(v => !v)}>
      <span className="todo-progress__label">{headingLabel}</span>
      <span className="todo-progress__chevron" aria-hidden="true"><Icon name="chevron" /></span>
      <span className={`todo-progress__ring todo-progress__ring--${ringState}`} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle className="todo-progress__ring-track" cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="6" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} transform="rotate(-90 8 8)" />
        </svg>
      </span>
      <span className="todo-progress__count">{`${snapshot.completedCount}/${snapshot.totalCount} bước`}</span>
      {status && <span className={`todo-progress__status todo-progress__status--${status.modifier}`}>{`· ${status.label}`}</span>}
    </button>
    {open && <ul id={listID} className="todo-progress__list">{snapshot.todos.map((todo, index) => <li key={index} className={`todo-item todo-item--${todo.status}${todo.status === 'in_progress' ? snapshot.active ? ' is-live' : ' is-paused' : ''}`}>
      <span className={`todo-item__icon todo-item__icon--${todo.status}`} role="img" aria-label={todo.status === 'completed' ? 'Hoàn tất' : todo.status === 'in_progress' ? snapshot.active ? 'Đang chạy' : 'Đã dừng' : todo.status === 'cancelled' ? 'Đã hủy' : 'Chờ thực hiện'}>{todo.status === 'completed' ? <Icon name="check" /> : todo.status === 'cancelled' ? <Icon name="close" /> : todo.status === 'in_progress' && !snapshot.active ? <Icon name="stop" /> : null}</span>
      <span className="todo-item__content">{todo.content}</span>
    </li>)}</ul>}
  </section>
}
