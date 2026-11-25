import type { DesktopApi } from '../../../../packages/protocol/src/index'
import { dirty, documentID, savedDocument, type Buffer } from './state'

type RemovalApi = Pick<DesktopApi, 'confirmProjectRemoval' | 'removeProject' | 'save'>

// Read the document store, never the visible tabs: inactive editors own buffers too.
export async function removeProjectSafely(projectID: string, options: {
  api: RemovalApi
  buffers: () => Record<string, Buffer>
  update: (key: string, update: (buffer: Buffer) => Buffer) => void
  saving: Set<string>
}): Promise<boolean> {
  const pending = () => Object.values(options.buffers()).filter(buffer => buffer.projectID === projectID && dirty(buffer))
  const paths = pending().map(buffer => buffer.path)
  const approval = paths.length ? await options.api.confirmProjectRemoval(projectID, paths) : undefined
  if (approval === null) return false
  if (approval?.choice === 'save') {
    for (const path of pending().map(buffer => buffer.path)) {
      const key = documentID(projectID, path)
      const buffer = options.buffers()[key]
      if (!buffer || !dirty(buffer)) continue
      try {
        if (buffer.conflict) throw new Error('FILE_CONFLICT: Xung đột phiên bản; cần nạp lại tệp sau khi giữ lại chỉnh sửa.')
        if (options.saving.has(key)) throw new Error('Tệp đang được lưu. Hãy thử gỡ lại sau khi lưu xong.')
        options.saving.add(key)
        try {
          const saved = await options.api.save(projectID, buffer.path, buffer.text, buffer.revision)
          options.update(key, current => savedDocument(current, saved, buffer.text))
        } finally { options.saving.delete(key) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('FILE_CONFLICT')) options.update(key, current => ({ ...current, conflict: true }))
        throw new Error(`Không thể lưu ${buffer.path}: ${message}`)
      }
    }
  }
  // Edits made while awaiting saves/confirmation must never be silently discarded.
  if (approval?.choice !== 'discard' && pending().length) {
    throw new Error(`Dừng gỡ dự án vì còn thay đổi chưa lưu: ${pending().map(buffer => buffer.path).join(', ')}`)
  }
  await options.api.removeProject(projectID, approval?.token)
  return true
}
