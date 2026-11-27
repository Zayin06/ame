import { dirty, documentID, type Buffer } from './state'

const key = 'ame.ide.dirty-buffers.v1'
const recovered = new Map<string, Buffer>()
function storage() {
  return typeof window !== 'undefined' ? window.sessionStorage : typeof sessionStorage !== 'undefined' ? sessionStorage : undefined
}
function restore() {
  try {
    const values: unknown = JSON.parse(storage()?.getItem(key) ?? '[]')
    if (Array.isArray(values)) for (const buffer of values) {
      if (buffer && typeof buffer.projectID === 'string' && typeof buffer.path === 'string' && typeof buffer.text === 'string' && typeof buffer.content === 'string' && typeof buffer.revision === 'string' && dirty(buffer)) recovered.set(documentID(buffer.projectID, buffer.path), buffer)
    }
  } catch { /* Recovery must also work without browser storage. */ }
}
restore()
export function syncDirtyBuffers(buffers: Record<string, Buffer>) {
  recovered.clear()
  for (const buffer of Object.values(buffers)) if (dirty(buffer)) recovered.set(documentID(buffer.projectID, buffer.path), { ...buffer })
  try {
    if (recovered.size) storage()?.setItem(key, JSON.stringify([...recovered.values()]))
    else storage()?.removeItem(key)
  } catch { /* The in-memory mirror remains available. */ }
}
export function hasUnsavedBuffers() { return recovered.size > 0 }
// Non-destructive until the hydrated App has mirrored its state; safe for replayed initializers.
export function takeRecoveredBuffers(): Record<string, Buffer> { return Object.fromEntries(recovered) }
export function clearRecoveredBuffers() {
  recovered.clear()
  try { storage()?.removeItem(key) } catch { /* Storage may be disabled. */ }
}

let installed: Promise<unknown> | undefined
let eventBatch: Promise<unknown> | undefined
// Initial consumers share in-flight work; synchronous account/bundle events share a batch.
// A later notification may represent a newer account and must supersede older work.
export function loadInstalledAccount<T>(loader: () => Promise<T> | T, fromEvent = false): Promise<T> {
  if (fromEvent) {
    if (!eventBatch) {
      let request: Promise<T>
      try { request = Promise.resolve(loader()) } catch (error) { request = Promise.reject(error) }
      eventBatch = request
      void Promise.resolve().then(() => { if (eventBatch === request) eventBatch = undefined })
    }
    return eventBatch as Promise<T>
  }
  if (!installed) {
    // Invoke immediately to preserve the existing IPC lifecycle contract.
    try { installed = Promise.resolve(loader()) } catch (error) { installed = Promise.reject(error) }
    const request = installed
    void Promise.resolve().then(() => { if (installed === request) installed = undefined })
    void request.then(() => { if (installed === request) installed = undefined }, () => { if (installed === request) installed = undefined })
  }
  return installed as Promise<T>
}
