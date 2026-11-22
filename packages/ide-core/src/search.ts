import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { validateWorkspacePath } from './workspace-fs'

export type SearchQuery = {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string[]
  exclude?: string[]
  maxFiles?: number
  maxMatches?: number
}
export type SearchMatch = { line: number; column: number; length: number; lineText: string; matchText: string }
export type SearchFileResult = { path: string; matches: SearchMatch[] }
export type SearchResponse = { results: SearchFileResult[]; totalMatches: number; filesSearched: number; truncated: boolean; engine: 'ripgrep' | 'node' }
type SearchOptions = { signal?: AbortSignal; forceEngine?: 'ripgrep' | 'node'; rgPath?: string }
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
  try { return new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, query.caseSensitive ? 'g' : 'gi') }
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

async function* textFiles(root: string, query: SearchQuery, signal?: AbortSignal, discovered?: Set<string>, allowlist?: Set<string>): AsyncGenerator<{ path: string; content: string }> {
  const includes = query.include?.map(pattern => glob(pattern))
  const excludes = query.exclude?.map(pattern => glob(pattern.replace(/\/$/, '') + (pattern.endsWith('/') ? '/**' : '')))
  async function* walk(directory: string, inherited: IgnoreRule[]): AsyncGenerator<{ path: string; content: string }> {
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
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)) } catch { continue }
        abort(signal)
        yield { path: relative, content }
      } finally { await handle.close() }
    }
  }
  yield* walk('', [])
}

function lineMatches(content: string, expression: RegExp, maximum: number): SearchMatch[] {
  const matches: SearchMatch[] = []
  const lines = content.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = expression.exec(lines[index]))) {
      matches.push({ line: index + 1, column: match.index + 1, length: match[0].length, lineText: lines[index], matchText: match[0] })
      if (matches.length >= maximum) return matches
      if (!match[0].length) expression.lastIndex++
    }
  }
  return matches
}

export async function searchWorkspace(root: string, query: SearchQuery, options: SearchOptions = {}): Promise<SearchResponse> {
  abort(options.signal)
  const response: SearchResponse = { results: [], totalMatches: 0, filesSearched: 0, truncated: false, engine: 'node' }
  if (!query.query) return response
  const expression = matcher(query)
  const { rootReal } = await validateWorkspacePath(root, '', { allowRoot: true })
  const found = await discovery(rootReal, options)
  response.engine = found.engine
  const maxFiles = limit(query.maxFiles, 5000), maxMatches = limit(query.maxMatches, 1000)
  if (!maxFiles || !maxMatches) return { ...response, truncated: true }
  for await (const file of textFiles(rootReal, query, options.signal, found.paths)) {
    response.filesSearched++
    const matches = lineMatches(file.content, expression, maxMatches - response.totalMatches)
    if (matches.length) response.results.push({ path: file.path, matches })
    response.totalMatches += matches.length
    if (response.filesSearched >= maxFiles || response.totalMatches >= maxMatches) { response.truncated = true; break }
  }
  abort(options.signal)
  return response
}

export async function replaceInWorkspace(root: string, options: SearchQuery & { replacement: string; files?: string[]; dryRun?: boolean }): Promise<{ filesChanged: number; replacements: number; previews: { path: string; count: number; sampleBefore: string; sampleAfter: string }[] }> {
  const { rootReal } = await validateWorkspacePath(root, '', { allowRoot: true })
  let allowlist: Set<string> | undefined
  if (options.files) {
    allowlist = new Set()
    // Validate the entire list before any write, even entries after a limit or an empty query.
    for (const file of options.files) allowlist.add((await validateWorkspacePath(rootReal, file)).normalized)
  }
  const result = { filesChanged: 0, replacements: 0, previews: [] as { path: string; count: number; sampleBefore: string; sampleAfter: string }[] }
  if (!options.query) return result
  const expression = matcher(options)
  const maxFiles = limit(options.maxFiles, 5000), maxMatches = limit(options.maxMatches, 1000)
  let filesSearched = 0
  if (!maxFiles || !maxMatches) return result
  for await (const file of textFiles(rootReal, options, undefined, undefined, allowlist)) {
    filesSearched++
    let count = 0
    // Split with captured separators so CRLF, LF, and CR are preserved byte-for-byte.
    const after = file.content.split(/(\r\n|\n|\r)/).map((line, index) => {
      if (index % 2) return line
      expression.lastIndex = 0
      return line.replace(expression, (...args: unknown[]) => {
        if (result.replacements + count >= maxMatches) return args[0] as string
        count++
        if (!options.regex) return options.replacement
        const match = args[0] as string
        const named = typeof args[args.length - 1] === 'object' ? args[args.length - 1] as Record<string, string> : undefined
        const offsetIndex = args.length - (named ? 3 : 2)
        const offset = args[offsetIndex] as number
        const captures = args.slice(1, offsetIndex) as (string | undefined)[]
        return options.replacement.replace(/\$([$&`']|\d{1,2}|<[^>]+>)/g, (token, key: string) => {
          if (key === '$') return '$'
          if (key === '&') return match
          if (key === '`') return line.slice(0, offset)
          if (key === "'") return line.slice(offset + match.length)
          if (key.startsWith('<')) return named ? named[key.slice(1, -1)] ?? '' : token
          const number = Number(key)
          if (number > 0 && number <= captures.length) return captures[number - 1] ?? ''
          const first = Number(key[0])
          return key.length === 2 && first > 0 && first <= captures.length ? (captures[first - 1] ?? '') + key[1] : token
        })
      })
    }).join('')
    result.replacements += count
    if (after !== file.content) {
      if (!options.dryRun) {
        const checked = await validateWorkspacePath(rootReal, file.path)
        const handle = await open(checked.target, 'r+')
        try {
          const current = await handle.readFile('utf8')
          if (current !== file.content) throw new Error('FILE_CONFLICT')
          const bytes = Buffer.from(after, 'utf8')
          let offset = 0
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
            if (!bytesWritten) throw new Error('WRITE_FAILED')
            offset += bytesWritten
          }
          await handle.truncate(bytes.length)
        } finally { await handle.close() }
      }
      result.filesChanged++
      result.previews.push({ path: file.path, count, sampleBefore: file.content.slice(0, 500), sampleAfter: after.slice(0, 500) })
    }
    if (filesSearched >= maxFiles || result.replacements >= maxMatches) break
  }
  return result
}
