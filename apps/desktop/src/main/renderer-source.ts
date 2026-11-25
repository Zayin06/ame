import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function rendererSource(isPackaged: boolean, here: string, devURL?: string) {
  const file = path.resolve(here, '../renderer/index.html')
  return !isPackaged && devURL ? { url: new URL(devURL).href, file: undefined } : { file, url: undefined }
}

export function isRendererDocument(documentURL: string, source: ReturnType<typeof rendererSource>): boolean {
  try {
    const document = new URL(documentURL)
    if (source.url) {
      const expected = new URL(source.url)
      return ['http:', 'https:'].includes(expected.protocol) && document.origin === expected.origin
    }
    if (document.protocol !== 'file:' || document.host || document.search) return false
    // Round-trip through a filesystem path to normalize escaping and path segments.
    const normalized = pathToFileURL(path.resolve(fileURLToPath(document))).href
    return normalized === pathToFileURL(source.file!).href
  } catch { return false }
}
