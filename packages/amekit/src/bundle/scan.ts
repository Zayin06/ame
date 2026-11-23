// Adapted from opencode-amekit/src/bundle/scan.ts; see ../docs/amekit.md for provenance.
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { exclusion, preview, safePath, type ImportOptions, type InputFile, type Issue } from "./package"
import { MAX_EXPANDED, MAX_FILE, MAX_PAYLOAD_FILES } from "./limits"

export async function scan(root: string, signal?: AbortSignal, options: ImportOptions = {}) {
  if (options.compatibilityMode !== undefined && options.compatibilityMode !== "native" && options.compatibilityMode !== "raw") throw new Error("INVALID_COMPATIBILITY_MODE")
  if (options.adaptClaudeAgents === true && options.compatibilityMode !== "raw") throw new Error("INVALID_COMPATIBILITY_MODE")
  if (!path.isAbsolute(root)) throw new Error("SELECT_ABSOLUTE_FOLDER")
  const absolute = path.resolve(root)
  const stat = await lstat(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw new Error("UNSAFE_SOURCE_ROOT")
  const files: InputFile[] = [], issues: Issue[] = []
  let visited = 0, expanded = 0
  async function walk(folder: string, prefix: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const name = prefix + entry.name
      if (++visited > 4096) throw new Error("SOURCE_SCAN_LIMIT_4096_ENTRIES")
      const target = path.join(folder, entry.name)
      const info = await lstat(target)
      if (info.isSymbolicLink() || (await realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()) {
        issues.push({ path: name, severity: "error", reason: "symlink/reparse path; never followed" }); continue
      }
      try { safePath(name) } catch { issues.push({ path: name, severity: "error", reason: "unsafe path" }); continue }
      const reason = exclusion(name, options)
      if (reason) { issues.push({ path: name + (info.isDirectory() ? "/**" : ""), severity: "excluded", reason }); continue }
      if (info.isDirectory()) { await walk(target, name + "/"); continue }
      if (!info.isFile()) { issues.push({ path: name, severity: "error", reason: "non-regular file" }); continue }
      const limit = info.size > MAX_FILE ? "file exceeds 4 MiB" : expanded + info.size > MAX_EXPANDED ? "expanded payload exceeds 24 MiB" : files.length >= MAX_PAYLOAD_FILES ? `more than ${MAX_PAYLOAD_FILES} payload entries` : undefined
      if (limit) { issues.push({ path: name, severity: "error", reason: limit }); continue }
      const data = new Uint8Array(await readFile(target))
      if (data.length !== info.size || (await lstat(target)).isSymbolicLink()) throw new Error("SOURCE_CHANGED_DURING_SCAN")
      expanded += data.length
      files.push({ path: name, data })
    }
  }
  await walk(absolute, "")
  return preview(files, issues, options)
}
