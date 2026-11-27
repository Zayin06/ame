import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PairedDevice } from '../../protocol/src/index'

export type PairedDeviceRecord = PairedDevice & { tokenHash: string }
type DeviceRecord = PairedDeviceRecord
const cleanLabel = (value: string) => value.replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Thiết bị OpenCode'

/** User agents are untrusted metadata, not device identities. */
export function parseDeviceLabel(userAgent = ''): string {
  const ua = userAgent.slice(0, 2048).replace(/\p{C}/gu, '')
  if (/opencode/i.test(ua)) return /android/i.test(ua) ? 'OpenCode Android' : /iphone|ipad|ios/i.test(ua) ? 'OpenCode iOS' : 'OpenCode Mobile'
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipad|ipod|ios/i.test(ua) ? 'iOS' : /windows/i.test(ua) ? 'Windows' : /macintosh|mac os/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : ''
  const browser = /edg(?:ios|a)?\//i.test(ua) ? 'Edge' : /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : ''
  return cleanLabel(browser && os ? `${browser} (${os})` : browser || (os === 'iOS' ? 'iOS / iPadOS' : os))
}

const publicDevice = ({ id, label, createdAt, lastUsedAt }: DeviceRecord): PairedDevice => ({ id, label: cleanLabel(label), createdAt, lastUsedAt })
const hash = (token: string) => createHash('sha256').update(token).digest()

/** Permanent pairing credentials. The caller owns the path and must await ready before authentication. */
export class PairingDeviceStore {
  private loading: Promise<void>
  private records: DeviceRecord[] = []
  private writes: Promise<void> = Promise.resolve()
  private mutations: Promise<unknown> = Promise.resolve()
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutations.catch(() => {}).then(operation)
    this.mutations = pending
    return pending
  }
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false
  private lastSavedUse = new Map<string, number>()
  constructor(private file: string) { this.loading = this.load() }
  ready() { return this.loading }

  private async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('devices' in data) || !Array.isArray(data.devices)) return
      const ids = new Set<string>(), hashes = new Set<string>()
      const records: DeviceRecord[] = []
      for (const item of data.devices) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || /[\p{C}<>]/u.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80 || typeof item.tokenHash !== 'string' || !/^[a-f\d]{64}$/i.test(item.tokenHash) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || !Number.isSafeInteger(item.lastUsedAt) || item.lastUsedAt < item.createdAt || ids.has(item.id) || hashes.has(item.tokenHash.toLowerCase())) return
        ids.add(item.id); hashes.add(item.tokenHash.toLowerCase())
        records.push({ id: item.id, label: cleanLabel(item.label), createdAt: item.createdAt, lastUsedAt: item.lastUsedAt, tokenHash: item.tokenHash.toLowerCase() })
      }
      this.records = records
      for (const record of records) this.lastSavedUse.set(record.id, record.lastUsedAt)
    } catch { /* Missing, unreadable and corrupt stores all fail closed. */ }
  }

  list(): PairedDevice[] { return this.records.map(publicDevice).sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)) }

  async create(userAgent?: string) {
    await this.ready()
    return this.mutate(async () => {
    const token = randomBytes(32).toString('base64url'), now = Date.now()
    const record: DeviceRecord = { id: randomUUID(), label: parseDeviceLabel(userAgent), createdAt: now, lastUsedAt: now, tokenHash: hash(token).toString('hex') }
    this.records.push(record)
    try { await this.persist() } catch (error) { this.records = this.records.filter(item => item !== record); throw error }
    this.lastSavedUse.set(record.id, now)
    return { device: publicDevice(record), token }
    })
  }

  authenticate(token: string): PairedDevice | undefined {
    if (!token) return
    const digest = hash(token)
    const record = this.records.find(item => timingSafeEqual(digest, Buffer.from(item.tokenHash, 'hex')))
    if (!record) return
    const now = Date.now()
    record.lastUsedAt = Math.max(record.lastUsedAt, now); this.dirty = true
    if (now - (this.lastSavedUse.get(record.id) ?? 0) >= 60000) {
      this.lastSavedUse.set(record.id, now)
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => { this.dirty = true }) }, 0)
        this.timer.unref()
      }
    }
    return publicDevice(record)
  }

  async revoke(id: string) {
    await this.ready()
    return this.mutate(async () => {
    const found = this.records.some(item => item.id === id)
    const previous = this.records, dirty = this.dirty
    this.records = this.records.filter(item => item.id !== id)
    try { await this.persist() } catch (error) { this.records = previous; this.dirty = dirty; throw error }
    this.lastSavedUse.delete(id)
    return found
    })
  }

  async revokeAll() {
    await this.ready()
    return this.mutate(async () => {
    const previous = this.records, dirty = this.dirty
    this.records = []
    try { await this.persist() } catch (error) { this.records = previous; this.dirty = dirty; throw error }
    this.lastSavedUse.clear()
    return previous.length
    })
  }

  private persist() {
    this.dirty = false
    const contents = JSON.stringify({ version: 1, devices: this.records })
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, this.file); break }
          catch (error) {
            if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
          }
        }
      }
      finally { await unlink(temporary).catch(() => {}) }
    })
    this.writes = write
    return write
  }

  async flush() {
    await this.ready()
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.dirty) await this.persist()
    await this.writes
  }
}
