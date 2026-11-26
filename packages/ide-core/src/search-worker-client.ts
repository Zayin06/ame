import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { ReplaceOptions, SearchQuery } from '../../protocol/src/index'

export type SearchWorkerTask =
  | { kind: 'search'; root: string; query: SearchQuery; options: { forceEngine?: 'ripgrep' | 'node'; rgPath?: string } }
  | { kind: 'preview'; root: string; options: ReplaceOptions }
  | { kind: 'replacement'; content: string; options: ReplaceOptions; maximum: number }

function workerTarget() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Rollup may place shared search code under main/chunks while entries stay in main/.
  for (const directory of [here, path.dirname(here)]) {
    const built = path.join(directory, 'search-worker.js')
    const unpacked = built.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    if (existsSync(unpacked)) return unpacked
    if (existsSync(built)) return built
  }
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
  const source = pathToFileURL(path.join(here, 'search-worker.ts')).href
  return new URL(`data:text/javascript,${encodeURIComponent(`import { tsImport } from ${JSON.stringify(loader)}; await tsImport(${JSON.stringify(source)}, ${JSON.stringify(import.meta.url)});`)}`)
}

/** Only read-only discovery and text computation run here; termination can never interrupt a file write. */
export class SearchWorker {
  private worker: Worker
  private pending?: { resolve(value: unknown): void; reject(error: Error): void }
  private closed = false
  constructor() {
    this.worker = new Worker(workerTarget(), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } })
    this.worker.on('message', (message: { ok: boolean; value?: unknown; error?: string; code?: string }) => {
      const pending = this.pending
      this.pending = undefined
      if (message.ok) pending?.resolve(message.value)
      else pending?.reject(Object.assign(new Error(message.error || 'SEARCH_WORKER_FAILED'), { code: message.code }))
    })
    this.worker.on('error', error => this.fail(Object.assign(new Error('SEARCH_WORKER_FAILED'), { code: 'SEARCH_WORKER_FAILED', cause: error })))
    this.worker.on('exit', () => this.fail(Object.assign(new Error('SEARCH_WORKER_FAILED'), { code: 'SEARCH_WORKER_FAILED' })))
  }
  private fail(error: Error) {
    this.pending?.reject(error)
    this.pending = undefined
    this.dispose()
  }
  async run<T>(task: SearchWorkerTask, signal?: AbortSignal, timeoutMs = 10_000): Promise<T> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('SEARCH_WORKER_CLOSED')
    if (this.pending) throw new Error('SEARCH_WORKER_BUSY')
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => this.fail(signal?.reason ?? new Error('SEARCH_CANCELLED'))
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending = { resolve: value => resolve(value as T), reject }
        timer = setTimeout(() => this.fail(Object.assign(new Error('SEARCH_TIMEOUT'), { code: 'SEARCH_TIMEOUT' })), timeoutMs)
        signal?.addEventListener('abort', abort, { once: true })
        try { this.worker.postMessage(task) } catch (error) { this.fail(error as Error) }
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  dispose() {
    if (this.closed) return
    this.closed = true
    this.pending?.reject(new Error('SEARCH_WORKER_CLOSED'))
    this.pending = undefined
    void this.worker.terminate()
  }
}
