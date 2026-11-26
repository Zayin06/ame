import { createReadStream, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { isValidGitCommitHash } from '../../protocol/src/index'
import type { BuildNotesFileStat, BuildNotesRequest, CommitAgentSnapshot, CommitAgentPlan, CommitAgentExecuteResult, GitBranches, GitCommitDetail, GitCommitFile, GitCommitSummary, GitPushOptions, GitStashEntry, GitSyncResult } from '../../protocol/src/index'

type GitRunOptions = { env?: NodeJS.ProcessEnv; input?: Buffer | string; timeoutMs?: number }

// Stream consumers share exit/timeout handling, including quiet hook failures.
function streamGit(cwd: string, args: string[], options: GitRunOptions, consume: (chunk: Buffer) => boolean | void) {
  return new Promise<{ stderr: string }>((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }, windowsHide: true })
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
    child.stdin.end(options.input)
  })
}

async function runGit(cwd: string, args: string[], options: GitRunOptions = {}) {
  const chunks: Buffer[] = []
  const { stderr } = await streamGit(cwd, args, options, chunk => { chunks.push(chunk) })
  return { stdout: Buffer.concat(chunks), stderr }
}

async function runGitBounded(cwd: string, args: string[], maxBytes: number, env?: NodeJS.ProcessEnv) {
  const chunks: Buffer[] = []
  let size = 0, truncated = false
  await streamGit(cwd, args, { env }, chunk => {
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

async function hashGitStdout(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const hash = createHash('sha256')
  await streamGit(cwd, args, { env }, chunk => { hash.update(chunk) })
  return hash.digest('hex')
}

async function hashFileContent(fullPath: string) {
  const hash = createHash('sha256'), info = await lstat(fullPath)
  if (info.isSymbolicLink()) hash.update(await readlink(fullPath, { encoding: 'buffer' }))
  else {
    if (!info.isFile()) throw new Error('INVALID_PATH')
    for await (const chunk of createReadStream(fullPath)) hash.update(chunk)
  }
  return hash.digest('hex')
}

async function assertNoActiveGitOperation(rootReal: string, git: SimpleGit) {
  const gitDir = path.resolve(rootReal, (await git.raw(['rev-parse', '--git-dir'])).trim())
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'].some(name => existsSync(path.join(gitDir, name)))) throw new Error('COMMIT_PLAN_REPO_BUSY')
  if ((await runGit(rootReal, ['ls-files', '--unmerged', '-z'])).stdout.length) throw new Error('COMMIT_PLAN_REPO_CONFLICT')
}

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
  const { git } = await repository(root)
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
  const { git } = await repository(root)
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

function stagedPaths(output: string) {
  const tokens = output.split('\0'), files = new Set<string>(), renamedFrom = new Map<string, string>()
  for (let i = 0; i + 1 < tokens.length && tokens[i];) {
    const status = tokens[i++], first = tokens[i++]
    files.add(first)
    if (/^[RC]/.test(status)) {
      const destination = tokens[i++]
      files.add(destination)
      if (status.startsWith('R')) renamedFrom.set(destination, first)
    }
  }
  return { files: [...files], renamedFrom }
}

export async function gitCommitPlanSnapshot(root: string, maxDiffBytes = 48_000, options?: { focusFiles?: readonly string[]; includeDiff?: boolean }): Promise<CommitAgentSnapshot & { stat: string; diffPreview: string; truncated: boolean }> {
  if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes < 0) throw new Error('INVALID_MAX_BYTES')
  const { rootReal, git } = await repository(root)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || '(unborn)'
  const branchRef = (await git.raw(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || '(detached)'
  const branch = branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : branchRef
  const indexHash = await hashGitStdout(rootReal, ['ls-files', '--stage', '-z'])
  const workingStatus = await git.raw(['status', '--porcelain=v1', '-z'])
  const workingDiffHash = await hashGitStdout(rootReal, ['diff', '--no-ext-diff', '--no-textconv', '--'])
  const stagedFiles = stagedPaths(await git.raw(['diff', '--cached', '--name-status', '-z', '--'])).files
  const scope = stagedFiles.length > 0 ? 'staged' : 'working'
  const untrackedRaw = (await runGit(rootReal, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean).sort()
  const untracked: string[] = []
  const untrackedHashes: Record<string, string> | undefined = scope === 'working' ? Object.create(null) : undefined
  for (const rawEntry of untrackedRaw) {
    const { target } = await filePath(rootReal, rawEntry)
    const info = await lstat(target)
    if (info.isDirectory()) continue
    untracked.push(rawEntry)
    if (untrackedHashes) untrackedHashes[rawEntry] = await hashFileContent(target)
  }
  const workingHash = hash((untrackedHashes ? [workingStatus, workingDiffHash, JSON.stringify(Object.entries(untrackedHashes))] : [workingStatus, workingDiffHash]).join('\0'))
  const workingFiles = [...new Set([
    ...(await git.raw(['diff', '--no-renames', '--name-only', '-z', '--'])).split('\0'),
    ...untracked,
  ].filter(Boolean))]
  const flags = scope === 'staged' ? ['--cached'] : []
  let stat = '', diffPreview = '', truncated = false
  if (options?.includeDiff !== false) {
    stat = (await git.raw(['diff', ...flags, '--stat', '--'])).trimEnd()
    const allowed = new Set(scope === 'staged' ? stagedFiles : workingFiles)
    const focus: string[] = []
    for (const name of options?.focusFiles ?? []) {
      const { file } = await filePath(rootReal, name)
      if (!allowed.has(file)) throw new Error('COMMIT_PLAN_OUT_OF_SCOPE')
      if (!focus.includes(file)) focus.push(file)
    }
    const args = ['diff', ...flags, '--no-ext-diff', '--no-textconv']
    const first = await runGitBounded(rootReal, [...args, '--', ...focus.map(file => `:(literal)${file}`)], maxDiffBytes)
    diffPreview = first.text; truncated = first.truncated
    if (focus.length && !truncated) {
      const rest = await runGitBounded(rootReal, [...args, '--', '.', ...focus.map(file => `:(exclude,literal)${file}`)], maxDiffBytes - Buffer.byteLength(diffPreview))
      diffPreview += rest.text; truncated = rest.truncated
    }
  }
  return { head, branchRef, branch, indexHash, workingHash, untrackedHashes, scope, fingerprint: hash([head, branchRef, indexHash, workingHash, scope].join('\0')), stagedFiles, workingFiles, stat, diffPreview, truncated }
}

export async function executeCommitPlan(root: string, plan: CommitAgentPlan): Promise<CommitAgentExecuteResult> {
  const { rootReal, git } = await repository(root)
  await assertNoActiveGitOperation(rootReal, git)
  const current = await gitCommitPlanSnapshot(root, 0, { includeDiff: false })
  if (current.head !== plan.snapshot.head || current.indexHash !== plan.snapshot.indexHash ||
      (plan.snapshot.branchRef !== undefined && current.branchRef !== plan.snapshot.branchRef) ||
      ((plan.scope === 'working' || plan.snapshot.workingHash !== undefined) && current.workingHash !== plan.snapshot.workingHash)) throw new Error('COMMIT_PLAN_STALE')
  for (const [file, hash] of Object.entries(plan.snapshot.untrackedHashes ?? {})) if (current.untrackedHashes?.[file] !== hash) throw new Error('COMMIT_PLAN_STALE')
  if (!['staged', 'working'].includes(plan.scope) || !Array.isArray(plan.commits) || plan.commits.length < 1 || plan.commits.length > 30) throw new Error('INVALID_COMMIT_PLAN')
  // Never let a working-tree plan accidentally commit an unrelated existing index.
  if (plan.scope === 'working' && current.stagedFiles.length) throw new Error('COMMIT_PLAN_OUT_OF_SCOPE')
  const allowed = new Set(plan.scope === 'staged' ? current.stagedFiles : current.workingFiles)
  const { renamedFrom } = stagedPaths(await git.raw(['diff', '--cached', '--name-status', '-z', '--']))
  const used = new Set<string>()
  const groups: { message: string; files: string[] }[] = []
  for (const group of plan.commits) {
    if (typeof group.message !== 'string' || !group.message.trim() || group.message.includes('\0') || group.message.length > 10000 || !Array.isArray(group.files) || !group.files.length) throw new Error('INVALID_COMMIT_PLAN')
    const files = new Set<string>()
    for (const name of group.files) {
      const { file } = await filePath(rootReal, name)
      if (!allowed.has(file)) throw new Error('COMMIT_PLAN_OUT_OF_SCOPE')
      files.add(file)
    }
    // A rename is one indivisible change; include its source even if the agent only named the destination.
    for (const [destination, source] of renamedFrom) {
      if (files.has(destination) || files.has(source)) { files.add(source); files.add(destination) }
    }
    for (const file of files) {
      await filePath(rootReal, file)
      if (!allowed.has(file)) throw new Error('COMMIT_PLAN_OUT_OF_SCOPE')
      if (used.has(file)) throw new Error('INVALID_COMMIT_PLAN')
      used.add(file)
    }
    groups.push({ message: group.message.trim(), files: [...files] })
  }
  const raw = async (args: string[], env?: NodeJS.ProcessEnv) => (await runGit(rootReal, args, { env })).stdout.toString('utf8')
  const objectFormat = (await raw(['rev-parse', '--show-object-format'])).trim() || 'sha1'
  const zeroOid = '0'.repeat(objectFormat === 'sha256' ? 64 : 40)
  const realGitDir = path.resolve(rootReal, (await raw(['rev-parse', '--git-dir'])).trim())
  const realCommonDir = path.resolve(rootReal, (await raw(['rev-parse', '--git-common-dir'])).trim())
  const hooksPath = (await raw(['config', '--get', 'core.hooksPath']).catch(() => '')).trim()
  const realHooksDir = hooksPath ? path.resolve(rootReal, hooksPath) : path.join(realCommonDir, 'hooks')
  const indexRaw = () => raw(['ls-files', '--stage', '-z'])
  const initialIndexRaw = await indexRaw()
  if (createHash('sha256').update(initialIndexRaw).digest('hex') !== current.indexHash) throw new Error('COMMIT_PLAN_STALE')
  const approvedIndexMap = new Map<string, { mode: string; oid: string }>()
  for (const record of initialIndexRaw.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(record)
    if (!match) throw new Error('COMMIT_PLAN_REPO_CONFLICT')
    approvedIndexMap.set(match[3], { mode: match[1], oid: match[2] })
  }
  const diskHash = async (file: string) => {
    try {
      const { target } = await filePath(rootReal, file)
      if ((await lstat(target)).isDirectory() && approvedIndexMap.get(file)?.mode === '160000') {
        return (await runGit(target, ['rev-parse', '--verify', 'HEAD'])).stdout.toString('utf8').trim()
      }
      if ((await lstat(target)).isDirectory() && approvedIndexMap.has(file)) return '(deleted)'
      return await hashFileContent(target)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return '(deleted)'
      throw error
    }
  }
  const deletionFirst = (lines: string[]) => lines.sort((a, b) => Number(b.startsWith('0 ')) - Number(a.startsWith('0 '))).join('')
  const approvedDisk = new Map<string, string>()
  if (plan.scope === 'working') {
    for (const file of used) {
      const hash = await diskHash(file)
      approvedDisk.set(file, hash)
      if (current.untrackedHashes?.[file] !== undefined && current.untrackedHashes[file] !== hash) throw new Error('COMMIT_PLAN_STALE')
    }
    const workingStatus = await git.raw(['status', '--porcelain=v1', '-z'])
    const workingDiffHash = await hashGitStdout(rootReal, ['diff', '--no-ext-diff', '--no-textconv', '--'])
    if (createHash('sha256').update([workingStatus, workingDiffHash, JSON.stringify(Object.entries(current.untrackedHashes ?? {}))].join('\0')).digest('hex') !== current.workingHash) throw new Error('COMMIT_PLAN_STALE')
  }
  let expectedHead = current.head, expectedRealIndexRaw = initialIndexRaw
  const expectedBranchRef = current.branchRef
  const commits: CommitAgentExecuteResult['commits'] = []
  const assertExpected = async (remainingFiles: string[]) => {
    await assertNoActiveGitOperation(rootReal, git)
    const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || '(unborn)'
    const branch = (await git.raw(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || '(detached)'
    if (head !== expectedHead || branch !== expectedBranchRef || await indexRaw() !== expectedRealIndexRaw) throw new Error('COMMIT_PLAN_ABORTED: HEAD, branch or real index changed')
    for (const file of remainingFiles) if (approvedDisk.has(file) && await diskHash(file) !== approvedDisk.get(file)) throw new Error('COMMIT_PLAN_STALE: working content changed')
  }
  for (const [idx, group] of groups.entries()) {
    let temporary: string | undefined
    let realIndexLock: string | undefined
    let nextIndex: string | undefined
    try {
      const remainingFiles = groups.slice(idx).flatMap(group => group.files)
      await assertExpected(remainingFiles)
      temporary = await mkdtemp(path.join(os.tmpdir(), 'ame-commit-plan-'))
      const tmpEnv = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') }
      if (expectedHead !== '(unborn)') await runGit(rootReal, ['read-tree', expectedHead], { env: tmpEnv })
      else await runGit(rootReal, ['read-tree', '--empty'], { env: tmpEnv })
      const lines: string[] = []
      for (const file of group.files) {
        let entry = approvedIndexMap.get(file)
        if (plan.scope === 'working') {
          const { target } = await filePath(rootReal, file)
          const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; return undefined })
          entry = undefined
          if (info?.isDirectory() && approvedIndexMap.get(file)?.mode === '160000') {
            const oid = (await runGit(target, ['rev-parse', '--verify', 'HEAD'])).stdout.toString('utf8').trim()
            if (oid !== approvedDisk.get(file)) throw new Error('COMMIT_PLAN_STALE')
            entry = { mode: '160000', oid }
          }
          if (info?.isDirectory() && !approvedIndexMap.has(file)) throw new Error('INVALID_PATH')
          if (info && !info.isDirectory()) {
            if (!info.isFile() && !info.isSymbolicLink()) throw new Error('INVALID_PATH')
            const bytes = info.isSymbolicLink() ? await readlink(target, { encoding: 'buffer' }) : await readFile(target)
            if (createHash('sha256').update(bytes).digest('hex') !== approvedDisk.get(file)) throw new Error('COMMIT_PLAN_STALE')
            const oid = (await runGit(rootReal, info.isSymbolicLink() ? ['hash-object', '-w', '--no-filters', '--stdin'] : ['hash-object', '-w', '--stdin', '--path', file], { input: bytes })).stdout.toString('utf8').trim()
            entry = { mode: info.isSymbolicLink() ? '120000' : process.platform === 'win32' ? approvedIndexMap.get(file)?.mode ?? '100644' : (info.mode & 0o111) ? '100755' : '100644', oid }
          }
        }
        lines.push(`${entry ? `${entry.mode} ${entry.oid}` : `0 ${zeroOid}`}\t${file}\0`)
      }
      const input = deletionFirst(lines)
      await runGit(rootReal, ['update-index', '-z', '--index-info'], { env: tmpEnv, input })
      const changed = (await raw(['diff', '--cached', '--no-renames', '--name-only', '-z', '--'], tmpEnv)).split('\0').filter(Boolean)
      if (!changed.length) throw new Error('COMMIT_PLAN_EMPTY_COMMIT')
      if (changed.some(file => !group.files.includes(file))) throw new Error('COMMIT_PLAN_INDEX_MISMATCH')
      const messageFile = path.join(temporary, 'message.txt')
      await writeFile(messageFile, group.message, 'utf8')
      const expectedTree = (await raw(['write-tree'], tmpEnv)).trim()
      const tmpGitDir = path.join(temporary, 'gitdir'), tmpHooksDir = path.join(temporary, 'hooks')
      await runGit(rootReal, ['init', '--bare', `--object-format=${objectFormat}`, tmpGitDir])
      await writeFile(path.join(tmpGitDir, 'objects', 'info', 'alternates'), path.join(realCommonDir, 'objects').replace(/\\/g, '/') + '\n')
      const copyIfPresent = async (source: string, destination: string) => {
        try { await copyFile(source, destination) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      await copyIfPresent(path.join(realCommonDir, 'config'), path.join(tmpGitDir, 'config'))
      if (realGitDir !== realCommonDir) await copyIfPresent(path.join(realGitDir, 'config.worktree'), path.join(tmpGitDir, 'config.worktree'))
      await copyIfPresent(path.join(realCommonDir, 'info', 'attributes'), path.join(tmpGitDir, 'info', 'attributes'))
      await mkdir(tmpHooksDir)
      for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
        const source = path.join(realHooksDir, name)
        const st = await stat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
        if (!st?.isFile() || (process.platform !== 'win32' && !(st.mode & 0o111))) continue
        const quoted = source.replace(/\\/g, '/').replace(/'/g, "'\\''")
        await writeFile(path.join(tmpHooksDir, name), `#!/bin/sh\nexec '${quoted}' "$@"\n`, { mode: 0o755 })
      }
      await raw([`--git-dir=${tmpGitDir}`, 'config', 'core.bare', 'false'])
      await raw([`--git-dir=${tmpGitDir}`, 'config', '--unset', 'core.worktree']).catch(() => {})
      await raw([`--git-dir=${tmpGitDir}`, 'config', 'core.hooksPath', tmpHooksDir])
      for (const key of ['commit.gpgSign', 'user.signingKey', 'gpg.format', 'gpg.program', 'i18n.commitEncoding', 'core.commentChar']) {
        const value = await raw(['config', '--get', key]).catch(() => undefined)
        if (value !== undefined) await raw([`--git-dir=${tmpGitDir}`, 'config', key, value.replace(/\r?\n$/, '')])
      }
      const refs = (await raw(['for-each-ref', '--format=%(refname) %(objectname)'])).trim().split(/\r?\n/).filter(Boolean)
      const updates = refs.flatMap(line => {
        const [ref, oid] = line.split(' ')
        return ref === 'HEAD' || ref === expectedBranchRef ? [] : [`update ${ref} ${oid}\n`]
      }).join('')
      if (updates) await runGit(rootReal, [`--git-dir=${tmpGitDir}`, 'update-ref', '--stdin'], { input: updates })
      if (expectedBranchRef !== '(detached)') {
        await writeFile(path.join(tmpGitDir, 'HEAD'), `ref: ${expectedBranchRef}\n`)
        if (expectedHead !== '(unborn)') await raw([`--git-dir=${tmpGitDir}`, 'update-ref', expectedBranchRef!, expectedHead])
      } else await writeFile(path.join(tmpGitDir, 'HEAD'), `${expectedHead}\n`)
      const isolatedEnv: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: tmpGitDir, GIT_WORK_TREE: rootReal, GIT_INDEX_FILE: tmpEnv.GIT_INDEX_FILE }
      delete isolatedEnv.GIT_COMMON_DIR
      delete isolatedEnv.GIT_OBJECT_DIRECTORY
      delete isolatedEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES
      for (const role of ['AUTHOR', 'COMMITTER']) {
        const ident = /^(.*) <([^>]*)> (\d+ [+-]\d{4})$/.exec((await raw(['var', `GIT_${role}_IDENT`])).trim())
        if (!ident) throw new Error('COMMIT_PLAN_ABORTED: invalid Git identity')
        isolatedEnv[`GIT_${role}_NAME`] = ident[1]
        isolatedEnv[`GIT_${role}_EMAIL`] = ident[2]
        if (process.env[`GIT_${role}_DATE`] === undefined) isolatedEnv[`GIT_${role}_DATE`] = ident[3]
      }
      await assertExpected(remainingFiles)
      await runGit(rootReal, ['commit', '-F', messageFile], { env: isolatedEnv })
      const candHash = (await raw(['rev-parse', '--verify', 'HEAD'], isolatedEnv)).trim()
      const parents = (await raw(['rev-list', '--parents', '-n', '1', candHash], isolatedEnv)).trim().split(/\s+/).slice(1)
      if (JSON.stringify(parents) !== JSON.stringify(expectedHead === '(unborn)' ? [] : [expectedHead])) throw new Error('COMMIT_PLAN_ABORTED: unexpected commit parents')
      const candTree = (await raw(['rev-parse', '--verify', `${candHash}^{tree}`], isolatedEnv)).trim()
      if (candTree !== expectedTree) {
        const changedFiles = (await raw(['diff-tree', '-r', '--no-renames', '--name-only', '-z', expectedTree, candTree], isolatedEnv)).split('\0').filter(Boolean)
        throw new Error(`COMMIT_PLAN_HOOK_MODIFIED_TREE: ${changedFiles.join(', ')}`)
      }
      await assertExpected(remainingFiles)
      const candidate = (await runGit(rootReal, ['cat-file', 'commit', candHash], { env: isolatedEnv })).stdout
      const newHead = (await runGit(rootReal, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: candidate })).stdout.toString('utf8').trim()
      if (newHead !== candHash) throw new Error('COMMIT_PLAN_ABORTED: promoted commit hash mismatch')
      const actualSubject = (await raw(['log', '-1', '--format=%s', newHead])).trimEnd()
      const realIndexPath = path.resolve(rootReal, (await raw(['rev-parse', '--git-path', 'index'])).trim())
      const lockPath = `${realIndexPath}.lock`
      const lock = await open(lockPath, 'wx')
      realIndexLock = lockPath
      await lock.close()
      await assertExpected(remainingFiles)
      await raw(['update-ref', '-m', `commit: ${actualSubject}`, ...(expectedBranchRef === '(detached)' ? ['--no-deref', 'HEAD'] : [expectedBranchRef!]), newHead, expectedHead === '(unborn)' ? zeroOid : expectedHead])
      const created = { hash: newHead, subject: actualSubject, files: [...group.files] }
      commits.push(created)
      created.hash = (await raw(['rev-parse', '--short', newHead])).trim()
      const actualFiles = (await raw(['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '--name-only', '-z', newHead])).split('\0').filter(Boolean)
      if (!actualFiles.length || actualFiles.some(file => !group.files.includes(file))) throw new Error('COMMIT_PLAN_INDEX_MISMATCH')
      if (plan.scope === 'working') {
        // Never adopt hook changes to the real index as our next approved baseline.
        await assertNoActiveGitOperation(rootReal, git)
        const currentHead = (await raw(['rev-parse', '--verify', 'HEAD'])).trim()
        const currentBranch = (await raw(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || '(detached)'
        if (currentHead !== newHead || currentBranch !== expectedBranchRef || await indexRaw() !== expectedRealIndexRaw) throw new Error('COMMIT_PLAN_ABORTED: HEAD, branch or real index changed')
        const committedIndex = await raw(['ls-tree', '-r', '-z', newHead])
        const entries = new Map(committedIndex.split('\0').filter(Boolean).map(record => {
          const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record)!
          return [match[3], `${match[1]} ${match[2]}`]
        }))
        nextIndex = `${realIndexPath}.${path.basename(temporary)}`
        await copyIfPresent(realIndexPath, nextIndex)
        await runGit(rootReal, ['update-index', '-z', '--index-info'], { env: { ...process.env, GIT_INDEX_FILE: nextIndex }, input: deletionFirst(group.files.map(file => `${entries.get(file) ?? `0 ${zeroOid}`}\t${file}\0`)) })
        await rename(nextIndex, realIndexPath)
        nextIndex = undefined
        expectedRealIndexRaw = await indexRaw()
      }
      expectedHead = newHead
      created.files = actualFiles
      await unlink(realIndexLock)
      realIndexLock = undefined
      await runGit(rootReal, ['hook', 'run', '--ignore-missing', 'post-commit']).catch(() => {})
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(`${detail}. Đã tạo ${commits.length} commit (${commits.map(commit => commit.hash).join(', ')}) trước khi dừng ở nhóm #${idx + 1}: ${group.message.split(/\r?\n/, 1)[0]}`), { code: detail.split(':', 1)[0].trim(), failedGroupIndex: idx, failedSubject: group.message.split(/\r?\n/, 1)[0], commits: [...commits], cause: error })
    } finally {
      if (nextIndex) await unlink(nextIndex).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      if (realIndexLock) await unlink(realIndexLock)
      if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5 })
    }
  }
  return { commits }
}

export async function buildNotesSummary(root: string, request: BuildNotesRequest, maxDiffBytes = 56_000): Promise<BuildNotesSummary> {
  const invalid = () => new Error('INVALID_BUILD_BASE_COMMIT')
  const validHash = isValidGitCommitHash
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
  const { rootReal, git } = await repository(root)
  const { target, file, spec } = await filePath(rootReal, relative)
  if (!Array.isArray(commitHashes) || commitHashes.length < 1 || commitHashes.length > maxCommits || commitHashes.some(hash => !isValidGitCommitHash(hash))) throw new Error('INVALID_COMMIT_HASH')
  const selected = new Set<string>()
  for (const hash of commitHashes) {
    try {
      const resolved = (await runGit(rootReal, ['rev-parse', '--verify', `${hash}^{commit}`])).stdout.toString('utf8').trim()
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
  const order = (await git.raw(['rev-list', '--topo-order', 'HEAD', '--'])).trim().split(/\r?\n/)
  for (const hash of order.filter(hash => selected.has(hash))) {
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
  const { git } = await repository(root)
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
  const { rootReal, git } = await repository(root)
  const files = (await git.raw(['diff', '--cached', '--name-only', '-z', '--'])).split('\0').filter(Boolean)
  const { text: diff, truncated } = await runGitBounded(rootReal, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--'], maxBytes)
  if (truncated) {
    const stat = (await git.raw(['diff', '--cached', '--stat'])).trimEnd()
    return { diff, files, truncated, stat }
  }
  return { diff, files, truncated }
}
