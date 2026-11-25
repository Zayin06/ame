import { existsSync } from 'node:fs'
import { lstat, readFile, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import type { BuildNotesFileStat, BuildNotesRequest, GitBranches, GitCommitDetail, GitCommitFile, GitCommitSummary, GitPushOptions, GitStashEntry, GitSyncResult } from '../../protocol/src/index'

async function repository(root: string) {
  const rootReal = await realpath(root)
  if (!existsSync(path.join(rootReal, '.git'))) throw new Error('GIT_ROOT_REQUIRED')
  const git = simpleGit(rootReal, { maxConcurrentProcesses: 1, trimmed: false, timeout: { block: 10000 } }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  return { rootReal, git }
}

async function remoteRepository(root: string) {
  const { rootReal } = await repository(root)
  return simpleGit(rootReal, { maxConcurrentProcesses: 1, trimmed: false, timeout: { block: 60000 } }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
}

export async function hasRemote(rootOrGit: string | SimpleGit): Promise<boolean> {
  const git = typeof rootOrGit === 'string' ? (await repository(rootOrGit)).git : rootOrGit
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
    [/authentication failed|could not read username|permission denied|publickey|repository not found/i, 'GIT_AUTH_FAILED'],
    [/could not resolve host|connection refused|timed out|failed to connect|network is unreachable/i, 'GIT_OFFLINE'],
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
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes(':') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error('INVALID_PATH')
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling link cannot be proven to stay within the repository.
      const entry = await lstat(prefix).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; return undefined })
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
  const { git } = await repository(root)
  await git.raw(['add', '-A', '--', '.'])
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
  const { git } = await repository(root)
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
  const { git } = await repository(root)
  if (!await hasHead(git)) return []
  const capped = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 40
  const output = await git.raw(['log', `-${capped}`, '--date=iso-strict', `--format=${commitFormat}%x1e`])
  return output.split('\x1e').filter(record => record.trim()).map(parseCommit)
}

export async function gitCommitDetail(root: string, hash: string): Promise<GitCommitDetail> {
  if (!/^[a-f0-9]{7,40}$/i.test(hash)) throw new Error('INVALID_COMMIT_HASH')
  const { git } = await repository(root)
  const summary = parseCommit(await git.raw(['show', '--quiet', '--date=iso-strict', `--format=${commitFormat}`, hash]))
  const args = ['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '-z']
  const stats = (await git.raw([...args, '--numstat', hash])).split('\0').filter(Boolean)
  const names = (await git.raw([...args, '--name-status', hash])).split('\0')
  const statuses = new Map<string, GitCommitFile['status']>()
  for (let i = 0; i + 1 < names.length; i += 2) statuses.set(names[i + 1], names[i] as GitCommitFile['status'])
  const files = stats.map(line => {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(line)!
    return { path: match[3], status: statuses.get(match[3]) ?? 'M', additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 }
  })
  const bytes = Buffer.from(await git.raw(['show', '--format=', '--patch', '--no-renames', '--no-ext-diff', '--no-textconv', hash, '--']))
  const suffix = '\n... (truncated)'
  let end = bytes.length > 262144 ? 262144 - Buffer.byteLength(suffix) : bytes.length
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return { ...summary, files, patch: bytes.subarray(0, end).toString('utf8') + (bytes.length > 262144 ? suffix : '') }
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
  const validHash = (hash: string) => typeof hash === 'string' && /^[a-f0-9]{7,40}$/i.test(hash)
  if ((request.baseCommit !== undefined && !validHash(request.baseCommit)) || (request.commitHashes?.length ?? 0) > 50 || request.commitHashes?.some(hash => !validHash(hash))) throw invalid()
  if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes < 0) throw new Error('INVALID_MAX_BYTES')
  const { rootReal, git } = await repository(root)
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
      const resolved = (await git.raw(['rev-parse', '--verify', `${hash}^{commit}`])).trim()
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
      const order = (await git.raw(['rev-list', '--topo-order', 'HEAD', '--'])).trim().split(/\r?\n/)
      for (const hash of order.filter(hash => selected.has(hash))) {
        commits.push(parseCommit(await git.raw(['show', '--quiet', '--date=iso-strict', `--format=${commitFormat}`, hash])))
        await collect(['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames'], [hash], ['show', '--format=', '--patch', ...patchFlags, hash], 'committed')
      }
    }
  }
  if (request.includeWorking) {
    await collect(headExists ? diffArgs : [...diffArgs, '--cached'], headExists ? ['HEAD'] : [], ['diff', ...patchFlags, ...(headExists ? ['HEAD'] : ['--cached'])], 'working')
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

export async function gitUndoLastCommit(root: string): Promise<{ message: string }> {
  const { git } = await repository(root)
  if (!await hasHead(git)) throw new Error('NO_COMMIT_TO_UNDO')
  const message = (await git.raw(['log', '-1', '--format=%B'])).trimEnd()
  if (await hasRef(git, 'HEAD~1')) await git.raw(['reset', '--soft', 'HEAD~1'])
  else await git.raw(['update-ref', '-d', 'HEAD'])
  return { message }
}

export async function gitStashList(root: string): Promise<GitStashEntry[]> {
  const { git } = await repository(root)
  // Keep %gd as stash@{index}; --date would otherwise turn the selector into a date.
  const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%aI%x1e'])
  return output.split('\x1e').filter(record => record.trim()).flatMap(record => {
    const [ref, subject, date] = record.trim().split('\x1f')
    const index = /^stash@\{(\d+)\}$/.exec(ref)
    if (!index) return []
    const match = /^(?:On |WIP on )([^:]+):\s*([\s\S]*)$/.exec(subject)
    return [{ index: Number(index[1]), ref, branch: match?.[1] ?? '', message: match?.[2] ?? subject, date }]
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

export async function gitStashApply(root: string, index: number, pop = false): Promise<void> {
  const ref = stashRef(index)
  const { git } = await repository(root)
  await git.raw(['stash', pop ? 'pop' : 'apply', ref])
}

export async function gitStashDrop(root: string, index: number): Promise<void> {
  const ref = stashRef(index)
  const { git } = await repository(root)
  await git.raw(['stash', 'drop', ref])
}

export async function stagedDiffSummary(root: string, maxBytes = 65536): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('INVALID_MAX_BYTES')
  const { git } = await repository(root)
  const files = (await git.raw(['diff', '--cached', '--name-only', '-z', '--'])).split('\0').filter(Boolean)
  const bytes = Buffer.from(await git.raw(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--']))
  let end = Math.min(maxBytes, bytes.length)
  // Do not split a UTF-8 code point or introduce replacement characters.
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return { diff: bytes.subarray(0, end).toString('utf8'), files, truncated: bytes.length > maxBytes }
}
