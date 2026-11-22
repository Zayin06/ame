import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire, SourceMap, type SourceMapPayload, type SourceMapping } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateWorkspacePath } from './workspace-fs'

export type DebugStatus = 'idle' | 'running' | 'paused' | 'exited'
export type DebugBreakpoint = { id?: string; path: string; line: number; verified: boolean }
export type DebugCallFrame = { callFrameId: string; functionName: string; path: string; line: number; column: number }
export type DebugVariable = { name: string; value: string; type: string }
export type DebugSessionSnapshot = { status: DebugStatus; entry?: string; frames: DebugCallFrame[]; variables: DebugVariable[]; breakpoints: DebugBreakpoint[]; exitCode?: number }
export type DebugEvent =
  | { type: 'state'; snapshot: DebugSessionSnapshot }
  | { type: 'output'; stream: 'stdout' | 'stderr' | 'console'; text: string }
  | { type: 'stopped'; reason?: string; snapshot: DebugSessionSnapshot }
  | { type: 'exited'; code: number | null; signal?: string | null }
export type DebugStartConfig = { entry: string; args?: string[]; cwd?: string; env?: Record<string, string>; runtime?: 'node' | 'tsx' }
export interface NodeDebugger {
  setBreakpoints(relativePath: string, lines: readonly number[]): Promise<DebugBreakpoint[]>
  /** An active or starting session rejects with DEBUG_SESSION_ACTIVE; stop it before restarting. */
  start(config: DebugStartConfig): Promise<void>
  continue(): Promise<void>
  pause(): Promise<void>
  stepOver(): Promise<void>
  stepInto(): Promise<void>
  stepOut(): Promise<void>
  evaluate(expression: string, callFrameId?: string): Promise<{ value: string; type: string; error?: string }>
  state(): DebugSessionSnapshot
  stop(): Promise<void>
  dispose(): Promise<void>
}

type RemoteObject = { type: string; value?: unknown; unserializableValue?: string; description?: string }
type Location = { scriptId: string; lineNumber: number; columnNumber?: number }
type CallFrame = { callFrameId: string; functionName: string; url: string; location: Location; scopeChain: { type: string; object: { objectId?: string } }[] }
type Pause = { reason?: string; hitBreakpoints?: string[]; callFrames: CallFrame[] }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type BreakpointFile = { relative: string; points: DebugBreakpoint[] }
type Script = { url: string; map?: SourceMap; mappings: SourceMapping[] }
type Session = {
  active: boolean
  stopping: boolean
  ready: boolean
  initialPause: boolean
  pauseVersion: number
  abort: AbortController
  child?: ChildProcessWithoutNullStreams
  socket?: WebSocket
  completion?: Promise<void>
  shutdown?: Promise<void>
  pending: Map<number, Pending>
  scripts: Map<string, Script>
  sourceBreakpoints: Map<DebugBreakpoint, string[]>
  resolved: Set<string>
  sequence: number
  stderr: string
  waitingForDisconnect?: boolean
  detachTimer?: ReturnType<typeof setTimeout>
}

function resolveTsxLoaderPath(): string {
  const resolved = createRequire(import.meta.url).resolve('tsx')
  const asarSegment = `${path.sep}app.asar${path.sep}`
  if (resolved.includes(asarSegment)) {
    const unpacked = resolved.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    if (existsSync(unpacked)) return unpacked
  }
  return resolved
}

function failure(code: string): Error { return Object.assign(new Error(code), { code }) }
function preview(object: RemoteObject): { value: string; type: string } {
  let value = object.unserializableValue ?? object.description ?? object.type
  if ('value' in object) value = typeof object.value === 'string' ? object.value : JSON.stringify(object.value) ?? String(object.value)
  return { value, type: object.type }
}

/** Runs a real loopback-only Node inspector session. All public paths are workspace-relative. */
export function createNodeDebugger(workspaceRoot: string, onEvent: (event: DebugEvent) => void): NodeDebugger {
  const root = realpathSync(workspaceRoot)
  const files = new Map<string, BreakpointFile>()
  let snapshot: DebugSessionSnapshot = { status: 'idle', frames: [], variables: [], breakpoints: [] }
  let session: Session | undefined
  let disposed = false
  let breakpointQueue: Promise<unknown> = Promise.resolve()

  function state(): DebugSessionSnapshot {
    return { ...snapshot, frames: snapshot.frames.map(frame => ({ ...frame })), variables: snapshot.variables.map(variable => ({ ...variable })), breakpoints: [...files.values()].flatMap(file => file.points.map(point => ({ ...point }))) }
  }
  function emit(event: DebugEvent) {
    // A consumer callback must not interrupt transport/child cleanup.
    try { onEvent(event) } catch { /* The host owns callback error reporting. */ }
  }
  function emitState() { emit({ type: 'state', snapshot: state() }) }
  function check(s: Session) { if (!s.active || s.stopping || session !== s) throw failure('DEBUG_SESSION_STOPPED') }
  async function validated(relative: string, allowRoot = false) {
    if (typeof relative !== 'string' || relative.replace(/\\/g, '/').split('/').includes('..')) throw failure('PATH_OUTSIDE_WORKSPACE')
    return validateWorkspacePath(root, relative, { allowRoot })
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = breakpointQueue.then(operation)
    breakpointQueue = result.catch(() => {})
    return result
  }
  function detachWhenFinished(s: Session) {
    if (!s.waitingForDisconnect || s.pending.size || s.detachTimer) return
    // Let responses already queued on the CDP socket settle before detaching at natural exit.
    s.detachTimer = setTimeout(() => {
      s.detachTimer = undefined
      if (!s.pending.size && s.active && !s.stopping) disconnect(s)
    }, 25)
  }
  function disconnect(s: Session) {
    if (s.detachTimer) { clearTimeout(s.detachTimer); s.detachTimer = undefined }
    const socket = s.socket
    s.socket = undefined
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
    for (const pending of s.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('DEBUG_DISCONNECTED')) }
    s.pending.clear()
  }
  function finish(s: Session, code: number | null, signal?: NodeJS.Signals | null) {
    if (!s.active) return
    s.active = false
    s.abort.abort()
    disconnect(s)
    if (session !== s) return
    session = undefined
    for (const file of files.values()) for (const point of file.points) { delete point.id; point.verified = false }
    if (s.child) {
      snapshot = { status: 'exited', entry: snapshot.entry, frames: [], variables: [], breakpoints: [], ...(code === null ? {} : { exitCode: code }) }
      emit({ type: 'exited', code, signal })
      emitState()
    }
  }
  function shutdown(s: Session): Promise<void> {
    if (s.shutdown) return s.shutdown
    s.stopping = true
    s.abort.abort()
    disconnect(s)
    s.shutdown = (async () => {
      const child = s.child
      if (!child) { finish(s, null); return }
      if (child.exitCode === null && child.signalCode === null) child.kill()
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 750)
      try { await s.completion } finally { clearTimeout(timer) }
    })()
    return s.shutdown
  }
  function command<T = Record<string, never>>(s: Session, method: string, params: object = {}): Promise<T> {
    check(s)
    const socket = s.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(failure('DEBUG_NOT_CONNECTED'))
    const id = ++s.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id)
        reject(failure(`DEBUG_COMMAND_TIMEOUT: ${method}`))
        detachWhenFinished(s)
      }, 10_000)
      s.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { socket.send(JSON.stringify({ id, method, params })) } catch (error) {
        clearTimeout(timer); s.pending.delete(id); reject(error)
      }
    })
  }
  async function workspaceUrl(url: string): Promise<string | undefined> {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return undefined
      const relative = path.relative(root, fileURLToPath(parsed))
      return (await validated(relative)).normalized
    } catch { return undefined }
  }
  function sourceMapFor(url: string, sourceMapURL?: string): Script {
    const script: Script = { url, mappings: [] }
    // tsx emits inline maps; never fetch source maps from untrusted remote URLs.
    if (!sourceMapURL?.startsWith('data:application/json')) return script
    try {
      const comma = sourceMapURL.indexOf(',')
      const json = sourceMapURL.slice(0, comma).includes(';base64') ? Buffer.from(sourceMapURL.slice(comma + 1), 'base64').toString() : decodeURIComponent(sourceMapURL.slice(comma + 1))
      const payload = JSON.parse(json) as SourceMapPayload
      payload.sources = payload.sources.map(source => path.isAbsolute(source) ? pathToFileURL(source).href : new URL(`${payload.sourceRoot || ''}${source}`, url).href)
      payload.sourceRoot = ''
      script.map = new SourceMap(payload)
      // SourceMap exposes generated->original lookup. Decode segment positions to invert it.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      let generatedLine = 0
      for (const line of payload.mappings.split(';')) {
        let generatedColumn = 0
        for (const segment of line.split(',')) {
          if (!segment) continue
          let value = 0, shift = 0
          for (const character of segment) {
            const digit = alphabet.indexOf(character)
            if (digit < 0) throw failure('DEBUG_INVALID_SOURCE_MAP')
            value += (digit & 31) * 2 ** shift
            if (!(digit & 32)) break
            shift += 5
          }
          generatedColumn += value & 1 ? -(value >> 1) : value >> 1
          const mapping = script.map.findEntry(generatedLine, generatedColumn)
          if (mapping.originalSource && mapping.generatedLine === generatedLine && mapping.generatedColumn === generatedColumn) script.mappings.push(mapping)
        }
        generatedLine++
      }
    } catch { script.map = undefined; script.mappings = [] }
    return script
  }
  async function removePoint(s: Session, point: DebugBreakpoint) {
    for (const id of new Set([...(point.id ? [point.id] : []), ...(s.sourceBreakpoints.get(point) ?? [])])) await command(s, 'Debugger.removeBreakpoint', { breakpointId: id })
    s.sourceBreakpoints.delete(point)
    delete point.id; point.verified = false
  }
  async function installMapped(s: Session, file: BreakpointFile, scriptId: string, script: Script) {
    if (!script.map) return
    await validated(file.relative)
    check(s)
    for (const point of file.points) {
      for (const mapping of script.mappings) {
        if (mapping.originalLine !== point.line - 1 || await workspaceUrl(mapping.originalSource) !== file.relative) continue
        const result = await command<{ breakpointId: string }>(s, 'Debugger.setBreakpoint', { location: { scriptId, lineNumber: mapping.generatedLine, columnNumber: mapping.generatedColumn } })
        const ids = s.sourceBreakpoints.get(point) ?? []
        // A source line is not a generated line: retaining the URL breakpoint creates false stops.
        if (point.id && !ids.includes(point.id)) await command(s, 'Debugger.removeBreakpoint', { breakpointId: point.id })
        ids.push(result.breakpointId)
        s.sourceBreakpoints.set(point, ids)
        point.id = result.breakpointId
        point.verified = true
        break
      }
    }
  }
  async function applyBreakpoints(s: Session, file: BreakpointFile) {
    check(s)
    const checked = await validated(file.relative)
    check(s)
    for (const point of file.points) await removePoint(s, point)
    for (const point of file.points) {
      const result = await command<{ breakpointId: string; locations: Location[] }>(s, 'Debugger.setBreakpointByUrl', { lineNumber: point.line - 1, url: pathToFileURL(checked.target).href })
      check(s)
      point.id = result.breakpointId
      point.verified = result.locations.length > 0 || s.resolved.has(result.breakpointId)
    }
    for (const [scriptId, script] of s.scripts) await installMapped(s, file, scriptId, script)
    emitState()
  }
  async function paused(s: Session, params: Pause) {
    const version = ++s.pauseVersion
    await breakpointQueue
    check(s)
    const frames: DebugCallFrame[] = []
    for (const frame of params.callFrames) {
      const script = s.scripts.get(frame.location.scriptId)
      const mapping = script?.map?.findEntry(frame.location.lineNumber, frame.location.columnNumber ?? 0)
      const relative = await workspaceUrl(mapping?.originalSource || frame.url || script?.url || '')
      if (relative) frames.push({ callFrameId: frame.callFrameId, functionName: frame.functionName, path: relative, line: (mapping?.originalLine ?? frame.location.lineNumber) + 1, column: (mapping?.originalColumn ?? frame.location.columnNumber ?? 0) + 1 })
    }
    check(s)
    if (version !== s.pauseVersion) return
    const first = s.initialPause
    s.initialPause = false
    const top = frames[0]
    const entryBreakpoint = top && files.get(top.path)?.points.some(point => point.line === top.line)
    // --inspect-brk pauses independently of user breakpoints, after runIfWaitingForDebugger.
    if (first && !params.hitBreakpoints?.length && !entryBreakpoint && (params.reason === 'Break on start' || params.reason === 'other')) {
      await command(s, 'Debugger.resume')
      return
    }
    snapshot = { ...snapshot, status: 'paused', frames, variables: [] }
    const variables = new Map<string, DebugVariable>()
    for (const scope of params.callFrames[0]?.scopeChain ?? []) {
      if (!['local', 'closure', 'block'].includes(scope.type) || !scope.object.objectId) continue
      const properties = await command<{ result: { name: string; value?: RemoteObject }[] }>(s, 'Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true, generatePreview: true })
      for (const property of properties.result) {
        if (property.value && !variables.has(property.name)) variables.set(property.name, { name: property.name, ...preview(property.value) })
      }
    }
    check(s)
    if (version !== s.pauseVersion) return
    snapshot = { ...snapshot, variables: [...variables.values()] }
    emit({ type: 'stopped', reason: params.reason, snapshot: state() })
    emitState()
  }
  function protocolEvent(s: Session, method: string, params: unknown) {
    if (!s.active || s.stopping || session !== s) return
    if (method === 'Debugger.scriptParsed') {
      const parsed = params as { scriptId: string; url: string; sourceMapURL?: string }
      const script = sourceMapFor(parsed.url, parsed.sourceMapURL)
      s.scripts.set(parsed.scriptId, script)
      if (script.map && s.ready) {
        void serialize(async () => {
          for (const file of files.values()) await installMapped(s, file, parsed.scriptId, script)
          emitState()
        }).catch(error => {
          if (s.active && !s.stopping) {
            emit({ type: 'output', stream: 'stderr', text: `Debugger source map error: ${String(error)}\n` })
            void shutdown(s)
          }
        })
      }
    } else if (method === 'Debugger.breakpointResolved') {
      const { breakpointId } = params as { breakpointId: string }
      s.resolved.add(breakpointId)
      for (const file of files.values()) for (const point of file.points) if (point.id === breakpointId) point.verified = true
      emitState()
    } else if (method === 'Debugger.paused') {
      void paused(s, params as Pause).catch(error => {
        if (s.active && !s.stopping) {
          emit({ type: 'output', stream: 'stderr', text: `Debugger error: ${String(error)}\n` })
          void shutdown(s)
        }
      })
    } else if (method === 'Debugger.resumed') {
      ++s.pauseVersion
      snapshot = { ...snapshot, status: 'running', frames: [], variables: [] }
      emitState()
    } else if (method === 'Runtime.consoleAPICalled') {
      const event = params as { args: RemoteObject[] }
      emit({ type: 'output', stream: 'console', text: event.args.map(value => preview(value).value).join(' ') + '\n' })
    }
  }
  async function connect(s: Session, address: string) {
    const url = new URL(address)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || !url.port) throw failure('DEBUG_INVALID_INSPECTOR_URL')
    check(s)
    const socket = new WebSocket(url)
    s.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(failure('DEBUG_CONNECT_TIMEOUT')), 10_000)
      const abort = () => done(failure('DEBUG_SESSION_STOPPED'))
      function done(error?: Error) {
        clearTimeout(timer)
        s.abort.signal.removeEventListener('abort', abort)
        socket.onopen = null
        if (error) reject(error); else resolve()
      }
      s.abort.signal.addEventListener('abort', abort, { once: true })
      socket.onopen = () => done()
      socket.onerror = () => { done(failure('DEBUG_CONNECTION_FAILED')); if (s.active && !s.stopping) void shutdown(s) }
      socket.onclose = () => { done(failure('DEBUG_DISCONNECTED')); if (s.active && !s.stopping) void shutdown(s) }
      socket.onmessage = event => {
        let message: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown }
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.id !== undefined) {
          const pending = s.pending.get(message.id)
          if (!pending) return
          s.pending.delete(message.id); clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result)
          detachWhenFinished(s)
        } else if (message.method) protocolEvent(s, message.method, message.params)
      }
    })
  }
  async function launch(s: Session, config: DebugStartConfig) {
    try {
      const entry = await validated(config.entry)
      if (!(await stat(entry.target)).isFile()) throw failure('DEBUG_ENTRY_NOT_FILE')
      if (!/\.(?:[cm]?js|tsx?)$/i.test(entry.target)) throw failure('DEBUG_UNSUPPORTED_ENTRY')
      const cwd = await validated(config.cwd ?? '.', true)
      if (!(await stat(cwd.target)).isDirectory()) throw failure('NOT_A_DIRECTORY')
      if (config.args && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw failure('DEBUG_INVALID_ARGS')
      if (config.runtime !== undefined && config.runtime !== 'node' && config.runtime !== 'tsx') throw failure('DEBUG_INVALID_RUNTIME')
      const env: NodeJS.ProcessEnv = {}
      // Inherited/preloaded Node options must not override loopback binding or execute loaders.
      for (const [key, value] of Object.entries({ ...process.env, ...config.env })) {
        if (!/^(NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START|ELECTRON_RUN_AS_NODE)$/i.test(key) && typeof value === 'string' && !key.includes('=') && !key.includes('\0') && !value.includes('\0')) env[key] = value
      }
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
      const args = ['--inspect-brk=127.0.0.1:0']
      if (config.runtime === 'tsx' || /\.tsx?$/i.test(entry.target)) args.push('--import', pathToFileURL(resolveTsxLoaderPath()).href)
      args.push('--', entry.target, ...(config.args ?? []))
      check(s)
      snapshot = { status: 'running', entry: entry.normalized, frames: [], variables: [], breakpoints: [] }
      const child = spawn(process.execPath, args, { cwd: cwd.target, env, shell: false, windowsHide: true, stdio: 'pipe' })
      s.child = child
      s.completion = new Promise<void>(resolve => {
        child.once('close', (code, signal) => {
          finish(s, code, signal)
          child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.removeAllListeners()
          resolve()
        })
      })
      const address = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => done(failure('DEBUG_START_TIMEOUT')), 15_000)
        const abort = () => done(failure('DEBUG_SESSION_STOPPED'))
        function done(error?: Error, url?: string) {
          clearTimeout(timer)
          s.abort.signal.removeEventListener('abort', abort)
          if (error) reject(error); else resolve(url!)
        }
        s.abort.signal.addEventListener('abort', abort, { once: true })
        child.once('error', error => done(error))
        child.once('exit', () => { done(failure('DEBUG_EXITED_BEFORE_CONNECT')); disconnect(s) })
        child.stdout.on('data', (chunk: Buffer) => emit({ type: 'output', stream: 'stdout', text: chunk.toString() }))
        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          emit({ type: 'output', stream: 'stderr', text })
          s.stderr = (s.stderr + text).slice(-8192)
          const match = s.stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)
          if (match) done(undefined, match[1])
          // Node deliberately stays alive at natural exit until its inspector client detaches.
          if (s.stderr.includes('Waiting for the debugger to disconnect')) {
            s.waitingForDisconnect = true
            detachWhenFinished(s)
          }
        })
      })
      emitState()
      await connect(s, await address)
      await command(s, 'Debugger.enable')
      await command(s, 'Runtime.enable')
      await serialize(async () => {
        check(s)
        s.ready = true
        for (const file of files.values()) await applyBreakpoints(s, file)
      })
      await command(s, 'Runtime.runIfWaitingForDebugger')
    } catch (error) {
      await shutdown(s)
      throw error
    }
  }
  async function control(method: string, status: 'running' | 'paused') {
    const s = session
    if (!s || snapshot.status !== status) throw failure(status === 'paused' ? 'DEBUG_NOT_PAUSED' : 'DEBUG_NOT_RUNNING')
    await command(s, method)
  }

  return {
    state,
    setBreakpoints(relativePath, lines) {
      return serialize(async () => {
        if (disposed) throw failure('DEBUG_DISPOSED')
        const checked = await validated(relativePath)
        if (!Array.isArray(lines) || lines.some(line => !Number.isSafeInteger(line) || line < 1)) throw failure('DEBUG_INVALID_BREAKPOINT')
        const old = files.get(checked.normalized)
        const s = session
        if (s?.ready && old) {
          for (const point of old.points) await removePoint(s, point)
        }
        const file: BreakpointFile = { relative: checked.normalized, points: [...new Set(lines)].sort((a, b) => a - b).map(line => ({ path: checked.normalized, line, verified: false })) }
        files.set(checked.normalized, file)
        if (s?.ready) await applyBreakpoints(s, file); else emitState()
        return file.points.map(point => ({ ...point }))
      })
    },
    start(config) {
      if (disposed) return Promise.reject(failure('DEBUG_DISPOSED'))
      if (session) return Promise.reject(failure('DEBUG_SESSION_ACTIVE'))
      const s: Session = { active: true, stopping: false, ready: false, initialPause: true, pauseVersion: 0, abort: new AbortController(), pending: new Map(), scripts: new Map(), sourceBreakpoints: new Map(), resolved: new Set(), sequence: 0, stderr: '' }
      session = s
      return launch(s, config)
    },
    continue: () => control('Debugger.resume', 'paused'),
    pause: () => control('Debugger.pause', 'running'),
    stepOver: () => control('Debugger.stepOver', 'paused'),
    stepInto: () => control('Debugger.stepInto', 'paused'),
    stepOut: () => control('Debugger.stepOut', 'paused'),
    async evaluate(expression, callFrameId) {
      const s = session
      if (!s) throw failure('DEBUG_NOT_CONNECTED')
      const frame = snapshot.status === 'paused' ? callFrameId ?? snapshot.frames[0]?.callFrameId : undefined
      const result = await command<{ result: RemoteObject; exceptionDetails?: { text: string; exception?: RemoteObject } }>(s, frame ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate', { expression, ...(frame ? { callFrameId: frame } : {}), generatePreview: true })
      return { ...preview(result.result), ...(result.exceptionDetails ? { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text } : {}) }
    },
    async stop() { if (session) await shutdown(session) },
    async dispose() { disposed = true; if (session) await shutdown(session); files.clear() }
  }
}
