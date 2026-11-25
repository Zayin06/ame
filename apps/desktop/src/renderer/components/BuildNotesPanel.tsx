import { useEffect, useRef, useState } from 'react'
import type { BuildNotesMode, BuildNotesPreview, BuildNotesRequest, BuildNotesResult, DiffTarget, GitCommitSummary, GitState } from '../../../../../packages/protocol/src/index'
import { formatBuildNotesError, markdownToPlainText, summarizeBuildScope } from '../build-notes-ui'
import { formatRelativeGitDate } from '../git-ui'
import { FileTypeIcon } from './FileTypeIcon'
import { Icon } from './Icon'
import { MessageContent } from './MessageContent'

export type BuildNotesPanelProps = {
  projectID: string
  connected: boolean
  git?: GitState
  generation: number
  initialBaseCommit?: string
  onConsumeInitialBase?: () => void
  onDiff: (path: string, target?: DiffTarget) => void
  onOpenFile?: (path: string, line?: number) => void
}

const cancelled = (reason: unknown) => /\bCANCELLED\b/.test(String(reason))

export function BuildNotesPanel({ projectID, connected, git, generation, initialBaseCommit, onConsumeInitialBase, onDiff, onOpenFile }: BuildNotesPanelProps) {
  const [mode, setMode] = useState<BuildNotesMode>('range')
  const [baseCommit, setBaseCommit] = useState('')
  const [selectedHashes, setSelectedHashes] = useState<string[]>([])
  const [commitFilter, setCommitFilter] = useState('')
  const [includeWorking, setIncludeWorking] = useState(true)
  const [extraNote, setExtraNote] = useState('')
  const [commits, setCommits] = useState<GitCommitSummary[]>([])
  const [preview, setPreview] = useState<BuildNotesPreview>()
  const [previewScope, setPreviewScope] = useState<BuildNotesRequest>()
  const [result, setResult] = useState<BuildNotesResult>()
  const [notesText, setNotesText] = useState('')
  const [viewMode, setViewMode] = useState<'preview' | 'edit'>('preview')
  const [error, setError] = useState<unknown>()
  const [copied, setCopied] = useState('')
  const [busy, setBusy] = useState(false)
  const [scopeProject, setScopeProject] = useState(projectID)
  const mounted = useRef(false)
  const scope = useRef({ projectID, generation })
  const lock = useRef<object | null>(null)
  if (scope.current.projectID !== projectID || scope.current.generation !== generation) scope.current = { projectID, generation }
  const context = scope.current
  const current = () => mounted.current && scope.current === context
  const report = (reason: unknown) => { if (current() && !cancelled(reason)) setError(reason) }
  const workingCount = git?.changes.length ?? 0

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; lock.current = null }
  }, [])

  useEffect(() => {
    setScopeProject(projectID)
    setMode('range'); setBaseCommit(''); setSelectedHashes([]); setCommitFilter('')
    setIncludeWorking(true); setExtraNote(''); setCommits([]); setPreview(undefined); setPreviewScope(undefined)
    setResult(undefined); setNotesText(''); setViewMode('preview'); setError(undefined); setCopied('')
  }, [projectID])

  useEffect(() => {
    lock.current = null
    setBusy(false)
  }, [projectID, generation])

  useEffect(() => {
    if (initialBaseCommit) {
      setMode('range'); setBaseCommit(initialBaseCommit)
      onConsumeInitialBase?.()
    }
  }, [projectID, initialBaseCommit])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const loaded = await window.ame.gitLog(projectID, 50)
        if (!active || !current()) return
        setCommits(loaded)
        const valid = new Set(loaded.map(commit => commit.hash))
        setBaseCommit(hash => valid.has(hash) ? hash : '')
        setSelectedHashes(hashes => hashes.every(hash => valid.has(hash)) ? hashes : hashes.filter(hash => valid.has(hash)))
      } catch (reason) { if (active) report(reason) }
    })()
    return () => { active = false }
  }, [projectID, generation])

  const request: BuildNotesRequest = {
    mode,
    ...(mode === 'range' && baseCommit ? { baseCommit } : {}),
    ...(mode === 'commits' ? { commitHashes: selectedHashes } : {}),
    includeWorking,
    ...(extraNote.trim() ? { note: extraNote.trim() } : {}),
  }

  useEffect(() => {
    if (scopeProject !== projectID) return
    let active = true
    setPreview(undefined)
    setPreviewScope(undefined)
    void (async () => {
      try {
        const loaded = await window.ame.buildNotesPreview(projectID, request)
        if (active && current()) { setPreview(loaded); setPreviewScope(request) }
      } catch (reason) { if (active) report(reason) }
    })()
    return () => { active = false }
  }, [scopeProject, projectID, generation, mode, baseCommit, selectedHashes, includeWorking, workingCount])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(''), 2000)
    return () => clearTimeout(timer)
  }, [copied, projectID])

  const hasChanges = preview ? preview.commitCount > 0 || preview.files.length > 0 : Boolean(baseCommit) || selectedHashes.length > 0 || (includeWorking && workingCount > 0)
  async function generate() {
    if (!current() || lock.current || !connected || !hasChanges) return
    const token = {}
    lock.current = token
    const valid = () => current() && lock.current === token
    setBusy(true); setError(undefined); setCopied('')
    try {
      const generated = await window.ame.generateBuildNotes(projectID, request)
      if (valid()) { setResult(generated); setNotesText(generated.notes); setViewMode('preview') }
    } catch (reason) { if (valid()) report(reason) }
    finally { if (valid()) { lock.current = null; setBusy(false) } }
  }

  async function copy(plain: boolean) {
    if (!navigator.clipboard?.writeText) { report(new Error('Không thể truy cập clipboard.')); return }
    try {
      await navigator.clipboard.writeText(plain ? markdownToPlainText(notesText) : notesText)
      if (current()) setCopied(plain ? 'plain' : 'markdown')
    } catch (reason) { report(reason) }
  }

  const filteredCommits = commits.filter(commit => `${commit.shortHash} ${commit.hash} ${commit.subject} ${commit.body} ${commit.author}`.toLowerCase().includes(commitFilter.trim().toLowerCase()))
  const displayedError = error ? formatBuildNotesError(error) : undefined

  return <div className="git-build-notes">
    <section className="git-bn-card">
      <header><h2>Phạm vi bản build</h2><span className="git-workspace__branch"><Icon name="git" />{git?.branch ?? 'Nhánh hiện tại'}</span></header>
      <div role="group" aria-label="Chế độ chọn thay đổi">
        <button type="button" aria-pressed={mode === 'range'} disabled={busy} onClick={() => setMode('range')}>Từ mốc commit trước</button>
        <button type="button" aria-pressed={mode === 'commits'} disabled={busy} onClick={() => setMode('commits')}>Chọn lẻ commit</button>
      </div>
      {mode === 'range' ? <label>Mốc commit gốc (nhánh hiện tại)<select aria-label="Mốc commit gốc" data-testid="build-notes-base-select" value={baseCommit} disabled={busy} onChange={event => setBaseCommit(event.target.value)}>
        <option value="">Chỉ thay đổi chưa commit</option>
        {commits.map(commit => <option key={commit.hash} value={commit.hash}>{commit.shortHash} — {commit.subject}</option>)}
      </select></label> : <>
        <input aria-label="Lọc commit" placeholder="Tìm commit theo nội dung, tác giả, hash..." value={commitFilter} disabled={busy} onChange={event => setCommitFilter(event.target.value)} />
        <button type="button" disabled={busy || !selectedHashes.length} onClick={() => setSelectedHashes([])}>Bỏ chọn tất cả</button>
        <ul className="git-bn-commit-list" style={{ maxHeight: 280, overflowY: 'auto' }}>{filteredCommits.map(commit => <li key={commit.hash}><label>
          <input type="checkbox" checked={selectedHashes.includes(commit.hash)} disabled={busy} onChange={event => setSelectedHashes(hashes => event.target.checked ? [...new Set([...hashes, commit.hash])] : hashes.filter(hash => hash !== commit.hash))} />
          <code>{commit.shortHash}</code> <strong>{commit.subject}</strong> <span>{commit.author}</span> <time dateTime={commit.date}>{formatRelativeGitDate(commit.date)}</time>
        </label></li>)}</ul>
      </>}
      <label><input type="checkbox" data-testid="build-notes-include-working" checked={includeWorking} disabled={busy} onChange={event => setIncludeWorking(event.target.checked)} />Gồm code đang sửa chưa commit{workingCount > 0 ? ` (${workingCount} tệp)` : ''}</label>
      <textarea data-testid="build-notes-extra-note" aria-label="Ghi chú cho AI" rows={2} maxLength={2000} placeholder="Ghi chú thêm cho bản build (VD: Build Staging v1.2, tập trung test luồng thanh toán...)" value={extraNote} disabled={busy} onChange={event => setExtraNote(event.target.value)} />
      <div className="git-bn-summary">
        {preview && <><span>{summarizeBuildScope(preview)}</span>{preview.truncated && <span className="git-bn-warning">Diff đã được rút gọn</span>}</>}
        <span className="git-bn-config">Skill: {preview?.skill ? '/' + preview.skill : 'Mặc định QC'} · Model: {preview?.effectiveModelID ?? 'default'}</span>
        {preview && <details><summary>Danh sách tệp thay đổi ({preview.files.length})</summary><ul>{preview.files.map(file => <li key={file.path}>
          <button type="button" onClick={() => {
            if (file.source === 'working') onDiff(file.path)
            else if (preview.commits.length === 1 && file.source === 'committed') onDiff(file.path, { kind: 'commit', commit: preview.commits[0].hash })
            else if (previewScope?.mode === 'range' && previewScope.baseCommit) onDiff(file.path, { kind: 'range', baseCommit: previewScope.baseCommit, includeWorking: previewScope.includeWorking && file.source === 'both' })
            else if (preview.commits.length > 0) onDiff(file.path, { kind: 'commits', commits: preview.commits.map(commit => commit.hash), includeWorking: !!previewScope?.includeWorking && file.source === 'both' })
            else onDiff(file.path)
          }}><FileTypeIcon path={file.path} />{file.path} <span>+{file.additions} -{file.deletions}</span></button>
        </li>)}</ul></details>}
      </div>
      <button type="button" className="primary" data-testid="build-notes-generate-btn" disabled={!connected || busy || !hasChanges} onClick={() => void generate()}>
        {busy ? <span className="amekit-spinner" aria-hidden="true" /> : <Icon name="notes" />}{busy ? 'Đang tạo mô tả…' : result ? 'Tạo lại' : 'Tạo mô tả bản build'}
      </button>
    </section>
    <section className="git-bn-card" data-testid="build-notes-output">
      <h2>Kết quả mô tả bản build</h2>
      {displayedError && <div role="alert"><strong>{displayedError.title}</strong>{displayedError.detail && <p>{displayedError.detail}</p>}</div>}
      {!notesText && !displayedError && <p>Chọn phạm vi thay đổi và tạo mô tả bản build để QC kiểm thử.</p>}
      {(notesText || result) && <>
        <div className="git-bn-toolbar">
          <div role="group" aria-label="Chế độ xem mô tả">
            <button type="button" aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}>Xem trước</button>
            <button type="button" aria-pressed={viewMode === 'edit'} onClick={() => setViewMode('edit')}>Chỉnh sửa</button>
          </div>
          <button type="button" data-testid="build-notes-copy-md" onClick={() => void copy(false)}><Icon name="copy" />Copy Markdown</button>
          <button type="button" data-testid="build-notes-copy-plain" onClick={() => void copy(true)}><Icon name="copy" />Copy Plain Text</button>
          {copied && <span role="status">Đã sao chép</span>}
          {result && <><span>Model: {result.modelID}</span><span>Skill: {result.skill ? '/' + result.skill : 'Mặc định QC'}</span>{result.truncated && <span className="git-bn-warning">Diff đã được rút gọn</span>}</>}
        </div>
        {viewMode === 'preview' ? <div className="git-bn-preview"><MessageContent text={notesText} onOpenFile={onOpenFile} /></div> : <textarea data-testid="build-notes-result-editor" className="git-bn-editor" rows={12} aria-label="Nội dung mô tả bản build" value={notesText} onChange={event => setNotesText(event.target.value)} />}
      </>}
    </section>
  </div>
}
