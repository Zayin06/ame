import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { clampWidth, defaultWidths, type Pane } from '../state'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div> }
export function IconButton({ label, children, onClick, active = false, disabled = false }: { label: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-btn ${active ? 'is-active' : ''}`} title={label} aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>
}
export function Resizer({ pane, width, onChange }: { pane: Pane; width: number; onChange: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const finish = (element: HTMLElement) => { start.current = null; setDragging(false); element.closest('.workspace-body')?.classList.remove('is-resizing') }
  return <div className={`pane-resizer ${dragging ? 'is-dragging' : ''}`} data-resize={({ rail: 'sidebar', inspector: 'inspector', stage: 'sidepanel' })[pane]} role="separator" aria-label={`Độ rộng ${pane}`} aria-orientation="vertical" aria-valuemin={pane === 'stage' ? 300 : 190} aria-valuemax={pane === 'stage' ? 780 : 360} aria-valuenow={width} tabIndex={0}
    onDoubleClick={() => onChange(defaultWidths[pane])}
    onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onChange(clampWidth(pane, width + (e.key === 'ArrowRight' ? 20 : -20))) } if (e.key === 'Home') onChange(defaultWidths[pane]) }}
    onPointerDown={e => { if (e.button !== 0) return; start.current = { x: e.clientX, width }; setDragging(true); e.currentTarget.closest('.workspace-body')?.classList.add('is-resizing'); e.currentTarget.setPointerCapture(e.pointerId) }}
    onPointerMove={e => { if (start.current) onChange(clampWidth(pane, start.current.width + (e.clientX - start.current.x) * (pane === 'stage' ? -1 : 1))) }}
    onPointerUp={e => { finish(e.currentTarget); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
    onPointerCancel={e => finish(e.currentTarget)} onLostPointerCapture={e => finish(e.currentTarget)} />
}
export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close); closeRef.current = close
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return }
      if (e.key !== 'Tab') return
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => { window.removeEventListener('keydown', handler, { capture: true }); if (prior?.isConnected) prior.focus() }
  }, [])
  return <div className="modal-shade" onMouseDown={e => { if (e.target === e.currentTarget) close() }}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><h2>{title}</h2><IconButton label="Đóng" onClick={close}>×</IconButton></header>{children}</div></div>
}
