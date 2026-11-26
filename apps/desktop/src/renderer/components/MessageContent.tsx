import { type ReactNode } from 'react'
import { parseFileRef, parseMarkdown, type BlockNode, type InlineNode } from '../markdown-parser'
import { CopyButton } from './ToolCard'

type OpenFile = (path: string, line?: number) => void

function inline(nodes: InlineNode[], onOpenFile?: OpenFile): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return node.text
      case 'code': {
        const ref = onOpenFile ? parseFileRef(node.text) : null
        return ref && onOpenFile
          ? <button type="button" className="file-chip" key={index} aria-label={`Mở tệp ${node.text}`} onClick={() => onOpenFile(ref.path, ref.line)}>{node.text}</button>
          : <code className="inline-code" key={index}>{node.text}</code>
      }
      case 'strong': return <strong key={index}>{inline(node.children, onOpenFile)}</strong>
      case 'em': return <em key={index}>{inline(node.children, onOpenFile)}</em>
      case 'del': return <del key={index}>{inline(node.children, onOpenFile)}</del>
      case 'link': return <a key={index} href={node.url} target="_blank" rel="noreferrer" onClick={event => {
        event.preventDefault()
        void window.ame.openExternal(node.url).catch(() => {})
      }}>{inline(node.children, onOpenFile)}</a>
    }
  })
}

function renderBlocks(blocks: BlockNode[], onOpenFile?: OpenFile): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'paragraph': return <p key={index}>{inline(block.children, onOpenFile)}</p>
      case 'heading': {
        const Heading = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return <Heading key={index}>{inline(block.children, onOpenFile)}</Heading>
      }
      case 'hr': return <hr key={index} />
      case 'blockquote': return <blockquote key={index}>{renderBlocks(block.blocks, onOpenFile)}</blockquote>
      case 'code': return <div className="code-block" key={index}>
        <div className="code-block__header"><span>{block.language || 'code'} {!block.closed && <span className="code-block__streaming">streaming</span>}</span><CopyButton text={block.code} label="Sao chép khối mã" /></div>
        <pre><code>{block.code}</code></pre>
      </div>
      case 'table': return <div className="gfm-table-scroll" key={index}><table className="gfm-table">
        <thead><tr>{block.headers.map((cell, column) => <th key={column} scope="col" style={{ textAlign: block.align[column] ?? undefined }}>{inline(cell, onOpenFile)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>{inline(cell, onOpenFile)}</td>)}</tr>)}</tbody>
      </table></div>
      case 'list': {
        const List = block.ordered ? 'ol' : 'ul'
        return <List key={index} className={block.items.some(item => item.checked !== undefined) ? 'task-list' : undefined}>{block.items.map((item, itemIndex) => <li key={itemIndex} className={item.checked !== undefined ? 'task-list__item' : undefined}>
          {item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Đã hoàn thành' : 'Chưa hoàn thành'} />}
          {inline(item.children, onOpenFile)}{item.blocks && renderBlocks(item.blocks, onOpenFile)}
        </li>)}</List>
      }
    }
  })
}
export function MessageContent({ text, onOpenFile }: { text: string; onOpenFile?: OpenFile }) {
  return <div className="chat-markdown">{renderBlocks(parseMarkdown(text), onOpenFile)}</div>
}
