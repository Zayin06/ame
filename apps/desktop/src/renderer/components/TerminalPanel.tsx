import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import type { TerminalEvent, TerminalInfo, TerminalProfile } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { errorText, IconButton } from './Primitives'
import { clearTerminal, terminalTheme, updateTerminalTheme } from '../terminal-controls'
import type { MutableRefObject } from 'react'
import type { DebugStatus } from '../../../../../packages/protocol/src/index'
import { ProblemsPanel, type ProblemsPanelProps } from './ProblemsPanel'
import { DebugPanel, type DebugPanelProps } from './DebugPanel'

export type BottomPanelTab = 'terminal' | 'problems' | 'debug'
const idleDebugProps: DebugPanelProps = {
  snapshot: { status: 'idle', frames: [], variables: [], breakpoints: [] }, output: [], entry: '',
  onEntryChange: () => {}, onStart: () => {}, onStop: () => {}, onContinue: () => {}, onPause: () => {},
  onStepOver: () => {}, onStepInto: () => {}, onStepOut: () => {}, onSelectFrame: () => {},
  onOpenLocation: () => {}, onRemoveBreakpoint: () => {},
  onEvaluate: async () => ({ value: '', type: 'error', error: 'Chưa mở project.' })
}

function Shell({ terminal, theme, instance }: { terminal: TerminalInfo; theme: string; instance: MutableRefObject<Terminal | null> }) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const themeRef = useRef(theme); themeRef.current = theme
  useEffect(() => {
    const element = container.current!
    let alive = true, ready = false, sequence = -1
    let queued: TerminalEvent[] = []
    const term = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, scrollback: 5000, theme: terminalTheme(themeRef.current) })
    instance.current = term
    const fit = new FitAddon(); term.loadAddon(fit); term.open(element)
    const report = (error: unknown) => { if (alive) setError(errorText(error)) }
    const apply = (event: TerminalEvent) => {
      if (event.sequence <= sequence) return
      sequence = event.sequence
      if (event.data) term.write(event.data)
      if (event.exitCode !== undefined) term.write(`\r\n[Shell exited: ${event.exitCode}]\r\n`)
    }
    const off = window.ame.onEvent(event => {
      if (event.type !== 'terminal' || event.terminalID !== terminal.id) return
      if (ready) apply(event); else queued.push(event)
    })
    const resize = () => {
      if (!alive || !ready || element.clientWidth < 20 || element.clientHeight < 20) return
      fit.fit()
      void window.ame.terminalResize(terminal.projectID, terminal.id, Math.min(500, Math.max(2, term.cols)), Math.min(300, Math.max(1, term.rows))).catch(report)
    }
    void window.ame.terminalSnapshot(terminal.projectID, terminal.id).then(snapshot => {
      if (!alive) return
      term.resize(snapshot.cols, snapshot.rows)
      term.write(snapshot.output)
      sequence = snapshot.sequence
      if (snapshot.exitCode !== undefined) term.write(`\r\n[Shell exited: ${snapshot.exitCode}]\r\n`)
      ready = true; queued.forEach(apply); queued = []; resize()
    }).catch(report)
    const input = term.onData(data => { if (ready) void window.ame.terminalWrite(terminal.projectID, terminal.id, data).catch(report) })
    const binary = term.onBinary(data => { if (ready) void window.ame.terminalWrite(terminal.projectID, terminal.id, data).catch(report) })
    term.attachCustomKeyEventHandler(event => {
      const mac = /Mac/i.test(navigator.platform)
      const copy = event.key.toLowerCase() === 'c' && (mac ? event.metaKey : event.ctrlKey && event.shiftKey)
      const paste = event.key.toLowerCase() === 'v' && (mac ? event.metaKey : event.ctrlKey)
      if (copy || paste) {
        if (event.type === 'keydown') {
          event.preventDefault()
          if (copy && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(report)
          if (paste) void navigator.clipboard.readText().then(text => { if (alive) term.paste(text) }).catch(report)
        }
        return false
      }
      return true
    })
    const observer = new ResizeObserver(resize); observer.observe(element)
    return () => { alive = false; off(); observer.disconnect(); input.dispose(); binary.dispose(); instance.current = null; term.dispose() }
  }, [terminal.id, terminal.projectID, instance])
  useEffect(() => { updateTerminalTheme(instance.current, theme) }, [theme, instance])
  return <><div ref={container} className="terminal-surface" data-terminal-id={terminal.id} />{error && <div className="terminal-error" role="alert">{error}</div>}</>
}

export function TerminalPanel({ projectID, theme, visible, close, createdTerminal, height, onHeightChange, activeTab, onSelectTab, problemsProps, debugProps, problemCounts = { error: 0, warning: 0 }, debugStatus = 'idle' }: {
  projectID?: string; theme: string; visible: boolean; close: () => void; createdTerminal?: TerminalInfo;
  height?: number; onHeightChange?: (height: number) => void;
  activeTab?: BottomPanelTab; onSelectTab?: (tab: BottomPanelTab) => void;
  problemsProps?: ProblemsPanelProps; debugProps?: DebugPanelProps;
  problemCounts?: { error: number; warning: number }; debugStatus?: DebugStatus
}) {
  const [localHeight, setLocalHeight] = useState(185)
  const panelHeight = Math.min(520, Math.max(130, height ?? localHeight))
  const resizePanel = (next: number) => { const clamped = Math.min(520, Math.max(130, next)); setLocalHeight(clamped); onHeightChange?.(clamped) }
  const drag = useRef<{ y: number; height: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const finishResize = () => { drag.current = null; setDragging(false) }
  const [localTab, setLocalTab] = useState<BottomPanelTab>('terminal')
  const tab = activeTab ?? localTab
  const selectTab = (next: BottomPanelTab) => { setLocalTab(next); onSelectTab?.(next) }
  const instance = useRef<Terminal | null>(null)
  const createdRef = useRef(createdTerminal); createdRef.current = createdTerminal
  const handledCreated = useRef(createdTerminal)
  const [profiles, setProfiles] = useState<Pick<TerminalProfile, 'id' | 'name'>[]>([])
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [selected, setSelected] = useState('')
  const [profile, setProfile] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    const createdAtStart = createdRef.current
    setTerminals([]); setSelected(''); setError(''); setBusy(false)
    void Promise.all([window.ame.terminalProfiles(), projectID ? window.ame.terminalList(projectID) : Promise.resolve([])]).then(([profiles, items]) => {
      if (current !== generation.current) return
      const latest = createdRef.current
      const created = latest && latest.projectID === projectID && (latest !== createdAtStart || items.some(item => item.id === latest.id)) ? latest : undefined
      const merged = created && !items.some(item => item.id === created.id) ? [...items, created] : items
      setProfiles(profiles); setProfile(profiles[0]?.id || ''); setTerminals(merged); setSelected(created?.id || items[0]?.id || '')
    }).catch(error => { if (current === generation.current) setError(errorText(error)) })
    return () => { generation.current++ }
  }, [projectID])
  useEffect(() => {
    if (!createdTerminal || createdTerminal.projectID !== projectID || handledCreated.current === createdTerminal) return
    handledCreated.current = createdTerminal
    setTerminals(items => items.some(item => item.id === createdTerminal.id) ? items : [...items, createdTerminal])
    setSelected(createdTerminal.id)
  }, [createdTerminal, projectID])
  useEffect(() => window.ame.onEvent(event => {
    if (event.type === 'terminal' && event.projectID === projectID && event.exitCode !== undefined) setTerminals(items => items.map(item => item.id === event.terminalID ? { ...item, exitCode: event.exitCode } : item))
  }), [projectID])
  async function create() {
    if (!projectID || busy) return
    const current = generation.current
    setBusy(true); setError('')
    try {
      const item = await window.ame.terminalCreate(projectID, profile || undefined)
      if (current === generation.current) { setTerminals(items => [...items, item]); setSelected(item.id) }
    } catch (error) { if (current === generation.current) setError(errorText(error)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  async function remove(item: TerminalInfo) {
    const current = generation.current
    try {
      await window.ame.terminalClose(item.projectID, item.id)
      if (current !== generation.current) return
      setTerminals(items => items.filter(value => value.id !== item.id))
      if (selected === item.id) setSelected(terminals.find(value => value.id !== item.id)?.id || '')
    } catch (error) { if (current === generation.current) setError(errorText(error)) }
  }
  const active = terminals.find(item => item.id === selected)
  return <section className={`editor-terminal ${visible ? '' : 'is-hidden'} ${dragging ? 'is-resizing' : ''}`} style={{ '--bottom-panel-h': `${panelHeight}px` } as CSSProperties} aria-label="Terminal">
    <div className={`bottom-panel-resizer ${dragging ? 'is-dragging' : ''}`} role="separator" aria-orientation="horizontal" aria-label="Chiều cao Bottom Panel" aria-valuemin={130} aria-valuemax={520} aria-valuenow={panelHeight} tabIndex={0}
      onDoubleClick={() => resizePanel(185)}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resizePanel(panelHeight + (event.key === 'ArrowUp' ? 20 : -20)) } else if (event.key === 'Home') { event.preventDefault(); resizePanel(185) } }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { y: event.clientY, height: panelHeight }; setDragging(true); event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => { if (drag.current) resizePanel(drag.current.height + drag.current.y - event.clientY) }}
      onPointerUp={event => { finishResize(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={finishResize} onLostPointerCapture={finishResize} />
    <div className="editor-terminal__head"><div className="term-head__left"><div className="bottom-panel-tabs" role="tablist" aria-label="Bottom panel">{(['terminal', 'problems', 'debug'] as const).map(value => <button type="button" role="tab" key={value} aria-selected={tab === value} onClick={() => selectTab(value)}>{value === 'terminal' ? 'TERMINAL' : value === 'problems' ? <>Vấn đề <span className="bottom-panel-count">{problemCounts.error + problemCounts.warning}</span></> : <><span className={`debug-indicator debug-indicator--${debugStatus}`} />Gỡ lỗi</>}</button>)}</div><div className="term-tabs" hidden={tab !== 'terminal'} role="tablist" aria-label="Shell terminals">{terminals.map((item, index) => <div className={`term-tab ${item.id === selected ? 'is-active' : ''}`} key={item.id}><button role="tab" aria-selected={item.id === selected} onClick={() => setSelected(item.id)}>{item.title} {index + 1}{item.exitCode !== undefined ? ` (${item.exitCode})` : ''}</button><button className="term-tab__close" aria-label={`Kill terminal ${index + 1}`} onClick={() => void remove(item)}>×</button></div>)}</div></div>
      <div className="term-head__actions"><select hidden={tab !== 'terminal'} aria-label="Terminal profile" value={profile} onChange={event => setProfile(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><button hidden={tab !== 'terminal'} className="icon-btn term-act-btn" aria-label="New Terminal" title="New Terminal" disabled={!projectID || !profiles.length || busy} onClick={() => void create()}><Icon name="plus" /></button><button hidden={tab !== 'terminal'} className="icon-btn term-act-btn" aria-label="Clear Terminal" title="Clear Terminal" disabled={!active} onClick={() => clearTerminal(instance.current)}><Icon name="refresh" /></button><IconButton label="Close Terminal Panel" onClick={close}><Icon name="close" /></IconButton></div></div>
    <div className="terminal-wrap" hidden={tab !== 'terminal'}>{error && <div className="terminal-error" role="alert">{error}</div>}{active ? <Shell key={active.id} terminal={active} theme={theme} instance={instance} /> : <div className="terminal-empty">{projectID ? <button disabled={busy || !profiles.length} onClick={() => void create()}>Mở terminal tại project</button> : 'Mở project để dùng terminal.'}</div>}</div>
    {tab !== 'terminal' && <div className="bottom-panel-body">{tab === 'problems' ? <ProblemsPanel {...(problemsProps ?? { problems: [], onOpenLocation: () => {} })} /> : <DebugPanel {...(debugProps ?? idleDebugProps)} />}</div>}
  </section>
}
