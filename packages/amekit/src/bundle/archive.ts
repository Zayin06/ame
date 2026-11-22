// Adapted from opencode-amekit/src/bundle/archive.ts; see ../docs/amekit.md for provenance.
import { Inflate } from "fflate"

// ZIP reader shared in behavior with the other Amecode client/server boundary.
// Validate central AND local headers before expanding bytes; never extract paths directly.
export const ARCHIVE_LIMIT = 20 * 1024 * 1024
const FILE_LIMIT = 10 * 1024 * 1024
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ table[(value ^ byte) & 255]!
  return (value ^ 0xffffffff) >>> 0
}

function safe(name: string) {
  const parts = name.replace(/\/$/, "").split("/")
  if (
    !name || new TextEncoder().encode(name).length > 240 || parts.length > 16 ||
    /[\\:\x00-\x1f\x7f]/.test(name) ||
    parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  ) throw new Error("ZIP chứa đường dẫn không an toàn: " + name)
}

type Entry = { name: string; start: number; packed: number; size: number; method: number; crc: number; mode: number }

export type ArchiveLimits = { compressed: number; expanded: number; file: number; files: number; entries: number; ratio?: number; strict?: boolean; allowPath?: (path: string) => boolean }
const skillLimits: ArchiveLimits = { compressed: ARCHIVE_LIMIT, expanded: ARCHIVE_LIMIT, file: FILE_LIMIT, files: 256, entries: 512 }

function extra(bytes: Uint8Array, start: number, end: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (start < end) {
    if (start + 4 > end) throw new Error("ZIP extra field không hợp lệ")
    const id = view.getUint16(start, true)
    const length = view.getUint16(start + 2, true)
    // Only inert timestamp/Unix uid-gid metadata; reject ZIP64, links and alternate paths.
    if (![0x5455, 0x7875].includes(id) || start + 4 + length > end) throw new Error("ZIP metadata không hỗ trợ")
    const data = start + 4
    if (id === 0x5455) {
      const flags = bytes[data] ?? 0
      const fields = Number(!!(flags & 1)) + Number(!!(flags & 2)) + Number(!!(flags & 4))
      if (!length || flags & ~7 || (length !== 1 + 4 * fields && !(length === 5 && flags & 1)))
        throw new Error("ZIP timestamp metadata không hợp lệ")
    } else {
      const uid = bytes[data + 1] ?? 0
      const gid = bytes[data + 2 + uid] ?? 0
      if (length < 5 || bytes[data] !== 1 || uid < 1 || uid > 8 || gid < 1 || gid > 8 || length !== 3 + uid + gid)
        throw new Error("ZIP Unix metadata không hợp lệ")
    }
    start += 4 + length
  }
}

function footer(bytes: Uint8Array, view: DataView, limits: ArchiveLimits) {
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0 || bytes.length < 22 || view.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + view.getUint16(end + 20, true) !== bytes.length) throw new Error("ZIP không hợp lệ")
  const count = view.getUint16(end + 10, true)
  const offset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
      view.getUint16(end + 8, true) !== count || !count || count > limits.entries ||
      offset + view.getUint32(end + 12, true) !== end)
    throw new Error("ZIP đa đĩa/ZIP64 hoặc quá nhiều entry không được hỗ trợ")
  return { end, count, offset }
}

function supported(entry: Entry, flags: number, disk: number, mode: number, local: number) {
  if (flags & 1 || (entry.method !== 0 && entry.method !== 8) || disk ||
      entry.packed === 0xffffffff || entry.size === 0xffffffff || local === 0xffffffff ||
      ((mode & 0xf000) && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000))
    throw new Error("ZIP chứa entry mã hóa, liên kết hoặc định dạng không hỗ trợ")
  if (entry.name.endsWith("/")) {
    if (entry.size || (mode & 0xf000) === 0x8000) throw new Error("ZIP directory không hợp lệ")
    return
  }
  if ((mode & 0xf000) === 0x4000) throw new Error("ZIP file không hợp lệ")
}

function locate(bytes: Uint8Array, view: DataView, entry: Entry, local: number, offset: number, flags: number, length: number) {
  if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== entry.method ||
      view.getUint16(local + 26, true) !== length) throw new Error("ZIP local header bị hỏng")
  entry.start = local + 30 + length + view.getUint16(local + 28, true)
  if (entry.start > offset || entry.start + entry.packed > offset ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + length)) !== entry.name)
    throw new Error("ZIP local path/size không khớp")
}

function layout(entries: Entry[], seen: Set<string>, spans: [number, number][]) {
  spans.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < spans.length; index++)
    if (spans[index]![0] < spans[index - 1]![1]) throw new Error("ZIP entries chồng lấn")
  const files = new Set(entries.map((entry) => entry.name.normalize("NFC").toLowerCase()))
  for (const key of seen) {
    const parts = key.split("/")
    while (parts.length > 1) {
      parts.pop()
      if (files.has(parts.join("/"))) throw new Error("ZIP xung đột file/thư mục")
    }
  }
}

function directory(bytes: Uint8Array, limits: ArchiveLimits) {
  if (bytes.length < 22 || bytes.length > limits.compressed) throw new Error("ZIP vượt giới hạn hoặc không hợp lệ")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const info = footer(bytes, view, limits)
  const entries: Entry[] = []
  const seen = new Set<string>()
  const spans: [number, number][] = []
  let at = info.offset
  let total = 0
  for (let index = 0; index < info.count; index++) {
    if (at + 46 > info.end || view.getUint32(at, true) !== 0x02014b50) throw new Error("ZIP central directory bị hỏng")
    const length = view.getUint16(at + 28, true)
    const next = at + 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    if (next > info.end) throw new Error("ZIP central directory bị hỏng")
    const entry: Entry = {
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + length)),
      start: 0, packed: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true),
      method: view.getUint16(at + 10, true), crc: view.getUint32(at + 16, true), mode: (view.getUint32(at + 38, true) >>> 16) & 0o777,
    }
    const local = view.getUint32(at + 42, true)
    const flags = view.getUint16(at + 8, true)
    supported(entry, flags, view.getUint16(at + 34, true), view.getUint32(at + 38, true) >>> 16, local)
    safe(entry.name)
    if (limits.allowPath && !limits.allowPath(entry.name)) throw new Error("ZIP chứa đường dẫn ngoài layout")
    const key = entry.name.replace(/\/$/, "").normalize("NFC").toLowerCase()
    if (seen.has(key)) throw new Error("ZIP trùng đường dẫn: " + entry.name)
    seen.add(key)
    locate(bytes, view, entry, local, info.offset, flags, length)
    if (limits.strict) {
      const host = view.getUint16(at + 4, true) >>> 8
      const attrs = view.getUint32(at + 38, true)
      if (![0, 3].includes(host) || (attrs & 0xffff & ~0x37) || (attrs & 0x08) ||
          ((attrs & 0x10) !== 0 && !entry.name.endsWith("/")) ||
          flags & ~0x800 || view.getUint16(at + 6, true) > 20 ||
          view.getUint16(local + 4, true) > 20 || view.getUint16(at + 36, true) ||
          view.getUint32(local + 14, true) !== entry.crc || view.getUint32(local + 18, true) !== entry.packed ||
          view.getUint32(local + 22, true) !== entry.size ||
          (entry.name.endsWith("/") && (entry.packed || entry.method !== 0)))
        throw new Error("ZIP flags/type/header không hỗ trợ")
      extra(bytes, at + 46 + length, at + 46 + length + view.getUint16(at + 30, true))
      extra(bytes, local + 30 + length, entry.start)
      if (entry.size > Math.max(1, entry.packed) * limits.ratio!) throw new Error("ZIP vượt tỷ lệ nén")
    }
    spans.push([local, entry.start + entry.packed])
    if (!entry.name.endsWith("/")) {
      total += entry.size
      if (entry.size > limits.file || total > limits.expanded || entries.length >= limits.files)
        throw new Error("ZIP vượt giới hạn file/giải nén")
      entries.push(entry)
    }
    at = next
  }
  if (at !== info.end) throw new Error("ZIP directory không khớp")
  layout(entries, seen, spans)
  if (limits.strict) {
    let end = 0
    for (const span of spans) {
      if (span[0] !== end) throw new Error("ZIP chứa dữ liệu không được khai báo")
      end = span[1]
    }
    if (end !== info.offset) throw new Error("ZIP có dữ liệu ngoài entry")
  }
  return entries
}

export function readArchive(bytes: Uint8Array, limits: ArchiveLimits = skillLimits) {
  return expand(bytes, directory(bytes, limits), limits)
}

function* expand(bytes: Uint8Array, entries: Entry[], limits: ArchiveLimits) {
  let expanded = 0
  for (const entry of entries) {
    const chunks: Uint8Array[] = []
    let size = 0
    const append = (chunk: Uint8Array) => {
      size += chunk.length
      expanded += chunk.length
      if (size > entry.size || expanded > limits.expanded) throw new Error("ZIP vượt kích thước giải nén khai báo")
      chunks.push(chunk)
    }
    const input = bytes.subarray(entry.start, entry.start + entry.packed)
    if (entry.method === 0) append(input)
    else {
      const stream = new Inflate(append)
      for (let index = 0; index < input.length; index += 4096)
        stream.push(input.subarray(index, index + 4096), index + 4096 >= input.length)
      if (!input.length) stream.push(input, true)
    }
    if (size !== entry.size) throw new Error("ZIP kích thước file không khớp")
    const data = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) { data.set(chunk, cursor); cursor += chunk.length }
    if (crc(data) !== entry.crc) throw new Error("ZIP checksum file không khớp")
    yield { path: entry.name, data, mode: entry.mode }
  }
}

export function unpack(bytes: Uint8Array) {
  const entries = directory(bytes, skillLimits)
  const roots = entries.filter((entry) => entry.name === "SKILL.md" || /^[^/]+\/SKILL\.md$/.test(entry.name))
  if (roots.length !== 1) throw new Error("ZIP phải chứa đúng một SKILL.md tại root hoặc trong một thư mục ngoài cùng")
  const prefix = roots[0]!.name.slice(0, -"SKILL.md".length)
  if (entries.some((entry) => !entry.name.startsWith(prefix))) throw new Error("ZIP chứa file ngoài thư mục skill")
  return [...expand(bytes, entries, skillLimits)].map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
}

