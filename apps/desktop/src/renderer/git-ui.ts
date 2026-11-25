export type GitStatusLike = {
  branch: string
  changes: readonly { index: string }[]
  tracking?: string | null
  ahead?: number
  behind?: number
  hasRemote?: boolean
  merging?: boolean
}
export type GitBranchItemLike = { name: string; current?: boolean; commit?: string; upstream?: string; remote?: boolean }
export type GitBranchesLike = { current?: string; branches: readonly GitBranchItemLike[]; remoteBranches?: readonly GitBranchItemLike[] }

const gitErrors: Record<string, { title: string; detail?: string }> = {
  NO_REMOTE_CONFIGURED: { title: 'Chưa cấu hình remote Git', detail: 'Thêm remote origin hoặc mở Terminal để gắn repository từ xa.' },
  GIT_AUTH_FAILED: { title: 'Xác thực Git với remote thất bại' },
  GIT_OFFLINE: { title: 'Không thể kết nối tới remote Git' },
  GIT_PUSH_REJECTED_NON_FF: { title: 'Push bị từ chối do remote có commit mới', detail: 'Hãy Pull về trước rồi thử Push lại.' },
  GIT_CONFLICT: { title: 'Phát sinh xung đột (merge conflict)', detail: 'Giải quyết xung đột trong mã nguồn, stage các tệp đã sửa rồi commit để hoàn tất.' },
  GIT_DIRTY_WORKTREE: { title: 'Có thay đổi cục bộ chưa commit sẽ bị ghi đè', detail: 'Hãy Commit hoặc Stash thay đổi trước khi Pull / chuyển nhánh.' },
  GIT_ROOT_REQUIRED: { title: 'Thư mục dự án không phải gốc Git (.git)' },
  CANNOT_DELETE_CURRENT_BRANCH: { title: 'Không thể xóa nhánh đang mở', detail: 'Chuyển sang nhánh khác trước khi xóa.' },
  INVALID_BRANCH_NAME: { title: 'Tên nhánh không hợp lệ theo quy tắc Git' },
  DETACHED_HEAD_PUSH_UNSUPPORTED: { title: 'Đang ở trạng thái Detached HEAD', detail: 'Tạo hoặc checkout một nhánh cục bộ trước khi Push.' },
  NO_COMMIT_TO_UNDO: { title: 'Chưa có commit nào để hoàn tác' }
}

export function formatGitError(error: unknown): { title: string; detail?: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.trim().replace(/^(?:Error:\s*)?Error invoking remote method\s+(['"]).*?\1:\s*/s, '').replace(/^(?:Error:\s*)+/, '').trim()
  const match = /^([A-Z][A-Z_]+)(?::\s*([\s\S]*))?$/.exec(message)
  const known = match ? gitErrors[match[1]] : undefined
  if (known) {
    const detail = match?.[2]?.trim()
    return (match?.[1] === 'GIT_AUTH_FAILED' || match?.[1] === 'GIT_OFFLINE') && detail ? { title: known.title, detail } : { ...known }
  }
  if (/hook|pre-commit|commit-msg/i.test(message)) return { title: 'Git hook chặn commit', detail: message }
  return { title: message }
}

export function analyzeCommitMessage(message: string): { subject: string; subjectLength: number; subjectOverLimit: boolean; lineCount: number; charCount: number } {
  const lines = message.split(/\r?\n/)
  const subject = (lines.find(line => line.trim()) ?? lines[0] ?? '').replace(/\r$/, '')
  const subjectLength = [...subject].length
  return { subject, subjectLength, subjectOverLimit: subjectLength > 72, lineCount: lines.length, charCount: message.length }
}

export function formatRelativeGitDate(iso: string, now = Date.now()): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  const elapsed = Math.max(0, now - date.getTime())
  const minute = 60_000, hour = 60 * minute, day = 24 * hour
  if (elapsed < minute) return 'Vừa xong'
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} phút trước`
  if (elapsed < day) return `${Math.floor(elapsed / hour)} giờ trước`
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)} ngày trước`
  return date.toLocaleDateString('vi-VN')
}

export function filterBranches(branches: GitBranchesLike | undefined, query: string): { local: GitBranchItemLike[]; remote: GitBranchItemLike[] } {
  const needle = query.trim().toLowerCase()
  const matches = (branch: GitBranchItemLike) => branch.name.toLowerCase().includes(needle)
  return { local: (branches?.branches ?? []).filter(matches), remote: (branches?.remoteBranches ?? []).filter(matches) }
}

export function syncBadgeSummary(git?: GitStatusLike): { canSync: boolean; needsPublish: boolean; ahead: number; behind: number; pushLabel: string; pullLabel: string; statusText: string } {
  const canSync = !!git?.hasRemote
  const needsPublish = canSync && !git?.tracking
  const ahead = git?.ahead ?? 0, behind = git?.behind ?? 0
  const pushLabel = needsPublish ? 'Publish' : ahead > 0 ? `Push ↑${ahead}` : 'Push'
  const pullLabel = behind > 0 ? `Pull ↓${behind}` : 'Pull'
  const statusText = !canSync ? 'Chưa có remote' : needsPublish ? 'Chưa publish nhánh' : [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' ') || 'Đã đồng bộ'
  return { canSync, needsPublish, ahead, behind, pushLabel, pullLabel, statusText }
}
