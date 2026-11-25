import type { DiffContent } from '../../protocol/src/index'

export const diffPreviewLimit = 4 * 1024 * 1024
export type DiffSide = { content: string; size: number; binary?: boolean; tooLarge?: boolean }
export async function readDiffSide(size: number, read: () => Promise<Buffer>): Promise<DiffSide> {
  if (size > diffPreviewLimit) return { content: '', size, tooLarge: true }
  const bytes = await read()
  if (bytes.length > diffPreviewLimit) return { content: '', size: bytes.length, tooLarge: true }
  if (!bytes.includes(0)) {
    try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), size: bytes.length } } catch { /* Invalid UTF-8 is not previewable text. */ }
  }
  return { content: '', size: bytes.length, binary: true }
}
export function diffContent(original: DiffSide, modified: DiffSide): DiffContent {
  const binary = !!(original.binary || modified.binary), tooLarge = !!(original.tooLarge || modified.tooLarge)
  if (!binary && !tooLarge) return { original: original.content, modified: modified.content }
  return {
    original: '', modified: '', binary, tooLarge,
    originalSize: original.size, modifiedSize: modified.size, sizeBytes: Math.max(original.size, modified.size),
    reason: [binary && 'Tệp nhị phân hoặc không phải UTF-8 hợp lệ', tooLarge && 'Kích thước vượt giới hạn xem trước 4 MiB'].filter(Boolean).join('; '),
  }
}
