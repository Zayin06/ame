import { useEffect, useMemo, useRef, useState } from 'react'
import { extractCommitSnapshotID, inspectCommitAgentPlan } from '../../../../../packages/amekit/src/commit-plan'
import type { ChatItem, CommitAgentInfo, CommitAgentMode, CommitAgentStoredPlan, Model, Permission, Session, SessionForm } from '../../../../../packages/protocol/src/index'
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
const drafts = new Map<string, string>()
const draftRevisions = new Map<string, number>()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type Props = {
  projectID: string; projectName?: string; projectDirectory?: string; connected: boolean; theme: 'dark' | 'light'
  timelineDetail?: TimelineDetailMode
  initialSessionID?: string
  onClose: () => void; onActivity: () => void; onGitRefresh: () => void
  onApplyCommitMessage: (message: string) => void; onOpenFile: (path: string, line?: number) => void
}

export function CommitAgentModal({ projectID, projectName, projectDirectory, connected, theme, timelineDetail = 'compact', initialSessionID, onClose, onActivity, onGitRefresh, onApplyCommitMessage, onOpenFile }: Props) {
  const [info, setInfo] = useState<CommitAgentInfo>()
  const [planSnapshots, setPlanSnapshots] = useState<Record<string, CommitAgentStoredPlan>>({})
  const [session, setSession] = useState<Session | undefined>(initialSessionID !== undefined ? { id: initialSessionID, title: 'Trợ lý Commit AI' } : undefined)
  const [model, setModel] = useState<Model>()
  const [disabledSessionModel, setDisabledSessionModel] = useState(false)
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [forms, setForms] = useState<SessionForm[]>([])
  const [text, updateText] = useState(() => drafts.get(projectID) ?? '')
  const setText = (value: string) => { draftRevisions.set(projectID, (draftRevisions.get(projectID) ?? 0) + 1); if (value) drafts.set(projectID, value); else drafts.delete(projectID); updateText(value) }
  const [busy, setBusy] = useState(false)
  const [replying, setReplying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [sessionStateReady, setSessionStateReady] = useState(false)
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
  // Never replace a previously bound snapshot, including after a Git refresh.
  const mergePlans = (plans: Record<string, CommitAgentStoredPlan>) => setPlanSnapshots(current => {
    const next = { ...current }
    for (const [id, plan] of Object.entries(plans)) {
      const previous = current[id]
      next[id] = previous ? { ...previous, status: previous.status === 'active' || previous.status === 'executing' ? plan.status : previous.status } : { ...plan, snapshot: { ...plan.snapshot, stagedFiles: [...plan.snapshot.stagedFiles], workingFiles: [...plan.snapshot.workingFiles], untrackedHashes: plan.snapshot.untrackedHashes && { ...plan.snapshot.untrackedHashes } } }
    }
    return next
  })
  const turns = useMemo(() => projectChatTimeline(messages, { running, mode: timelineDetail, pendingForms: forms.length > 0 }), [messages, running, timelineDetail, forms.length])
  const planCards = turns.flatMap(turn => turn.blocks.flatMap(block => {
    const inspection = block.kind === 'text' ? inspectCommitAgentPlan(block.item.text) : null
    return inspection ? [{ turn, block, inspection, key: `${sessionID}:${turn.id}:${block.id}` }] : []
  }))
  const latestPlan = planCards.at(-1)

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
        if (value.plans) mergePlans(value.plans)
        if (!initialized.current) {
          initialized.current = true
          const id = initialSessionID ?? value.commitSessionIDs.filter(id => !value.lockedSessionIDs.includes(id)).at(-1)
          if (id) setSession({ id, title: 'Trợ lý Commit AI' })
        }
      } catch (e) { if (alive && request === generation) setError(errorText(e)) }
    }
    void load()
    window.addEventListener('ame-account-changed', load)
    window.addEventListener('ame-bundle-updated', load)
    window.addEventListener('ame-commit-agent-changed', load)
    const unsubscribe = window.ame.onEvent(event => { if (event.type === 'opencode' && event.projectID === projectID) { clearTimeout(timer); timer = setTimeout(() => void load(), 300) } })
    return () => { alive = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('ame-account-changed', load); window.removeEventListener('ame-bundle-updated', load); window.removeEventListener('ame-commit-agent-changed', load) }
  }, [projectID, connected])

  useEffect(() => {
    setSessionStateReady(false)
    if (!sessionID || !connected) return
    let alive = true, loading = false, queued = false
    const load = async () => {
      if (!alive) return
      if (loading) { queued = true; return }
      loading = true
      try {
        const [items, pending, sessions, pendingForms] = await Promise.allSettled([window.ame.messages(projectID, sessionID), window.ame.permissions(projectID, sessionID), window.ame.sessions(projectID), window.ame.forms(projectID, sessionID)])
        if (!alive) return
        if (items.status === 'fulfilled') setMessages(current => same(current, items.value) ? current : items.value)
        if (pending.status === 'fulfilled') setPermissions(current => same(current, pending.value) ? current : pending.value)
        if (pendingForms.status === 'fulfilled') setForms(current => same(current, pendingForms.value) ? current : pendingForms.value)
        setLoaded(true)
        const failed = [items, pending, sessions, pendingForms].find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') setError(`Không tải được một phần dữ liệu phiên commit: ${errorText(failed.reason)}`)
        const latest = sessions.status === 'fulfilled' ? sessions.value.find(item => item.id === sessionID) : undefined
        setSessionStateReady(sessions.status === 'fulfilled' && pending.status === 'fulfilled' && pendingForms.status === 'fulfilled' && latest?.status === 'idle')
        if (latest) setSession(current => same(current, latest) ? current : latest)
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
    if (!sessionID || !connected) { setModel(undefined); setDisabledSessionModel(false); return }
    let alive = true, generation = 0
    const load = async () => {
      const request = ++generation
      try {
        const [map, models] = await Promise.all([window.ame.agentMap(projectID, sessionID), window.ame.models(projectID)])
        if (!alive || request !== generation) return
        const root = map.nodes.find(node => node.id === sessionID)
        const active = models.find(model => model.providerID === 'amecode' && model.providerID === (root?.providerID || 'amecode') && (model.id === root?.model || model.modelID === root?.model))
        setModel(root?.model ? active : undefined)
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

  const send = async (value = text, mode: CommitAgentMode = 'custom') => {
    if (!available || !value.trim() || operation.current) return
    operation.current = true; setBusy(true); setSessionStateReady(false); setError(''); setApplied('')
    const request = epoch.current
    const draftRevision = draftRevisions.get(projectID)
    try {
      const result = await window.ame.commitAgentPrompt(projectID, sessionID, value.trim(), mode)
      if (draftRevisions.get(projectID) === draftRevision) drafts.delete(projectID)
      notify(); callbacks.current.onActivity()
      if (!mounted.current || request !== epoch.current) return
      setSession(result.session); currentSession.current = result.session.id; setModel(result.model); setDisabledSessionModel(false)
      if (result.planID && result.snapshot) mergePlans({ [result.planID]: { planID: result.planID, snapshot: result.snapshot, status: 'active' } })
      setText(''); setLoaded(false); setRevision(value => value + 1)
      if (result.locked) setInfo(current => current ? { ...current, lockedSessionIDs: [...new Set([...current.lockedSessionIDs, result.session.id])] } : current)
    } catch (e) {
      if (mounted.current && request === epoch.current) {
        const message = errorText(e); setError(message)
        if (message.includes('COMMIT_SESSION_LOCKED')) { if (sessionID) setInfo(current => current ? { ...current, lockedSessionIDs: [...new Set([...current.lockedSessionIDs, sessionID])] } : current); notify() }
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const finishDisabled = !connected || !sessionID || busy || running || locked || !loaded || !sessionStateReady || session?.status !== 'idle' || permissions.length > 0 || forms.length > 0
  const executePlan = async (plan: NonNullable<ReturnType<typeof inspectCommitAgentPlan>>['plan'], key: string, planID: string | null) => {
    const stored = planID ? planSnapshots[planID] : undefined
    if (!planID || !connected || !sessionID || busy || running || locked || !stored || stored.status !== 'active' || key !== latestPlan?.key || latestPlan.inspection.violations.length > 0 || operation.current) return
    const id = sessionID, request = epoch.current, snapshot = stored.snapshot
    const valid = () => mounted.current && request === epoch.current && currentSession.current === id
    operation.current = true; setBusy(true); setError(''); setApplied('')
    try {
      const result = await window.ame.commitAgentExecutePlan(projectID, id, { planID, scope: plan.scope ?? snapshot.scope, snapshot: { head: snapshot.head, branchRef: snapshot.branchRef, indexHash: snapshot.indexHash, workingHash: snapshot.workingHash, untrackedHashes: snapshot.untrackedHashes }, commits: plan.commits })
      if (result.commits.length > 0) callbacks.current.onGitRefresh()
      if (!valid()) return
      const created = `Đã tạo commit: ${result.commits.map(commit => commit.hash).join(', ')}`
      setPlanSnapshots(current => ({ ...current, [planID]: { ...stored, status: result.partialFailure ? 'stale' : 'executed' } }))
      if (result.commits.length > 0) setApplied(created)
      if (result.partialFailure) setError(`${created}. Dừng tại nhóm #${result.partialFailure.failedGroupIndex + 1}: ${result.partialFailure.failedSubject}. ${result.partialFailure.message}`)
      if (result.commits.length > 0) {
        const value = await window.ame.commitAgentInfo(projectID)
        if (valid()) { setInfo(value); if (value.plans) mergePlans(value.plans) }
      }
    } catch (e) {
      if (!valid()) return
      const message = errorText(e)
      setError(message.includes('COMMIT_PLAN_HOOK_MODIFIED_TREE') ? 'Git hook đã thay đổi cây làm việc. Hãy lập lại kế hoạch trước khi duyệt.' : message.includes('COMMIT_PLAN_STALE') ? 'Trạng thái Git đã thay đổi kể từ khi lập kế hoạch. Hãy bấm hoặc gửi yêu cầu "Lập lại kế hoạch" trước khi duyệt.' : /COMMIT_PLAN_.*MISMATCH/.test(message) ? 'Kế hoạch không khớp với dữ liệu đã lưu. Hãy lập lại kế hoạch trước khi duyệt.' : message.includes('COMMIT_PLAN_ABORTED') ? 'Thực thi kế hoạch đã bị hủy. Hãy lập lại kế hoạch trước khi duyệt.' : message)
      if (/COMMIT_PLAN_(STALE|ABORTED|HOOK_MODIFIED_TREE)/.test(message)) {
        setPlanSnapshots(current => ({ ...current, [planID]: { ...stored, status: 'stale' } }))
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
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
    setMessages([]); setPermissions([]); setForms([]); setText(''); setLoaded(false); setSessionStateReady(false); setError(''); setApplied(''); follow.current = true
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
      {disabledSessionModel && <div className="warning" role="status">Model trước đó của phiên đã bị vô hiệu hóa từ API. Lượt tiếp theo sẽ tự động dùng model đang hoạt động: {info?.effectiveModelName || info?.effectiveModelID}.</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {applied && <div role="status">{applied}</div>}
      <div ref={stream} className="chat-stream translation-modal__timeline" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}><div className="chat-stream__inner">
        {!info ? <p role="status">Đang tải cấu hình commit…</p> : sessionID && !loaded ? <p role="status">Đang tải phiên commit…</p> : !messages.length && !locked ? <div className="translation-presets"><h3>Commit rõ ràng, thay đổi atomic</h3><p>Phân tích diff trong phiên riêng. Xác nhận cách tách trước khi agent thực thi commit.</p><div className="translation-presets__grid">{presets.map(preset => <button key={preset.mode} type="button" disabled={!available} onClick={() => void send(preset.text, preset.mode)}><strong>{preset.title}</strong><span>{preset.text}</span></button>)}</div></div> : turns.map(turn => <section key={turn.id} className="chat-turn">
          {turn.user && <article className="msg-user"><MessageContent text={extractUserDisplayText(turn.user.text) || '…'} onOpenFile={onOpenFile} /></article>}
          <div className="msg-turn-body">{turn.blocks.map(block => {
            if (block.kind === 'work-group') return <TurnWorkGroup key={block.id} id={block.id} items={block.items} summary={block.summary} live={block.live} defaultOpen={block.defaultOpen} {...actions} />
            if (block.kind === 'active-tools') return <ActiveToolsView key={block.id} items={block.items} {...actions} />
            if (block.kind === 'live-status') return <LiveTurnStatus key={block.id} label={forms.length ? 'Đang chờ bạn trả lời câu hỏi…' : block.label} />
            if (block.kind === 'error') return <div key={block.id} className="inline-error" role="alert">{block.item.text}{/compaction|token limit|context/i.test(block.item.text) && <p>Ngữ cảnh phiên vượt giới hạn token. Hãy mở Phiên mới để tiếp tục.</p>}</div>
            const item = block.item
            if (block.kind === 'tool' && item.tool?.name === 'question' && (item.tool.status === 'running' || item.tool.status === 'streaming') && running) return <ActiveToolsView key={block.id} items={[item]} {...actions} />
             const commits = block.kind === 'text' ? extractCommitMessagesFromText(item.text) : []
              const inspection = block.kind === 'text' ? inspectCommitAgentPlan(item.text) : null
              const plan = inspection?.plan
             const planID = turn.user ? (info?.messagePlanIDs?.[turn.user.id] ?? extractCommitSnapshotID(turn.user.text)) : null
             const key = `${sessionID}:${turn.id}:${block.id}`
             const stored = planID ? planSnapshots[planID] : undefined
             const boundSnapshot = stored?.snapshot
              const reason = inspection?.violations.length ? inspection.violations.map(v => `Nhóm #${v.groupIndex + 1} có ${v.fileCount} tệp, vượt giới hạn ${v.maxFiles} tệp/nhóm — hãy yêu cầu chia nhóm trước khi duyệt.`).join(' ') : !planID || !boundSnapshot ? 'Snapshot không còn trong phiên — hãy lập lại kế hoạch' : key !== latestPlan?.key ? 'Kế hoạch đã được thay thế' : stored?.status === 'executing' ? 'Kế hoạch đang được thực thi…' : stored?.status === 'executed' ? 'Kế hoạch này đã thực thi' : stored?.status === 'stale' ? 'Kế hoạch đã cũ — hãy yêu cầu lập lại kế hoạch' : stored?.status === 'superseded' ? 'Kế hoạch đã được thay thế' : ''
             return <article key={block.id} className="msg-agent">{block.kind === 'tool' && item.tool ? <ToolCard call={item.tool} {...actions} /> : block.kind === 'changes' && item.turn && sessionID ? <TurnChanges projectID={projectID} sessionID={sessionID} from={item.turn.from} files={item.turn.files} theme={theme} /> : block.kind === 'reasoning' ? <details className="thought-block"><summary>Suy nghĩ</summary><MessageContent text={item.text || '…'} onOpenFile={onOpenFile} /></details> : <MessageContent text={item.text || '…'} onOpenFile={onOpenFile} />}{commits.length > 0 && <div className="button-row commit-agent-modal__apply">{commits.map((message, index) => <button key={index} type="button" onClick={() => { onApplyCommitMessage(message); setApplied('Đã điền vào ô Commit') }}>{commits.length === 1 ? 'Điền vào ô Commit' : `Điền commit #${index + 1}`}</button>)}</div>}{plan && !locked && !running && <section data-testid="commit-plan-approval">
               <h3>Kế hoạch Commit chờ duyệt</h3>{boundSnapshot && <><p>Nhánh: {boundSnapshot.branch || boundSnapshot.branchRef}</p><p>Phạm vi: {plan.scope ?? boundSnapshot.scope}</p><p>HEAD: <code>{boundSnapshot.head}</code></p></>}
              <ol>{plan.commits.map((commit, index) => <li key={index}><strong>{index + 1}. {commit.message.split('\n')[0]}</strong><ul>{commit.files.map(file => <li key={file} style={{ whiteSpace: 'pre' }}>{/^\s|\s$/.test(file) ? <code>{JSON.stringify(file)}</code> : file}</li>)}</ul></li>)}</ol>
               {reason && <p role="status">{reason}</p>}
               <button type="button" data-testid="commit-plan-execute-btn" disabled={!!reason || !connected || busy || !sessionID} onClick={() => { if (!inspection?.violations.length) void executePlan(plan, key, planID) }}>Duyệt &amp; thực thi {plan.commits.length} commit</button>
               {reason && key === latestPlan?.key && <button type="button" disabled={!available} onClick={() => void send('Lập lại kế hoạch')}>Lập lại kế hoạch</button>}
            </section>}</article>
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
