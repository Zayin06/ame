export type GitStatusMeta = { code: string; dataStatus: 'M' | 'U' | 'D'; label: string }
export type FilePathParts = { name: string; dir: string }
export type FileTypeMeta = { kind: string; glyph?: string; label: string }

export function gitStatusMeta(raw: string): GitStatusMeta {
  switch (raw.trim()) {
    case '?': return { code: 'U', dataStatus: 'U', label: 'Untracked' }
    case 'A': return { code: 'A', dataStatus: 'U', label: 'Added' }
    case 'M': return { code: 'M', dataStatus: 'M', label: 'Modified' }
    case 'D': return { code: 'D', dataStatus: 'D', label: 'Deleted' }
    case 'R': return { code: 'R', dataStatus: 'U', label: 'Renamed' }
    case 'C': return { code: 'C', dataStatus: 'U', label: 'Copied' }
    default: return { code: raw.trim() || 'M', dataStatus: 'M', label: 'Changed' }
  }
}

export function splitFilePath(filePath: string): FilePathParts {
  const normalized = filePath.replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  return { name: normalized.slice(separator + 1), dir: separator < 0 ? '' : normalized.slice(0, separator) }
}

export function fileTypeMeta(filePath: string): FileTypeMeta {
  const name = splitFilePath(filePath).name.toLowerCase()
  if (/\.(test|spec)\.tsx?$/.test(name)) return { kind: 'ts-test', glyph: 'TS', label: 'TypeScript Test' }
  if (/\.(ts|mts|cts|tsx)$/.test(name)) return { kind: 'ts', glyph: 'TS', label: 'TypeScript' }
  if (/\.(test|spec)\.jsx?$/.test(name)) return { kind: 'js-test', glyph: 'JS', label: 'JavaScript Test' }
  if (/\.(js|mjs|cjs|jsx)$/.test(name)) return { kind: 'js', glyph: 'JS', label: 'JavaScript' }
  if (/\.(md|mdx)$/.test(name)) return { kind: 'md', label: 'Markdown' }
  if (/\.(json|jsonc)$/.test(name)) return { kind: 'json', glyph: '{}', label: 'JSON' }
  if (/\.(css|scss|sass|less)$/.test(name)) return { kind: 'css', glyph: '#', label: 'Stylesheet' }
  if (/\.(html|htm|xml|svg)$/.test(name)) return { kind: 'markup', glyph: '<>', label: 'Markup' }
  if (/\.(yml|yaml|toml|env)$/.test(name)) return { kind: 'config', glyph: '⚙', label: 'Config' }
  if (/\.py$/.test(name)) return { kind: 'py', glyph: 'PY', label: 'Python' }
  if (/\.kts?$/.test(name)) return { kind: 'kt', glyph: 'KT', label: 'Kotlin' }
  if (/\.java$/.test(name)) return { kind: 'java', glyph: 'JV', label: 'Java' }
  if (/\.go$/.test(name)) return { kind: 'go', glyph: 'GO', label: 'Go' }
  if (/\.rs$/.test(name)) return { kind: 'rs', glyph: 'RS', label: 'Rust' }
  if (/\.(sh|ps1)$/.test(name)) return { kind: 'shell', glyph: '>_', label: 'Shell' }
  if (/\.(png|jpg|jpeg|gif|webp|ico)$/.test(name)) return { kind: 'image', label: 'Image' }
  return { kind: 'file', label: 'File' }
}
