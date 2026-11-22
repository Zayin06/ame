import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import type { TerminalEvent, TerminalInfo, TerminalProfile } from '../../../../../packages/protocol/src/index'
import { Icon } from './Icon'
import { errorText, IconButton } from './Primitives'

function Shell({ terminal, theme }: { terminal: TerminalInfo; theme: string }) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = container.current!
    let alive = true, ready = false, sequence = -1
    let queued: TerminalEvent[] = []
    const term = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, scrollback: 5000, theme: theme === 'light' ? { background: '#ffffff', foreground: '#24292f', cursor: '#24292f' } : { background: '#14161a', foreground: '#d4d4d4', cursor: '#d4d4d4' } })
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
    return () => { alive = false; off(); observer.disconnect(); input.dispose(); binary.dispose(); term.dispose() }
  }, [terminal.id, terminal.projectID, theme])
  return <><div ref={container} className="terminal-surface" data-terminal-id={terminal.id} />{error && <div className="terminal-error" role="alert">{error}</div>}</>
}

export function TerminalPanel({ projectID, theme, visible, close }: { projectID?: string; theme: string; visible: boolean; close: () => void }) {
  const [profiles, setProfiles] = useState<Pick<TerminalProfile, 'id' | 'name'>[]>([])
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [selected, setSelected] = useState('')
  const [profile, setProfile] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setTerminals([]); setSelected(''); setError(''); setBusy(false)
    void Promise.all([window.ame.terminalProfiles(), projectID ? window.ame.terminalList(projectID) : Promise.resolve([])]).then(([profiles, items]) => {
      if (current !== generation.current) return
      setProfiles(profiles); setProfile(profiles[0]?.id || ''); setTerminals(items); setSelected(items[0]?.id || '')
    }).catch(error => { if (current === generation.current) setError(errorText(error)) })
    return () => { generation.current++ }
  }, [projectID])
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
  return <section className={`editor-terminal ${visible ? '' : 'is-hidden'}`} aria-label="Terminal">
    <div className="editor-terminal__head"><div className="term-head__left"><span className="term-head__label">TERMINAL</span><div className="term-tabs" role="tablist" aria-label="Shell terminals">{terminals.map((item, index) => <div className={`term-tab ${item.id === selected ? 'is-active' : ''}`} key={item.id}><button role="tab" aria-selected={item.id === selected} onClick={() => setSelected(item.id)}>{item.title} {index + 1}{item.exitCode !== undefined ? ` (${item.exitCode})` : ''}</button><button className="term-tab__close" aria-label={`Kill terminal ${index + 1}`} onClick={() => void remove(item)}>×</button></div>)}</div></div>
      <div className="term-head__actions"><select aria-label="Terminal profile" value={profile} onChange={event => setProfile(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><button className="icon-btn term-act-btn" aria-label="New Terminal" title="New Terminal" disabled={!projectID || !profiles.length || busy} onClick={() => void create()}><Icon name="plus" /></button><IconButton label="Close Terminal Panel" onClick={close}><Icon name="close" /></IconButton></div></div>
    <div className="terminal-wrap">{error && <div className="terminal-error" role="alert">{error}</div>}{active ? <Shell key={active.id} terminal={active} theme={theme} /> : <div className="terminal-empty">{projectID ? <button disabled={busy || !profiles.length} onClick={() => void create()}>Mở terminal tại project</button> : 'Mở project để dùng terminal.'}</div>}</div>
  </section>
}
