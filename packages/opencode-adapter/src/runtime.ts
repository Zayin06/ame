import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export type RuntimeEndpoint = { url: string; username: string; password: string }
export type RuntimeOptions = {
  resources: string; profile: string; onExit?: () => void
  /** Total API/plugin readiness budget after listening; defaults to 30 seconds. */
  readinessTimeoutMs?: number
}
const version = '2.3.2'
export function privateEnvironment(profile: string, password: string, inherited = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(OPENCODE_|XDG_|OTEL_|ELECTRON_|NODE_OPTIONS$|BUN_OPTIONS$)/i.test(key)))
  return { ...env, XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_STATE_HOME: path.join(profile, 'state'),
    OPENCODE_CONFIG_DIR: path.join(profile, 'config', 'opencode'), OPENCODE_TEST_HOME: path.join(profile, 'home'),
    OPENCODE_DB: path.join(profile, 'data', 'ide.db'), OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FILEWATCHER: '1',
    DO_NOT_TRACK: '1' }
}
export class PrivateRuntime {
  private child?: ChildProcess
  private endpoint?: RuntimeEndpoint
  private pending?: Promise<RuntimeEndpoint>
  private closed?: Promise<void>
  private stopping = false
  constructor(private options: RuntimeOptions) {}
  executable() { return path.join(this.options.resources, 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode') }
  start(): Promise<RuntimeEndpoint> {
    if (this.stopping) return Promise.reject(new Error('RUNTIME_STOPPING'))
    if (this.endpoint) return Promise.resolve(this.endpoint)
    if (this.pending) return this.pending
    this.pending = this.launch().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async launch(): Promise<RuntimeEndpoint> {
    const executable = this.executable(), directory = path.dirname(executable)
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
      const digest = createHash('sha256').update(await readFile(executable)).digest('hex')
      if (manifest.version !== version || manifest.platform !== `${process.platform}-${process.arch}` || manifest.sha256 !== digest) throw new Error()
    } catch { throw new Error('BUNDLED_RUNTIME_INVALID: Rebuild the bundled OpenCode 2.3.2 runtime.') }
    const profile = this.options.profile
    for (const folder of ['config/opencode', 'data', 'cache', 'state', 'home', 'workspace']) await mkdir(path.join(profile, folder), { recursive: true })
    await writeFile(path.join(profile, 'config', 'opencode', 'opencode.json'), JSON.stringify({
      plugins: [pathToFileURL(path.join(this.options.resources, 'amekit-models')).href],
      experimental: { subagent_depth: 3, artifacts: true, todo: true },
    }), { mode: 0o600 })
    if (this.stopping) throw new Error('RUNTIME_STOPPING')
    const password = randomBytes(32).toString('base64url')
    const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: path.join(profile, 'workspace'), env: privateEnvironment(profile, password),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.closed = new Promise(resolve => { child.once('close', () => { if (this.child === child) { this.child = undefined; this.endpoint = undefined; if (!this.stopping) this.options.onExit?.() } resolve() }) })
    child.stderr?.on('data', () => {})
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buffer = ''
        const timer = setTimeout(() => finish(new Error('RUNTIME_START_TIMEOUT')), 60000)
        const fail = () => finish(new Error('RUNTIME_START_FAILED'))
        const finish = (error?: Error, url?: string) => {
          clearTimeout(timer); child.off('error', fail); child.off('exit', fail); child.stdout?.off('data', data)
          error ? reject(error) : resolve(url!)
        }
        const data = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-8192)
          const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)
          if (match) finish(undefined, match[1])
        }
        child.once('error', fail); child.once('exit', fail); child.stdout?.on('data', data)
      })
      child.stdout?.resume()
      await this.waitUntilReady(child, url, password)
      if (this.stopping || this.child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('RUNTIME_STOPPED')
      this.endpoint = { url, username: 'opencode', password }
      return this.endpoint
    } catch (error) { child.kill(); await this.closed; throw error }
  }
  private async waitUntilReady(child: ChildProcess, url: string, password: string) {
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('RUNTIME_PLUGIN_NOT_READY: readiness timeout')), this.options.readinessTimeoutMs ?? 30000)
    const stopped = () => controller.abort(new Error('RUNTIME_STOPPED'))
    child.once('exit', stopped)
    child.once('error', stopped)
    const check = () => {
      if (this.stopping || this.child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('RUNTIME_STOPPED')
      controller.signal.throwIfAborted()
    }
    const request = async (route: string, init?: RequestInit) => {
      check()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
      try {
        const response = await fetch(`${url}${route}`, { ...init, headers: { ...headers, ...init?.headers }, signal, redirect: 'error' })
        // Consume the body under the same deadline, not just the response headers.
        return { status: response.status, body: await response.text() }
      } catch (error) {
        check()
        if (signal.aborted || error instanceof TypeError) return undefined
        throw error
      }
    }
    try {
      let verified = false
      for (;;) {
        check()
        if (!verified) {
          const info = await request('/api/info')
          if (info && info.status !== 503) {
            if (info.status !== 200 || JSON.parse(info.body)?.version !== version) throw new Error('RUNTIME_VERSION_MISMATCH')
            verified = true
          }
        }
        if (verified) {
          const response = await request('/api/plugin')
          if (response && response.status !== 503) {
            if (response.status !== 200) throw new Error(`RUNTIME_PLUGIN_FAILED: plugin inventory HTTP ${response.status}`)
            const plugins = JSON.parse(response.body) as { data?: { id?: string; source?: { type?: string }; state?: { status?: string } }[] }
            if (!Array.isArray(plugins?.data)) throw new Error('RUNTIME_PLUGIN_FAILED: invalid plugin inventory')
            if (plugins.data.some(p => p.source?.type !== 'builtin' && p.state?.status === 'failed')) throw new Error('RUNTIME_PLUGIN_FAILED: amekit-models setup failed')
            const plugin = plugins.data.find(p => p.id === 'amekit-models')
            // RPC handlers can be registered before setup finishes; require the host's active state too.
            if (plugin?.id === 'amekit-models' && plugin.state?.status === 'active') {
              const rpc = await request('/api/rpc/amekit-models/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: null }) })
              if (rpc && rpc.status !== 404 && rpc.status !== 503) {
                if (rpc.status !== 200 || JSON.parse(rpc.body)?.output?.authenticated !== false) throw new Error('RUNTIME_PLUGIN_FAILED: invalid signed-out status')
                check()
                return
              }
            }
          }
        }
        await delay(250, undefined, { signal: controller.signal })
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      clearTimeout(timer)
      child.off('exit', stopped)
      child.off('error', stopped)
    }
  }
  async stop() {
    this.stopping = true
    this.child?.kill()
    await this.pending?.catch(() => {})
    if (this.child) this.child.kill()
    await this.closed
    this.endpoint = undefined
  }
}
