import { existsSync } from 'node:fs'
import { lstat, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'

async function repository(root: string) {
  const rootReal = await realpath(root)
  if (!existsSync(path.join(rootReal, '.git'))) throw new Error('GIT_ROOT_REQUIRED')
  const git = simpleGit(rootReal, { maxConcurrentProcesses: 1, trimmed: false }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  return { rootReal, git }
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
  } else if (await hasHead(git) && (await git.raw(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', file])).split('\0').includes(file)) {
    await git.raw(['checkout', 'HEAD', '--', spec])
  } else if (entry) {
    await unlink(target)
  }
}

export function validateBranchName(name: string): string {
  if (typeof name !== 'string' || !name || name === '@' || name === 'HEAD' || /^[-./]/.test(name) || /[./]$/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//') || /[\s\x00-\x1f\x7f~^:?*\[\\]/u.test(name) || name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new Error('INVALID_BRANCH_NAME')
  return name
}

export async function listBranches(root: string): Promise<{ current: string; branches: { name: string; current: boolean; commit: string }[] }> {
  const { git } = await repository(root)
  const current = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() || '(detached)'
  if (!await hasHead(git)) return { current: current === '(detached)' ? '(unborn)' : current, branches: [] }
  const refs = await git.raw(['for-each-ref', '--format=%(refname:short)%00%(objectname)', '--', 'refs/heads/'])
  const branches = refs.trimEnd().split('\n').filter(Boolean).map(line => {
    const [name, commit] = line.replace(/\r$/, '').split('\0')
    return { name, current: name === current, commit }
  })
  return { current, branches }
}

export async function checkoutBranch(root: string, name: string): Promise<void> {
  const branch = validateBranchName(name)
  const { git } = await repository(root)
  await git.raw(['checkout', branch, '--'])
}

export async function createBranch(root: string, name: string, checkout = true): Promise<void> {
  const branch = validateBranchName(name)
  const { git } = await repository(root)
  await git.raw(checkout ? ['checkout', '-b', branch, '--'] : ['branch', '--', branch])
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
