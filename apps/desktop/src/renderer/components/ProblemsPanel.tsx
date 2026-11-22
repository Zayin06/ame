import { useEffect, useState } from "react"
import type { LspDiagnostic, LspSeverity } from "../../../../../packages/ide-core/src/ts-lsp"

export function filterAndGroupProblems(items: LspDiagnostic[], filter: { severity: "all" | LspSeverity; query: string }): {
  groups: { path: string; items: LspDiagnostic[] }[]
  counts: { all: number; error: number; warning: number; info: number }
} {
  // Summary counts describe the whole input, independently of the active filters.
  const counts = { all: items.length, error: 0, warning: 0, info: 0 }
  const grouped = new Map<string, LspDiagnostic[]>()
  const query = filter.query.trim().toLocaleLowerCase("vi")
  for (const item of items) {
    counts[item.severity]++
    if (filter.severity !== "all" && item.severity !== filter.severity) continue
    if (query && !`${item.path} ${item.message} ${item.source}${item.code} ${item.code}`.toLocaleLowerCase("vi").includes(query)) continue
    const group = grouped.get(item.path) ?? []
    group.push(item)
    grouped.set(item.path, group)
  }
  const groups = [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([path, problems]) => ({
    path, items: problems.sort((left, right) => left.line - right.line || left.column - right.column),
  }))
  return { groups, counts }
}

export type ProblemsPanelProps = {
  problems: LspDiagnostic[]
  loading?: boolean
  onOpenLocation: (path: string, line: number, column: number) => void
  onRefresh?: () => void
}

const severityLabels = { all: "Tất cả", error: "Lỗi", warning: "Cảnh báo", info: "Thông tin" } as const
const severities = ["all", "error", "warning", "info"] as const

export function ProblemsPanel({ problems, loading = false, onOpenLocation, onRefresh }: ProblemsPanelProps) {
  useEffect(() => { void import("../problems-panel.css") }, [])
  const [severity, setSeverity] = useState<"all" | LspSeverity>("all")
  const [query, setQuery] = useState("")
  const { groups, counts } = filterAndGroupProblems(problems, { severity, query })
  return <section className="problems-panel" aria-label="Vấn đề" aria-busy={loading}>
    <header className="problems-header">
      <h2>Vấn đề</h2>
      <button type="button" disabled={loading || !onRefresh} onClick={onRefresh}>Làm mới</button>
    </header>
    <div className="problems-filters" role="group" aria-label="Lọc theo mức độ">
      {severities.map(value => <button type="button" key={value} aria-pressed={severity === value}
        className={`problems-filter problems-${value}`} onClick={() => setSeverity(value)}>
        {severityLabels[value]} <span>{counts[value]}</span>
      </button>)}
    </div>
    <label className="problems-search">Tìm kiếm vấn đề
      <input type="search" placeholder="Tìm kiếm vấn đề..." value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    {loading && <p role="status">Đang tải vấn đề…</p>}
    {!groups.length && !loading && <p className="problems-empty" role="status">{problems.length ? "Không có vấn đề phù hợp." : "Không có vấn đề."}</p>}
    <div className="problems-groups">
      {groups.map(group => <section className="problems-group" key={group.path} aria-label={group.path}>
        <h3>{group.path} <span>({group.items.length})</span></h3>
        <ul aria-label={`Vấn đề trong ${group.path}`}>
          {group.items.map((item, index) => <li key={`${item.line}:${item.column}:${item.code}:${index}`}>
            <button type="button" className="problems-row" onClick={() => onOpenLocation(item.path, item.line, item.column)}>
              <span className={`problems-severity problems-${item.severity}`}>{severityLabels[item.severity]}</span>
              <span className="problems-message">{item.message}</span>
              <span className="problems-location">{item.source}({item.code}) · {item.line}:{item.column}</span>
            </button>
          </li>)}
        </ul>
      </section>)}
    </div>
  </section>
}
