import { useEffect, useRef, useState } from 'react'
import type { ReplaceResult, SearchResponse } from '../../../../../packages/protocol/src/index'
import { errorText, humanizeIdeError } from './Primitives'
import { Icon } from './Icon'

const globs = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean)
export function ReplacementReport({ result, dryRun }: { result: ReplaceResult; dryRun: boolean }) {
  const failures = result.conflicts.length + result.errors.length
  return <div className={failures ? 'inline-error' : undefined}>
    <p>{dryRun ? 'Preview' : 'Đã thay thế'}: {result.replacements} vị trí trong {result.filesChanged} tệp.</p>
    {!dryRun && !!result.writtenFiles.length && <p>Đã ghi: {result.writtenFiles.join(', ')}</p>}
    {!!failures && <><p>Chưa thay thế {failures} tệp. Kiểm tra các tệp bên dưới rồi Preview lại trước khi thử tiếp.</p>
      <ul>{result.conflicts.map(file => <li key={`conflict:${file}`}><code>{file}</code>: Tệp đã thay đổi sau Preview; giữ nguyên nội dung mới.</li>)}
        {result.errors.map(({ path, code }, index) => <li key={`error:${index}`}><code>{path}</code>: {humanizeIdeError(code)}</li>)}</ul></>}
  </div>
}
export function ProjectSearch({ projectID, onOpen, refresh, generation }: { projectID: string; onOpen: (path: string, line?: number, column?: number) => void; refresh: () => void; generation: number }) {
  const [query, setQuery] = useState('')
  const [sensitive, setSensitive] = useState(false)
  const [word, setWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [response, setResponse] = useState<SearchResponse>()
  const [status, setStatus] = useState('')
  const [preview, setPreview] = useState<string | { result: ReplaceResult; dryRun: boolean }>('')
  const [busy, setBusy] = useState(false)
  const operation = useRef(0)
  const options = { query, caseSensitive: sensitive, wholeWord: word, regex, include: globs(include), exclude: globs(exclude) }
  useEffect(() => {
    let cancelled = false
    setResponse(undefined)
    if (!query) { setStatus('Nhập nội dung để tìm trong dự án.'); return }
    setStatus('Đang tìm…')
    const timer = setTimeout(() => {
      void window.ame.searchProject(projectID, options).then(result => {
        if (!cancelled) {
          setResponse(result)
          const snippets = result.results.some(file => file.matches.some(match => match.snippetTruncated))
          setStatus(`${result.totalMatches} hits trong ${result.results.length} tệp · ${result.engine}${result.truncated ? ' · truncated (đã giới hạn số lượng/dung lượng kết quả)' : ''}${snippets ? ' · Dòng dài đã rút gọn; vị trí mở tệp vẫn chính xác.' : ''}`)
        }
      }).catch(error => { if (!cancelled) setStatus(humanizeIdeError(error)) })
    }, 225)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [projectID, query, sensitive, word, regex, include, exclude, generation])
  useEffect(() => {
    operation.current++
    setPreview('')
    setBusy(false)
    return () => { operation.current++ }
  }, [projectID, query, sensitive, word, regex, include, exclude, replacement])
  const replace = async (dryRun: boolean) => {
    if (!query || busy) return
    const request = ++operation.current
    setBusy(true)
    try {
      const result = await window.ame.replaceInProject(projectID, { ...options, replacement, dryRun })
      if (!dryRun && result.writtenFiles.length) refresh()
      if (request === operation.current) setPreview({ result, dryRun })
    } catch (error) { if (request === operation.current && !errorText(error).includes('CANCELLED')) setPreview(humanizeIdeError(error)) }
    finally { if (request === operation.current) setBusy(false) }
  }
  return <div data-testid="project-search"><div className="vsc-search-box"><div className="vsc-search-field"><input aria-label="Tìm trong dự án" autoFocus placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />{[['Aa', sensitive, () => setSensitive(v => !v), 'Match Case'], ['ab', word, () => setWord(v => !v), 'Match Whole Word'], ['.*', regex, () => setRegex(v => !v), 'Use Regular Expression']].map(([text, active, toggle, label]) => <button key={String(text)} title={String(label)} aria-pressed={Boolean(active)} className={`vsc-search-flag ${active ? 'is-active' : ''}`} onClick={toggle as () => void}>{String(text)}</button>)}</div>
    <div className="search-options"><label>Include<input aria-label="Include globs" placeholder="src/**, *.ts" value={include} onChange={e => setInclude(e.target.value)} /></label><label>Exclude<input aria-label="Exclude globs" placeholder="**/*.test.ts" value={exclude} onChange={e => setExclude(e.target.value)} /></label><button type="button" aria-expanded={replacing} onClick={() => setReplacing(value => !value)}>Replace</button>{replacing && <><input aria-label="Replacement" placeholder="Replacement" value={replacement} disabled={busy} onChange={e => setReplacement(e.target.value)} /><div className="button-row"><button disabled={busy || !query} onClick={() => void replace(true)}>Preview</button><button disabled={busy || !query} onClick={() => void replace(false)}>Replace All</button></div><div role="status">{typeof preview === 'string' ? preview : <ReplacementReport {...preview} />}</div></>}</div>
    </div><div className="vsc-search-summary" role="status">{status}</div>{response?.results.map(result => <section className="vsc-search-group" key={result.path}><button className="vsc-search-file-head" onClick={() => onOpen(result.path)}><Icon name="file" /><span className="truncate">{result.path}</span><span>{result.matches.length}</span></button><div className="vsc-search-matches">{result.matches.map((match, index) => <button className="vsc-search-hit" key={`${match.line}:${match.column}:${index}`} title={`${result.path}:${match.line}:${match.column}${match.snippetTruncated ? ' · Đoạn trích rút gọn' : ''}`} onClick={() => onOpen(result.path, match.line, match.column)}><span>{match.line}</span><span className="vsc-search-hit__text">{match.lineText}</span></button>)}</div></section>)}</div>
}
