export type ParsedQuickOpen = { mode: 'line'; line: number; column?: number } | { mode: 'file'; query: string; line?: number; column?: number }

export function parseQuickOpenInput(raw: string): ParsedQuickOpen {
  const query = raw.trim()
  const match = /^(.*?):(-?\d+)(?::(-?\d+))?$/.exec(query)
  if (!match || Number(match[2]) <= 0) return { mode: 'file', query }
  const position = {
    line: Math.min(Number.MAX_SAFE_INTEGER, Number(match[2])),
    ...(match[3] === undefined ? {} : { column: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Number(match[3]))) })
  }
  return match[1] ? { mode: 'file', query: match[1], ...position } : { mode: 'line', ...position }
}

export type FuzzyMatch = { score: number; indices: number[] }

export function fuzzyMatchPath(query: string, candidate: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] }
  if (query.length > candidate.length) return null
  const path = candidate.replace(/\\/g, '/')
  const needle = query.replace(/\\/g, '/')
  const basename = path.lastIndexOf('/') + 1
  const parents: number[][] = []
  let previous = new Array<number>(path.length).fill(-Infinity)
  // Dynamic programming keeps the best alignment, not merely the first subsequence.
  for (let i = 0; i < needle.length; i++) {
    const scores = new Array<number>(path.length).fill(-Infinity)
    const links = new Array<number>(path.length).fill(-1)
    let best = -Infinity, bestIndex = -1
    for (let j = 0; j < path.length; j++) {
      if (j > 0 && previous[j - 1] + (j - 1) * 0.15 > best) {
        best = previous[j - 1] + (j - 1) * 0.15
        bestIndex = j - 1
      }
      if (needle[i].toLowerCase() !== path[j].toLowerCase()) continue
      const boundary = j === 0 || /[\/\-_.\s]/.test(path[j - 1]) || (/[a-z]/.test(path[j - 1]) && /[A-Z]/.test(path[j]))
      const bonus = 10 + (j >= basename ? 12 : 0) + (boundary ? 9 : 0) + (needle[i] === path[j] ? 1 : 0)
      if (i === 0) scores[j] = bonus - j * 0.05
      else if (bestIndex !== -1) {
        scores[j] = best - (j - 1) * 0.15 + bonus
        links[j] = bestIndex
        if (j > 0 && previous[j - 1] + 14 + bonus >= scores[j]) {
          scores[j] = previous[j - 1] + 14 + bonus
          links[j] = j - 1
        }
      }
    }
    parents.push(links)
    previous = scores
  }
  let end = -1
  for (let j = 0; j < previous.length; j++) if (end === -1 || previous[j] > previous[end]) end = j
  if (end === -1 || !Number.isFinite(previous[end])) return null
  const score = previous[end] - candidate.length * 0.02
  const indices = new Array<number>(needle.length)
  for (let i = needle.length - 1; i >= 0; i--) { indices[i] = end; end = parents[i][end] }
  return { score, indices }
}

export type QuickOpenItem = { path: string; name: string; directory: string; recent: boolean; score: number; indices: number[] }

export function rankQuickOpenFiles(query: string, files: readonly string[], recentPaths: readonly string[] = [], limit = 60): QuickOpenItem[] {
  const recent = new Map<string, number>()
  recentPaths.forEach((path, index) => { if (!recent.has(path)) recent.set(path, index) })
  const items: QuickOpenItem[] = []
  for (const path of new Set(files)) {
    const match = fuzzyMatchPath(query, path)
    if (!match) continue
    const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    items.push({ path, name: path.slice(separator + 1), directory: path.slice(0, Math.max(0, separator)), recent: recent.has(path), ...match })
  }
  items.sort((a, b) => query
    ? b.score - a.score || Number(b.recent) - Number(a.recent) || a.path.length - b.path.length || a.path.localeCompare(b.path)
    : (recent.get(a.path) ?? Infinity) - (recent.get(b.path) ?? Infinity) || a.path.localeCompare(b.path))
  return items.slice(0, Number.isNaN(limit) ? 0 : Math.max(0, Math.floor(limit)))
}
