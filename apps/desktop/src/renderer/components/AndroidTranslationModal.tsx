import { useEffect, useMemo, useRef, useState } from 'react'
import type { AndroidTranslationInfo, ChatItem, Model, Permission, Session } from '../../../../../packages/protocol/src/index'
import { extractUserDisplayText, projectChatTimeline } from '../chat-timeline'
import type { SessionForm } from '../../../../../packages/protocol/src/index'
import { SessionFormCard } from './SessionFormCard'
import { formatAmeKitError } from '../amekit-ui'
import type { TimelineDetailMode } from '../state'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'
import { errorText, IconButton } from './Primitives'
import { TurnChanges } from './SessionChanges'
import { ToolCard } from './ToolCard'
import { ActiveToolsView, LiveTurnStatus, TurnWorkGroup } from './TurnWorkGroup'

const updatePrompt = 'Chạy chế độ Update: quét key mới/thay đổi trong res/values/strings.xml và cập nhật đồng bộ tất cả locale hiện có.'
const fullPrompt = 'Dịch toàn bộ strings.xml sang ngôn ngữ mới: [nhập mã locale, ví dụ: ja, ko, fr]\nGhi chú giọng văn / ngữ cảnh (nếu có): '
const scanPrompt = 'Chạy strings_tool.py scan và pending để báo cáo tình trạng các locale trong dự án (chỉ báo cáo, chưa sửa file).'
const notifyTranslation = () => window.dispatchEvent(new Event('ame-translation-changed'))
const drafts = new Map<string, string>()
const draftRevisions = new Map<string, number>()
const draftModes = new Map<string, 'update' | 'full' | 'scan' | 'custom'>()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type Props = {
  projectID: string
  projectName?: string
  projectDirectory?: string
  connected: boolean
  theme: 'dark' | 'light'
  timelineDetail?: TimelineDetailMode
  onClose: () => void
  onActivity: () => void
  onOpenFile: (path: string, line?: number) => void
}

export function AndroidTranslationModal({ projectID, projectName, projectDirectory, connected, theme, timelineDetail = 'compact', onClose, onActivity, onOpenFile }: Props) {
  const [info, setInfo] = useState<AndroidTranslationInfo>()
  const [session, setSession] = useState<Session>()
  const [pinnedModel, setPinnedModel] = useState<Model>()
  const [disabledSessionModel, setDisabledSessionModel] = useState(false)
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [forms, setForms] = useState<SessionForm[]>([])
  const [text, updateText] = useState(() => drafts.get(projectID) ?? '')
  const setText = (value: string) => { draftRevisions.set(projectID, (draftRevisions.get(projectID) ?? 0) + 1); if (value) drafts.set(projectID, value); else { drafts.delete(projectID); draftModes.delete(projectID) } if (!value.trim()) setMode('incremental'); updateText(value) }
  const [mode, updateMode] = useState<'incremental' | 'update' | 'full' | 'scan' | 'custom'>(() => draftModes.get(projectID) ?? 'custom')
  const setMode = (value: typeof mode) => { if (value === 'incremental') draftModes.delete(projectID); else draftModes.set(projectID, value); updateMode(value) }
  const [busy, setBusy] = useState(false)
  const [replying, setReplying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stream = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const mounted = useRef(false)
  const operation = useRef(false)
  const sessionID = session?.id
  const currentSession = useRef(sessionID); currentSession.current = sessionID
  const initialized = useRef(false)
  const epoch = useRef(0)
  const callbacks = useRef({ onClose, onActivity }); callbacks.current = { onClose, onActivity }
  const locked = !!sessionID && !!info?.lockedSessionIDs.includes(sessionID)
  const running = session?.status === 'running' || forms.length > 0
  const available = connected && !!info?.configured && !locked && !busy && !running && !forms.length && (!sessionID || loaded)
  const turns = useMemo(() => projectChatTimeline(messages, { running, mode: timelineDetail, pendingForms: forms.length > 0 }), [messages, running, timelineDetail, forms.length])

  useEffect(() => {
    mounted.current = true
    const prior = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); return }
      if (event.key !== 'Tab') return
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? []).filter(node => !node.closest('fieldset:disabled'))
      const first = nodes[0], last = nodes[nodes.length - 1]
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
        const value = await window.ame.androidTranslationInfo(projectID)
        if (!alive || request !== generation) return
        setInfo(current => ({ ...value, lockedSessionIDs: [...new Set([...value.lockedSessionIDs, ...(current?.lockedSessionIDs ?? [])])] }))
        if (!initialized.current) {
          initialized.current = true
          const id = value.translationSessionIDs.filter(id => !value.lockedSessionIDs.includes(id)).at(-1)
          if (id) setSession({ id, title: 'Dịch Android Strings' })
        }
      } catch (e) { if (alive && request === generation) setError(errorText(e)) }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    window.addEventListener('ame-bundle-updated', load)
    window.addEventListener('ame-translation-changed', load)
    const unsubscribe = window.ame.onEvent(event => {
      if (event.type === 'opencode' && event.projectID === projectID) { clearTimeout(timer); timer = setTimeout(() => void load(), 300) }
    })
    return () => { alive = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('ame-account-changed', load); window.removeEventListener('ame-bundle-updated', load); window.removeEventListener('ame-translation-changed', load) }
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
        if (alive) {
          if (items.status === 'fulfilled') setMessages(current => same(current, items.value) ? current : items.value)
          if (pending.status === 'fulfilled') setPermissions(current => same(current, pending.value) ? current : pending.value)
          if (pendingForms.status === 'fulfilled') setForms(current => same(current, pendingForms.value) ? current : pendingForms.value)
          setLoaded(true)
          const failed = [items, pending, sessions, pendingForms].find(result => result.status === 'rejected')
          if (failed?.status === 'rejected') setError(`Không tải được một phần dữ liệu phiên dịch: ${errorText(failed.reason)}`)
          const latest = sessions.status === 'fulfilled' ? sessions.value.find(item => item.id === sessionID) : undefined
          if (latest) setSession(current => same(current, latest) ? current : latest)
        }
      } catch (e) { if (alive) { setError(errorText(e)); setLoaded(true) } }
      finally { loading = false; if (alive && queued) { queued = false; void load() } }
    }
    const unsubscribe = window.ame.onEvent(event => { if (event.type === 'opencode' && event.projectID === projectID && (!event.sessionID || event.sessionID === sessionID)) void load() })
    const timer = setInterval(() => void load(), 1500)
    void load()
    return () => { alive = false; clearInterval(timer); unsubscribe() }
  }, [projectID, sessionID, connected, revision])

  useEffect(() => {
    if (!sessionID || !connected) { setPinnedModel(undefined); setDisabledSessionModel(false); return }
    let alive = true, generation = 0
    const load = async () => {
      const request = ++generation
      try {
        const [map, models] = await Promise.all([window.ame.agentMap(projectID, sessionID), window.ame.models(projectID)])
        if (!alive || request !== generation) return
        const root = map.nodes.find(node => node.id === sessionID)
        const active = models.find(model => model.providerID === 'amecode' && model.providerID === (root?.providerID || 'amecode') && (model.id === root?.model || model.modelID === root?.model))
        setPinnedModel(root?.model ? active : undefined)
        setDisabledSessionModel(!!root?.model && !active)
      } catch {}
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    window.addEventListener('ame-bundle-updated', load)
    return () => { alive = false; window.removeEventListener('ame-account-changed', load); window.removeEventListener('ame-bundle-updated', load) }
  }, [projectID, sessionID, connected, revision])

  useEffect(() => { if (follow.current) stream.current?.scrollTo({ top: stream.current.scrollHeight }) }, [messages, permissions, forms])
  const formIDs = forms.map(form => form.id).join(',')
  useEffect(() => { if (forms.length) { follow.current = true; stream.current?.scrollTo({ top: stream.current.scrollHeight }) } }, [formIDs])

  const send = async (value = text, preset = mode) => {
    if (!available || !value.trim() || operation.current) return
    operation.current = true; setBusy(true); setError('')
    const request = epoch.current
    const draftRevision = draftRevisions.get(projectID)
    try {
      const result = await window.ame.androidTranslationPrompt(projectID, sessionID, value.trim(), preset === 'incremental' ? 'custom' : preset)
      if (draftRevisions.get(projectID) === draftRevision) { drafts.delete(projectID); draftModes.delete(projectID) }
      notifyTranslation(); callbacks.current.onActivity()
      if (!mounted.current || request !== epoch.current) return
      setSession(result.session); currentSession.current = result.session.id; setPinnedModel(result.model); setDisabledSessionModel(false)
      setText(''); setMode('custom'); setLoaded(false); setRevision(value => value + 1)
      if (result.locked) setInfo(current => current ? { ...current, lockedSessionIDs: [...new Set([...current.lockedSessionIDs, result.session.id])] } : current)
    } catch (e) {
      if (mounted.current && request === epoch.current) {
        const message = errorText(e); setError(message)
        if (message.includes('TRANSLATION_SESSION_LOCKED')) {
          if (sessionID) setInfo(current => current ? { ...current, lockedSessionIDs: [...new Set([...current.lockedSessionIDs, sessionID])] } : current)
          notifyTranslation()
        }
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const finish = async () => {
    if (!sessionID || busy || running || !loaded || permissions.length || forms.length || operation.current || !connected) return
    operation.current = true; setBusy(true); setError('')
    try {
      const state = await window.ame.androidTranslationLock(projectID, sessionID)
      notifyTranslation(); callbacks.current.onActivity()
      if (!mounted.current) return
      setInfo(current => current ? { ...current, ...state } : current)
      callbacks.current.onClose()
    } catch (e) { if (mounted.current) setError(errorText(e)) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const newSession = () => {
    if (busy || operation.current) return
    epoch.current++; setSession(undefined); currentSession.current = undefined; setPinnedModel(undefined)
    setMessages([]); setPermissions([]); setForms([]); setText(''); setMode('custom'); setLoaded(false); setError(''); follow.current = true
    input.current?.focus()
  }
  const reply = async (permission: Permission, response: 'once' | 'always' | 'reject') => {
    if (replying || !connected || locked) return
    const id = sessionID
    setReplying(true)
    try {
      await window.ame.replyPermission(projectID, permission.id, response)
      if (mounted.current && currentSession.current === id) setPermissions(items => items.filter(item => item.id !== permission.id))
    } catch (e) { if (mounted.current) setError(errorText(e)) }
    finally { if (mounted.current) setReplying(false) }
  }
  const finishDisabled = !connected || !sessionID || busy || running || locked || !loaded || permissions.length > 0 || forms.length > 0
  const interruptedQuestion = !locked && !running && forms.length === 0 && messages.some(item => item.kind === 'tool' && item.tool?.name === 'question' && (item.tool.status === 'running' || item.tool.status === 'streaming'))
  const actions = { projectDirectory, onOpenFile }
  return <div className="translation-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className="translation-modal" role="dialog" aria-modal="true" aria-label="Dịch Android Strings" tabIndex={-1}>
      <header className="translation-modal__header"><div><h2><Icon name="globe" /> Dịch Android Strings</h2><p>{projectName || projectID} · Phiên OpenCode riêng, không thay đổi Chat chính</p></div><div className="button-row"><button type="button" disabled={busy || operation.current} onClick={newSession}>Phiên dịch mới</button><button type="button" className="translation-primary" disabled={finishDisabled} onClick={() => void finish()}>✓ Hoàn tất &amp; đóng</button><IconButton label="Đóng Dịch Android" onClick={onClose}><Icon name="close" /></IconButton></div></header>
      <div className="translation-modal__metadata"><span className="amekit-pill">{info?.skill ? `Skill: /${info.skill}` : 'Chưa cấu hình skill'}</span><span className="amekit-pill"><Icon name="lock" /> Model: {pinnedModel?.name || info?.effectiveModelName || info?.effectiveModelID || 'Đang tải…'}</span>{!!info?.stringsFiles.length && <span className="amekit-pill" title={info.stringsFiles.join('\n')}>{info.stringsFiles.length} tệp strings.xml</span>}</div>
      {!connected && <div className="warning" role="status">Chưa kết nối OpenCode. Kết nối lại để tiếp tục phiên dịch.</div>}
      {info && (!info.configured || !info.skill) && <div className="warning" role="status">Nhờ Admin cấu hình Skill cho Dịch Android trong Cài đặt → AmeKit trước khi dịch.</div>}
      {info?.fallbackToDefault && <div className="warning" role="status">Model dịch chưa được cấu hình hoặc không còn hoạt động. Phiên mới dùng model mặc định từ API: {info.effectiveModelName || info.effectiveModelID}.</div>}
      {disabledSessionModel && <div className="warning" role="status">Model trước đó của phiên đã bị vô hiệu hóa từ API. Lượt tiếp theo sẽ tự động dùng model đang hoạt động: {info?.effectiveModelName || info?.effectiveModelID}.</div>}
      {error && <div className="inline-error" role="alert">{formatAmeKitError(error).title}{formatAmeKitError(error).detail && <p>{formatAmeKitError(error).detail}</p>}</div>}
      <div ref={stream} className="chat-stream translation-modal__timeline" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}><div className="chat-stream__inner">
        {!info ? <p role="status">Đang tải cấu hình dịch…</p> : sessionID && !loaded ? <p role="status">Đang tải phiên dịch…</p> : !messages.length && !locked ? <div className="translation-presets"><h3>Chỉ dịch Android Strings</h3><p>Chỉ bản địa hóa res/values*/strings.xml và i18n/translation-context.md. Dùng Chat chính cho yêu cầu lập trình khác.</p><div className="translation-presets__grid"><button type="button" disabled={!available} onClick={() => void send(updatePrompt, 'update')}><strong>Cập nhật string mới (Update)</strong><span>Đồng bộ key mới và thay đổi với các locale hiện có.</span></button><button type="button" disabled={!available} onClick={() => { setText(fullPrompt); setMode('full'); input.current?.focus() }}><strong>Thêm ngôn ngữ mới (Full)</strong><span>Chọn mã locale và ngữ cảnh trước khi gửi.</span></button><button type="button" disabled={!available} onClick={() => void send(scanPrompt, 'scan')}><strong>Quét key thiếu / lỗi (Scan)</strong><span>Chỉ báo cáo, chưa sửa tệp.</span></button></div></div> : turns.map(turn => <section key={turn.id} className="chat-turn">
          {turn.user && <article className="msg-user"><MessageContent text={extractUserDisplayText(turn.user.text) || '…'} onOpenFile={onOpenFile} /></article>}
          <div className="msg-turn-body">{turn.blocks.map(block => {
            if (block.kind === 'work-group') return <TurnWorkGroup key={block.id} id={block.id} items={block.items} summary={block.summary} live={block.live} defaultOpen={block.defaultOpen} {...actions} />
            if (block.kind === 'active-tools') return <ActiveToolsView key={block.id} items={block.items} {...actions} />
            if (block.kind === 'live-status') return <LiveTurnStatus key={block.id} label={forms.length ? 'Đang chờ bạn trả lời câu hỏi…' : block.label} />
            if (block.kind === 'error') return <div key={block.id} className="inline-error" role="alert">{block.item.text}{/compaction|token limit|context/i.test(block.item.text) && <p>Ngữ cảnh phiên đã quá dài khiến bước tóm tắt bị vượt giới hạn token. Hãy bấm Phiên dịch mới (hoặc tạo cuộc trò chuyện mới) để tiếp tục.</p>}</div>
            const item = block.item
            if (block.kind === 'tool' && item.tool?.name === 'question' && (item.tool.status === 'running' || item.tool.status === 'streaming') && (running || forms.length > 0)) return <ActiveToolsView key={block.id} items={[item]} {...actions} />
            return <article key={block.id} className="msg-agent">{block.kind === 'tool' && item.tool ? <ToolCard call={item.tool} {...actions} /> : block.kind === 'changes' && item.turn && sessionID ? <TurnChanges projectID={projectID} sessionID={sessionID} from={item.turn.from} files={item.turn.files} theme={theme} /> : block.kind === 'reasoning' ? <details className="thought-block"><summary>Suy nghĩ</summary><MessageContent text={item.text || '…'} onOpenFile={onOpenFile} /></details> : <MessageContent text={item.text || '…'} onOpenFile={onOpenFile} />}</article>
          })}</div>
        </section>)}
        {interruptedQuestion && <div className="warning" role="status">Câu hỏi trước đó đã bị gián đoạn và không còn hiệu lực. Bạn có thể trả lời tiếp ở ô nhập bên dưới, bấm Phiên dịch mới, hoặc Hoàn tất &amp; đóng.</div>}
        {!locked && forms.map(form => <SessionFormCard key={`${sessionID}:${form.id}`} projectID={projectID} form={form} disabled={!connected} onResolved={id => { setForms(current => current.filter(form => form.id !== id)); setRevision(value => value + 1) }} />)}
        {!locked && permissions.map(permission => <section className="permission" key={permission.id} role="alert"><h3>Yêu cầu quyền</h3><p>{permission.title}</p><div className="button-row"><button disabled={replying || !connected} onClick={() => void reply(permission, 'once')}>Cho phép một lần</button><button disabled={replying || !connected} onClick={() => void reply(permission, 'always')}>Luôn cho phép</button><button disabled={replying || !connected} onClick={() => void reply(permission, 'reject')}>Từ chối</button></div></section>)}
      </div></div>
      {locked ? <div className="translation-locked-banner" role="status"><Icon name="lock" /><p>Phiên dịch đã hoàn tất và được khóa vĩnh viễn. Nội dung chỉ đọc.</p><button type="button" disabled={busy || operation.current} onClick={newSession}>Phiên dịch mới</button></div> : <div className="composer-dock translation-composer"><div className="composer-dock__inner">
        {mode === 'full' && <button type="button" className="amekit-pill" onClick={() => setMode('incremental')}>Full × · Chuyển về dịch bổ sung</button>}
        {!running && messages.length > 0 && (session?.outcome === 'failed' ? <div className="inline-error" role="alert"><p>Lượt dịch gần nhất gặp lỗi và chưa hoàn tất. Hãy xem chi tiết lỗi ở trên hoặc bấm Phiên dịch mới để chạy lại.</p><button type="button" disabled={busy || operation.current} onClick={newSession}>Phiên dịch mới</button></div> : <div className="translation-finish-banner"><p>Đã dịch xong? Hoàn tất để khóa phiên và tránh dùng nhầm model cho việc code.</p><button type="button" className="translation-primary" disabled={finishDisabled} onClick={() => void finish()}>✓ Hoàn tất &amp; đóng</button></div>)}
        <form className="composer-card translation-composer__form" onSubmit={event => { event.preventDefault(); void send() }}><textarea ref={input} className="composer-input translation-composer__input" aria-label="Yêu cầu dịch Android" placeholder="Nhập yêu cầu dịch strings.xml…" rows={3} value={text} disabled={!available} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} /><div className="translation-composer__toolbar"><span>Chỉ Android Strings · Shift+Enter xuống dòng</span><div className="button-row">{running && sessionID && <button type="button" disabled={!connected || busy} onClick={() => { void window.ame.cancel(projectID, sessionID).catch(e => { if (mounted.current && currentSession.current === sessionID) setError(errorText(e)) }).finally(() => { if (mounted.current && currentSession.current === sessionID) setRevision(value => value + 1) }) }}>Dừng phản hồi</button>}<button type="submit" className="translation-primary" disabled={!available || !text.trim()}>Gửi yêu cầu dịch</button></div></div></form>
      </div></div>}
    </div>
  </div>
}
