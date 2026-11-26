import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { create, OpenTunnelStorage, type OpenTunnelConnection } from '@opentunnel/client'
import { PairingHost } from './pairing'
import type { PairingPreferences, PairingSettings } from '../../protocol/src/index'

type Tunnel = Pick<OpenTunnelConnection, 'urls' | 'closed' | 'close'>
export type TunnelConnector = (target: string, signal: AbortSignal) => Promise<Tunnel>

const routes = new Map<string, Promise<string>>()

/** Persist only Ame's route; never modify the shared OpenTunnel profile. */
export function loadOrCreateRoute(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const pending = routes.get(key)
  if (pending) return pending
  const operation = provisionRoute(resolved).finally(() => { routes.delete(key) })
  routes.set(key, operation)
  return operation
}

async function provisionRoute(directory: string): Promise<string> {
  const file = path.join(directory, 'route.json')
  const read = async () => {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (value?.version === 1 && typeof value.route === 'string' && /^ame-[a-f0-9]{24}$/.test(value.route)) return value.route as string
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const existing = await read()
  if (existing) return existing
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.route-${randomBytes(12).toString('hex')}.tmp`)
  try {
    const route = `ame-${randomBytes(12).toString('hex')}`
    await writeFile(temporary, JSON.stringify({ version: 1, route }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
    return route
  } finally {
    try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

export function automaticTunnel(directory: string): TunnelConnector {
  return async (target, signal) => {
    const client = create({ api: 'https://opentunnel.xyz', store: OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: path.resolve(directory) } }) })
    try {
      const route = await loadOrCreateRoute(directory)
      const connection = await client.tunnel.connect({ routes: { [route]: target }, signal, onRouteConflict: 'retry' })
      void connection.closed.catch(() => {}).finally(() => client.dispose()).catch(() => {})
      return { urls: { ame: connection.urls[route] }, closed: connection.closed, close: () => connection.close() }
    } catch (error) { await client.dispose(); throw error }
  }
}

/** Owns only Ame's route and identity, never the user's OpenCode service or shared tunnel profile. */
export class RemotePairing {
  private settings: PairingSettings = { enabled: false, publicURL: '', port: 0, keepScreenActive: false }
  private controller?: AbortController
  private tunnel?: Tunnel
  private pending?: Promise<void>
  private generation = 0
  constructor(private host: PairingHost, private connect: TunnelConnector) {}
  status(): PairingSettings { return { ...this.settings, devices: this.host.status().devices } }
  async revokeDevice(id: string): Promise<PairingSettings> {
    await this.host.revokeDevice(id)
    return this.status()
  }
  async revokeAll(): Promise<PairingSettings> {
    await this.host.revokeAll()
    return this.status()
  }
  async configure(input: PairingPreferences) {
    if (input.enabled && this.settings.enabled) {
      this.settings.keepScreenActive = input.keepScreenActive
      return this.status()
    }
    await this.stop()
    this.settings = { ...this.settings, enabled: input.enabled, keepScreenActive: input.keepScreenActive, error: undefined }
    if (!input.enabled) return this.status()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    this.settings.connecting = true
    const timer = setTimeout(() => controller.abort(), 180000)
    const pending = (async () => {
      try {
        await this.host.configure({ ...this.settings, publicURL: 'https://pending.invalid', port: 0 })
        if (generation !== this.generation) return
        const connection = await this.connect(`127.0.0.1:${this.host.status().port}`, controller.signal)
        if (generation !== this.generation || controller.signal.aborted) { await connection.close(); return }
        this.tunnel = connection
        const publicURL = connection.urls.ame
        if (!publicURL) throw new Error('PAIRING_TUNNEL_NO_URL')
        await this.host.configure({ ...this.host.status(), publicURL })
        if (generation !== this.generation || controller.signal.aborted) return
        this.settings = { ...this.host.status(), keepScreenActive: this.settings.keepScreenActive, connecting: false }
        void connection.closed.then(() => this.failed(generation), () => this.failed(generation)).catch(() => {})
      } catch { await this.failed(generation) }
      finally { clearTimeout(timer) }
    })()
    this.pending = pending
    return this.status()
  }
  private async failed(generation: number) {
    if (generation !== this.generation) return
    this.generation++
    this.controller?.abort(); this.controller = undefined
    const tunnel = this.tunnel; this.tunnel = undefined
    this.settings = { ...this.settings, enabled: false, connecting: false, publicURL: '', port: 0, error: 'PAIRING_TUNNEL_FAILED: Không thể kết nối OpenTunnel. Kiểm tra mạng rồi bật Remote access để thử lại.' }
    await this.host.stop()
    await tunnel?.close().catch(() => {})
  }
  async issue() {
    const generation = this.generation
    await this.pending
    if (generation !== this.generation || !this.settings.enabled || this.settings.connecting) throw new Error(this.settings.error || 'PAIRING_NOT_READY')
    const code = await this.host.issue()
    if (generation !== this.generation || !this.settings.enabled) throw new Error('PAIRING_NOT_READY')
    return code
  }
  async stop() {
    this.generation++
    this.controller?.abort(); this.controller = undefined
    const tunnel = this.tunnel; this.tunnel = undefined
    this.settings = { ...this.settings, enabled: false, connecting: false, publicURL: '', port: 0 }
    await this.pending?.catch(() => {})
    await this.host.stop()
    await tunnel?.close().catch(() => {})
  }
}
