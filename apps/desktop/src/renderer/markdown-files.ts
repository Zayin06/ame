const MARKDOWN_FILE_RE = /\.(?:md|mdx|markdown)$/i
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

export function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_FILE_RE.test(filePath.trim())
}

/** Resolves a relative Markdown href against the current workspace file path without escaping root. */
export function resolveMarkdownLink(currentFilePath: string, href: string): string | null {
  const cleanHref = href.trim().split('#')[0].split('?')[0].trim()
  if (!cleanHref || ANY_SCHEME_RE.test(cleanHref) || cleanHref.startsWith('//') || /^[a-z]:/i.test(cleanHref) || cleanHref.startsWith('/')) {
    return null
  }
  const normalizedBase = currentFilePath.replace(/\\/g, '/')
  const lastSlash = normalizedBase.lastIndexOf('/')
  const dirParts = lastSlash >= 0 ? normalizedBase.slice(0, lastSlash).split('/').filter(Boolean) : []
  const stack = [...dirParts]
  for (const rawSegment of cleanHref.replace(/\\/g, '/').split('/')) {
    if (!rawSegment) continue
    let segment: string
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      return null
    }
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return null
    stack.push(segment)
  }
  return stack.length ? stack.join('/') : null
}
