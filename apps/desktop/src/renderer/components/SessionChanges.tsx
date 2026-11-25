import { useEffect, useMemo, useState } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type { SessionDiff } from '../../../../../packages/protocol/src/index'
import { normalize } from '../opencode-session-diff'
import type { SessionChangesState } from '../session-changes'
import { Empty, errorText } from './Primitives'

function RawPatchFallback({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.replace(/\r\n/g, '\n').split('\n'), [patch])
  return <pre className="session-change-raw" data-testid="session-change-raw"><code>{lines.map((line, index) => {
    const kind = line.startsWith('+') && !line.startsWith('+++') ? 'is-add'
      : line.startsWith('-') && !line.startsWith('---') ? 'is-del'
        : line.startsWith('@@') ? 'is-hunk' : ''
    return <span key={index} className={kind ? `session-change-raw__line ${kind}` : 'session-change-raw__line'}>{line}{'\n'}</span>
  })}</code></pre>
}

function ChangeFileItem({ file, theme }: { file: SessionDiff; theme: 'dark' | 'light' }) {
  const [open, setOpen] = useState(false)
  const parsed = useMemo(() => {
    try { return { view: normalize(file) } }
    catch (error) { return { error: errorText(error) } }
  }, [file])
  const additions = parsed.view ? parsed.view.additions : file.additions
  const deletions = parsed.view ? parsed.view.deletions : file.deletions
  const statusLabel = parsed.view?.eolOnly ? 'EOL only' : parsed.view?.eolNormalized ? `${file.status} · CRLF↔LF` : file.status

  return <details className="session-change-file" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="truncate" title={file.file}>{file.file}</span>
      <span>{statusLabel} · <b className="session-change-added">+{additions}</b> <b className="session-change-deleted">−{deletions}</b></span>
    </summary>
    {open && <>
      {file.more && <p className="muted session-change-note">OpenCode đã giới hạn nội dung patch.</p>}
      {!file.patch ? <p className="muted session-change-note">OpenCode không cung cấp patch văn bản cho tệp này.</p>
        : parsed.error ? <><div role="alert" className="session-change-note">{parsed.error}</div><RawPatchFallback patch={file.patch} /></>
          : parsed.view?.eolOnly ? <p className="muted session-change-note">Tệp này chỉ thay đổi ký tự xuống dòng (CRLF ↔ LF), không có thay đổi nội dung.</p>
            : parsed.view?.parseFailed || !parsed.view?.fileDiff.hunks.length ? <RawPatchFallback patch={file.patch} />
              : <>
                {parsed.view.eolNormalized && <p className="muted session-change-note">Đã ẩn các dòng chỉ khác ký tự xuống dòng (CRLF/LF).</p>}
                <FileDiff fileDiff={parsed.view.fileDiff} options={{ themeType: theme, diffStyle: 'unified', overflow: 'scroll', disableFileHeader: true }} />
              </>}
    </>}
  </details>
}

export function SessionChanges({ state, theme, turn = false, onRetry }: { state: SessionChangesState; theme: 'dark' | 'light'; turn?: boolean; onRetry?: () => void }) {
  return <section className="session-changes" data-testid="session-changes" aria-label={turn ? 'Thay đổi của lượt chat' : 'Thay đổi của session'}>
    <h3>{turn ? 'Lượt chat' : 'Session'} · {state.status === 'ready' ? `${state.files.length} files changed` : 'File changes'}</h3>
    {state.status === 'loading' ? <Empty>Đang tải thay đổi từ OpenCode…</Empty> : state.status === 'error' ? <div className="inline-error" role="alert">{state.error}{onRetry && <button onClick={onRetry}>Thử lại</button>}</div> : !state.files.length ? <Empty>Không có thay đổi trong {turn ? 'lượt chat' : 'session'} này.</Empty> : state.files.map(file => <ChangeFileItem key={file.file} file={file} theme={theme} />)}
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
