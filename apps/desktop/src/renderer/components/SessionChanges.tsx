import { useEffect, useMemo, useState } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type { SessionDiff } from '../../../../../packages/protocol/src/index'
import { normalize } from '../opencode-session-diff'
import type { SessionChangesState } from '../session-changes'
import { Empty, errorText } from './Primitives'

function Patch({ file, theme }: { file: SessionDiff; theme: 'dark' | 'light' }) {
  const parsed = useMemo(() => {
    try { return { diff: normalize(file).fileDiff } }
    catch (error) { return { error: errorText(error) } }
  }, [file])
  if (!parsed.diff) return <div role="alert">{parsed.error}</div>
  return <FileDiff fileDiff={parsed.diff} options={{ themeType: theme, diffStyle: 'unified', overflow: 'scroll', disableFileHeader: true }} />
}

export function SessionChanges({ state, theme, turn = false, onRetry }: { state: SessionChangesState; theme: 'dark' | 'light'; turn?: boolean; onRetry?: () => void }) {
  return <section className="session-changes" data-testid="session-changes" aria-label={turn ? 'Thay đổi của lượt chat' : 'Thay đổi của session'}>
    <h3>{turn ? 'Lượt chat' : 'Session'} · {state.status === 'ready' ? `${state.files.length} files changed` : 'File changes'}</h3>
    {state.status === 'loading' ? <Empty>Đang tải thay đổi từ OpenCode…</Empty> : state.status === 'error' ? <div className="inline-error" role="alert">{state.error}{onRetry && <button onClick={onRetry}>Thử lại</button>}</div> : !state.files.length ? <Empty>Không có thay đổi trong {turn ? 'lượt chat' : 'session'} này.</Empty> : state.files.map(file => <details className="session-change-file" key={file.file}>
      <summary><span className="truncate" title={file.file}>{file.file}</span><span>{file.status} · <b className="session-change-added">+{file.additions}</b> <b className="session-change-deleted">−{file.deletions}</b></span></summary>
      {file.more && <p className="muted">OpenCode đã giới hạn nội dung patch.</p>}
      {file.patch ? <Patch file={file} theme={theme} /> : <p className="muted">OpenCode không cung cấp patch văn bản cho tệp này.</p>}
    </details>)}
  </section>
}

export function TurnChanges({ projectID, sessionID, from, files, theme }: { projectID: string; sessionID: string; from: string; files: string[]; theme: 'dark' | 'light' }) {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<SessionChangesState>({ status: 'loading', files: [] })
  useEffect(() => {
    if (!open || state.status === 'ready') return
    let alive = true
    setState({ status: 'loading', files: [] })
    void window.ame.sessionDiff(projectID, sessionID, from).then(diffs => { if (alive) setState({ status: 'ready', files: diffs }) }).catch(error => { if (alive) setState({ status: 'error', files: [], error: errorText(error) }) })
    return () => { alive = false }
  }, [open, projectID, sessionID, from, attempt])
  return <details className="turn-changes" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{state.status === 'ready' ? state.files.length : files.length} files changed · lượt chat</summary>
    {open && <><SessionChanges state={state} theme={theme} turn />{state.status === 'error' && <button onClick={() => setAttempt(value => value + 1)}>Thử lại</button>}</>}
  </details>
}
