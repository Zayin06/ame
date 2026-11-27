import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { OpenCode } from '@opencode/client'
import type { PairingCode, PairingSettings } from '../../protocol/src/index'
import { randomBytes } from 'node:crypto'
import { PairingDeviceStore } from './pairing-store'

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
function normalizeProxyPathname(rawPathname: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(rawPathname) } catch (error) { if (error instanceof URIError) return null; throw error }
  return path.posix.normalize(decoded.replace(/\\+/g, '/'))
}
function isAllowedRemoteRoute(method: string | undefined, pathname: string): boolean {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method ?? '')) return false
  if (/^\/api\/session(?:\/active|\/[^/]+)?$/.test(pathname)) return true
  if (/^\/api\/session\/[^/]+\/(?:message[^/]*(?:\/.*)?|prompt|interrupt|diff|permission[^/]*(?:\/.*)?|form[^/]*(?:\/.*)?|fork|revert[^/]*(?:\/.*)?|agent|model|command|compact|context|view|generate)$/.test(pathname)) return true
  if (pathname === '/api/permission/request' || pathname === '/api/form') return true
  if (method !== 'GET') return false
  return pathname === '/' || /^\/(?:assets\/.*|favicon[^/]*|manifest[^/]*)$/.test(pathname) ||
    /^\/api\/(?:info|event|project(?:\/.*)?|location|model(?:\/default)?|agent(?:\/.*)?|command|skill|reference|vcs[^/]*(?:\/.*)?|worktree|fs\/(?:list|find|read\/.*)|experimental\/(?:artifacts[^/]*(?:\/.*)?|media\/.*|blob\/.*))$/.test(pathname)
}
function forwardHeaders(input: IncomingMessage['headers']) {
  const headers = { ...input }
  for (const name of [...hopHeaders, ...(input.connection?.split(',').map(value => value.trim().toLowerCase()) ?? [])]) delete headers[name]
  delete headers.host
  return headers
}

/** Loopback-only tunnel target. Permanent devices use master credentials only on the private loopback hop. */
export class PairingHost {
  private server?: Server
  private sockets = new Set<Socket>()
  private target?: URL
  private pendingCodes = new Map<string, { expiresAt: number }>()
  private deviceSockets = new Map<string, Set<Socket>>()
  private generation = 0
  private revoking = false
  private connecting = new Set<Promise<void>>()
  private settings: PairingSettings = { enabled: false, publicURL: '', port: 4097, keepScreenActive: false }
  constructor(private endpoint: () => { url: string; headers: Record<string, string> } | undefined, private store?: PairingDeviceStore) {}
  status(): PairingSettings { return { ...this.settings, ...(this.store ? { devices: this.store.list() } : {}) } }
  async configure(settings: PairingSettings) {
    await this.store?.ready()
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
      const server = createServer((req, res) => {
        const pending = this.forward(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy() })
        this.connecting.add(pending)
        void pending.finally(() => this.connecting.delete(pending))
      })
      server.on('connection', socket => { this.sockets.add(socket); socket.on('error', () => socket.destroy()); socket.once('close', () => this.sockets.delete(socket)) })
      server.on('upgrade', (req, socket, head) => { try { this.upgrade(req, socket as Socket, head) } catch { socket.destroy() } })
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
    if (!this.server || !this.settings.enabled || this.revoking || !endpoint || this.target?.origin !== endpoint.url) throw new Error('PAIRING_NOT_READY')
    if (this.store) {
      const now = Date.now()
      for (const [code, value] of this.pendingCodes) if (value.expiresAt <= now) this.pendingCodes.delete(code)
      while (this.pendingCodes.size >= 20) this.pendingCodes.delete(this.pendingCodes.keys().next().value!)
      const code = randomBytes(24).toString('base64url'), expiresAt = now + 300000
      this.pendingCodes.set(code, { expiresAt })
      return { ...pairingPayload(this.settings.publicURL, code), expiresAt }
    }
    const code = await OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers }).server.pair({ signal: AbortSignal.timeout(15000) })
    if (!Number.isInteger(code.expires_in) || code.expires_in <= 0) throw new Error('PAIRING_INVALID_EXPIRY')
    return { ...pairingPayload(this.settings.publicURL, code.code), expiresAt: Date.now() + code.expires_in * 1000 }
  }
  private current() {
    return this.target && this.endpoint()?.url === this.target.origin ? this.target : undefined
  }
  private cookieName(req: IncomingMessage) {
    const port = URL.parse(`http://${req.headers.host}`)?.port
    return `opencode_session${port ? `_${port}` : ''}`
  }
  private authenticate(req: IncomingMessage, url: URL, websocket = false) {
    const basic = (value: string | null | undefined) => {
      if (!value?.startsWith('Basic ')) return
      const decoded = Buffer.from(value.slice(6), 'base64').toString()
      return decoded.startsWith('opencode:') ? decoded.slice(9) : undefined
    }
    const query = websocket ? url.searchParams.get('auth_token') : null
    const header = req.headers.authorization
    for (const token of [basic(query ? `Basic ${query}` : undefined), header?.startsWith('Bearer ') ? header.slice(7) : basic(header)]) {
      const device = token ? this.store!.authenticate(token) : undefined
      if (device) return device
    }
    {
      const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${this.cookieName(req)}=`))
      if (cookie) {
        if (req.headers.origin !== undefined) {
          try { if (new URL(req.headers.origin).host !== req.headers.host) return } catch { return }
        }
        return this.store!.authenticate(cookie.slice(cookie.indexOf('=') + 1))
      }
    }
  }
  private privateHeaders(req: IncomingMessage) {
    const headers = forwardHeaders(req.headers)
    delete headers.authorization
    if (headers.cookie) {
      headers.cookie = headers.cookie.split(';').filter(cookie => !/^opencode_session(?:_[^=;]*)?=/i.test(cookie.trim())).join(';')
      if (!headers.cookie) delete headers.cookie
    }
    return { ...headers, ...this.endpoint()!.headers }
  }
  private responseHeaders(headers: IncomingMessage['headers']) {
    const filtered = forwardHeaders(headers)
    if (this.store && filtered['set-cookie']) filtered['set-cookie'] = filtered['set-cookie'].filter(value => !/^opencode_session(?:_[^=;]*)?=/i.test(value.trim()))
    return filtered
  }
  private track(socket: Socket, deviceID: string) {
    this.sockets.add(socket)
    let sockets = this.deviceSockets.get(deviceID)
    if (!sockets) this.deviceSockets.set(deviceID, sockets = new Set())
    if (sockets.has(socket)) return
    sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket); sockets!.delete(socket)
      if (!sockets!.size && this.deviceSockets.get(deviceID) === sockets) this.deviceSockets.delete(deviceID)
    })
  }
  private async forward(req: IncomingMessage, res: ServerResponse) {
    const target = this.current()
    if (!target) { res.writeHead(503).end(); return }
    // Keep the path as a path: never interpret an incoming absolute URL as an outbound destination.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400).end(); return }
    const checkedPath = normalizeProxyPathname(new URL(req.url, 'http://127.0.0.1').pathname)
    if (checkedPath === null) { res.writeHead(400).end(); return }
    const connectRoute = /^\/auth\/connect\/[A-Za-z0-9_-]+$/.test(checkedPath) && ['GET', 'POST', 'HEAD'].includes(req.method ?? '')
    if (connectRoute && (req.method === 'HEAD' || /slackbot|whatsapp|telegrambot|discordbot|twitterbot|facebookexternalhit|linkedinbot|bot|crawler|preview/i.test(req.headers['user-agent'] ?? ''))) {
      res.writeHead(405, { 'cache-control': 'no-store' }).end(); return
    }
    if (!connectRoute && !isAllowedRemoteRoute(req.method, checkedPath)) {
      res.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Remote admin/pairing route is disabled' })); return
    }
    let requestPath = req.url, deviceID: string | undefined
    if (this.store) {
      if (this.revoking) { res.writeHead(401, { 'cache-control': 'no-store' }).end(); return }
      const url = new URL(req.url, 'http://127.0.0.1')
      const pathname = normalizeProxyPathname(url.pathname)
      if (pathname === null) { res.writeHead(400).end(); return }
      if (/^\/auth\/connect\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        res.setHeader('cache-control', 'no-store')
        if (!['GET', 'POST'].includes(req.method ?? '') || /slackbot|whatsapp|telegrambot|discordbot|twitterbot|facebookexternalhit|linkedinbot|bot|crawler|preview/i.test(req.headers['user-agent'] ?? '')) {
          res.writeHead(405).end(); return
        }
        const code = url.pathname.slice('/auth/connect/'.length), expiry = this.pendingCodes.get(code)
        this.pendingCodes.delete(code)
        if (!expiry || expiry.expiresAt <= Date.now()) {
          const html = req.headers.accept?.includes('text/html')
          res.writeHead(401, { 'content-type': html ? 'text/plain; charset=utf-8' : 'application/json' }).end(html ? 'Liên kết ghép nối đã hết hạn hoặc đã được sử dụng.' : JSON.stringify({ message: 'Pairing link expired or already used' }))
          return
        }
        const generation = this.generation
        const { token, device } = await this.store.create(req.headers['user-agent'])
        if (generation !== this.generation || !this.server) { await this.store.revoke(device.id); res.writeHead(401).end(); return }
        if (req.headers.accept?.includes('text/html')) {
          res.writeHead(302, { location: '/', 'set-cookie': `${this.cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax${this.settings.publicURL.startsWith('https://') ? '; Secure' : ''}; Max-Age=2592000` }).end()
        } else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token })) }
        return
      }
      if (!isAllowedRemoteRoute(req.method, pathname)) { res.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Remote admin/pairing route is disabled' })); return }
      if (url.searchParams.has('auth_token')) { res.writeHead(401, { 'cache-control': 'no-store' }).end(); return }
      const device = this.authenticate(req, url)
      if (!device) { res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Authentication required' })); return }
      deviceID = device.id
      this.track(req.socket, deviceID)
      url.searchParams.delete('auth_token'); requestPath = url.pathname + url.search
    }
    const upstream = request({ hostname: target.hostname, port: target.port, method: req.method, path: requestPath, headers: { ...(this.store ? this.privateHeaders(req) : forwardHeaders(req.headers)), host: target.host } }, response => {
      res.writeHead(response.statusCode ?? 502, this.responseHeaders(response.headers))
      response.pipe(res)
      response.on('error', () => res.destroy())
    })
    if (deviceID) upstream.on('socket', socket => this.track(socket, deviceID!))
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const target = this.current()
    if (!target || !req.url?.startsWith('/') || req.url.startsWith('//')) { socket.destroy(); return }
    const checkedPath = normalizeProxyPathname(new URL(req.url, 'http://127.0.0.1').pathname)
    if (checkedPath === null) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    if (!isAllowedRemoteRoute(req.method, checkedPath)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    let requestPath = req.url, deviceID: string | undefined
    if (this.store) {
      if (this.revoking) { socket.destroy(); return }
      const url = new URL(req.url, 'http://127.0.0.1')
      const pathname = normalizeProxyPathname(url.pathname)
      if (pathname === null) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
      if (!isAllowedRemoteRoute(req.method, pathname)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
      const device = this.authenticate(req, url, true)
      if (!device) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
      deviceID = device.id; this.track(socket, deviceID)
      url.searchParams.delete('auth_token'); requestPath = url.pathname + url.search
    }
    const upstream = request({ hostname: target.hostname, port: target.port, method: req.method, path: requestPath, headers: { ...(this.store ? this.privateHeaders(req) : forwardHeaders(req.headers)), host: target.host, connection: 'Upgrade', upgrade: req.headers.upgrade } })
    if (deviceID) upstream.on('socket', remote => this.track(remote, deviceID!))
    upstream.on('upgrade', (response, remote, received) => {
      this.sockets.add(remote)
      remote.once('close', () => this.sockets.delete(remote))
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        if (this.store && response.rawHeaders[i].toLowerCase() === 'set-cookie' && /^opencode_session(?:_[^=;]*)?=/i.test(response.rawHeaders[i + 1])) continue
        socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`)
      }
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
    this.generation++
    this.pendingCodes.clear()
    const server = this.server
    this.server = undefined; this.target = undefined
    this.settings = { ...this.settings, enabled: false }
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.deviceSockets.clear()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all([...this.connecting])
    await this.store?.flush()
  }
  async revokeDevice(id: string) {
    try { await this.store?.revoke(id) }
    finally {
      for (const socket of this.deviceSockets.get(id) ?? []) socket.destroy()
      this.deviceSockets.delete(id)
    }
    return this.status()
  }
  async revokeAll() {
    this.revoking = true
    this.generation++; this.pendingCodes.clear()
    try {
      await Promise.all([...this.connecting])
      await this.store?.revokeAll()
    } finally {
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear(); this.deviceSockets.clear()
      this.revoking = false
    }
    return this.status()
  }
}
