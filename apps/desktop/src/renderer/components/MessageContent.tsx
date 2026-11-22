import { Fragment, type ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code className="inline-code" key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
    return part
  })
}
export function MessageContent({ text }: { text: string }) {
  const blocks = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
  return <>{blocks.map((block, index) => {
    if (block.startsWith('```')) {
      const newline = block.indexOf('\n')
      return <div className="code-block" key={index}><div className="code-block__header">{block.slice(3, newline).trim() || 'code'}</div><pre><code>{block.slice(newline + 1).replace(/```$/, '')}</code></pre></div>
    }
    return <Fragment key={index}>{block.split(/\n\s*\n/).filter(Boolean).map((paragraph, p) => {
      if (/^#{1,3} /.test(paragraph)) return <h3 key={p}>{inline(paragraph.replace(/^#{1,3} /, ''))}</h3>
      if (/^[-*] /.test(paragraph)) return <ul key={p}>{paragraph.split('\n').map((line, i) => <li key={i}>{inline(line.replace(/^[-*] /, ''))}</li>)}</ul>
      return <p key={p}>{inline(paragraph)}</p>
    })}</Fragment>
  })}</>
}
