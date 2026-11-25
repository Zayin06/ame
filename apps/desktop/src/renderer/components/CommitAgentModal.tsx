import { useEffect, useRef, useState } from 'react'
import type { ChatItem, CommitAgentInfo, CommitAgentMode, Model, Permission, Session, SessionForm } from '../../../../../packages/protocol/src/index'
import { extractCommitMessagesFromText, extractUserDisplayText, projectChatTimeline } from '../chat-timeline'
import type { TimelineDetailMode } from '../state'
import { SessionFormCard } from './SessionFormCard'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'
import { errorText, IconButton } from './Primitives'
import { TurnChanges } from './SessionChanges'
import { ToolCard } from './ToolCard'
import { ActiveToolsView, LiveTurnStatus, TurnWorkGroup } from './TurnWorkGroup'

const presets = [
  { mode: 'analyze', title: 'Phân tích & đề xuất tách commit', text: 'Đọc toàn bộ diff theo từng nhóm thay đổi, đề xuất cách tách atomic commit và hỏi xác nhận qua tool question trước khi commit.' },
  { mode: 'split', title: 'Phân tích & thực thi tách commit', text: 'Phân tích đầy đủ các nhóm thay đổi, hỏi xác nhận qua tool question rồi tự động tách stage và chạy nhiều commit UTF-8 lần lượt theo lựa chọn của tôi.' },
  { mode: 'single', title: 'Viết 1 thông điệp commit chuẩn', text: 'Đọc đầy đủ diff mọi tệp đã stage, không cắt 64KB, và tạo 1 commit message Conventional Commits trong fenced code block commit để điền vào ô Commit. Không tự tạo commit.' },
] satisfies { mode: CommitAgentMode; title: string; text: string }[]
const notify = () => window.dispatchEvent(new Event('ame-commit-agent-changed'))

type Props = {
  projectID: string; projectName?: string; projectDirectory?: string; connected: boolean; theme: 'dark' | 'light'
  timelineDetail?: TimelineDetailMode
  onClose: () => void; onActivity: () => void; onGitRefresh: () => void
  onApplyCommitMessage: (message: string) => void; onOpenFile: (path: string, line?: number) => void
}

export function CommitAgentModal({ projectID, projectName, projectDirectory, connected, theme, timelineDetail = 'compact', onClose, onActivity, onGitRefresh, onApplyCommitMessage, onOpenFile }: Props) {
  const [info, setInfo] = useState<CommitAgentInfo>()
  const [session, setSession] = useState<Session>()
  const [model, setModel] = useState<Model>()
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [forms, setForms] = useState<SessionForm[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [replying, setReplying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [applied, setApplied] = useState('')
  const dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), stream = useRef<HTMLDivElement>(null)
  const follow = useRef(true), mounted = useRef(false), operation = useRef(false), initialized = useRef(false), epoch = useRef(0)
  const sessionID = session?.id
  const currentSession = useRef(sessionID); currentSession.current = sessionID
  const callbacks = useRef({ onClose, onActivity, onGitRefresh }); callbacks.current = { onClose, onActivity, onGitRefresh }
  const previous = useRef<{ id?: string; running: boolean }>({ running: false })
  const locked = !!sessionID && !!info?.lockedSessionIDs.includes(sessionID)
  const running = session?.status === 'running' || forms.length > 0
  const available = connected && !!(model?.id || info?.effectiveModelID) && !locked && !busy && !running && !forms.length && (!sessionID || loaded)

  useEffect(() => {
    mounted.current = true
    const prior = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); return }
      if (event.key !== 'Tab') return
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? []).filter(node => !node.closest('fieldset:disabled'))
      const first = nodes[0], last = nodes.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => { mounted.current = false; epoch.current++; window.removeEventListener('keydown', keydown, true); if (prior?.isConnected) prior.focus() }
  }, [])

  useEffect(() => {
    if (!connected) return
    let alive = true, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const request = ++generation
      try {
        const value = await window.ame.commitAgentInfo(projectID)
        if (!alive || request !== generation) return
        setInfo(current => ({ ...value, lockedSessionIDs: [...new Set([...value.lockedSessionIDs, ...(current?.lockedSessionIDs ?? [])])] }))
        if (!initialized.current) {
          initialized.current = true
          const id = value.commitSessionIDs.filter(id => !value.lockedSessionIDs.includes(id)).at(-1)
          if (id) setSession({ id, title: 'Trợ lý Commit AI' })
        }
      } catch (e) { if (alive && request === generation) setError(errorText(e)) }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    window.addEventListener('ame-commit-agent-changed', load)
    const unsubscribe = window.ame.onEvent(event => { if (event.type === 'opencode' && event.projectID === projectID) { clearTimeout(timer); timer = setTimeout(() => void load(), 300) } })
    return () => { alive = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('ame-account-changed', load); window.removeEventListener('ame-commit-agent-changed', load) }
  }, [projectID, connected])

  useEffect(() => {
    if (!sessionID || !connected) return
    let alive = true, loading = false, queued = false
    const load = async () => {
      if (!alive) return
      if (loading) { queued = true; return }
      loading = true
      try {
        const [items, pending, sessions, pendingForms] = await Promise.allSettled([window.ame.messages(projectID, sessionID), window.ame.permissions(projectID, sessionID), window.ame.sessions(projectID), window.ame.forms(projectID, sessionID)])
        if (!alive) return
        if (items.status === 'fulfilled') setMessages(items.value)
        if (pending.status === 'fulfilled') setPermissions(pending.value)
        if (pendingForms.status === 'fulfilled') setForms(pendingForms.value)
        setLoaded(true)
        const failed = [items, pending, sessions, pendingForms].find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') setError(`Không tải được một phần dữ liệu phiên commit: ${errorText(failed.reason)}`)
        const latest = sessions.status === 'fulfilled' ? sessions.value.find(item => item.id === sessionID) : undefined
        if (latest) setSession(latest)
      } finally { loading = false; if (alive && queued) { queued = false; void load() } }
    }
    const unsubscribe = window.ame.onEvent(event => { if (event.type === 'opencode' && event.projectID === projectID && (!event.sessionID || event.sessionID === sessionID)) void load() })
    const timer = setInterval(() => void load(), 1500)
    void load()
    return () => { alive = false; clearInterval(timer); unsubscribe() }
  }, [projectID, sessionID, connected, revision])

  useEffect(() => {
    if (previous.current.id === sessionID && previous.current.running && session?.status === 'idle') callbacks.current.onGitRefresh()
    previous.current = { id: sessionID, running: session?.status === 'running' }
  }, [sessionID, session?.status])
  useEffect(() => {
    if (!sessionID || !connected) return
    let alive = true
    void Promise.all([window.ame.agentMap(projectID, sessionID), window.ame.models(projectID)]).then(([map, models]) => {
      const root = map.nodes.find(node => node.id === sessionID)
      if (alive && root?.model) setModel(models.find(model => model.providerID === (root.providerID || 'amecode') && (model.id === root.model || model.modelID === root.model)) ?? { id: root.model, name: root.model, providerID: root.providerID || 'amecode' })
    }).catch(() => {})
    return () => { alive = false }
  }, [projectID, sessionID, connected])
  useEffect(() => { if (follow.current) stream.current?.scrollTo({ top: stream.current.scrollHeight }) }, [messages, permissions, forms])
  const formIDs = forms.map(form => form.id).join(',')
  useEffect(() => { if (forms.length) { follow.current = true; stream.current?.scrollTo({ top: stream.current.scrollHeight }) } }, [formIDs])

  const send = async (value = text, mode: CommitAgentMode = 'custom') => {
    if (!available || !value.trim() || operation.current) return
    operation.current = true; setBusy(true); setError(''); setApplied('')
    const request = epoch.current
    try {
      const result = await window.ame.commitAgentPrompt(projectID, sessionID, value.trim(), mode)
      notify(); callbacks.current.onActivity()
      if (!mounted.current || request !== epoch.current) return
      setSession(result.session); currentSession.current = result.session.id; setModel(result.model)
      setText(''); setLoaded(false); setRevision(value => value + 1)
      if (result.locked) setInfo(current => current ? { ...current, lockedSessionIDs: [...new Set([...current.lockedSessionIDs, result.session.id])] } : current)
    } catch (e) {
      if (mounted.current && request === epoch.current) {
        const message = errorText(e); setError(message)
        if (message.includes('COMMIT_SESSION_LOCKED')) { if (sessionID) setInfo(current => current ? { ...current, lockedSessionIDs: [...new Set([...current.lockedSessionIDs, sessionID])] } : current); notify() }
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const finishDisabled = !connected || !sessionID || busy || running || locked || !loaded || permissions.length > 0 || forms.length > 0
  const finish = async () => {
    if (finishDisabled || !sessionID || operation.current) return
    operation.current = true; setBusy(true); setError('')
    try {
      const state = await window.ame.commitAgentLock(projectID, sessionID)
      notify(); callbacks.current.onActivity(); callbacks.current.onGitRefresh()
      if (!mounted.current) return
      setInfo(current => current ? { ...current, ...state } : current); callbacks.current.onClose()
    } catch (e) { if (mounted.current) setError(errorText(e)) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const newSession = () => {
    if (busy || operation.current) return
    epoch.current++; setSession(undefined); currentSession.current = undefined; setModel(undefined)
    setMessages([]); setPermissions([]); setForms([]); setText(''); setLoaded(false); setError(''); setApplied(''); follow.current = true
    input.current?.focus()
  }
  const reply = async (permission: Permission, response: 'once' | 'always' | 'reject') => {
    if (replying || !connected || locked) return
    const id = sessionID
    setReplying(true)
    try { await window.ame.replyPermission(projectID, permission.id, response); if (mounted.current && currentSession.current === id) setPermissions(items => items.filter(item => item.id !== permission.id)) }
    catch (e) { if (mounted.current && currentSession.current === id) setError(errorText(e)) }
    finally { if (mounted.current) setReplying(false) }
  }
  const interruptedQuestion = !locked && !running && !forms.length && messages.some(item => item.kind === 'tool' && item.tool?.name === 'question' && (item.tool.status === 'running' || item.tool.status === 'streaming'))
  const actions = { projectDirectory, onOpenFile }
  return <div className="translation-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className="translation-modal commit-agent-modal" role="dialog" aria-modal="true" aria-label="Trợ lý Commit AI" tabIndex={-1}>
      <header className="translation-modal__header"><div><h2>Trợ lý Commit AI</h2><p>{projectName || projectID} · Phiên agent Git riêng, có tool đọc diff &amp; tách commit</p></div><div className="button-row"><button type="button" disabled={busy} onClick={newSession}>Phiên mới</button><button type="button" className="translation-primary" disabled={finishDisabled} onClick={() => void finish()}>✓ Hoàn tất &amp; đóng</button><IconButton label="Đóng Trợ lý Commit AI" onClick={onClose}>×</IconButton></div></header>
      <div className="translation-modal__metadata"><span className="amekit-pill">{info?.skill ? `Skill: /${info.skill}` : 'Conventional Commits'}</span><span className="amekit-pill"><Icon name="lock" /> Model: {model?.name || info?.effectiveModelName || info?.effectiveModelID || 'Chưa có model'}</span>{info?.branch && <span className="amekit-pill">{info.branch}</span>}{info && <span className="amekit-pill">{info.stagedCount} staged · {info.workingCount} chưa stage</span>}</div>
      {!connected && <div className="warning" role="status">Chưa kết nối OpenCode. Kết nối lại để tiếp tục phiên commit.</div>}
      {info?.fallbackToDefault && <div className="warning" role="status">Phiên mới dùng model mặc định: {info.effectiveModelName || info.effectiveModelID}.</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {applied && <div role="status">{applied}</div>}
      <div ref={stream} className="chat-stream translation-modal__timeline" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}><div className="chat-stream__inner">
        {!info ? <p role="status">Đang tải cấu hình commit…</p> : sessionID && !loaded ? <p role="status">Đang tải phiên commit…</p> : !messages.length && !locked ? <div className="translation-presets"><h3>Commit rõ ràng, thay đổi atomic</h3><p>Phân tích diff trong phiên riêng. Xác nhận cách tách trước khi agent thực thi commit.</p><div className="translation-presets__grid">{presets.map(preset => <button key={preset.mode} type="button" disabled={!available} onClick={() => void send(preset.text, preset.mode)}><strong>{preset.title}</strong><span>{preset.text}</span></button>)}</div></div> : projectChatTimeline(messages, { running, mode: timelineDetail, pendingForms: forms.length > 0 }).map(turn => <section key={turn.id} className="chat-turn">
          {turn.user && <article className="msg-user"><MessageContent text={extractUserDisplayText(turn.user.text) || '…'} onOpenFile={onOpenFile} /></article>}
          <div className="msg-turn-body">{turn.blocks.map(block => {
            if (block.kind === 'work-group') return <TurnWorkGroup key={block.id} id={block.id} items={block.items} summary={block.summary} live={block.live} defaultOpen={block.defaultOpen} {...actions} />
            if (block.kind === 'active-tools') return <ActiveToolsView key={block.id} items={block.items} {...actions} />
            if (block.kind === 'live-status') return <LiveTurnStatus key={block.id} label={forms.length ? 'Đang chờ bạn trả lời câu hỏi…' : block.label} />
            if (block.kind === 'error') return <div key={block.id} className="inline-error" role="alert">{block.item.text}{/compaction|token limit|context/i.test(block.item.text) && <p>Ngữ cảnh phiên vượt giới hạn token. Hãy mở Phiên mới để tiếp tục.</p>}</div>
            const item = block.item
            if (block.kind === 'tool' && item.tool?.name === 'question' && (item.tool.status === 'running' || item.tool.status === 'streaming') && running) return <ActiveToolsView key={block.id} items={[item]} {...actions} />
            const commits = block.kind === 'text' ? extractCommitMessagesFromText(item.text) : []
            return <article key={block.id} className="msg-agent">{block.kind === 'tool' && item.tool ? <ToolCard call={item.tool} {...actions} /> : block.kind === 'changes' && item.turn && sessionID ? <TurnChanges projectID={projectID} sessionID={sessionID} from={item.turn.from} files={item.turn.files} theme={theme} /> : block.kind === 'reasoning' ? <details className="thought-block"><summary>Suy nghĩ</summary><MessageContent text={item.text || '…'} onOpenFile={onOpenFile} /></details> : <MessageContent text={item.text || '…'} onOpenFile={onOpenFile} />}{commits.length > 0 && <div className="button-row commit-agent-modal__apply">{commits.map((message, index) => <button key={index} type="button" onClick={() => { onApplyCommitMessage(message); setApplied('Đã điền vào ô Commit') }}>{commits.length === 1 ? 'Điền vào ô Commit' : `Điền commit #${index + 1}`}</button>)}</div>}</article>
          })}</div>
        </section>)}
        {interruptedQuestion && <div className="warning" role="status">Câu hỏi trước đó đã bị gián đoạn và không còn hiệu lực. Trả lời tiếp bên dưới hoặc mở Phiên mới.</div>}
        {!locked && forms.map(form => <SessionFormCard key={`${sessionID}:${form.id}`} projectID={projectID} form={form} disabled={!connected} onResolved={id => { if (currentSession.current !== sessionID) return; setForms(current => current.filter(form => form.id !== id)); setRevision(value => value + 1) }} />)}
        {!locked && permissions.map(permission => <section className="permission" key={permission.id} role="alert"><h3>Yêu cầu quyền</h3><p>{permission.title}</p><div className="button-row"><button disabled={replying || !connected} onClick={() => void reply(permission, 'once')}>Cho phép một lần</button><button disabled={replying || !connected} onClick={() => void reply(permission, 'always')}>Luôn cho phép</button><button disabled={replying || !connected} onClick={() => void reply(permission, 'reject')}>Từ chối</button></div></section>)}
      </div></div>
      {locked ? <div className="translation-locked-banner" role="status"><Icon name="lock" /><p>Phiên commit đã hoàn tất và được khóa vĩnh viễn. Nội dung chỉ đọc.</p><button type="button" disabled={busy} onClick={newSession}>Phiên mới</button></div> : <div className="composer-dock translation-composer"><div className="composer-dock__inner">
        {!running && messages.length > 0 && (session?.outcome === 'failed' ? <div className="inline-error" role="alert"><p>Lượt commit gần nhất gặp lỗi và chưa hoàn tất. Xem lỗi ở trên hoặc mở Phiên mới.</p><button type="button" disabled={busy} onClick={newSession}>Phiên mới</button></div> : <div className="translation-finish-banner"><p>Đã xong? Hoàn tất để khóa phiên commit.</p><button type="button" className="translation-primary" disabled={finishDisabled} onClick={() => void finish()}>✓ Hoàn tất &amp; đóng</button></div>)}
        <form className="composer-card translation-composer__form" onSubmit={event => { event.preventDefault(); void send() }}><textarea ref={input} className="composer-input translation-composer__input" aria-label="Yêu cầu trợ lý Commit" placeholder="Nhập yêu cầu phân tích hoặc tạo commit…" rows={3} value={text} disabled={!available} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} /><div className="translation-composer__toolbar"><span>Git Commit · Shift+Enter xuống dòng</span><div className="button-row">{running && sessionID && <button type="button" disabled={!connected || busy} onClick={() => { void window.ame.cancel(projectID, sessionID).catch(e => { if (mounted.current && currentSession.current === sessionID) setError(errorText(e)) }).finally(() => { if (mounted.current && currentSession.current === sessionID) setRevision(value => value + 1) }) }}>Dừng phản hồi</button>}<button type="submit" className="translation-primary" disabled={!available || !text.trim()}>Gửi yêu cầu</button></div></div></form>
      </div></div>}
    </div>
  </div>
}
