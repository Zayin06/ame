import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { SearchQuery, SearchMatch, SearchResponse, ReplaceOptions, ReplacePreview, ReplaceResult } from '../../protocol/src/index'
import { existsSync } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { validateWorkspacePath } from './workspace-fs'
import { isMainThread } from 'node:worker_threads'
import { SearchWorker } from './search-worker-client'

export type { SearchQuery, SearchMatch, SearchResponse } from '../../protocol/src/index'
type SearchOptions = { signal?: AbortSignal; forceEngine?: 'ripgrep' | 'node'; rgPath?: string; timeoutMs?: number }
type IgnoreRule = { base: string; pattern: RegExp; directory: boolean; negate: boolean }
const skipped = new Set(['.git', 'node_modules', 'dist', 'out', '.next'])
const maxBytes = 2 * 1024 * 1024
const execute = promisify(execFile)

export function findRipgrep(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (env.AME_RIPGREP_PATH && exists(env.AME_RIPGREP_PATH)) return env.AME_RIPGREP_PATH
  const directories = env.PATH ?? env.Path ?? ''
  for (const directory of directories.split(path.delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg', 'rg.exe']) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

function glob(pattern: string, anchored = false): RegExp {
  pattern = pattern.replace(/\\/g, '/')
  if (pattern.startsWith('/')) { anchored = true; pattern = pattern.slice(1) }
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      index++
      if (pattern[index + 1] === '/') { source += '(?:.*/)?'; index++ } else source += '.*'
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else if (character === '[' && pattern.indexOf(']', index + 1) > index + 1) {
      const end = pattern.indexOf(']', index + 1)
      const members = pattern.slice(index + 1, end)
      source += `[${members.startsWith('!') ? '^' + members.slice(1) : members}]`
      index = end
    }
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${anchored || pattern.includes('/') ? '^' : '(?:^|/)'}${source}$`)
}

async function ignoreRules(root: string, directory: string, inherited: IgnoreRule[]): Promise<IgnoreRule[]> {
  const relative = directory ? `${directory}/.gitignore` : '.gitignore'
  const file = path.join(root, relative)
  try {
    if (!(await lstat(file)).isFile()) return inherited
    const checked = await validateWorkspacePath(root, relative)
    if ((await stat(checked.target)).size > maxBytes) return inherited
    const content = await readFile(checked.target, 'utf8')
    const rules = [...inherited]
    for (let pattern of content.split(/\r?\n/)) {
      pattern = pattern.trim()
      if (!pattern || pattern.startsWith('#')) continue
      const negate = pattern.startsWith('!')
      if (negate) pattern = pattern.slice(1)
      const directoryOnly = pattern.endsWith('/')
      if (directoryOnly) pattern = pattern.slice(0, -1)
      if (pattern) rules.push({ base: directory, pattern: glob(pattern), directory: directoryOnly, negate })
    }
    return rules
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return inherited
    throw error
  }
}
function ignored(relative: string, directory: boolean, rules: IgnoreRule[]) {
  let result = false
  for (const rule of rules) {
    const local = rule.base ? relative.slice(rule.base.length + 1) : relative
    if ((!rule.directory || directory) && rule.pattern.test(local)) result = !rule.negate
  }
  return result
}
function abort(signal?: AbortSignal) { signal?.throwIfAborted() }
function limit(value: number | undefined, fallback: number) { return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value)) }
function matcher(query: SearchQuery) {
  const source = query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try { return new RegExp(query.wholeWord ? `(?<![\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])` : source, (query.caseSensitive ? 'g' : 'gi') + (query.wholeWord ? 'u' : '')) }
  catch { throw Object.assign(new Error('INVALID_REGEX'), { code: 'INVALID_REGEX' }) }
}

async function discovery(root: string, options: SearchOptions): Promise<{ engine: 'node' | 'ripgrep'; paths?: Set<string> }> {
  const executable = options.forceEngine === 'node' ? null : options.rgPath ?? findRipgrep()
  if (!executable) return { engine: 'node' }
  try {
    // Ripgrep accelerates file discovery; matching stays in JS for identical UTF-16/regex semantics.
    const { stdout } = await execute(executable, ['--no-config', '--files', '--null', '--hidden', '--no-ignore', ...[...skipped].flatMap(name => ['--glob', `!**/${name}/**`]), '--', '.'], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, signal: options.signal, windowsHide: true
    })
    abort(options.signal)
    return { engine: 'ripgrep', paths: new Set(stdout.split('\0').filter(Boolean).map(file => file.replace(/\\/g, '/').replace(/^\.\//, ''))) }
  } catch {
    abort(options.signal)
    return { engine: 'node' }
  }
}

async function* textFiles(root: string, query: SearchQuery, signal?: AbortSignal, discovered?: Set<string>, allowlist?: Set<string>): AsyncGenerator<{ path: string; content: string; revision: string; bom: boolean }> {
  const includes = query.include?.map(pattern => glob(pattern))
  const excludes = query.exclude?.map(pattern => glob(pattern.replace(/\/$/, '') + (pattern.endsWith('/') ? '/**' : '')))
  async function* walk(directory: string, inherited: IgnoreRule[]): AsyncGenerator<{ path: string; content: string; revision: string; bom: boolean }> {
    abort(signal)
    const rules = await ignoreRules(root, directory, inherited)
    const checked = await validateWorkspacePath(root, directory, { allowRoot: true })
    const entries = (await readdir(checked.target, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      abort(signal)
      const relative = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink() || skipped.has(entry.name.toLowerCase()) || ignored(relative, entry.isDirectory(), rules)) continue
      if (entry.isDirectory()) { yield* walk(relative, rules); continue }
      if (!entry.isFile() || (discovered && !discovered.has(relative)) || (allowlist && !allowlist.has(relative))) continue
      if ((includes?.length && !includes.some(pattern => pattern.test(relative))) || excludes?.some(pattern => pattern.test(relative))) continue
      const file = await validateWorkspacePath(root, relative)
      const handle = await open(file.target, 'r')
      try {
        if (!(await handle.stat()).isFile() || (await handle.stat()).size > maxBytes) continue
        const bytes = Buffer.alloc(maxBytes + 1)
        let size = 0
        while (size < bytes.length) {
          abort(signal)
          const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > maxBytes || bytes.subarray(0, size).includes(0)) continue
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) } catch { continue }
        abort(signal)
        yield { path: relative, content, revision: revision(bytes.subarray(0, size)), bom: size >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf }
      } finally { await handle.close() }
    }
  }
  yield* walk('', [])
}

function* lineMatches(content: string, expression: RegExp): Generator<SearchMatch> {
  const lines = content.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = expression.exec(lines[index]))) {
      const start = Math.max(0, match.index - 100)
      const end = Math.min(lines[index].length, match.index + Math.min(match[0].length, 100) + 100)
      const snippetTruncated = start > 0 || end < lines[index].length
      yield { line: index + 1, column: match.index + 1, length: match[0].length,
        lineText: `${start ? '…' : ''}${lines[index].slice(start, end)}${end < lines[index].length ? '…' : ''}`,
        matchText: match[0].slice(0, 100), snippetStart: start + 1, snippetTruncated }
      if (!match[0].length) expression.lastIndex += expression.unicode && (lines[index].codePointAt(expression.lastIndex) ?? 0) > 0xffff ? 2 : 1
    }
  }
}

export async function searchWorkspace(root: string, query: SearchQuery, options: SearchOptions = {}): Promise<SearchResponse> {
  abort(options.signal)
  const response: SearchResponse = { results: [], totalMatches: 0, filesSearched: 0, truncated: false, engine: 'node' }
  if (!query.query) return response
  // Ignore/include globs also compile to regex, even for a literal text query.
  if (isMainThread) {
    const worker = new SearchWorker()
    try { return await worker.run<SearchResponse>({ kind: 'search', root, query, options: { forceEngine: options.forceEngine, rgPath: options.rgPath } }, options.signal, options.timeoutMs) }
    finally { worker.dispose() }
  }
  const expression = matcher(query)
  const { rootReal } = await validateWorkspacePath(root, '', { allowRoot: true })
  const found = await discovery(rootReal, options)
  response.engine = found.engine
  const maxFiles = limit(query.maxFiles, 5000), maxMatches = limit(query.maxMatches, 1000)
  const responseBudget = Math.max(256, Math.min(limit(query.maxResponseBytes, 1024 * 1024), 1024 * 1024))
  let responseBytes = 160 // Envelope and counters, including the final truncated flag.
  if (!maxFiles || !maxMatches) return { ...response, truncated: true }
  for await (const file of textFiles(rootReal, query, options.signal, found.paths)) {
    response.filesSearched++
    const matches: SearchMatch[] = []
    const fileBytes = Buffer.byteLength(JSON.stringify({ path: file.path, matches: [] })) + 1
    for (const match of lineMatches(file.content, expression)) {
      const bytes = Buffer.byteLength(JSON.stringify(match)) + 1 + (matches.length ? 0 : fileBytes)
      if (responseBytes + bytes > responseBudget) { response.truncated = true; break }
      responseBytes += bytes
      matches.push(match)
      if (response.totalMatches + matches.length >= maxMatches) break
    }
    if (matches.length) response.results.push({ path: file.path, matches })
    response.totalMatches += matches.length
    if (response.truncated || response.filesSearched >= maxFiles || response.totalMatches >= maxMatches) { response.truncated = true; break }
  }
  abort(options.signal)
  return response
}

const revision = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function replaceInWorkspace(root: string, options: ReplaceOptions, plan?: ReplacePreview[]): Promise<ReplaceResult> {
  const { rootReal } = await validateWorkspacePath(root, '', { allowRoot: true })
  let allowlist: Set<string> | undefined
  if (options.files && !plan) {
    allowlist = new Set()
    // Validate the entire list before any write, even entries after a limit or an empty query.
    for (const file of options.files) allowlist.add((await validateWorkspacePath(rootReal, file)).normalized)
  }
  const result: ReplaceResult = { filesChanged: 0, replacements: 0, previews: [], writtenFiles: [], conflicts: [], errors: [] }
  if (isMainThread && options.dryRun) {
    const worker = new SearchWorker()
    try { return await worker.run<ReplaceResult>({ kind: 'preview', root: rootReal, options }) }
    finally { worker.dispose() }
  }
  if (plan && !options.dryRun) {
    let worker: SearchWorker | undefined
    try {
      // No discovery here: only the exact files and per-file replacement counts approved in preview.
      for (const [entryIndex, entry] of plan.entries()) {
        try {
          const checked = await validateWorkspacePath(rootReal, entry.path)
          const handle = await open(checked.target, 'r+')
          try {
            const before = await handle.readFile()
            if (revision(before) !== entry.revision) { result.conflicts.push(entry.path); continue }
            const changed = isMainThread && options.regex
              ? await (worker ??= new SearchWorker()).run<{ after: string; count: number }>({ kind: 'replacement', content: before.toString('utf8'), options, maximum: entry.count })
              : replacementText(before.toString('utf8'), options, entry.count)
            const current = await readFile(checked.target)
            const openedFile = await handle.stat({ bigint: true }), currentFile = await stat(checked.target, { bigint: true })
            // An atomic save can replace a file with identical bytes while this handle still
            // points at the old inode. Never report a successful write to that detached file.
            if (revision(current) !== entry.revision || openedFile.dev !== currentFile.dev || openedFile.ino !== currentFile.ino) { result.conflicts.push(entry.path); continue }
            const bytes = Buffer.from(changed.after, 'utf8')
            let offset = 0
            while (offset < bytes.length) {
              const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
              if (!bytesWritten) throw new Error('WRITE_FAILED')
              offset += bytesWritten
            }
            await handle.truncate(bytes.length)
            result.filesChanged++
            result.replacements += changed.count
            result.writtenFiles.push(entry.path)
            result.previews.push(entry)
          } finally { await handle.close() }
        } catch (error) {
          result.errors.push({ path: entry.path, code: (error as NodeJS.ErrnoException).code ?? 'WRITE_FAILED' })
          if (error instanceof Error && /SEARCH_(?:TIMEOUT|WORKER)/.test(error.message)) {
            for (const pending of plan.slice(entryIndex + 1)) result.errors.push({ path: pending.path, code: 'REPLACE_ABORTED' })
            break
          }
        }
      }
      return result
    } finally { worker?.dispose() }
  }
  if (!options.dryRun) {
    const preview = await replaceInWorkspace(rootReal, { ...options, dryRun: true })
    return replaceInWorkspace(rootReal, options, preview.previews)
  }
  if (!options.query) return result
  matcher(options) // Validate before scanning, including an empty workspace.
  const maxFiles = limit(options.maxFiles, 5000), maxMatches = limit(options.maxMatches, 1000)
  let filesSearched = 0
  if (!maxFiles || !maxMatches) return result
  for await (const file of textFiles(rootReal, options, undefined, undefined, allowlist)) {
    filesSearched++
    const before = (file.bom ? '\uFEFF' : '') + file.content
    const { after, count } = replacementText(before, options, maxMatches - result.replacements)
    result.replacements += count
    if (after !== before) {
      result.filesChanged++
      result.previews.push({ path: file.path, revision: file.revision, count, sampleBefore: before.slice(0, 500), sampleAfter: after.slice(0, 500) })
    }
    if (filesSearched >= maxFiles || result.replacements >= maxMatches) break
  }
  return result
}

export function replacementText(content: string, options: ReplaceOptions, maximum: number) {
    const expression = matcher(options)
    let outputBytes = Buffer.byteLength(content, 'utf8')
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
    if (bom) content = content.slice(1)
    let count = 0
    // Split with captured separators so CRLF, LF, and CR are preserved byte-for-byte.
    const after = content.split(/(\r\n|\n|\r)/).map((line, index) => {
      if (index % 2) return line
      expression.lastIndex = 0
      return line.replace(expression, (...args: unknown[]) => {
        if (count >= maximum) return args[0] as string
        count++
        const bounded = (value: string) => {
          outputBytes += Buffer.byteLength(value, 'utf8') - Buffer.byteLength(args[0] as string, 'utf8')
          if (outputBytes > 4 * 1024 * 1024) throw Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' })
          return value
        }
        if (!options.regex) return bounded(options.replacement)
        const match = args[0] as string
        const named = typeof args[args.length - 1] === 'object' ? args[args.length - 1] as Record<string, string> : undefined
        const offsetIndex = args.length - (named ? 3 : 2)
        const offset = args[offsetIndex] as number
        const captures = args.slice(1, offsetIndex) as (string | undefined)[]
        return bounded(options.replacement.replace(/\$([$&`']|\d{1,2}|<[^>]+>)/g, (token, key: string) => {
          if (key === '$') return '$'
          if (key === '&') return match
          if (key === '`') return line.slice(0, offset)
          if (key === "'") return line.slice(offset + match.length)
          if (key.startsWith('<')) return named ? named[key.slice(1, -1)] ?? '' : token
          const number = Number(key)
          if (number > 0 && number <= captures.length) return captures[number - 1] ?? ''
          const first = Number(key[0])
          return key.length === 2 && first > 0 && first <= captures.length ? (captures[first - 1] ?? '') + key[1] : token
        }))
      })
    }).join('')
    const complete = bom + after
    if (Buffer.byteLength(complete, 'utf8') > 4 * 1024 * 1024) throw Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' })
    return { after: complete, count }
}
