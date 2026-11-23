import { parentPort } from 'node:worker_threads'
import { createTsLanguageServiceEngine, type TsLanguageService } from './ts-lsp-engine'

const port = parentPort!
const engines = new Map<number, TsLanguageService>()
const queues = new Map<number, Promise<void>>()
port.on('message', ({ id, serviceID, root, method, args }: { id: number; serviceID: number; root?: string; method: keyof TsLanguageService; args: unknown[] }) => {
  const queue = (queues.get(serviceID) ?? Promise.resolve()).then(async () => {
    try {
      if (method === 'dispose') {
        engines.get(serviceID)?.dispose()
        engines.delete(serviceID)
        queues.delete(serviceID)
        if (id > 0) port.postMessage({ id, serviceID, ok: true, result: undefined })
      } else {
        let engine = engines.get(serviceID)
        if (!engine) {
          if (!root) throw new Error('LSP_WORKSPACE_REQUIRED')
          engine = createTsLanguageServiceEngine(root)
          engines.set(serviceID, engine)
        }
        const result = await (engine[method] as (...a: unknown[]) => Promise<unknown>)(...args)
        port.postMessage({ id, serviceID, ok: true, result })
      }
    } catch (error) {
      port.postMessage({ id, serviceID, ok: false, message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined })
    }
  })
  queues.set(serviceID, queue)
})
