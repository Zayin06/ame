export type InlineNode =
  | { type: 'text' | 'code'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: InlineNode[] }
  | { type: 'link'; url: string; children: InlineNode[] }

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: 'code'; language: string; code: string; closed: boolean }
  | { type: 'blockquote'; blocks: BlockNode[] }
  | { type: 'hr' }
  | { type: 'table'; align: ('left' | 'center' | 'right' | null)[]; headers: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'list'; ordered: boolean; items: { checked?: boolean; children: InlineNode[]; blocks?: BlockNode[] }[] }
  | { type: 'paragraph'; children: InlineNode[] }

function safeUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

export function parseInline(text: string, depth = 0): InlineNode[] {
  if (depth > 64) return [{ type: 'text', text }]
  const nodes: InlineNode[] = []
  let labelSearchExhausted = false
  let nextLabelEnd = -1
  let closingParens: Map<number, number> | undefined
  const destinationEnd = (opening: number) => {
    if (!closingParens) {
      closingParens = new Map()
      const stack: number[] = []
      for (let index = 0; index < text.length; index++) {
        if (text[index] === '\\') { index++; continue }
        if (text[index] === '(') stack.push(index)
        else if (text[index] === ')') { const start = stack.pop(); if (start !== undefined) closingParens.set(start, index) }
      }
    }
    return closingParens.get(opening)
  }
  const plain = (value: string) => {
    const last = nodes.at(-1)
    if (last?.type === 'text') last.text += value
    else nodes.push({ type: 'text', text: value })
  }
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\`*_[\]~()|]/.test(text[i + 1] || '')) {
      plain(text[i + 1]); i += 2; continue
    }
    if (text[i] === '`') {
      const marker = /^`+/.exec(text.slice(i))![0]
      let end = text.indexOf(marker, i + marker.length)
      while (end >= 0 && (text[end - 1] === '`' || text[end + marker.length] === '`')) end = text.indexOf(marker, end + marker.length)
      if (end >= 0) {
        nodes.push({ type: 'code', text: text.slice(i + marker.length, end).replace(/\n/g, ' ') })
        i = end + marker.length; continue
      }
      plain(marker); i += marker.length; continue
    }
    if (text[i] === '[' && !labelSearchExhausted) {
      if (nextLabelEnd <= i) nextLabelEnd = text.indexOf('](', i + 1)
      const labelEnd = nextLabelEnd
      if (labelEnd < 0) labelSearchExhausted = true
      if (labelEnd >= 0) {
        const end = destinationEnd(labelEnd + 1)
        if (end !== undefined) {
          const url = text.slice(labelEnd + 2, end)
          if (safeUrl(url)) nodes.push({ type: 'link', url, children: parseInline(text.slice(i + 1, labelEnd), depth + 1) })
          else plain(text.slice(i, end + 1))
          i = end + 1; continue
        }
      }
    }
    let matched = false
    for (const marker of ['***', '___', '**', '__', '~~', '*', '_']) {
      if (!text.startsWith(marker, i) || text[i + marker.length] === marker[0] || /\s/.test(text[i + marker.length] || ' ')) continue
      if (marker.includes('_') && /[\p{L}\p{N}]/u.test(text[i - 1] || '')) continue
      let end = text.indexOf(marker, i + marker.length)
      while (end >= 0) {
        let runEnd = end + marker.length
        while (text[runEnd] === marker[0]) runEnd++
        const runLength = runEnd - end
        if (marker.length === 1 && runLength % 2 === 0) { end = text.indexOf(marker, runEnd); continue }
        const candidate = runEnd - marker.length
        if (!/\s/.test(text[candidate - 1]) && text[end - 1] !== '\\' && !(marker.includes('_') && /[\p{L}\p{N}]/u.test(text[runEnd] || ''))) { end = candidate; break }
        end = text.indexOf(marker, runEnd)
      }
      if (end < 0) continue
      const children = parseInline(text.slice(i + marker.length, end), depth + 1)
      nodes.push(marker.length === 3
        ? { type: 'strong', children: [{ type: 'em', children }] }
        : { type: marker === '~~' ? 'del' : marker.length === 2 ? 'strong' : 'em', children })
      i = end + marker.length; matched = true; break
    }
    if (!matched) {
      const literal = /^(?:\*+|_+|~+)/.exec(text.slice(i))?.[0] || text[i]
      plain(literal); i += literal.length
    }
  }
  return nodes
}

function tableCells(line: string): string[] {
  const cells: string[] = []
  let cell = '', ticks = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) { cell += line[i] + line[++i]; continue }
    if (line[i] === '`') {
      const run = /^`+/.exec(line.slice(i))![0]
      // An unmatched code delimiter must not swallow later table columns.
      if (ticks === run.length) ticks = 0
      else if (!ticks && line.indexOf(run, i + run.length) >= 0) ticks = run.length
      cell += run; i += run.length - 1; continue
    }
    if (line[i] === '|' && !ticks) { cells.push(cell.trim()); cell = '' }
    else cell += line[i]
  }
  cells.push(cell.trim())
  if (line.trimStart().startsWith('|')) cells.shift()
  if (line.trimEnd().endsWith('|') && cells.at(-1) === '') cells.pop()
  return cells
}

const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line)
const heading = (line: string) => /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line)
const rule = (line: string) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
const quote = (line: string) => /^ {0,3}>[ \t]?(.*)$/.exec(line)
const listItem = (line: string) => /^( *)([-+*]|\d+[.)])[ \t]+(.*)$/.exec(line)

export function parseMarkdown(source: string, depth = 0): BlockNode[] {
  if (depth > 64) return [{ type: 'paragraph', children: [{ type: 'text', text: source }] }]
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: BlockNode[] = []
  const tableAt = (index: number) => {
    if (!lines[index]?.includes('|') || !lines[index + 1]) return null
    const headers = tableCells(lines[index]), separators = tableCells(lines[index + 1])
    if (headers.length !== separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null
    return { headers, separators }
  }
  const startsBlock = (index: number) => fence(lines[index]) || heading(lines[index]) || rule(lines[index]) || quote(lines[index]) || listItem(lines[index]) || tableAt(index)
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const opening = fence(line)
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      const start = ++i
      const close = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`)
      while (i < lines.length && !close.test(lines[i])) i++
      const closed = i < lines.length
      blocks.push({ type: 'code', language: opening[2].trim().split(/\s/)[0] || '', code: lines.slice(start, i).join('\n') + (closed && i > start ? '\n' : ''), closed })
      if (closed) i++
      continue
    }
    const title = heading(line)
    if (title) {
      blocks.push({ type: 'heading', level: title[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(title[2].replace(/[ \t]+#+[ \t]*$/, '')) }); i++; continue
    }
    if (rule(line)) { blocks.push({ type: 'hr' }); i++; continue }
    if (quote(line)) {
      const quoted: string[] = []
      while (i < lines.length) {
        const match = quote(lines[i])
        if (!match) break
        quoted.push(match[1]); i++
      }
      blocks.push({ type: 'blockquote', blocks: parseMarkdown(quoted.join('\n'), depth + 1) }); continue
    }
    const table = tableAt(i)
    if (table) {
      const align = table.separators.map(cell => cell.startsWith(':') ? cell.endsWith(':') ? 'center' as const : 'left' as const : cell.endsWith(':') ? 'right' as const : null)
      const rows: InlineNode[][][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !fence(lines[i]) && !quote(lines[i]) && !heading(lines[i])) {
        const cells = tableCells(lines[i++])
        rows.push(table.headers.map((_, column) => parseInline(cells[column] || '')))
      }
      blocks.push({ type: 'table', align, headers: table.headers.map(cell => parseInline(cell)), rows }); continue
    }
    const first = listItem(line)
    if (first) {
      const ordered = /^\d/.test(first[2]), indent = first[1].length
      const items: Extract<BlockNode, { type: 'list' }>['items'] = []
      while (i < lines.length) {
        const match = listItem(lines[i])
        if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered || rule(lines[i])) break
        const task = /^\[([ xX])\][ \t]+(.*)$/.exec(match[3])
        const item: (typeof items)[number] = { children: parseInline(task ? task[2] : match[3]) }
        if (task) item.checked = task[1].toLowerCase() === 'x'
        const contentIndent = match[0].length - match[3].length
        const nested: string[] = []
        i++
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next = i + 1
            while (next < lines.length && !lines[next].trim()) next++
            if (next < lines.length && lines[next].match(/^ */)![0].length >= contentIndent) { nested.push(''); i++; continue }
            break
          }
          if (lines[i].match(/^ */)![0].length < contentIndent) break
          nested.push(lines[i++].slice(contentIndent))
        }
        if (nested.length) item.blocks = parseMarkdown(nested.join('\n'), depth + 1)
        items.push(item)
        while (i < lines.length && !lines[i].trim()) i++
      }
      blocks.push({ type: 'list', ordered, items }); continue
    }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !startsBlock(i)) paragraph.push(lines[i++])
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }
  return blocks
}

export function parseFileRef(text: string): { path: string; line?: number; endLine?: number } | null {
  if (text !== text.trim() || /[\s\u0000-\u001f\u007f]/.test(text) || text.includes('..')) return null
  const match = /^(.*?)(?::([1-9]\d*)(?:-([1-9]\d*))?|#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/.exec(text)
  if (!match) return null
  const path = match[1].replace(/\\/g, '/')
  if (!path || path.startsWith('/') || !/^(?:[\w@.$-]+\/)*[\w@.$-]+$/.test(path)) return null
  if (!path.includes('/') && !/\.(?:[cm]?[jt]sx?|jsonc?|css|scss|sass|less|html?|vue|svelte|py|pyi|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|ps1|sql|ya?ml|toml|xml|md|mdx)$/i.test(path)) return null
  const line = match[2] || match[4], endLine = match[3] || match[5]
  if (line && !Number.isSafeInteger(Number(line))) return null
  if (endLine && (!Number.isSafeInteger(Number(endLine)) || Number(endLine) < Number(line))) return null
  return { path, ...(line ? { line: Number(line) } : {}), ...(endLine ? { endLine: Number(endLine) } : {}) }
}
