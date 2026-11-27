import { Component, type ErrorInfo, type ReactNode } from 'react'
import { hasUnsavedBuffers } from '../buffer-recovery'

type ErrorBoundaryProps = { title?: string; resetKey?: unknown; onRetry?: () => void; children: ReactNode }

export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) { console?.error?.('[ErrorBoundary]', error, info) }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    // Render untrusted error text as text, never HTML or a stack trace.
    const message = (this.state.error.message || 'Không thể hiển thị nội dung này.').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2000)
    return <section className="error-boundary" role="alert" style={{ margin: 16, padding: 20, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', minWidth: 0 }}>
      <h2>{this.props.title ?? 'Đã xảy ra lỗi hiển thị'}</h2>
      <p style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={{ color: 'var(--accent)' }} onClick={() => { this.setState({ error: null }); this.props.onRetry?.() }}>Thử lại</button>
        <button type="button" onClick={() => { if (typeof window === 'undefined') return; if (hasUnsavedBuffers() && window.confirm?.('Bạn có thay đổi chưa lưu. Vẫn tải lại giao diện?') === false) return; window.location?.reload?.() }}>Tải lại giao diện</button>
      </div>
    </section>
  }
}
