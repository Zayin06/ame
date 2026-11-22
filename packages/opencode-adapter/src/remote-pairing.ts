import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { create, OpenTunnelStorage, type OpenTunnelConnection } from '@opentunnel/client'
import { PairingHost } from './pairing'
import type { PairingPreferences, PairingSettings } from '../../protocol/src/index'

type Tunnel = Pick<OpenTunnelConnection, 'urls' | 'closed' | 'close'>
export type TunnelConnector = (target: string, signal: AbortSignal) => Promise<Tunnel>

export function automaticTunnel(directory: string): TunnelConnector {
  return async (target, signal) => {
    const client = create({ api: 'https://opentunnel.xyz', store: OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: path.resolve(directory) } }) })
    try {
      const route = `ame-${randomBytes(12).toString('hex')}`
      const connection = await client.tunnel.connect({ routes: { [route]: target }, signal, onRouteConflict: 'fail' })
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
  status(): PairingSettings { return { ...this.settings } }
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
