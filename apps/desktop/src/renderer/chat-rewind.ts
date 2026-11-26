import type { ChatItem, SessionDiff } from '../../../../packages/protocol/src/index'
import { extractUserDisplayText } from './chat-timeline'

export type RevertState = {
  messageID: string
  partID?: string
  snapshot?: string
  files?: SessionDiff[]
}

export function partitionRevertedMessages(messages: readonly ChatItem[], revert?: RevertState): { active: ChatItem[]; reverted: ChatItem[]; revertedTurnCount: number; targetPromptText?: string } {
  const index = revert?.messageID ? messages.findIndex(item => item.id === revert.messageID || item.id.startsWith(`${revert.messageID}:`) || item.executionID === revert.messageID) : -1
  if (index < 0) return { active: [...messages], reverted: [], revertedTurnCount: 0 }
  const reverted = messages.slice(index)
  const target = reverted.find(item => item.role === 'user' && (item.id === revert!.messageID || item.executionID === revert!.messageID)) ?? reverted.find(item => item.role === 'user')
  return { active: messages.slice(0, index), reverted, revertedTurnCount: reverted.filter(item => item.role === 'user').length, targetPromptText: target ? extractUserDisplayText(target.text) : undefined }
}

export function describeRevertSummary(revert: RevertState, requestedFiles?: boolean): { mode: 'files-restored' | 'files-unavailable' | 'files-unchanged' | 'chat-only'; headline: string; detail: string; files: SessionDiff[]; totalAdditions: number; totalDeletions: number } {
  const files = revert.files ?? []
  const totals = { files, totalAdditions: files.reduce((sum, file) => sum + file.additions, 0), totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0) }
  if (files.length) return { ...totals, mode: 'files-restored', headline: `Đã quay lui hội thoại và khôi phục ${files.length} tệp`, detail: 'Các tệp trong phạm vi snapshot của OpenCode đã được đưa về trước mốc này.' }
  if (requestedFiles === true && !revert.snapshot) return { ...totals, mode: 'files-unavailable', headline: 'Đã quay lui hội thoại (không có snapshot tệp)', detail: 'Hội thoại đã quay lui, nhưng khôi phục tệp không khả dụng vì workspace không có Git hoặc dữ liệu snapshot.' }
  if (requestedFiles === true && revert.snapshot) return { ...totals, mode: 'files-unchanged', headline: 'Đã quay lui hội thoại và kiểm tra tệp', detail: 'Không có tệp nào trong snapshot thay đổi sau mốc đã chọn.' }
  return { ...totals, mode: 'chat-only', headline: 'Đang quay lui hội thoại (giữ nguyên tệp trên đĩa)', detail: 'Chỉ tạm quay lui ngữ cảnh trò chuyện; tệp trên đĩa không bị thay đổi.' }
}

export function formatRevertError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Không thể thực hiện quay lui.')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const value = `${code} ${message}`
  if (/SESSION_BUSY|Session is busy/.test(value)) return 'Phiên đang chạy; hãy dừng phản hồi trước khi quay lui.'
  if (/REVERT_CHILD_UNSUPPORTED/.test(value)) return 'Không thể quay lui trực tiếp trên phiên con.'
  if (/TRANSLATION_SESSION_LOCKED|ANDROID_TRANSLATION_SESSION_REQUIRED|COMMIT_AGENT/.test(value)) return 'Không hỗ trợ quay lui trong phiên chuyên biệt này.'
  if (/OPENCODE_DISCONNECTED/.test(value)) return 'Chưa kết nối tới OpenCode; hãy thử lại sau khi kết nối.'
  if (/SESSION_PROJECT_MISMATCH/.test(value)) return 'Phiên không thuộc dự án đang mở.'
  return message
}
