import { Children, isValidElement, useRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import { CopyButton } from './ToolCard'
import { isMarkdownFile, resolveMarkdownLink } from '../markdown-files'

export { isMarkdownFile, resolveMarkdownLink }

const EXTERNAL_HREF_RE = /^(?:https?:|mailto:)/i

function escapeSelector(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id)
  return id.replace(/([^\w-])/g, '\\$1')
}

function extractNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractNodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return extractNodeText(node.props.children)
  return ''
}

export function MarkdownViewer({
  content,
  theme,
  filePath,
  onOpenFile,
}: {
  content: string
  theme: 'dark' | 'light'
  filePath?: string
  onOpenFile?: (path: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={containerRef} className="md-viewer" data-testid="md-viewer" data-theme={theme}>
      <article className="markdown-body md-viewer__content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, rehypeHighlight]}
          components={{
            a({ href, children, ...rest }) {
              return (
                <a
                  {...rest}
                  href={href}
                  rel="noreferrer"
                  onClick={event => {
                    event.preventDefault()
                    if (!href) return
                    if (EXTERNAL_HREF_RE.test(href)) {
                      void window.ame?.openExternal?.(href).catch(() => {})
                      return
                    }
                    if (href.startsWith('#')) {
                      let targetId: string
                      try {
                        targetId = decodeURIComponent(href.slice(1))
                      } catch {
                        return
                      }
                      const root = containerRef.current
                      if (!targetId || !root) return
                      const el = root.querySelector<HTMLElement>(`#${escapeSelector(targetId)}`)
                      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      return
                    }
                    if (filePath && onOpenFile) {
                      const resolved = resolveMarkdownLink(filePath, href)
                      if (resolved) onOpenFile(resolved)
                    }
                  }}
                >
                  {children}
                </a>
              )
            },
            pre({ children, ...rest }) {
              const rawText = Children.toArray(children).map(extractNodeText).join('').replace(/\n$/, '')
              return (
                <div className="md-viewer__pre-wrap">
                  {rawText && (
                    <div className="md-viewer__copy-btn">
                      <CopyButton text={rawText} label="Sao chép khối mã" />
                    </div>
                  )}
                  <pre {...rest}>{children}</pre>
                </div>
              )
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  )
}
