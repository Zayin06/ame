import { isUtf8 } from 'node:buffer'
import { fileURLToPath } from 'node:url'

// Only consume complete, NUL-terminated names; never decode a partial UTF-16 unit.
function terminatedNames(buffer: Buffer, wide: boolean): string[] {
  const names: string[] = []
  const step = wide ? 2 : 1
  let start = 0
  for (let end = 0; end + step <= buffer.length; end += step) {
    if (wide ? buffer.readUInt16LE(end) !== 0 : buffer[end] !== 0) continue
    if (end === start) break
    const name = buffer.subarray(start, end)
    names.push(name.toString(wide ? 'utf16le' : isUtf8(name) ? 'utf8' : 'latin1'))
    start = end + step
  }
  return names
}

export function parseWinCfHdrop(buffer: Buffer): string[] {
  if (buffer.length < 20) return []
  const offset = buffer.readUInt32LE(0)
  if (offset < 20 || offset >= buffer.length) return []
  return terminatedNames(buffer.subarray(offset), buffer.readUInt32LE(16) !== 0)
}

export function parseWinFileNameW(buffer: Buffer): string[] {
  return terminatedNames(buffer, true).slice(0, 1)
}

function decodeXmlString(value: string): string | undefined {
  let valid = true
  const decoded = value.replace(/&([^;]*);|&/g, (entity, body: string | undefined) => {
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (body && Object.hasOwn(predefined, body)) return predefined[body]
    if (body && /^#(?:[0-9]+|x[0-9a-f]+)$/i.test(body)) {
      const code = body[1].toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code)
    }
    valid = false
    return entity
  })
  return valid && !decoded.includes('\0') ? decoded : undefined
}

export function parseMacFilenamesPlist(xml: string): string[] {
  // Apple serializes NSFilenamesPboardType as an XML array of strings. Do not
  // resolve DTD entities or treat strings outside that array as filenames.
  const array = /<array\s*>([\s\S]*?)<\/array\s*>/.exec(xml.replace(/<!--[\s\S]*?-->/g, ''))
  if (!array) return []
  const names: string[] = []
  for (const match of array[1].matchAll(/<string\s*>([^<]*)<\/string\s*>/g)) {
    const name = decodeXmlString(match[1])
    if (name) names.push(name)
  }
  return names
}

export function parseUriList(text: string): string[] {
  const names: string[] = []
  for (const entry of text.split(/\r\n|[\r\n\0]/)) {
    const line = entry.trim()
    if (!line || line.startsWith('#')) continue
    try {
      const url = new URL(line)
      if (url.protocol !== 'file:') continue
      const name = fileURLToPath(url)
      if (name && !name.includes('\0')) names.push(name)
    } catch { /* Ignore malformed URLs, including invalid percent escapes. */ }
  }
  return names
}

export interface OsClipboardApi {
  availableFormats?: () => string[]
  readBuffer?: (format: string) => Buffer
  read?: (format: string) => string
}

export function readOsClipboardFiles(api: OsClipboardApi, exists: (path: string) => boolean = () => true): string[] {
  const parsers = [
    ['CF_HDROP', (buffer: Buffer) => parseWinCfHdrop(buffer)],
    ['FileNameW', (buffer: Buffer) => parseWinFileNameW(buffer)],
    ['NSFilenamesPboardType', (buffer: Buffer) => parseMacFilenamesPlist(buffer.toString('utf8'))],
    ['public.file-url', (buffer: Buffer) => parseUriList(buffer.toString('utf8'))],
    ['text/uri-list', (buffer: Buffer) => parseUriList(buffer.toString('utf8'))],
  ] as const
  let formats: string[] | undefined
  try { formats = api.availableFormats?.() } catch { /* Probe known formats if enumeration fails. */ }
  const result: string[] = []
  const seen = new Set<string>()
  for (const [knownFormat, parse] of parsers) {
    const format = formats ? formats.find(value => value.toLowerCase() === knownFormat.toLowerCase()) : knownFormat
    if (!format) continue
    let names: string[] = []
    try {
      const buffer = api.readBuffer?.(format)
      if (buffer?.length) names = parse(buffer)
    } catch { /* A format may be advertised but not readable as a buffer. */ }
    if (!names.length && knownFormat !== 'CF_HDROP' && knownFormat !== 'FileNameW') {
      try {
        const text = api.read?.(format)
        if (text) names = parse(Buffer.from(text, 'utf8'))
      } catch { /* Continue with the remaining formats. */ }
    }
    for (const name of names) {
      if (!name || name.includes('\0') || seen.has(name)) continue
      seen.add(name)
      try { if (exists(name)) result.push(name) } catch { /* Inaccessible paths are not usable attachments. */ }
    }
  }
  return result
}
