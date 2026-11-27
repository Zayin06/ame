export const MAX_PROMPT_FILES = 8
export const MAX_DROPPED_BATCH = 16
export const MAX_MODEL_REQUEST_BYTES = 8 * 1024 * 1024
// Reserve room for JSON framing, prompt and history. The final request still needs
// the gateway check: history is not bounded by the attachment budget.
export const MODEL_REQUEST_RESERVE_BYTES = 2 * 1024 * 1024
export const MAX_ATTACHMENT_ENCODED_BYTES = MAX_MODEL_REQUEST_BYTES - MODEL_REQUEST_RESERVE_BYTES
// Conservative raw limit for every supported MIME, including its data URL prefix.
export const MAX_MEDIA_BYTES = Math.floor((MAX_ATTACHMENT_ENCODED_BYTES - 'data:application/pdf;base64,'.length) / 4) * 3
export const MAX_EXTERNAL_TEXT_BYTES = 512 * 1024
export const SUPPORTED_MEDIA_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf'
}

export function encodedAttachmentBytes(bytes: number, mime: string): number {
  return Math.ceil(bytes / 3) * 4 + new TextEncoder().encode(`data:${mime};base64,`).length
}

export function attachmentSizeError(file: { name: string; size: number; mime: string }): string | undefined {
  if (file.size <= MAX_MEDIA_BYTES && encodedAttachmentBytes(file.size, file.mime) <= MAX_ATTACHMENT_ENCODED_BYTES) return undefined
  const rawLimit = MAX_MEDIA_BYTES
  return `Tệp “${file.name}” quá lớn. Giới hạn thực tế là ${rawLimit} byte (khoảng ${(rawLimit / 1024 / 1024).toFixed(2)} MiB) trước mã hóa, tối đa 6 MiB sau base64 và prefix data URL; dành 2 MiB cho JSON, prompt và lịch sử trong trần yêu cầu 8 MiB.`
}

export function attachmentBatchSizeError(files: readonly { size: number; mime: string; dataUrl?: string }[]): string | undefined {
  const total = files.reduce((sum, file) => sum + Math.max(encodedAttachmentBytes(file.size, file.mime), file.dataUrl ? new TextEncoder().encode(file.dataUrl).length : 0), 0)
  return total > MAX_ATTACHMENT_ENCODED_BYTES
    ? `Tổng dung lượng đính kèm sau base64 và prefix data URL là ${(total / 1024 / 1024).toFixed(2)} MiB (${total} byte), vượt mức 6 MiB. Hãy bỏ bớt tệp trên bản nháp rồi thử lại (trần yêu cầu 8 MiB, dành 2 MiB cho JSON, prompt và lịch sử).`
    : undefined
}

export type PromptFileAttachment = {
  uri: string
  name?: string
  mime?: string
  source?: { type: 'inline' } | { type: 'uri'; uri: string }
}
export type ChatAttachment = { name: string; mime: string; dataUrl?: string; uri?: string; size?: number }
export type ResolvedDroppedFile =
  | { ok: true; kind: 'workspace-file'; path: string; name: string }
  | { ok: true; kind: 'media'; name: string; mime: string; dataUrl: string; size: number; workspacePath?: string }
  | { ok: true; kind: 'external-text'; name: string; mime: string; dataUrl: string; size: number }
  | { ok: false; name: string; reason: string }

export function normalizeBase64DataUrl(mime: string, rawBase64OrDataUrl: string): string {
  const payload = rawBase64OrDataUrl.replace(/\s+/g, '').replace(/^data:[^;,]+;base64,/i, '')
  if (!payload.length || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error('Invalid base64 attachment: expected a non-empty, padded base64 payload.')
  }
  return `data:${mime};base64,${payload}`
}

const textExtensions = new Set('txt md mdx json jsonc yaml yml xml gradle kts kt java ts tsx js jsx mjs cjs css scss html py sh bat ps1 sql toml ini cfg conf csv log properties svg go rs c cpp h hpp swift rb php dart'.split(' '))

export function isTextCodeExtension(name: string): boolean {
  return name.toLowerCase().endsWith('.env.example') || textExtensions.has(/\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase() || '')
}

export function hasNulByte(bytes: Uint8Array): boolean { return bytes.includes(0) }

const invalidPath = 'Đường dẫn tệp không hợp lệ.'
const linkedPath = 'Không hỗ trợ liên kết tượng trưng.'
const binaryFile = 'Không hỗ trợ tệp nhị phân bên ngoài (chỉ hỗ trợ ảnh, PDF và văn bản UTF-8).'
const textTooLarge = 'Tệp văn bản bên ngoài vượt quá giới hạn 512 KiB.'

function comparable(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value }

function sensitiveExternalPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/').filter(Boolean).map(part => part.replace(/[. ]+$/, ''))
  // Dot-prefixed names must retain their leading dot, including .env.
  if (parts.some(part => ['.ssh', '.aws', '.gnupg', '.kube'].includes(part))) return true
  if (parts.some((part, index) => part === '.config' && parts[index + 1] === 'gcloud')) return true
  const name = parts.at(-1) ?? ''
  if (/^(?:\.env(?:\.|$)|id_rsa|id_ed25519)/.test(name) || ['.npmrc', '.netrc'].includes(name) || name.includes('credentials')) return true
  return /^\/(?:etc|proc)(?:\/|$)/.test(normalized) || /^(?:[a-z]:)?\/(?:windows|programdata)(?:\/|$)/.test(normalized)
}

async function checkedPath(value: string) {
  const { lstat, realpath } = await import('node:fs/promises')
  const { default: path } = await import('node:path')
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) throw new Error(invalidPath)
  const absolute = path.resolve(value)
  const isMacOsSystemAlias = (p: string) => process.platform === 'darwin' && (p === '/var' || p === '/tmp' || p === '/etc')
  let current = path.parse(absolute).root
  const segments = absolute.slice(current.length).split(path.sep).filter(Boolean)
  let info = await lstat(current)
  if (info.isSymbolicLink() && !isMacOsSystemAlias(current)) throw new Error(linkedPath)
  for (const segment of segments) {
    current = path.join(current, segment)
    info = await lstat(current)
    if (info.isSymbolicLink() && !isMacOsSystemAlias(current)) throw new Error(linkedPath)
  }
  const real = await realpath(absolute)
  return { info, real }
}

export async function resolveDroppedPaths(projectDir: string, paths: readonly string[]): Promise<ResolvedDroppedFile[]> {
  const { readFile } = await import('node:fs/promises')
  const { default: path } = await import('node:path')
  let realProject = '', projectError = ''
  try {
    const project = await checkedPath(projectDir)
    if (!project.info.isDirectory()) throw new Error(invalidPath)
    realProject = project.real
  } catch (error) {
    projectError = error instanceof Error && [invalidPath, linkedPath].includes(error.message) ? error.message : 'Không thể đọc thư mục dự án.'
  }
  const results: ResolvedDroppedFile[] = []
  for (const droppedPath of paths.slice(0, MAX_DROPPED_BATCH)) {
    const name = typeof droppedPath === 'string' ? path.basename(droppedPath) || droppedPath : ''
    const reject = (reason: string) => results.push({ ok: false, name, reason })
    if (projectError) { reject(projectError); continue }
    try {
      const { info, real } = await checkedPath(droppedPath)
      if (info.isDirectory()) { reject('Không hỗ trợ kéo thư mục.'); continue }
      if (!info.isFile()) { reject('Chỉ hỗ trợ kéo tệp tin.'); continue }
      const relative = path.relative(realProject, real)
      const insideWorkspace = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      if (!insideWorkspace && sensitiveExternalPath(real)) { reject('SENSITIVE_PATH_REJECTED'); continue }
      const relativePosix = relative.split(path.sep).join('/')
      if (insideWorkspace && relativePosix.split('/').some(part => part.replace(/[. ]+$/, '').toLowerCase() === '.git')) {
        reject('Không thể đính kèm tệp nội bộ .git.'); continue
      }
      const extension = path.extname(real).slice(1).toLowerCase()
      const mime = Object.hasOwn(SUPPORTED_MEDIA_MIMES, extension) ? SUPPORTED_MEDIA_MIMES[extension] : undefined
      if (mime) {
        if (!info.size) { reject('Tệp rỗng không thể đính kèm.'); continue }
        const sizeError = attachmentSizeError({ name, size: info.size, mime })
        if (sizeError) { reject(sizeError); continue }
        const bytes = await readFile(real)
        if (!bytes.length) { reject('Tệp rỗng không thể đính kèm.'); continue }
        const readSizeError = attachmentSizeError({ name, size: bytes.length, mime })
        if (readSizeError) { reject(readSizeError); continue }
        results.push({ ok: true, kind: 'media', name, mime, dataUrl: normalizeBase64DataUrl(mime, bytes.toString('base64')), size: bytes.length, ...(insideWorkspace ? { workspacePath: relativePosix } : {}) })
      } else if (insideWorkspace) {
        results.push({ ok: true, kind: 'workspace-file', path: relativePosix, name })
      } else {
        if (info.size > MAX_EXTERNAL_TEXT_BYTES) { reject(textTooLarge); continue }
        const bytes = await readFile(real)
        if (bytes.length > MAX_EXTERNAL_TEXT_BYTES) { reject(textTooLarge); continue }
        if (hasNulByte(bytes)) { reject(binaryFile); continue }
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { reject(binaryFile); continue }
        results.push({ ok: true, kind: 'external-text', name, mime: 'text/plain', dataUrl: `data:text/plain;base64,${bytes.toString('base64')}`, size: bytes.length })
      }
    } catch (error) {
      reject(error instanceof Error && [invalidPath, linkedPath].includes(error.message) ? error.message : 'Không thể đọc tệp đính kèm.')
    }
  }
  const inline = results.filter((item): item is Extract<ResolvedDroppedFile, { dataUrl: string }> => item.ok && item.kind !== 'workspace-file')
  const batchError = attachmentBatchSizeError(inline)
  if (batchError) {
    // Reject the batch atomically rather than silently sending only some files.
    return results.map(item => item.ok && item.kind !== 'workspace-file' ? { ok: false, name: item.name, reason: batchError } : item)
  }
  if (paths.length > MAX_DROPPED_BATCH) results.push({ ok: false, name: '...', reason: 'Chỉ xử lý tối đa 16 tệp mỗi lần kéo thả.' })
  return results
}
