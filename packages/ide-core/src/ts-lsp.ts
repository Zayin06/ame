import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { TsLanguageService } from './ts-lsp-engine'

export type { LspSeverity, LspRange, LspDiagnostic, LspCompletion, LspHover, LspLocation, LspReference, LspTextEdit, LspRenameResult, TsLanguageService } from './ts-lsp-engine'

function resolveWorkerTarget() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const built = path.join(here, 'ts-lsp-worker.js')
  const unpacked = built.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  if (fs.existsSync(unpacked)) return { file: unpacked, execArgv: [] as string[] }
  if (fs.existsSync(built)) return { file: built, execArgv: [] as string[] }
  const tsSource = path.join(here, 'ts-lsp-worker.ts')
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  return { file: tsSource, execArgv: ['--import', tsxLoader] }
}

let nextServiceID = 1, nextRequestID = 1
let sharedWorker: Worker | undefined
let workerGeneration = 0
const activeServices = new Set<number>()
const pending = new Map<number, { serviceID: number; timer: ReturnType<typeof setTimeout>; resolve: (result: unknown) => void; reject: (error: Error) => void }>()

function rejectPending(error: Error) {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
  pending.clear()
}

function spawn() {
  const { file, execArgv } = resolveWorkerTarget()
  // Node 24 may select its native TS loader before --import hooks for a worker entry.
  const target = file.endsWith('.ts') ? new URL(`data:text/javascript,${encodeURIComponent(
    `import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(pathToFileURL(file).href)}, ${JSON.stringify(import.meta.url)});`
  )}`) : file
  const current = new Worker(target, { execArgv })
  sharedWorker = current
  workerGeneration++
  current.on('message', (message: { id: number; serviceID: number; ok: boolean; result?: unknown; message?: string; code?: string }) => {
    if (sharedWorker !== current) return
    const request = pending.get(message.id)
    if (!request || request.serviceID !== message.serviceID) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.ok) request.resolve(message.result)
    else {
      const error = new Error(message.message)
      if (message.code) Object.assign(error, { code: message.code })
      request.reject(error)
    }
  })
  const failed = (error: Error) => {
    if (sharedWorker !== current) return
    sharedWorker = undefined
    rejectPending(error)
    void current.terminate()
  }
  current.on('error', failed)
  current.on('exit', code => {
    if (sharedWorker === current) failed(new Error(`LSP_WORKER_EXIT: ${code}`))
  })
  return current
}

/** Workspaces retain isolated engines inside one lazily created shared worker. */
export function createTsLanguageService(workspaceRoot: string, options: { requestTimeoutMs?: number } = {}): TsLanguageService {
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('INVALID_LSP_TIMEOUT')
  const root = fs.realpathSync(workspaceRoot)
  const serviceID = nextServiceID++
  activeServices.add(serviceID)
  let disposed = false, initializedInWorker = false, sentGeneration = 0
  let activeRefresh: Promise<void> | undefined, refreshQueued = false
  function rpc<T>(method: keyof TsLanguageService, args: unknown[]): Promise<T> {
    if (disposed) return Promise.reject(new Error('LSP_DISPOSED'))
    return new Promise<T>((resolve, reject) => {
      try {
        const current = sharedWorker ?? spawn()
        if (sentGeneration !== workerGeneration) initializedInWorker = false
        const id = nextRequestID++
        const generation = workerGeneration
        const timer = setTimeout(() => {
          if (sharedWorker !== current || !pending.has(id)) return
          sharedWorker = undefined
          workerGeneration++
          rejectPending(new Error('LSP_TIMEOUT'))
          void current.terminate()
        }, requestTimeoutMs)
        pending.set(id, { serviceID, timer, resolve: result => {
          if (sharedWorker === current && workerGeneration === generation) initializedInWorker = true
          resolve(result as T)
        }, reject })
        try {
          current.postMessage({ id, serviceID, root: initializedInWorker ? undefined : root, method, args })
          sentGeneration = workerGeneration
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      } catch (error) { reject(error) }
    })
  }
  function refreshFiles(): Promise<void> {
    if (disposed) return Promise.reject(new Error('LSP_DISPOSED'))
    if (activeRefresh) { refreshQueued = true; return activeRefresh }
    activeRefresh = (async () => {
      await rpc<void>('refreshFiles', [])
      if (refreshQueued) { refreshQueued = false; await rpc<void>('refreshFiles', []) }
    })().finally(() => { activeRefresh = undefined; refreshQueued = false })
    return activeRefresh
  }
  return {
    updateDocument: (...args) => rpc('updateDocument', args),
    closeDocument: (...args) => rpc('closeDocument', args),
    refreshFiles,
    diagnostics: async (...args) => {
      // A filesystem event can queue another pass behind the active refresh.
      // Wait for both passes before enqueueing diagnostics on the worker.
      await activeRefresh
      return rpc('diagnostics', args)
    },
    completions: (...args) => rpc('completions', args),
    hover: (...args) => rpc('hover', args),
    definition: (...args) => rpc('definition', args),
    references: (...args) => rpc('references', args),
    renamePreview: (...args) => rpc('renamePreview', args),
    dispose() {
      if (disposed) return
      disposed = true
      activeServices.delete(serviceID)
      const error = new Error('LSP_DISPOSED')
      for (const [id, request] of pending) {
        if (request.serviceID !== serviceID) continue
        request.reject(error)
        clearTimeout(request.timer)
        pending.delete(id)
      }
      if (sharedWorker) {
        if (activeServices.size === 0) {
          const current = sharedWorker
          sharedWorker = undefined
          workerGeneration++
          rejectPending(error)
          void current.terminate()
        } else {
          sharedWorker.postMessage({ id: 0, serviceID, method: 'dispose', args: [] })
        }
      }
    },
  }
}
