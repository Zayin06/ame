import { useEffect, useRef, useState } from 'react'
import type { DiffTarget, GitCommitDetail, GitCommitSummary, GitStashEntry, GitState } from '../../../../../packages/protocol/src/index'
import { analyzeCommitMessage, formatGitError, formatRelativeGitDate, syncBadgeSummary } from '../git-ui'
import { canCommit, commitShortcut } from '../scm-commit'
import { FileTypeIcon } from './FileTypeIcon'
import { Icon } from './Icon'
import { BuildNotesPanel } from './BuildNotesPanel'

export type GitWorkspaceTab = 'commit' | 'history' | 'stash' | 'build-notes'
export type GitWorkspaceProps = {
  projectID: string
  projectName?: string
  connected: boolean
  git?: GitState
  gitError: string
  generation: number
  activeTab: GitWorkspaceTab
  onSelectTab: (tab: GitWorkspaceTab) => void
  message: string
  onMessageChange: (value: string) => void
  amend: boolean
  onAmendChange: (value: boolean) => void
  noVerify: boolean
  onNoVerifyChange: (value: boolean) => void
  commitEnhanceSkill: string
  onDiff: (path: string, target?: DiffTarget) => void
  onOpenFile?: (path: string, line?: number) => void
  onOpenCommitAgent?: () => void
  onClose: () => void
  refresh: () => void
}

const cancelled = (error: unknown) => /\bCANCELLED\b/.test(String(error))

export function GitWorkspace(props: GitWorkspaceProps) {
  const { projectID, generation, git, activeTab, message, amend, noVerify, onMessageChange, refresh } = props
  const [pendingBaseCommit, setPendingBaseCommit] = useState('')
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ReturnType<typeof formatGitError>>()
  const [notice, setNotice] = useState('')
  const [commits, setCommits] = useState<GitCommitSummary[]>([])
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [selectedHash, setSelectedHash] = useState('')
  const [detail, setDetail] = useState<GitCommitDetail>()
  const [query, setQuery] = useState('')
  const [stashNote, setStashNote] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)
  const [revision, setRevision] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [stashLoading, setStashLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const mounted = useRef(false)
  const scope = useRef({ projectID, generation })
  const lock = useRef<object | null>(null)
  if (scope.current.projectID !== projectID || scope.current.generation !== generation) scope.current = { projectID, generation }
  const context = scope.current
  const current = () => mounted.current && scope.current === context
  const report = (reason: unknown) => { if (current() && !cancelled(reason)) setError(formatGitError(reason)) }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; lock.current = null }
  }, [])

  useEffect(() => {
    lock.current = null
    setPending(''); setError(undefined); setNotice('')
    setCommits([]); setStashes([]); setSelectedHash(''); setDetail(undefined)
    setQuery(''); setStashNote(''); setIncludeUntracked(true); setPendingBaseCommit('')
  }, [projectID])

  useEffect(() => {
    lock.current = null
    setPending('')
  }, [projectID, generation])

  useEffect(() => {
    let active = true
    setStashLoading(true)
    void (async () => {
      try {
        const result = await window.ame.gitStashList(projectID)
        if (active && current()) setStashes(result)
      } catch (reason) { if (active) report(reason) }
      finally { if (active && current()) setStashLoading(false) }
    })()
    return () => { active = false }
  }, [projectID, generation, revision])

  useEffect(() => {
    if (activeTab !== 'history') return
    let active = true
    setHistoryLoading(true)
    void (async () => {
      try {
        const result = await window.ame.gitLog(projectID, 50)
        if (active && current()) {
          setCommits(result)
          setSelectedHash(hash => result.some(commit => commit.hash === hash) ? hash : '')
        }
      } catch (reason) { if (active) report(reason) }
      finally { if (active && current()) setHistoryLoading(false) }
    })()
    return () => { active = false }
  }, [projectID, generation, activeTab, revision])

  useEffect(() => {
    setDetail(undefined)
    setDetailLoading(false)
    if (activeTab !== 'history' || !selectedHash) return
    let active = true
    setDetailLoading(true)
    void (async () => {
      try {
        const result = await window.ame.gitCommitDetail(projectID, selectedHash)
        if (active && current()) setDetail(result)
      } catch (reason) { if (active) report(reason) }
      finally { if (active && current()) setDetailLoading(false) }
    })()
    return () => { active = false }
  }, [projectID, generation, activeTab, selectedHash, revision])

  const busy = !!pending
  const changes = git?.changes ?? []
  const stagedChanges = changes.filter(file => !!file.index.trim() && !['?', '!'].includes(file.index))
  const workingChanges = changes.filter(file => (!!file.working.trim() && file.working !== '!') || file.index === '?')
  const commitState = { busy, message, changes, amend }
  const stats = analyzeCommitMessage(message)
  const sync = syncBadgeSummary(git)
  const displayedError = error ?? (props.gitError && !cancelled(props.gitError) ? formatGitError(props.gitError) : undefined)

  async function run(label: string, operation: (valid: () => boolean) => Promise<void>, refreshAfter = true) {
    if (!current() || lock.current) return
    const token = {}
    lock.current = token
    const valid = () => current() && lock.current === token
    setPending(label); setError(undefined); setNotice('')
    try {
      await operation(valid)
      if (valid()) setNotice(`${label}: Hoàn tất`)
    } catch (reason) { if (valid()) report(reason) }
    finally {
      if (valid()) {
        lock.current = null
        setPending('')
        if (refreshAfter) { setRevision(value => value + 1); refresh() }
      }
    }
  }

  async function submitCommit(push: boolean) {
    if (!canCommit(commitState) || (push && !git?.hasRemote)) return
    await run(push ? 'Commit & Push' : 'Commit', async valid => {
      await window.ame.commit(projectID, message, { amend, noVerify })
      if (!valid()) return
      onMessageChange('')
      if (amend) props.onAmendChange(false)
      if (push) await window.ame.gitPush(projectID)
    })
  }

  function enhance() {
    if (!props.connected || !stagedChanges.length) return
    void run('Enhance bằng AI', async valid => {
      const result = await window.ame.generateCommitMessage(projectID)
      if (valid()) onMessageChange(result.message)
    }, false)
  }

  function undo() {
    void run('Hoàn tác commit cuối', async valid => {
      const result = await window.ame.gitUndoLastCommit(projectID)
      if (valid() && result.message.trim()) onMessageChange(result.message)
    })
  }

  function toggleAmend(value: boolean) {
    props.onAmendChange(value)
    if (value && !message.trim()) void run('Đọc commit gần nhất', async valid => {
      const [last] = await window.ame.gitLog(projectID, 1)
      if (valid() && last) onMessageChange(last.subject + (last.body ? `\n\n${last.body}` : ''))
    }, false)
  }

  function quickSync(action: 'fetch' | 'pull' | 'push') {
    if (!git?.hasRemote) return
    void run(action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull' : 'Push', async valid => {
      const result = await (action === 'fetch' ? window.ame.gitFetch(projectID) : action === 'pull' ? window.ame.gitPull(projectID) : window.ame.gitPush(projectID, { setUpstream: sync.needsPublish }))
      if (valid() && result.conflicts?.length) throw new Error('GIT_CONFLICT')
    })
  }

  const filteredCommits = commits.filter(commit => `${commit.subject}\n${commit.body}\n${commit.author}\n${commit.hash}`.toLowerCase().includes(query.trim().toLowerCase()))

  return <main data-testid="git-workspace" className="git-workspace" data-region="Git Workspace">
    <header className="git-workspace__header">
      <button type="button" data-testid="git-workspace-close" onClick={props.onClose}>← Quay lại Chat</button>
      <h1>{props.projectName ?? projectID}</h1>
      <span className="git-workspace__branch"><Icon name="git" />{git?.branch ?? 'Git'}</span>
      {git?.tracking && <span>{git.tracking}</span>}
      <span className="git-workspace__sync">{sync.statusText}</span>
      <div className="git-workspace__sync-actions">
        <button type="button" disabled={!git?.hasRemote || busy} onClick={() => quickSync('fetch')}><Icon name="refresh" />Fetch</button>
        <button type="button" disabled={!git?.hasRemote || busy} onClick={() => quickSync('pull')}><Icon name="download" />{sync.pullLabel}</button>
        <button type="button" disabled={!git?.hasRemote || busy} onClick={() => quickSync('push')}><Icon name="upload" />{sync.pushLabel}</button>
      </div>
      <div role="tablist" aria-label="Git Workspace">
        {(['commit', 'history', 'stash', 'build-notes'] as const).map(tab => <button type="button" key={tab} id={`git-workspace-tab-${tab}`} role="tab" aria-selected={activeTab === tab} aria-controls={`git-workspace-panel-${tab}`} onClick={() => props.onSelectTab(tab)}>
          {tab === 'commit' ? 'Soạn Commit' : tab === 'history' ? 'Lịch sử' : tab === 'build-notes' ? 'Build Notes' : `Stash (${stashes.length})`}
        </button>)}
      </div>
    </header>
    {displayedError && <div role="alert"><strong>{displayedError.title}</strong>{displayedError.detail && <p>{displayedError.detail}</p>}</div>}
    {pending ? <div role="status"><span className="amekit-spinner" aria-hidden="true" />{pending}…</div> : notice && <div role="status">{notice}</div>}
    <section role="tabpanel" id={`git-workspace-panel-${activeTab}`} aria-labelledby={`git-workspace-tab-${activeTab}`}>
      {activeTab === 'commit' && <>
        <div className="git-composer">
          <div className="git-composer__stats">
            <span className={stats.subjectOverLimit ? 'git-composer__counter is-over' : 'git-composer__counter'}>Tiêu đề: {stats.subjectLength}/72</span>
            <span>{stats.lineCount} dòng</span><span>{props.commitEnhanceSkill ? `/ ${props.commitEnhanceSkill}` : 'Conventional Commits'}</span>
          </div>
          <div className="git-composer__toolbar">
            <button type="button" data-testid="git-workspace-enhance-btn" disabled={!props.connected || busy || !stagedChanges.length} aria-busy={pending === 'Enhance bằng AI'} onClick={enhance}>
              {pending === 'Enhance bằng AI' ? <span className="amekit-spinner" aria-hidden="true" /> : <Icon name="wand" />}Enhance bằng AI
            </button>
            <button type="button" data-testid="git-workspace-commit-agent-btn" disabled={!props.connected || busy || !changes.length || !props.onOpenCommitAgent} title="Mở phiên agent có tool để đọc đủ diff, hỏi xác nhận và tách nhiều commit" onClick={() => props.onOpenCommitAgent?.()}><Icon name="wand" />Trợ lý Commit AI</button>
            <button type="button" data-testid="git-workspace-undo-commit-btn" disabled={busy} onClick={undo}><Icon name="undo" />Hoàn tác commit cuối</button>
            <button type="button" disabled={busy || !message} onClick={() => { setError(undefined); onMessageChange('') }}>Xóa nội dung</button>
          </div>
          <textarea data-testid="git-workspace-commit-input" className="git-composer__textarea" rows={9} aria-label="Thông điệp commit mở rộng" value={message} disabled={busy}
            onChange={event => { setError(undefined); setNotice(''); onMessageChange(event.target.value) }} onKeyDown={event => commitShortcut(event, commitState, () => void submitCommit(false))} />
          <div className="git-composer__options">
            <label><input type="checkbox" checked={amend} disabled={busy} onChange={event => toggleAmend(event.target.checked)} />Sửa commit gần nhất (Amend)</label>
            <label><input type="checkbox" checked={noVerify} disabled={busy} onChange={event => props.onNoVerifyChange(event.target.checked)} />Bỏ qua Git hooks (--no-verify)</label>
          </div>
          <div className="git-composer__actions">
            <button type="button" className="primary" data-testid="git-workspace-commit-btn" disabled={!canCommit(commitState)} onClick={() => void submitCommit(false)}><Icon name="check" />Commit</button>
            <button type="button" data-testid="git-workspace-commit-push-btn" disabled={!canCommit(commitState) || !git?.hasRemote} onClick={() => void submitCommit(true)}>Commit &amp; Push</button>
          </div>
        </div>
        <section className="git-staged-summary" aria-label="Staged Changes">
          <header><h2>Staged Changes ({stagedChanges.length})</h2>
            {workingChanges.length > 0 && <button type="button" disabled={busy} onClick={() => void run('Stage tất cả', async () => { await window.ame.stageAll(projectID) })}>Stage tất cả ({workingChanges.length} tệp)</button>}
          </header>
          {!changes.length && <p>Cây làm việc sạch. Dùng Amend hoặc tạo thay đổi mới trước khi commit.</p>}
          {!!changes.length && !stagedChanges.length && <p>Stage tệp để bắt đầu soạn commit.</p>}
          <ul>{stagedChanges.map(file => <li key={file.path}>
            <button type="button" onClick={() => props.onDiff(file.path, { kind: 'staged' })}><FileTypeIcon path={file.path} />{file.path}<span>{file.index}</span></button>
            <button type="button" aria-label={`Bỏ stage ${file.path}`} disabled={busy} onClick={() => void run('Bỏ stage', async () => { await window.ame.stage(projectID, file.path, false) })}>Bỏ stage</button>
          </li>)}</ul>
        </section>
      </>}
      {activeTab === 'history' && <div className="git-history">
        <div className="git-history__toolbar">
          <input aria-label="Tìm commit" placeholder="Tìm commit theo nội dung, tác giả, mã hash..." value={query} onChange={event => setQuery(event.target.value)} />
          <button type="button" disabled={busy || historyLoading} onClick={() => { setError(undefined); setRevision(value => value + 1) }}>Làm mới</button>
        </div>
        {historyLoading && <p role="status">Đang tải lịch sử…</p>}
        {!historyLoading && !filteredCommits.length && <p>Không có commit phù hợp.</p>}
        <ul className="git-history__list" style={{ overflowY: 'auto' }}>{filteredCommits.map(commit => <li key={commit.hash}>
          <button type="button" aria-pressed={selectedHash === commit.hash} onClick={() => { setError(undefined); setSelectedHash(commit.hash) }}>
            <code>{commit.shortHash}</code><strong>{commit.subject}</strong><span>{commit.author}</span><time dateTime={commit.date}>{formatRelativeGitDate(commit.date)}</time>
            {commit.refs.map(ref => <span className="git-history__ref" key={ref}>{ref}</span>)}
          </button>
          <button type="button" onClick={() => { setPendingBaseCommit(commit.hash); props.onSelectTab('build-notes') }}>Build Notes từ mốc này</button>
          {commit.hash === commits[0]?.hash && <button type="button" disabled={busy} onClick={undo}>Hoàn tác (Soft Reset)</button>}
        </li>)}</ul>
        {detailLoading && <p role="status">Đang tải commit…</p>}
        {detail && <article className="git-history__detail">
          <h2>{detail.subject}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{detail.body}</p>
          <ul>{detail.files.map(file => <li key={file.path}><button type="button" onClick={() => props.onDiff(file.path, { kind: 'commit', commit: detail.hash })}><span>{file.status}</span><FileTypeIcon path={file.path} />{file.path}<span>+{file.additions} −{file.deletions}</span></button></li>)}</ul>
          <pre className="git-commit-patch">{detail.patch}</pre>
        </article>}
      </div>}
      {activeTab === 'build-notes' && <BuildNotesPanel projectID={projectID} connected={props.connected} git={git} generation={generation} initialBaseCommit={pendingBaseCommit || undefined} onConsumeInitialBase={() => setPendingBaseCommit('')} onDiff={props.onDiff} onOpenFile={props.onOpenFile} />}
      {activeTab === 'stash' && <div className="git-stash">
        <form onSubmit={event => {
          event.preventDefault()
          if (stashLoading) return
          void run('Lưu Stash', async valid => {
            await window.ame.gitStashPush(projectID, stashNote, includeUntracked)
            if (valid()) setStashNote('')
          })
        }}>
          <input aria-label="Thông điệp stash" placeholder="Thông điệp stash (tùy chọn)" maxLength={500} value={stashNote} disabled={busy} onChange={event => setStashNote(event.target.value)} />
          <label><input type="checkbox" checked={includeUntracked} disabled={busy} onChange={event => setIncludeUntracked(event.target.checked)} />Gồm tệp mới (untracked)</label>
          <button type="submit" disabled={busy || stashLoading}><Icon name="stash" />Lưu Stash</button>
        </form>
        {stashLoading && <p role="status">Đang tải stash…</p>}
        {!stashLoading && !stashes.length && <p>Chưa có stash.</p>}
        <ul>{stashes.map(stash => <li key={stash.ref}>
          <code>{stash.ref}</code><span>{stash.branch}</span><strong>{stash.message}</strong><time dateTime={stash.date}>{formatRelativeGitDate(stash.date)}</time>
          <button type="button" disabled={busy || stashLoading} onClick={() => void run('Pop Stash', async () => { await window.ame.gitStashApply(projectID, stash.index, true) })}>Pop</button>
          <button type="button" disabled={busy || stashLoading} onClick={() => void run('Apply Stash', async () => { await window.ame.gitStashApply(projectID, stash.index, false) })}>Apply</button>
          <button type="button" disabled={busy || stashLoading} onClick={() => void run('Xóa Stash', async () => { await window.ame.gitStashDrop(projectID, stash.index) })}>Xóa</button>
        </li>)}</ul>
      </div>}
    </section>
  </main>
}
