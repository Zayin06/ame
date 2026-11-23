import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export const MAX_PROMPT_FILES = 8
export const MAX_DROPPED_BATCH = 16
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024
export const MAX_EXTERNAL_TEXT_BYTES = 512 * 1024
export const SUPPORTED_MEDIA_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf'
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
  return name.toLowerCase().endsWith('.env.example') || textExtensions.has(path.extname(name).slice(1).toLowerCase())
}

export function hasNulByte(bytes: Uint8Array): boolean { return bytes.includes(0) }

const invalidPath = 'Đường dẫn tệp không hợp lệ.'
const linkedPath = 'Không hỗ trợ liên kết tượng trưng.'
const binaryFile = 'Không hỗ trợ tệp nhị phân bên ngoài (chỉ hỗ trợ ảnh, PDF và văn bản UTF-8).'
const mediaTooLarge = 'Tệp ảnh/PDF vượt quá giới hạn 10 MiB.'
const textTooLarge = 'Tệp văn bản bên ngoài vượt quá giới hạn 512 KiB.'

function comparable(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value }

async function checkedPath(value: string) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) throw new Error(invalidPath)
  const absolute = path.resolve(value)
  let current = path.parse(absolute).root
  const segments = absolute.slice(current.length).split(path.sep).filter(Boolean)
  let info = await lstat(current)
  if (info.isSymbolicLink()) throw new Error(linkedPath)
  for (const segment of segments) {
    current = path.join(current, segment)
    info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(linkedPath)
  }
  const real = await realpath(absolute)
  if (comparable(real) !== comparable(absolute)) throw new Error(linkedPath)
  return { info, real }
}

export async function resolveDroppedPaths(projectDir: string, paths: readonly string[]): Promise<ResolvedDroppedFile[]> {
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
      const relativePosix = relative.split(path.sep).join('/')
      if (insideWorkspace && relativePosix.split('/').some(part => part.replace(/[. ]+$/, '').toLowerCase() === '.git')) {
        reject('Không thể đính kèm tệp nội bộ .git.'); continue
      }
      const extension = path.extname(real).slice(1).toLowerCase()
      const mime = Object.hasOwn(SUPPORTED_MEDIA_MIMES, extension) ? SUPPORTED_MEDIA_MIMES[extension] : undefined
      if (mime) {
        if (!info.size) { reject('Tệp rỗng không thể đính kèm.'); continue }
        if (info.size > MAX_MEDIA_BYTES) { reject(mediaTooLarge); continue }
        const bytes = await readFile(real)
        if (!bytes.length) { reject('Tệp rỗng không thể đính kèm.'); continue }
        if (bytes.length > MAX_MEDIA_BYTES) { reject(mediaTooLarge); continue }
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
  if (paths.length > MAX_DROPPED_BATCH) results.push({ ok: false, name: '...', reason: 'Chỉ xử lý tối đa 16 tệp mỗi lần kéo thả.' })
  return results
}
