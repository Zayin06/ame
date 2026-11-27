/** Serialize a DOM selection without mutating the document or selection. */
export function selectionToMarkdown(container: HTMLElement, range: Range, source: string): string | null {
  if (range.collapsed || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
  const ignored = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('.code-block__header')
  const selectedText = (node: Node): string => {
    if (ignored(node) || !range.intersectsNode(node)) return ''
    if (node.nodeType !== 3) return Array.from(node.childNodes).map(selectedText).join('')
    const text = node.textContent ?? ''
    return text.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : text.length)
  }
  // Visible leaf boundaries exclude code header controls.
  const leaves: Node[] = []
  const collect = (node: Node) => {
    if (ignored(node)) return
    if ((node.nodeType === 3 && node.textContent) || (node.nodeType === 1 && (node as Element).matches('hr, pre > code:empty'))) leaves.push(node)
    else node.childNodes.forEach(collect)
  }
  collect(container)
  if (leaves.length && leaves.every(node => {
    if (node.nodeType === 3) return range.comparePoint(node, 0) === 0 && range.comparePoint(node, node.textContent!.length) === 0
    const parent = node.parentNode!
    const index = Array.from(parent.childNodes).indexOf(node as ChildNode)
    return range.comparePoint(parent, index) === 0 && range.comparePoint(parent, index + 1) === 0
  })) return source
  if (!selectedText(container) && !Array.from(container.querySelectorAll('hr')).some(hr => range.intersectsNode(hr))) return null
  const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement
  const narrow = start?.closest('.inline-code, .file-chip, strong, em, del, a, pre > code')
  if (narrow && container.contains(narrow) && narrow.contains(range.endContainer)) return range.toString()
  const codeSpan = (text: string) => {
    const fence = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
    const pad = text.startsWith('`') || text.endsWith('`') || (/^ .* $/s.test(text) && /[^ ]/.test(text)) ? ' ' : ''
    return `${fence}${pad}${text}${pad}${fence}`
  }
  const children = (node: Node, depth = 0): string => Array.from(node.childNodes).map(child => serialize(child, depth)).join('')
  const blocks = (node: Node, depth = 0): string => Array.from(node.childNodes).map(child => serialize(child, depth)).filter(Boolean).join('\n\n')
  const serialize = (node: Node, depth = 0): string => {
    if (ignored(node) || !range.intersectsNode(node)) return ''
    if (node.nodeType === 3) return selectedText(node)
    if (node.nodeType !== 1) return ''
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') return ''
    if (tag === 'hr') return '---'
    if (el.matches('.code-block')) {
      const code = el.querySelector('pre > code')
      const text = code ? selectedText(code) : ''
      if (!text) return ''
      const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
      return `${fence}${el.dataset.language ?? ''}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`
    }
    if (el.matches('.gfm-table')) {
      const rows = Array.from(el.querySelectorAll('tr')).filter(row => selectedText(row))
      return rows.flatMap((row, index) => {
        const cells = Array.from(row.children).map(cell => children(cell).replace(/\|/g, '\\|').replace(/\n/g, '<br>'))
        const line = `| ${cells.join(' | ')} |`
        if (index !== 0) return [line]
        const separators = Array.from(row.children).map(cell => {
          const align = (cell as HTMLElement).style.textAlign
          return align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---'
        })
        return [line, `| ${separators.join(' | ')} |`]
      }).join('\n')
    }
    if (tag === 'ul' || tag === 'ol') {
      let number = Number(el.getAttribute('start') ?? 1)
      return Array.from(el.children).map(item => {
        const value = item.getAttribute('value')
        if (value !== null) number = Number(value)
        const marker = tag === 'ol' ? `${number++}. ` : '- '
        const checkbox = Array.from(item.children).find(child => child.matches('input[type="checkbox"]')) as HTMLInputElement | undefined
        const body = Array.from(item.childNodes).reduce((body, child) => {
          if (child.nodeType === 1 && (child as Element).matches('ul, ol')) {
            const nested = serialize(child, depth + 1)
            return nested ? `${body}\n${nested}` : body
          }
          const content = serialize(child, depth)
          if (content && child.nodeType === 1 && (child as Element).matches('p, blockquote, .code-block, h1, h2, h3, h4, h5, h6, hr, .gfm-table-scroll')) {
            const indent = '  '.repeat(depth) + ' '.repeat(marker.length)
            if (body.trim()) return `${body}\n\n${content.split('\n').map(line => `${indent}${line}`).join('\n')}`
            return content.split('\n').map((line, index) => index ? `${indent}${line}` : line).join('\n')
          }
          return body + content
        }, '')
        return body ? `${'  '.repeat(depth)}${marker}${checkbox ? `[${checkbox.checked ? 'x' : ' '}] ` : ''}${body}` : ''
      }).filter(Boolean).join('\n')
    }
    const text = children(el, depth)
    if (!text) return ''
    if (el.matches('.inline-code, .file-chip')) return codeSpan(selectedText(el))
    if (tag === 'strong') return `**${text}**`
    if (tag === 'em') return `*${text}*`
    if (tag === 'del') return `~~${text}~~`
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? ''
      return selectedText(el) === href ? href : `[${text}](${href})`
    }
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${text}`
    if (tag === 'blockquote') return blocks(el, depth).split('\n').map(line => `> ${line}`).join('\n')
    if (el.matches('.gfm-table-scroll')) return blocks(el, depth)
    return text
  }
  return blocks(container)
}
