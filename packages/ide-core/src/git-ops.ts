import { createReadStream, existsSync } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath, stat, unlink } from 'node:fs/promises'
import { cleanupStaleSaveTemps } from './file-save'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { isValidGitCommitHash } from '../../protocol/src/index'
import type { BuildNotesFileStat, BuildNotesRequest, GitBranches, GitCommitDetail, GitCommitFile, GitCommitSummary, GitPushOptions, GitStashEntry, GitSyncResult } from '../../protocol/src/index'

type GitRunOptions = { env?: NodeJS.ProcessEnv; input?: Buffer | string | ReturnType<typeof createReadStream>; timeoutMs?: number }

// Stream consumers share exit/timeout handling, including quiet hook failures.
function streamGit(cwd: string, args: string[], options: GitRunOptions, consume: (chunk: Buffer) => boolean | void) {
  return new Promise<{ stderr: string }>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }, windowsHide: true })
    let stderr = '', stopped = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs ?? 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      if (!stopped && consume(chunk) === false) { stopped = true; child.stdout.destroy(); child.kill() }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, Math.max(0, 16_384 - stderr.length)) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut || (!stopped && code !== 0)) reject(new Error(`GIT_COMMAND_FAILED: git ${args[0]} exit ${code}${timedOut ? ' (timeout)' : ''}${stderr ? `: ${stderr.trim()}` : ''}`))
      else resolve({ stderr })
    })
    if (options.input && typeof options.input !== 'string' && !Buffer.isBuffer(options.input)) {
      const input = options.input
      input.on('error', error => { child.kill(); reject(error) })
      child.on('close', () => input.destroy())
      input.pipe(child.stdin)
    } else child.stdin.end(options.input)
  })
}

async function runGit(cwd: string, args: string[], options: GitRunOptions = {}) {
  const chunks: Buffer[] = []
  const { stderr } = await streamGit(cwd, args, options, chunk => { chunks.push(chunk) })
  return { stdout: Buffer.concat(chunks), stderr }
}

async function runGitBounded(cwd: string, args: string[], maxBytes: number, env?: NodeJS.ProcessEnv, readonlyConfig?: string[]) {
  const chunks: Buffer[] = []
  let size = 0, truncated = false
  await streamGit(cwd, [...(readonlyConfig ?? await safeReadOnlyGitConfig(cwd)).flatMap(value => ['-c', value]), ...args], { env }, chunk => {
    const part = chunk.subarray(0, maxBytes + 1 - size)
    // Copy only the retained bytes, never keep a reference to a large source chunk.
    chunks.push(Buffer.from(part)); size += part.length
    if (size > maxBytes) { truncated = true; return false }
  })
  const bytes = Buffer.concat(chunks)
  let end = Math.min(bytes.length, maxBytes)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated }
}

export async function safeReadOnlyGitConfig(rootReal: string): Promise<string[]> {
  const config = ['core.fsmonitor=false', 'diff.external=', 'core.pager=cat', 'core.hooksPath=', 'core.sshCommand=', 'credential.helper=']
  const pattern = '^(filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.textconv)$'
  const query = async (scope: string[]) => (await runGit(rootReal, ['config', ...scope, '--name-only', '--get-regexp', pattern]).catch(error => {
    if (/exit 1(?::|$)/.test(String(error))) return { stdout: Buffer.alloc(0) }
    throw error
  })).stdout
  // Keep the explicit local audit, and also cover included/global/worktree definitions
  // that Git's normal effective configuration will otherwise still execute.
  const stdout = Buffer.concat([await query(['--local']), Buffer.from('\n'), await query(['--includes'])])
  const filters = new Set<string>()
  for (const key of stdout.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    if (/^filter\..*\.(clean|smudge|process|required)$/i.test(key)) filters.add(key.slice(0, key.lastIndexOf('.')))
    else config.push(`${key}=`)
  }
  for (const filter of filters) config.push(`${filter}.clean=`, `${filter}.smudge=`, `${filter}.process=`, `${filter}.required=false`)
  return config
}

export async function detectUntrustedGitConfig(root: string): Promise<string[]> {
  const { rootReal, git } = await repository(root, true)
  const { stdout } = await runGit(rootReal, ['config', '--local', '--includes', '--name-only', '--get-regexp', '^(core\\.(fsmonitor|hookspath|sshcommand)|credential\\.helper|diff\\.external|diff\\..*\\.textconv|filter\\..*\\.(clean|smudge|process))$']).catch(error => {
    if (/exit 1(?::|$)/.test(String(error))) return { stdout: Buffer.alloc(0) }
    throw error
  })
  const gitDir = path.resolve(rootReal, (await git.raw(['rev-parse', '--git-common-dir'])).trim())
  const hooks = await readdir(path.join(gitDir, 'hooks'), { withFileTypes: true }).catch(() => [])
  return [...new Set([...stdout.toString('utf8').split(/\r?\n/).filter(Boolean), ...hooks.filter(entry => !entry.isDirectory() && !entry.name.endsWith('.sample')).map(entry => `hooks/${entry.name}`)])]
}

export async function resolveCommitHash(git: SimpleGit, hash: string): Promise<string> {
  if (!isValidGitCommitHash(hash)) throw new Error('INVALID_COMMIT_HASH')
  const resolved = (await git.raw(['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(resolved) || !resolved.toLowerCase().startsWith(hash.toLowerCase())) throw new Error('INVALID_COMMIT_HASH')
  return resolved
}

async function selectedCommitOrder(git: SimpleGit, selected: Set<string>): Promise<string[]> {
  const recent = (await git.raw(['rev-list', '--topo-order', '--max-count=2000', 'HEAD', '--'])).trim().split(/\r?\n/)
  const ordered = recent.filter(hash => selected.has(hash))
  const remaining = [...selected].filter(hash => !ordered.includes(hash))
  if (remaining.length) ordered.push(...(await git.raw(['rev-list', '--no-walk=sorted', ...remaining, '--'])).trim().split(/\r?\n/).filter(Boolean))
  return ordered
}

async function repository(root: string, readOnly = false) {
  const rootReal = await realpath(root)
  if (!existsSync(path.join(rootReal, '.git'))) throw new Error('GIT_ROOT_REQUIRED')
  const git = simpleGit(rootReal, { maxConcurrentProcesses: 1, trimmed: false, config: readOnly ? await safeReadOnlyGitConfig(rootReal) : ['core.fsmonitor=false'], timeout: { block: 10000 } }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  return { rootReal, git }
}

async function remoteRepository(root: string) {
  const { rootReal } = await repository(root)
  return simpleGit(rootReal, { maxConcurrentProcesses: 1, trimmed: false, config: ['core.fsmonitor=false'], timeout: { block: 60000 } }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
}

export async function hasRemote(rootOrGit: string | SimpleGit): Promise<boolean> {
  const git = typeof rootOrGit === 'string' ? (await repository(rootOrGit, true)).git : rootOrGit
  return (await git.raw(['remote'])).trim().length > 0
}

async function firstRemote(git: SimpleGit): Promise<string> {
  const remotes = (await git.raw(['remote'])).trim().split(/\r?\n/).filter(Boolean)
  if (!remotes.length) throw new Error('NO_REMOTE_CONFIGURED')
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

export function mapGitNetworkError(error: unknown): Error {
  const details = error && typeof error === 'object' ? error as { stderr?: unknown; message?: unknown } : undefined
  const message = String(details?.stderr || details?.message || error).trim()
  const codes: [RegExp, string][] = [
    [/authentication failed|could not read username|permission denied \((?:publickey|keyboard-interactive)\)|publickey|repository not found/i, 'GIT_AUTH_FAILED'],
    [/could not resolve host|connection refused|timed out|failed to connect|network is unreachable/i, 'GIT_OFFLINE'],
    [/\[remote rejected\]/i, 'GIT_REMOTE_REJECTED'],
    [/non-fast-forward|fetch first|rejected/i, 'GIT_PUSH_REJECTED_NON_FF'],
    [/would be overwritten by merge|local changes|overwritten by checkout/i, 'GIT_DIRTY_WORKTREE'],
    [/conflict/i, 'GIT_CONFLICT']
  ]
  const code = codes.find(([pattern]) => pattern.test(message))?.[1]
  return new Error(code ? `${code}: ${message}` : message)
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || relative.split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('INVALID_PATH')
}

async function filePath(root: string, relative: string) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || (process.platform === 'win32' && relative.includes(':')) || /^[a-zA-Z]:/.test(relative) || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error('INVALID_PATH')
  const parts = relative.split(/[\\/]/)
  if (parts.some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('INVALID_PATH')
  const target = path.resolve(root, ...parts)
  inside(root, target)
  if (target === root) throw new Error('INVALID_PATH')
  let prefix = root
  for (const part of path.relative(root, target).split(path.sep)) {
    prefix = path.join(prefix, part)
    try {
      await lstat(prefix)
      // Resolve every existing component, including links whose final child is missing.
      inside(root, await realpath(prefix))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      // A dangling link cannot be proven to stay within the repository.
      const entry = code === 'ENOENT' ? await lstat(prefix).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err; return undefined }) : undefined
      if (entry?.isSymbolicLink()) throw new Error('INVALID_PATH')
    }
  }
  const file = path.relative(root, target).split(path.sep).join('/')
  return { target, file, spec: `:(literal)${file}` }
}

async function hasHead(git: Awaited<ReturnType<typeof repository>>['git']) {
  // simple-git can resolve a quiet nonzero exit with empty stdout on unborn HEAD.
  return git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).then(output => output.trim().length > 0, () => false)
}

export async function stageAll(root: string): Promise<void> {
  await cleanupStaleSaveTemps(root).catch(() => {})
  const { git } = await repository(root)
  await git.raw(['add', '-A', '--', '.', ':(exclude,glob)**/.ame-save-*.tmp', ':(exclude,glob)**/.ame-save-*.bak'])
}

export async function unstageAll(root: string): Promise<void> {
  const { git } = await repository(root)
  await git.raw(await hasHead(git) ? ['reset', 'HEAD', '--', '.'] : ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', '.'])
}

export async function discardFile(root: string, relative: string): Promise<void> {
  const { rootReal, git } = await repository(root)
  const { target, file, spec } = await filePath(rootReal, relative)
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (entry?.isDirectory()) throw new Error('INVALID_PATH')
  const indexed = await git.raw(['ls-files', '--cached', '-z', '--', spec])
  if (indexed) {
    // Restore the index version, including staged additions without a HEAD entry.
    await git.raw(['checkout', '--', spec])
  } else if (await hasHead(git) && (await git.raw(['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', file])).split('\0').includes(file)) {
    await git.raw(['checkout', 'HEAD', '--', spec])
  } else if (entry) {
    await unlink(target)
  }
}

export function validateBranchName(name: string): string {
  if (typeof name !== 'string' || !name || name === '@' || name === 'HEAD' || /^[-./]/.test(name) || /[./]$/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//') || /[\s\x00-\x1f\x7f~^:?*\[\\]/u.test(name) || name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new Error('INVALID_BRANCH_NAME')
  return name
}

export async function listBranches(root: string): Promise<GitBranches> {
  const { git } = await repository(root, true)
  const current = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() || '(detached)'
  const refs = await git.raw(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(upstream:short)', '--', 'refs/heads/'])
  const branches = refs.trimEnd().split('\n').filter(Boolean).map(line => {
    const [name, commit, upstream] = line.replace(/\r$/, '').split('\0')
    return { name, current: name === current, commit, ...(upstream ? { upstream } : {}) }
  })
  const remoteRefs = await git.raw(['for-each-ref', '--format=%(refname:short)%00%(objectname)', '--', 'refs/remotes/'])
  const remoteBranches = remoteRefs.trimEnd().split('\n').filter(Boolean).flatMap(line => {
    const [name, commit] = line.replace(/\r$/, '').split('\0')
    if (!name?.includes('/') || name.endsWith('/HEAD') || !/^[a-f0-9]{40,64}$/i.test(commit ?? '')) return []
    try { validateBranchName(name) } catch { return [] }
    return [{ name, current: false, commit, remote: true }]
  })
  return { current: current === '(detached)' && !await hasHead(git) ? '(unborn)' : current, branches, ...(remoteBranches.length ? { remoteBranches } : {}) }
}

async function hasRef(git: SimpleGit, ref: string): Promise<boolean> {
  return git.raw(['rev-parse', '--verify', '--quiet', ref]).then(output => !!output.trim(), () => false)
}

export async function checkoutBranch(root: string, name: string): Promise<void> {
  const branch = validateBranchName(name)
  const { git } = await repository(root)
  if (!await hasRef(git, `refs/heads/${branch}`) && branch.includes('/') && await hasRef(git, `refs/remotes/${branch}`)) {
    const local = validateBranchName(branch.slice(branch.indexOf('/') + 1))
    if (await hasRef(git, `refs/heads/${local}`)) {
      const upstream = (await git.raw(['for-each-ref', '--format=%(upstream)', `refs/heads/${local}`])).trim()
      if (upstream !== `refs/remotes/${branch}`) throw new Error('GIT_BRANCH_UPSTREAM_MISMATCH: Choose a different local branch name.')
    }
    await git.raw(await hasRef(git, `refs/heads/${local}`) ? ['checkout', local, '--'] : ['checkout', '-b', local, '--track', branch, '--'])
  } else {
    await git.raw(['checkout', branch, '--'])
  }
}

export async function createBranch(root: string, name: string, checkout = true): Promise<void> {
  const branch = validateBranchName(name)
  const { git } = await repository(root)
  await git.raw(checkout ? ['checkout', '-b', branch, '--'] : ['branch', '--', branch])
}

export async function deleteBranch(root: string, name: string, force = false): Promise<void> {
  const branch = validateBranchName(name)
  const { git } = await repository(root)
  const current = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
  if (branch === current) throw new Error('CANNOT_DELETE_CURRENT_BRANCH')
  await git.raw(['branch', force ? '-D' : '-d', '--', branch])
}

export async function gitFetch(root: string): Promise<GitSyncResult> {
  const git = await remoteRepository(root)
  if (!await hasRemote(git)) throw new Error('NO_REMOTE_CONFIGURED')
  try {
    await git.raw(['fetch', '--all', '--prune'])
    return { summary: 'Đã fetch từ remote.', remote: await firstRemote(git) }
  } catch (error) { throw mapGitNetworkError(error) }
}

export async function gitPull(root: string): Promise<GitSyncResult> {
  const git = await remoteRepository(root)
  if (!await hasRemote(git)) throw new Error('NO_REMOTE_CONFIGURED')
  try {
    const res = await git.pull(['--no-rebase'])
    const status = await git.status()
    // simple-git can resolve pull even when Git stops the merge on conflicts.
    if (status.conflicted.length) throw new Error(`GIT_CONFLICT: ${status.conflicted.join(', ')}`)
    return { summary: 'Đã pull từ remote.', filesChanged: res.summary.changes, branch: status.current ?? '(detached)', remote: await firstRemote(git) }
  } catch (error) {
    const conflicts = await git.status().then(status => status.conflicted, () => [])
    if (conflicts.length) throw new Error(`GIT_CONFLICT: ${conflicts.join(', ')}`)
    throw mapGitNetworkError(error)
  }
}

export async function gitPush(root: string, options?: GitPushOptions): Promise<GitSyncResult> {
  const git = await remoteRepository(root)
  if (!await hasRemote(git)) throw new Error('NO_REMOTE_CONFIGURED')
  const branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
  if (!branch) throw new Error('DETACHED_HEAD_PUSH_UNSUPPORTED')
  try {
    const upstream = (await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim()
    const remote = !upstream || options?.setUpstream
      ? await firstRemote(git)
      : (await git.raw(['config', '--get', `branch.${branch}.remote`])).trim()
    if (!upstream || options?.setUpstream) await git.raw(['push', '-u', remote, branch])
    else await git.push()
    return { summary: 'Đã push lên remote.', branch, remote }
  } catch (error) { throw mapGitNetworkError(error) }
}

const commitFormat = '%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1f%D'
function parseCommit(record: string): GitCommitSummary {
  const [hash, shortHash, subject, body, author, date, refs = ''] = record.trimStart().split('\x1f')
  return { hash, shortHash, subject, body, author, date, refs: refs.trim().split(',').map(ref => ref.trim()).filter(Boolean) }
}

export async function gitLog(root: string, limit = 40): Promise<GitCommitSummary[]> {
  const { git } = await repository(root, true)
  if (!await hasHead(git)) return []
  const capped = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 40
  const output = await git.raw(['log', `-${capped}`, '--date=iso-strict', `--format=${commitFormat}%x1e`])
  return output.split('\x1e').filter(record => record.trim()).map(parseCommit)
}

async function commitFirstParentDiff(git: SimpleGit, hash: string) {
  const parents = (await git.raw(['rev-list', '--parents', '-n', '1', hash])).trim().split(/\s+/)
  const isMerge = parents.length > 2
  const treeArgs = ['diff-tree', '--root', '-m', '--first-parent', '--no-commit-id', '-r', '--no-renames']
  // diff-tree can still expand every merge parent with -m on older Git versions.
  // Explicit endpoints guarantee the same comparison as the file viewer (hash^..hash).
  const revisions = isMerge ? [parents[1], hash] : [hash]
  const patchArgs = ['show', '-m', '--first-parent', '--format=', '--patch', '--no-renames', '--no-ext-diff', '--no-textconv', hash]
  return { isMerge, treeArgs, revisions, patchArgs }
}

export async function gitCommitDetail(root: string, hash: string): Promise<GitCommitDetail> {
  if (!isValidGitCommitHash(hash)) throw new Error('INVALID_COMMIT_HASH')
  const { git } = await repository(root, true)
  hash = await resolveCommitHash(git, hash)
  const summary = parseCommit(await git.raw(['show', '--quiet', '--date=iso-strict', `--format=${commitFormat}`, hash]))
  const { isMerge, treeArgs, revisions, patchArgs } = await commitFirstParentDiff(git, hash)
  const args = [...treeArgs, '-z']
  const stats = (await git.raw([...args, '--numstat', ...revisions])).split('\0').filter(Boolean)
  const names = (await git.raw([...args, '--name-status', ...revisions])).split('\0')
  const statuses = new Map<string, GitCommitFile['status']>()
  for (let i = 0; i + 1 < names.length; i += 2) statuses.set(names[i + 1], names[i] as GitCommitFile['status'])
  const files = stats.map(line => {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(line)!
    return { path: match[3], status: statuses.get(match[3]) ?? 'M', additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 }
  })
  const bytes = Buffer.from(await git.raw([...patchArgs, '--']))
  const suffix = '\n... (truncated)'
  let end = bytes.length > 262144 ? 262144 - Buffer.byteLength(suffix) : bytes.length
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return { ...summary, files, patch: bytes.subarray(0, end).toString('utf8') + (bytes.length > 262144 ? suffix : ''), ...(isMerge ? { isMerge: true } : {}) }
}

export type BuildNotesSummary = {
  branch: string
  commits: GitCommitSummary[]
  files: BuildNotesFileStat[]
  workingFileCount: number
  additions: number
  deletions: number
  diff: string
  truncated: boolean
}

const buildNotesNoise = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Podfile\.lock|gradle\.lockfile)$|\.(?:min\.js|min\.css|map|png|jpe?g|webp|gif|ico|pdf|zip|apk|aab|jar|bin)$/i

function utf8Prefix(text: string, limit: number): string {
  const bytes = Buffer.from(text)
  let end = Math.min(bytes.length, limit)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

export async function buildNotesSummary(root: string, request: BuildNotesRequest, maxDiffBytes = 56_000): Promise<BuildNotesSummary> {
  const invalid = () => new Error('INVALID_BUILD_BASE_COMMIT')
  const validHash = isValidGitCommitHash
  if ((request.baseCommit !== undefined && !validHash(request.baseCommit)) || (request.commitHashes?.length ?? 0) > 50 || request.commitHashes?.some(hash => !validHash(hash))) throw invalid()
  if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes < 0) throw new Error('INVALID_MAX_BYTES')
  const { rootReal, git } = await repository(root, true)
  const headExists = await hasHead(git)
  const branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() || (headExists ? '(detached)' : '(unborn)')
  const commits: GitCommitSummary[] = []
  const files = new Map<string, BuildNotesFileStat>()
  const workingFiles = new Set<string>()
  const patches: { path: string; source: 'committed' | 'working'; load: () => Promise<string> }[] = []
  let truncated = false
  const merge = (file: BuildNotesFileStat) => {
    if (file.source === 'working') workingFiles.add(file.path)
    const previous = files.get(file.path)
    files.set(file.path, previous ? { ...file, additions: previous.additions + file.additions, deletions: previous.deletions + file.deletions, source: previous.source === file.source ? file.source : 'both' } : file)
  }
  const collect = async (args: string[], revisions: string[], patchArgs: string[], source: 'committed' | 'working') => {
    const stats = await git.raw([...args, '--numstat', '-z', ...revisions, '--'])
    const names = (await git.raw([...args, '--name-status', '-z', ...revisions, '--'])).split('\0')
    const statuses = new Map<string, BuildNotesFileStat['status']>()
    for (let i = 0; i + 1 < names.length; i += 2) statuses.set(names[i + 1], names[i] as BuildNotesFileStat['status'])
    for (const line of stats.split('\0').filter(Boolean)) {
      const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(line)
      if (!match) continue
      const name = match[3]
      merge({ path: name, status: statuses.get(name) ?? 'M', additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0, source })
      patches.push({ path: name, source, load: () => git.raw([...patchArgs, '--', `:(literal)${name}`]) })
    }
  }
  const ancestor = async (hash: string) => {
    try {
      const resolved = await resolveCommitHash(git, hash)
      if (!resolved) throw invalid()
      await git.raw(['merge-base', '--is-ancestor', resolved, 'HEAD'])
      // Quiet nonzero exits can resolve successfully in simple-git; verify the common ancestor too.
      if ((await git.raw(['merge-base', resolved, 'HEAD'])).trim() !== resolved) throw invalid()
      return resolved
    } catch { throw invalid() }
  }
  const diffArgs = ['diff', '--no-renames']
  const patchFlags = ['--no-renames', '--no-ext-diff', '--no-textconv']
  if (!headExists) {
    if ((request.mode === 'range' && request.baseCommit) || (request.mode === 'commits' && request.commitHashes?.length)) throw invalid()
  } else if (request.mode === 'range' && request.baseCommit) {
    const base = await ancestor(request.baseCommit)
    const log = await git.raw(['log', '-n', '100', '--date=iso-strict', `--format=${commitFormat}%x1e`, `${base}..HEAD`, '--'])
    commits.push(...log.split('\x1e').filter(record => record.trim()).map(parseCommit))
    await collect(diffArgs, [base, 'HEAD'], ['diff', ...patchFlags, base, 'HEAD'], 'committed')
  } else if (request.mode === 'commits') {
    const selected = new Set<string>()
    for (const hash of new Set(request.commitHashes ?? [])) selected.add(await ancestor(hash))
    if (selected.size) {
      for (const hash of await selectedCommitOrder(git, selected)) {
        commits.push(parseCommit(await git.raw(['show', '--quiet', '--date=iso-strict', `--format=${commitFormat}`, hash])))
        const { treeArgs, revisions, patchArgs } = await commitFirstParentDiff(git, hash)
        await collect(treeArgs, revisions, patchArgs, 'committed')
      }
    }
  }
  if (request.includeWorking) {
    const base = headExists ? 'HEAD' : (await runGit(rootReal, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.toString('utf8').trim()
    await collect(diffArgs, [base], ['diff', ...patchFlags, base], 'working')
    const untracked = await git.raw(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'])
    for (const name of untracked.split('\0').filter(Boolean)) {
      const { target } = await filePath(rootReal, name)
      inside(rootReal, await realpath(target))
      const entry = await stat(target)
      if (!entry.isFile()) continue
      let additions = 0, patch = ''
      if (entry.size <= 262_144) {
        const bytes = await readFile(target)
        if (!bytes.subarray(0, 8192).includes(0)) {
          const text = bytes.toString('utf8')
          const lines = text ? text.replace(/\n$/, '').split('\n') : []
          additions = lines.length
          if (text) patch = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`
        }
      } else if (!buildNotesNoise.test(name)) {
        truncated = true
      }
      merge({ path: name, status: 'U', additions, deletions: 0, source: 'working' })
      patches.push({ path: name, source: 'working', load: async () => patch })
    }
  }
  let diff = '', used = 0
  const perFileBytes = new Map<string, number>()
  const noiseSeen = new Set<string>()
  for (const patch of [...patches.filter(patch => patch.source === 'working'), ...patches.filter(patch => patch.source === 'committed')]) {
    const noisy = buildNotesNoise.test(patch.path)
    if (noisy && noiseSeen.has(patch.path)) continue
    if (noisy) noiseSeen.add(patch.path)
    const available = Math.min(4096 - (perFileBytes.get(patch.path) ?? 0), maxDiffBytes - used)
    if (available <= 0) { truncated = true; continue }
    const text = noisy ? `\n${patch.source} ${patch.path}\n[bỏ qua chi tiết diff lockfile/tài nguyên]\n` : `\n${patch.source} ${patch.path}\n${await patch.load()}`
    const part = utf8Prefix(text, available)
    const size = Buffer.byteLength(part)
    if (size < Buffer.byteLength(text)) truncated = true
    diff += part
    used += size
    perFileBytes.set(patch.path, (perFileBytes.get(patch.path) ?? 0) + size)
  }
  const resultFiles = [...files.values()]
  return { branch, commits, files: resultFiles, workingFileCount: workingFiles.size, additions: resultFiles.reduce((sum, file) => sum + file.additions, 0), deletions: resultFiles.reduce((sum, file) => sum + file.deletions, 0), diff, truncated }
}

export async function gitFileCommitPatch(root: string, relative: string, commitHashes: readonly string[], includeWorking = false, maxCommits = 50): Promise<string> {
  const { rootReal, git } = await repository(root, true)
  const { target, file, spec } = await filePath(rootReal, relative)
  if (!Array.isArray(commitHashes) || commitHashes.length < 1 || commitHashes.length > maxCommits || commitHashes.some(hash => !isValidGitCommitHash(hash))) throw new Error('INVALID_COMMIT_HASH')
  const selected = new Set<string>()
  for (const hash of commitHashes) {
    try {
      const resolved = await resolveCommitHash(git, hash)
      await runGit(rootReal, ['merge-base', '--is-ancestor', resolved, 'HEAD'])
      selected.add(resolved)
    } catch { throw new Error('INVALID_COMMIT_HASH') }
  }
  const maxBytes = 4 * 1024 * 1024
  let result = '', used = 0, truncated = false
  const append = (text: string) => {
    const part = utf8Prefix(text, maxBytes - used)
    if (Buffer.byteLength(part) < Buffer.byteLength(text)) truncated = true
    result += part; used += Buffer.byteLength(part)
  }
  for (const hash of await selectedCommitOrder(git, selected)) {
    if (used >= maxBytes) break
    const summary = parseCommit(await git.raw(['show', '--quiet', `--format=${commitFormat}`, hash]))
    const { patchArgs } = await commitFirstParentDiff(git, hash)
    append(`# commit ${summary.shortHash} ${summary.subject}\n`)
    const patch = await runGitBounded(rootReal, [...patchArgs, '--', spec], maxBytes - used)
    append(patch.text)
    if (patch.truncated) return utf8Prefix(result, maxBytes - Buffer.byteLength('\n[Diff truncated at 4 MiB]\n')) + '\n[Diff truncated at 4 MiB]\n'
  }
  if (includeWorking && used < maxBytes) {
    const base = await hasHead(git) ? 'HEAD' : (await runGit(rootReal, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.toString('utf8').trim()
    const patch = await runGitBounded(rootReal, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--', spec], maxBytes - used)
    truncated ||= patch.truncated
    append(patch.text)
    if (!patch.truncated && (await git.raw(['ls-files', '--others', '--exclude-standard', '-z', '--', spec])).split('\0').includes(file)) {
      const info = await lstat(target)
      if (info.isFile() || info.isSymbolicLink()) {
        const chunks: Buffer[] = []
        let size = 0
        if (info.isSymbolicLink()) chunks.push(await readlink(target, { encoding: 'buffer' }))
        else for await (const chunk of createReadStream(target)) {
          const part = Buffer.from(chunk.subarray(0, maxBytes - used + 1 - size))
          chunks.push(part); size += part.length
          if (size > maxBytes - used) break
        }
        const bytes = Buffer.concat(chunks)
        truncated ||= bytes.length > maxBytes - used
        if (!bytes.subarray(0, 8192).includes(0)) {
          let end = Math.min(bytes.length, maxBytes - used)
          while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
          const text = bytes.subarray(0, end).toString('utf8')
          const lines = text ? text.replace(/\n$/, '').split('\n') : []
          append(`diff --git a/${file} b/${file}\nnew file mode ${info.isSymbolicLink() ? '120000' : '100644'}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`)
        }
      }
    }
  }
  return truncated || used >= maxBytes ? utf8Prefix(result, maxBytes - Buffer.byteLength('\n[Diff truncated at 4 MiB]\n')) + '\n[Diff truncated at 4 MiB]\n' : result
}

export async function isHeadPushed(root: string): Promise<boolean> {
  const { git } = await repository(root, true)
  return await hasHead(git) && !!(await git.raw(['branch', '-r', '--contains', 'HEAD'])).trim()
}

export async function gitUndoLastCommit(root: string): Promise<{ message: string }> {
  const { git } = await repository(root)
  if (!await hasHead(git)) throw new Error('NO_COMMIT_TO_UNDO')
  const message = (await git.raw(['log', '-1', '--format=%B'])).trimEnd()
  const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
  const object = await git.raw(['cat-file', 'commit', head])
  const parent = /^parent ([a-f0-9]+)$/m.exec(object.split('\n\n', 1)[0])?.[1]
  if (parent) {
    if (!await hasRef(git, `${parent}^{commit}`)) throw new Error('GIT_SHALLOW_HISTORY: Fetch more history before undoing this commit.')
    await git.raw(['reset', '--soft', parent])
  } else {
    // Deleting a detached HEAD removes .git/HEAD itself and invalidates the repository.
    const branchRef = (await git.raw(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim()
    if (!branchRef.startsWith('refs/heads/')) throw new Error('GIT_DETACHED_ROOT_UNDO_UNSUPPORTED')
    await git.raw(['update-ref', '-d', branchRef, head])
  }
  return { message }
}

export async function gitStashList(root: string): Promise<GitStashEntry[]> {
  const { git } = await repository(root, true)
  // Keep %gd as stash@{index}; --date would otherwise turn the selector into a date.
  const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%aI%x1f%H%x1e'])
  return output.split('\x1e').filter(record => record.trim()).flatMap(record => {
    const [ref, subject, date, oid] = record.trim().split('\x1f')
    const index = /^stash@\{(\d+)\}$/.exec(ref)
    if (!index) return []
    const match = /^(?:On |WIP on )([^:]+):\s*([\s\S]*)$/.exec(subject)
    return [{ index: Number(index[1]), ref, branch: match?.[1] ?? '', message: match?.[2] ?? subject, date, oid }]
  })
}

export async function gitStashPush(root: string, message?: string, includeUntracked = true): Promise<void> {
  if (message?.includes('\0')) throw new Error('INVALID_STASH_MESSAGE')
  const { git } = await repository(root)
  if (!(await git.raw(['status', '--porcelain', '-u'])).trim()) return
  await git.raw(['stash', 'push', ...(includeUntracked ? ['-u'] : []), ...(message?.trim() ? ['-m', message.trim().slice(0, 500)] : []), '--'])
}

function stashRef(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 10000) throw new Error('INVALID_STASH_INDEX')
  return `stash@{${index}}`
}

export async function gitStashApply(root: string, index: number, pop = false, expectedOid?: string): Promise<void> {
  const ref = stashRef(index)
  const { git } = await repository(root)
  if (expectedOid && (await git.raw(['rev-parse', '--verify', ref])).trim() !== expectedOid) throw new Error('GIT_STASH_STALE: Reload the stash list.')
  await git.raw(['stash', pop ? 'pop' : 'apply', ref])
}

export async function gitStashDrop(root: string, index: number, expectedOid?: string): Promise<void> {
  const ref = stashRef(index)
  const { git } = await repository(root)
  if (expectedOid && (await git.raw(['rev-parse', '--verify', ref])).trim() !== expectedOid) throw new Error('GIT_STASH_STALE: Reload the stash list.')
  await git.raw(['stash', 'drop', ref])
}

export async function stagedDiffSummary(root: string, maxBytes = 65536): Promise<{ diff: string; files: string[]; truncated: boolean; stat?: string }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('INVALID_MAX_BYTES')
  const { rootReal, git } = await repository(root, true)
  const files = (await git.raw(['diff', '--cached', '--name-only', '-z', '--'])).split('\0').filter(Boolean)
  const { text: diff, truncated } = await runGitBounded(rootReal, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--'], maxBytes)
  if (truncated) {
    const stat = (await git.raw(['diff', '--cached', '--stat'])).trimEnd()
    return { diff, files, truncated, stat }
  }
  return { diff, files, truncated }
}
