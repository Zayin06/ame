import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { OpenCode } from '@opencode/client'
import type { PairingCode, PairingSettings } from '../../protocol/src/index'

export function tunnelAddress(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('PAIRING_HTTPS_REQUIRED') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('PAIRING_HTTPS_REQUIRED')
  return url.origin
}

// OpenCode v2.3.2 Pairing wire format (MIT, Copyright (c) 2025 opencode).
export function pairingPayload(address: string, code: string) {
  const url = tunnelAddress(address)
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('PAIRING_INVALID_CODE')
  return { url: new URL(`/auth/connect/${code}`, url).href, qr: JSON.stringify({ code, urls: [url] }) }
}

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
function forwardHeaders(input: IncomingMessage['headers']) {
  const headers = { ...input }
  for (const name of [...hopHeaders, ...(input.connection?.split(',').map(value => value.trim().toLowerCase()) ?? [])]) delete headers[name]
  delete headers.host
  return headers
}

/** Loopback-only tunnel target. Never supplies the private master password. */
export class PairingHost {
  private server?: Server
  private sockets = new Set<Socket>()
  private target?: URL
  private settings: PairingSettings = { enabled: false, publicURL: '', port: 4097, keepScreenActive: false }
  constructor(private endpoint: () => { url: string; headers: Record<string, string> } | undefined) {}
  status(): PairingSettings { return { ...this.settings } }
  async configure(settings: PairingSettings) {
    if (!Number.isInteger(settings.port) || (settings.port !== 0 && settings.port < 1024) || settings.port > 65535) throw new Error('PAIRING_INVALID_PORT')
    const publicURL = settings.publicURL ? tunnelAddress(settings.publicURL) : ''
    if (settings.enabled && !publicURL) throw new Error('PAIRING_HTTPS_REQUIRED')
    const endpoint = this.endpoint()
    if (settings.enabled && !endpoint) throw new Error('PAIRING_PRIVATE_BACKEND_REQUIRED')
    if (settings.enabled && this.server && settings.port === this.settings.port) {
      if (this.target?.origin !== endpoint!.url) throw new Error('PAIRING_BACKEND_CHANGED')
      this.settings = { ...settings, publicURL }
      return this.status()
    }
    await this.stop()
    if (settings.enabled) {
      const target = new URL(endpoint!.url)
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('PAIRING_PRIVATE_BACKEND_REQUIRED')
      this.target = target
      const server = createServer((req, res) => this.forward(req, res))
      server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head))
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(settings.port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
        this.server = server
        settings = { ...settings, port: (server.address() as { port: number }).port }
      } catch { this.target = undefined; throw new Error('PAIRING_PORT_UNAVAILABLE') }
    }
    this.settings = { ...settings, publicURL }
    return this.status()
  }
  async issue(): Promise<PairingCode> {
    const endpoint = this.endpoint()
    if (!this.server || !this.settings.enabled || !endpoint || this.target?.origin !== endpoint.url) throw new Error('PAIRING_NOT_READY')
    const code = await OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers }).server.pair({ signal: AbortSignal.timeout(15000) })
    if (!Number.isInteger(code.expires_in) || code.expires_in <= 0) throw new Error('PAIRING_INVALID_EXPIRY')
    return { ...pairingPayload(this.settings.publicURL, code.code), expiresAt: Date.now() + code.expires_in * 1000 }
  }
  private current() {
    return this.target && this.endpoint()?.url === this.target.origin ? this.target : undefined
  }
  private forward(req: IncomingMessage, res: ServerResponse) {
    const target = this.current()
    if (!target) { res.writeHead(503).end(); return }
    // Keep the path as a path: never interpret an incoming absolute URL as an outbound destination.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400).end(); return }
    const upstream = request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...forwardHeaders(req.headers), host: target.host } }, response => {
      res.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers))
      response.pipe(res)
      response.on('error', () => res.destroy())
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const target = this.current()
    if (!target || !req.url?.startsWith('/') || req.url.startsWith('//')) { socket.destroy(); return }
    const upstream = request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...forwardHeaders(req.headers), host: target.host, connection: 'Upgrade', upgrade: req.headers.upgrade } })
    upstream.on('upgrade', (response, remote, received) => {
      this.sockets.add(remote)
      remote.once('close', () => this.sockets.delete(remote))
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
      for (let i = 0; i < response.rawHeaders.length; i += 2) socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`)
      socket.write('\r\n')
      if (received.length) socket.write(received)
      if (head.length) remote.write(head)
      remote.pipe(socket); socket.pipe(remote)
      remote.on('error', () => socket.destroy())
      socket.on('error', () => remote.destroy())
      socket.on('close', () => remote.destroy())
      remote.on('close', () => socket.destroy())
    })
    upstream.on('response', response => {
      socket.end(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      response.resume()
    })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.end()
  }
  async stop() {
    const server = this.server
    this.server = undefined; this.target = undefined
    this.settings = { ...this.settings, enabled: false }
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
