import type { BuildNotesPreview } from '../../../../packages/protocol/src/index'
import { formatGitError } from './git-ui'

function plainInline(text: string): string {
  return text.split(/(\[[^\]]+\]\([^)]+\)|`+[^`]*`+)/g).map(part => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) return `${plainInline(link[1])} (${link[2]})`
    if (part.startsWith('`')) return part.replace(/^`+|`+$/g, '')
    return part.replace(/\*\*([^\n]+?)\*\*|__([^\n]+?)__/g, (_, bold, underline) => bold ?? underline)
      .replace(/~~([^\n]+?)~~/g, '$1')
      .replace(/\*([^*\n]+?)\*/g, '$1')
      .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2')
  }).join('')
}

export function markdownToPlainText(markdown: string): string {
  let fence: { marker: string; length: number } | undefined
  return markdown.replace(/\r\n?/g, '\n').split('\n').flatMap(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) { fence = undefined; return [] }
      return [line]
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; return [] }
    return [plainInline(line.replace(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/, '$1')
      .replace(/^(\s*)[-+*]\s+\[([ xX])\]\s*/, (_, indent, checked) => `${indent}- ${checked.toLowerCase() === 'x' ? '☑' : '☐'} `)
      .replace(/^(\s*)[-+*]\s+/, '$1- '))]
  }).join('\n').trim()
}

const buildNotesErrors: Record<string, { title: string; detail?: string }> = {
  NO_BUILD_CHANGES: { title: 'Không có thay đổi để tạo ghi chú bản build', detail: 'Chọn commit hoặc bao gồm các thay đổi chưa commit.' },
  INVALID_BUILD_BASE_COMMIT: { title: 'Commit được chọn không hợp lệ', detail: 'Chọn tối đa 50 commit thuộc lịch sử nhánh hiện tại.' },
  EMPTY_BUILD_NOTES: { title: 'Mô hình chưa trả về ghi chú bản build', detail: 'Hãy thử tạo lại ghi chú.' },
  AMECODE_LOGIN_REQUIRED: { title: 'Cần đăng nhập AmeCode', detail: 'Đăng nhập AmeCode trước khi tạo ghi chú bản build.' },
  MODEL_POLICY_UNAVAILABLE: { title: 'Không thể sử dụng mô hình đã cấu hình', detail: 'Kiểm tra cấu hình và quyền truy cập mô hình rồi thử lại.' },
}

export function formatBuildNotesError(error: unknown): { title: string; detail?: string } {
  const fallback = formatGitError(error)
  const match = /^([A-Z][A-Z_]+)(?::[\s\S]*)?$/.exec(fallback.title)
  const known = match ? buildNotesErrors[match[1]] : undefined
  return known ? { ...known } : fallback
}

export function summarizeBuildScope(preview: Pick<BuildNotesPreview, 'commitCount' | 'files' | 'workingFileCount' | 'additions' | 'deletions'>): string {
  return `${preview.commitCount} commit · ${preview.files.length} tệp · ${preview.workingFileCount} tệp chưa commit · +${preview.additions} -${preview.deletions}`
}
