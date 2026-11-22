import { rankQuickOpenFiles } from './quick-open'

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

export type ComposerAttachment = { id: string; kind: 'file' | 'selection'; path: string; lineStart?: number; lineEnd?: number; excerpt?: string }

export function composePromptWithAttachments(text: string, attachments: readonly ComposerAttachment[]): string {
  const seen = new Set<string>()
  const blocks: string[] = []
  for (const attachment of attachments) {
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
