import { useEffect, useState } from 'react'
import { errorText } from './Primitives'
import { Icon } from './Icon'

type Result = { path: string; lines: { number: number; text: string }[] }
export function ProjectSearch({ projectID, onOpen }: { projectID: string; onOpen: (path: string) => void }) {
  const [query, setQuery] = useState('')
  const [sensitive, setSensitive] = useState(false)
  const [word, setWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<Result[]>([])
  const [status, setStatus] = useState('')
  useEffect(() => {
    let cancelled = false
    setResults([])
    if (!query) { setStatus('Nhập nội dung để tìm trong dự án.'); return }
    setStatus('Đang tìm…')
    const timer = setTimeout(() => void (async () => {
      try {
        const escaped = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(word ? `\\b(?:${escaped})\\b` : escaped, sensitive ? '' : 'i')
        const found: Result[] = []
        const pending = ['']
        let files = 0, hits = 0
        while (pending.length && files < 2000 && hits < 200 && !cancelled) {
          const directory = pending.shift()!
          const entries = await window.ame.entries(projectID, directory)
          for (const entry of entries) {
            if (cancelled || files >= 2000 || hits >= 200) break
            if (entry.directory) { if (!['.git', 'node_modules', '.next', 'dist', 'out'].includes(entry.name)) pending.push(entry.path); continue }
            files++
            try {
              const doc = await window.ame.read(projectID, entry.path)
              if (doc.content.includes('\0')) continue
              const lines: Result['lines'] = []
              doc.content.split(/\r?\n/).forEach((text, index) => { if (hits < 200 && pattern.test(text)) { lines.push({ number: index + 1, text }); hits++ } })
              if (lines.length) found.push({ path: entry.path, lines })
            } catch { /* Unreadable/binary files are not searchable through the text bridge. */ }
          }
        }
        if (!cancelled) { setResults(found); setStatus(`${hits} dòng trong ${found.length} tệp${pending.length || files >= 2000 || hits >= 200 ? ' · giới hạn 2.000 tệp / 200 kết quả' : ''}`) }
      } catch (error) { if (!cancelled) setStatus(errorText(error)) }
    })(), 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [projectID, query, sensitive, word, regex])
  return <div data-testid="project-search"><div className="vsc-search-box"><div className="vsc-search-field"><input aria-label="Tìm trong dự án" autoFocus placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />{[['Aa', sensitive, () => setSensitive(v => !v), 'Match Case'], ['ab', word, () => setWord(v => !v), 'Match Whole Word'], ['.*', regex, () => setRegex(v => !v), 'Use Regular Expression']].map(([text, active, toggle, label]) => <button key={String(text)} title={String(label)} aria-pressed={Boolean(active)} className={`vsc-search-flag ${active ? 'is-active' : ''}`} onClick={toggle as () => void}>{String(text)}</button>)}</div></div><div className="vsc-search-summary" role="status">{status}</div>{results.map(result => <section className="vsc-search-group" key={result.path}><button className="vsc-search-file-head" onClick={() => onOpen(result.path)}><Icon name="file" /><span className="truncate">{result.path}</span><span>{result.lines.length}</span></button><div className="vsc-search-matches">{result.lines.map(line => <button className="vsc-search-hit" key={line.number} title={`${result.path}:${line.number}`} onClick={() => onOpen(result.path)}><span>{line.number}</span><span className="vsc-search-hit__text">{line.text}</span></button>)}</div></section>)}</div>
}
