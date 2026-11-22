import type { Session } from '../../../../../packages/protocol/src/index'
import { sessionTree } from '../session-tree'
import { Empty } from './Primitives'
import { Icon } from './Icon'

export function AgentList({ sessions, selected, loading, error, connected, onRetry, onSelect }: { sessions: Session[]; selected?: string; loading: boolean; error: string; connected: boolean; onRetry: () => void; onSelect: (id: string) => void }) {
  if (!connected) return <Empty>Kết nối OpenCode để tải tác vụ.</Empty>
  if (error) return <Empty><span role="alert">{error}</span><button onClick={onRetry}>Thử lại</button></Empty>
  if (loading && !sessions.length) return <Empty>Đang tải tác vụ…</Empty>
  if (!sessions.length) return <Empty>Chưa có tác vụ. Subagents xuất hiện khi agent gọi công cụ native.</Empty>
  return <div className="scroll agent-list" aria-label="Native subagent tree"><p className="muted">Root + 3 tầng con · trạng thái từ OpenCode. Parent đã dừng không có nghĩa mọi tác vụ con đã xong.</p><div role="tree" aria-label="Sessions & subagents">{sessionTree(sessions).map(({ session, depth, runningDescendants }) => <button role="treeitem" aria-level={depth + 1} aria-selected={selected === session.id} data-session-id={session.id} data-status={session.status} className={`agent-row ${selected === session.id ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 20 }} key={session.id} onClick={() => onSelect(session.id)}><Icon name="agents" /><span className="truncate" title={session.title}>{session.title}<small>{session.agent || 'Agent mặc định'} · depth {depth}</small></span><span className="agent-outcome">{session.status === 'running' ? 'Đang chạy' : session.outcome || 'Chờ'}{runningDescendants > 0 && <small>{runningDescendants} tác vụ con đang chạy</small>}</span></button>)}</div></div>
}
