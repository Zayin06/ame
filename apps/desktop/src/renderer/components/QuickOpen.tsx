import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { parseQuickOpenInput, rankQuickOpenFiles, type QuickOpenItem } from '../quick-open'
import { Modal } from './Primitives'

export type QuickOpenProps = {
  open: boolean
  mode: 'files' | 'line'
  files: readonly string[]
  recentPaths?: readonly string[]
  activeFile?: string
  activeLineCount?: number
  loading?: boolean
  onSelectFile: (path: string, line?: number, column?: number) => void
  onGoToLine: (line: number, column?: number) => void
  onClose: () => void
}

function HighlightedPath({ item }: { item: QuickOpenItem }) {
  const matched = new Set(item.indices)
  return <>{item.path.split('').map((character, index) => matched.has(index) ? <mark key={index}>{character}</mark> : <span key={index}>{character}</span>)}</>
}

function QuickOpenDialog({ mode, files, recentPaths, activeFile, activeLineCount, loading, onSelectFile, onGoToLine, onClose }: QuickOpenProps) {
  const [input, setInput] = useState(mode === 'line' ? ':' : '')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionsRef = useRef<HTMLUListElement>(null)
  const id = useId()
  const parsed = parseQuickOpenInput(mode === 'line' && !input.startsWith(':') ? `:${input}` : input)
  const lineMode = mode === 'line' || parsed.mode === 'line'
  const items = useMemo(() => rankQuickOpenFiles(parsed.mode === 'file' ? parsed.query : '', files, recentPaths), [parsed.mode === 'file' ? parsed.query : '', files, recentPaths])
  const index = Math.max(0, Math.min(selected, items.length - 1))
  const overflow = parsed.mode === 'line' && activeLineCount !== undefined && parsed.line > activeLineCount
  const title = lineMode ? 'Đi đến dòng' : 'Mở tệp nhanh'

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelected(0) }, [files, recentPaths])
  useEffect(() => { optionsRef.current?.children[index]?.scrollIntoView?.({ block: 'nearest' }) }, [index, input])

  const selectFile = (item: QuickOpenItem) => {
    if (loading || parsed.mode !== 'file') return
    onSelectFile(item.path, parsed.line, parsed.column)
    onClose()
  }
  const confirm = () => {
    if (parsed.mode === 'line') {
      const count = activeLineCount !== undefined && Number.isFinite(activeLineCount) ? Math.max(1, Math.floor(activeLineCount)) : undefined
      onGoToLine(count === undefined ? parsed.line : Math.min(parsed.line, count), parsed.column)
      onClose()
    } else if (!lineMode && items[index]) selectFile(items[index])
  }

  return <Modal title={title} close={onClose}>
    <div className="quick-open" style={{ display: 'grid', gap: 8 }}>
      <input ref={inputRef} type="text" role="combobox" aria-label={title} aria-autocomplete={lineMode ? 'none' : 'list'} aria-expanded={!lineMode} aria-controls={lineMode ? undefined : `${id}-list`} aria-activedescendant={!lineMode && !loading && items[index] ? `${id}-option-${index}` : undefined} aria-describedby={`${id}-status`} autoComplete="off" spellCheck={false}
        placeholder={mode === 'line' ? ':dòng:cột' : 'Tìm tệp hoặc :dòng:cột'} value={input}
        onChange={event => { setInput(event.target.value); setSelected(0) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); confirm() }
          if (!lineMode && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            if (items.length) setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
          }
        }} />
      <div id={`${id}-status`} role="status" aria-live="polite">
        {lineMode ? <>{activeFile && <span>{activeFile}: </span>}{parsed.mode !== 'line' ? 'Nhập số dòng lớn hơn 0.' : overflow ? `Tệp có ${activeLineCount} dòng; sẽ chuyển đến dòng cuối.` : `Dòng ${parsed.line}${parsed.column === undefined ? '' : `, cột ${parsed.column}`}`}</> : loading ? 'Đang tải danh sách tệp…' : `${items.length} kết quả`}
      </div>
      {!lineMode && <ul ref={optionsRef} id={`${id}-list`} role="listbox" aria-label="Tệp" aria-busy={loading || false} style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '50vh', overflowY: 'auto' }}>
        {!loading && items.map((item, itemIndex) => <li key={item.path} id={`${id}-option-${itemIndex}`} role="option" aria-selected={itemIndex === index} className={itemIndex === index ? 'is-active' : ''}
          style={{ padding: '8px 12px', cursor: 'pointer', background: itemIndex === index ? 'var(--surface-hover, rgba(128,128,128,.18))' : undefined }}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(itemIndex)} onClick={() => selectFile(item)}>
          <HighlightedPath item={item} /> {item.recent && <small>(đang mở)</small>}
        </li>)}
      </ul>}
      {!lineMode && !loading && !items.length && <p>Không tìm thấy tệp.</p>}
    </div>
  </Modal>
}

export function QuickOpen(props: QuickOpenProps) {
  return props.open ? <QuickOpenDialog key={props.mode} {...props} /> : null
}
