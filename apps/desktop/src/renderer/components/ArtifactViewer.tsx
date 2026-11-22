import { useEffect, useRef, useState } from 'react'
import type { ArtifactDetail, ArtifactSummary } from '../../../../../packages/protocol/src/index'
import { MessageContent } from './MessageContent'
import { Empty, errorText } from './Primitives'

export function ArtifactViewer({ projectID, sessionID }: { projectID: string; sessionID?: string }) {
  return <ArtifactBrowser key={JSON.stringify([projectID, sessionID])} projectID={projectID} sessionID={sessionID} />
}

function ArtifactBrowser({ projectID, sessionID }: { projectID: string; sessionID?: string }) {
  const [scope, setScope] = useState<'session' | 'project'>(sessionID ? 'session' : 'project')
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState('')
  const [list, setList] = useState<{ scope: string; items: ArtifactSummary[]; loading: boolean; error: string }>({ scope, items: [], loading: true, error: '' })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.ame.onEvent(event => {
      if (event.type !== 'opencode' || event.projectID !== projectID) return
      clearTimeout(timer)
      timer = setTimeout(() => setRevision(value => value + 1), 120)
    })
    return () => { clearTimeout(timer); unsubscribe() }
  }, [projectID])
  useEffect(() => {
    let alive = true
    setList(current => ({ scope, items: current.scope === scope ? current.items : [], loading: true, error: '' }))
    const load = async () => {
      try {
        const items = await window.ame.artifacts(projectID, scope === 'session' ? sessionID : undefined)
        if (!alive) return
        setList({ scope, items, loading: false, error: '' })
        setSelection(current => items.some(item => item.id === current) ? current : items[0]?.id || '')
      } catch (e) {
        if (alive) setList(current => ({ ...current, loading: false, error: errorText(e) }))
      }
    }
    void load()
    return () => { alive = false }
  }, [projectID, sessionID, scope, revision])
  const items = list.scope === scope ? list.items : []
  const loading = list.scope !== scope || list.loading
  return <section className="artifact-viewer" aria-label="Artifacts">
    <div className="artifact-viewer__toolbar button-row">
      <button type="button" disabled={!sessionID} aria-pressed={scope === 'session'} onClick={() => { if (scope !== 'session') { setSelection(''); setScope('session') } }}>Phiên hiện tại</button>
      <button type="button" aria-pressed={scope === 'project'} onClick={() => { if (scope !== 'project') { setSelection(''); setScope('project') } }}>Toàn dự án</button>
      <button type="button" onClick={() => setRevision(value => value + 1)}>Làm mới</button>
    </div>
    {list.scope === scope && list.error && <div className="inline-error" role="status">{list.error}</div>}
    {loading && <p role="status">Đang tải artifacts…</p>}
    {!loading && !list.error && !items.length && <Empty>Chưa có artifact trong {scope === 'session' ? 'phiên hiện tại' : 'dự án'}.</Empty>}
    {!!items.length && <label className="artifact-viewer__selection">Artifact <select aria-label="Chọn artifact" value={selection} onChange={event => setSelection(event.target.value)}>
      {items.map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
    </select></label>}
    {selection && items.some(item => item.id === selection) && <ArtifactFiles key={`${scope}:${selection}`} projectID={projectID} artifactID={selection} revision={revision} onDeleted={() => {
      setSelection('')
      setList(current => ({ ...current, items: current.items.filter(item => item.id !== selection) }))
      setRevision(value => value + 1)
    }} />}
  </section>
}

function ArtifactFiles({ projectID, artifactID, revision, onDeleted }: { projectID: string; artifactID: string; revision: number; onDeleted: () => void }) {
  const [detail, setDetail] = useState<ArtifactDetail>()
  const [file, setFile] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const deletePending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    const load = async () => {
      try {
        const result = await window.ame.artifact(projectID, artifactID)
        if (!alive) return
        setDetail(result)
        setFile(current => Object.hasOwn(result.files, current) ? current : Object.hasOwn(result.files, result.info.entry) ? result.info.entry : Object.keys(result.files)[0] || '')
      } catch (e) { if (alive) setError(errorText(e)) }
      finally { if (alive) setLoading(false) }
    }
    void load()
    return () => { alive = false }
  }, [projectID, artifactID, revision])
  const remove = async () => {
    if (deletePending.current) return
    deletePending.current = true; setDeleting(true); setError('')
    try {
      await window.ame.deleteArtifact(projectID, artifactID)
      if (mounted.current) onDeleted()
    } catch (e) {
      if (mounted.current && !/(?:^|:\s*)CANCELLED$/.test(errorText(e).trim())) setError(errorText(e))
    } finally {
      deletePending.current = false
      if (mounted.current) setDeleting(false)
    }
  }
  return <div className="artifact-viewer__detail">
    {error && <div className="inline-error" role="status">{error}</div>}
    {loading && <p role="status">Đang tải nội dung…</p>}
    {detail && <>
      <h3>{detail.info.title || artifactID}</h3>
      <div className="artifact-viewer__actions button-row">
        <label>Tệp <select aria-label="Chọn tệp artifact" value={file} onChange={event => setFile(event.target.value)} disabled={!Object.keys(detail.files).length}>
          {Object.keys(detail.files).map(path => <option key={path} value={path}>{path}</option>)}
        </select></label>
        {Object.hasOwn(detail.files, file) && <ArtifactCopy key={file} text={detail.files[file]} />}
        <button type="button" disabled={deleting} onClick={() => void remove()}>{deleting ? 'Đang xóa…' : 'Xóa'}</button>
      </div>
      {Object.hasOwn(detail.files, file) ? <ArtifactFile key={file} file={file} content={detail.files[file]} title={detail.info.title || artifactID} /> : <Empty>Artifact không có tệp.</Empty>}
    </>}
  </div>
}

function ArtifactCopy({ text }: { text: string }) {
  const [feedback, setFeedback] = useState('')
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    generation.current++; setFeedback('')
    return () => { generation.current++; clearTimeout(timer.current) }
  }, [text])
  const copy = async () => {
    const current = ++generation.current
    clearTimeout(timer.current)
    let result = 'Đã sao chép'
    try { await navigator.clipboard.writeText(text) } catch { result = 'Không thể sao chép' }
    if (current !== generation.current) return
    setFeedback(result)
    timer.current = setTimeout(() => setFeedback(''), 1500)
  }
  return <button type="button" aria-label="Sao chép mã nguồn" onClick={() => void copy()}><span role="status">{feedback || 'Sao chép'}</span></button>
}

function ArtifactFile({ file, content, title }: { file: string; content: string; title: string }) {
  const [previewSource, setPreviewSource] = useState<string | null>(null)
  const preview = previewSource !== null && previewSource === content
  if (/\.(md|markdown)$/i.test(file)) return <MessageContent text={content} />
  return <div className="artifact-viewer__file">
    {/\.html?$/i.test(file) && <button type="button" aria-pressed={preview} onClick={() => setPreviewSource(preview ? null : content)}>{preview ? 'Mã nguồn' : 'Xem trước'}</button>}
    {preview ? <iframe sandbox="" srcDoc={content} title={`${title} — ${file}`} /> : <pre><code>{content}</code></pre>}
  </div>
}
