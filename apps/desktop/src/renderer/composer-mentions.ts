import { rankQuickOpenFiles } from './quick-open'
import type { PromptFileAttachment, ResolvedDroppedFile } from '../../../../packages/ide-core/src/dropped-attachments'
import { attachmentBatchSizeError, attachmentSizeError, MAX_EXTERNAL_TEXT_BYTES, MAX_PROMPT_FILES, SUPPORTED_MEDIA_MIMES } from '../../../../packages/ide-core/src/dropped-attachments'
export { MAX_EXTERNAL_TEXT_BYTES, MAX_MEDIA_BYTES, MAX_PROMPT_FILES } from '../../../../packages/ide-core/src/dropped-attachments'

export const WORKSPACE_DRAG_MIME = 'application/x-ame-workspace-path'

export type ComposerTrigger = { kind: '@' | '/'; start: number; end: number; query: string }

export function detectComposerTrigger(text: string, cursor: number): ComposerTrigger | null {
  if (!Number.isFinite(cursor)) return null
  const end = Math.max(0, Math.min(text.length, Math.floor(cursor)))
  let start = end
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const kind = text[start]
  if ((kind !== '@' && kind !== '/') || start === end) return null
  return { kind, start, end, query: text.slice(start + 1, end) }
}

export function applyComposerCompletion(text: string, trigger: ComposerTrigger, replacement: string): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, trigger.start))
  const end = Math.max(start, Math.min(text.length, trigger.end))
  const suffix = text.slice(end)
  const completion = replacement + (/\s$/.test(replacement) || /^\s/.test(suffix) ? '' : ' ')
  return { text: text.slice(0, start) + completion + suffix, cursor: start + completion.length + (!/\s$/.test(completion) && /^\s/.test(suffix) ? 1 : 0) }
}

export type SlashEntry = { kind: 'command' | 'skill'; name: string; description?: string; insertText: string }

export function filterSlashEntries(query: string, commands: readonly { name: string; description?: string }[], skills: readonly { id: string; name: string; description?: string }[]): SlashEntry[] {
  const needle = query.replace(/^\//, '').toLowerCase()
  const entries: SlashEntry[] = [
    ...commands.map(command => ({ ...command, kind: 'command' as const, insertText: `/${command.name}` })),
    ...skills.map(skill => ({ kind: 'skill' as const, name: skill.name, description: skill.description, insertText: `/${skill.id}` }))
  ]
  const seen = new Set<string>()
  return entries.filter(entry => {
    const key = entry.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return key.includes(needle)
  }).sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)) || a.name.localeCompare(b.name))
}

export function filterFileMentions(query: string, files: readonly string[], recentPaths?: readonly string[], limit?: number) {
  return rankQuickOpenFiles(query, files, recentPaths, limit)
}

export type ComposerAttachment =
  | { id: string; kind: 'file' | 'selection'; path: string; lineStart?: number; lineEnd?: number; excerpt?: string }
  | { id: string; kind: 'media' | 'external-text'; name: string; mime: string; dataUrl: string; size: number; workspacePath?: string }

// Validate the whole draft, including attachments from earlier picker/drop events.
// Keep this pure so a failed validation never discards the user's draft.
export function composerAttachmentSizeError(attachments: readonly ComposerAttachment[]): string | undefined {
  const inline = attachments.filter((item): item is Extract<ComposerAttachment, { dataUrl: string }> => 'dataUrl' in item)
  for (const item of inline) {
    const error = attachmentSizeError(item)
    if (error) return error
  }
  const unique = inline.filter((item, index) => inline.findIndex(other => other.dataUrl === item.dataUrl && other.name === item.name) === index)
  return attachmentBatchSizeError(unique)
}

export function composePromptWithAttachments(text: string, attachments: readonly ComposerAttachment[]): string {
  const seen = new Set<string>()
  const blocks: string[] = []
  for (const attachment of attachments) {
    if (attachment.kind !== 'file' && attachment.kind !== 'selection') continue
    if (!attachment.path.trim()) continue
    const { kind, path, lineStart, lineEnd, excerpt } = attachment
    const key = JSON.stringify([kind, path, lineStart, lineEnd, excerpt])
    if (seen.has(key)) continue
    seen.add(key)
    const start = lineStart !== undefined && Number.isFinite(lineStart) ? Math.max(1, Math.floor(lineStart)) : undefined
    const line = start !== undefined ? `:${start}${lineEnd !== undefined && Number.isFinite(lineEnd) ? `-${Math.max(start, Math.floor(lineEnd))}` : ''}` : ''
    let block = `@${path.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')}${line}`
    if (excerpt) {
      // A longer fence keeps arbitrary source excerpts from closing the context block.
      const fence = '`'.repeat(Math.max(3, ...Array.from(excerpt.matchAll(/`+/g), match => match[0].length + 1)))
      block += `\n${fence}\n${excerpt}\n${fence}`
    }
    blocks.push(block)
  }
  return blocks.length ? blocks.join('\n\n') + (text ? `\n\n${text}` : '') : text
}

export function splitComposerAttachments(text: string, attachments: readonly ComposerAttachment[]): { text: string; files: PromptFileAttachment[]; truncatedCount: number } {
  const seen = new Set<string>()
  const files: PromptFileAttachment[] = []
  let truncatedCount = 0
  for (const item of attachments) {
    if (item.kind !== 'media' && item.kind !== 'external-text') continue
    const key = JSON.stringify([item.dataUrl, item.name])
    if (seen.has(key)) continue
    seen.add(key)
    if (files.length === MAX_PROMPT_FILES) { truncatedCount++; continue }
    files.push({ uri: item.dataUrl, name: item.name, mime: item.mime, source: { type: 'inline' } })
  }
  return { text: composePromptWithAttachments(text, attachments), files, truncatedCount }
}

const mediaMimes = SUPPORTED_MEDIA_MIMES
const textExtensions = new Set('txt md mdx json jsonc yaml yml xml gradle kts kt java ts tsx js jsx mjs cjs css scss html py sh bat ps1 sql toml ini cfg conf csv log properties svg go rs c cpp h hpp swift rb php dart'.split(' '))

export function classifyBrowserFile(file: { name: string; type?: string; size: number }): { ok: true; kind: 'media' | 'external-text'; mime: string } | { ok: false; reason: string } {
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, reason: 'Tệp rỗng không thể đính kèm.' }
  const extension = /\.([^.\\/]+)$/.exec(file.name)?.[1].toLowerCase() || ''
  const type = file.type?.toLowerCase() || ''
  const mime = Object.values(mediaMimes).includes(type) ? type : Object.hasOwn(mediaMimes, extension) ? mediaMimes[extension] : undefined
  if (mime) {
    const reason = attachmentSizeError({ ...file, mime })
    return reason ? { ok: false, reason } : { ok: true, kind: 'media', mime }
  }
  if (textExtensions.has(extension) || file.name.toLowerCase().endsWith('.env.example')) {
    return file.size > MAX_EXTERNAL_TEXT_BYTES ? { ok: false, reason: 'Tệp văn bản bên ngoài vượt quá giới hạn 512 KiB.' } : { ok: true, kind: 'external-text', mime: 'text/plain' }
  }
  return { ok: false, reason: 'Không hỗ trợ loại tệp này (chỉ hỗ trợ ảnh, PDF và văn bản UTF-8).' }
}

export async function readBrowserFileAttachment(file: File): Promise<ResolvedDroppedFile> {
  const classification = classifyBrowserFile(file)
  if (!classification.ok) return { ...classification, name: file.name }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const checked = classifyBrowserFile({ name: file.name, type: file.type, size: bytes.length })
    if (!checked.ok) return { ...checked, name: file.name }
    const { kind, mime } = classification
    if (kind === 'external-text') {
      try {
        if (bytes.includes(0)) throw new Error('NUL')
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return { ok: false, name: file.name, reason: 'Không hỗ trợ tệp nhị phân bên ngoài (chỉ hỗ trợ ảnh, PDF và văn bản UTF-8).' }
      }
    }
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return { ok: true, kind, name: file.name, mime, dataUrl: `data:${mime};base64,${btoa(binary)}`, size: bytes.length }
  } catch {
    return { ok: false, name: file.name, reason: 'Không thể đọc tệp đính kèm.' }
  }
}
