import { lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('PATH_OUTSIDE_WORKSPACE')
}
async function existing(target: string) {
  try { return await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Reject every symlink/junction in the requested path, including links within the root. */
export async function validateWorkspacePath(root: string, relative: string, options?: { allowRoot?: boolean }): Promise<{ rootReal: string; target: string; normalized: string }> {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) fail('INVALID_PATH')
  const parts = relative.replace(/\\/g, '/').split('/')
  if (parts.some(part => part.replace(/[. ]+$/, '').toLowerCase() === '.git' || part.toLowerCase() === '.git')) fail('PATH_OUTSIDE_WORKSPACE')
  const rootReal = await realpath(root)
  if (!(await stat(rootReal)).isDirectory()) fail('NOT_A_DIRECTORY')
  const target = path.resolve(rootReal, ...parts)
  inside(rootReal, target)
  const normalized = path.relative(rootReal, target).split(path.sep).join('/')
  if (!normalized && !options?.allowRoot) fail('INVALID_PATH')
  // Windows silently strips these suffixes; rejecting them prevents metadata/root aliases.
  if (parts.some(part => part && part !== '.' && part !== '..' && /[. ]$/.test(part))) fail('INVALID_PATH')
  let current = rootReal
  const segments = normalized ? normalized.split('/') : []
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index])
    const info = await existing(current)
    if (!info) break
    if (info.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED')
    inside(rootReal, await realpath(current))
    if (index < segments.length - 1 && !info.isDirectory()) fail('NOT_A_DIRECTORY')
  }
  return { rootReal, target, normalized }
}

async function ensureParents(root: string, normalized: string) {
  const segments = normalized.split('/').slice(0, -1)
  for (let index = 1; index <= segments.length; index++) {
    const relative = segments.slice(0, index).join('/')
    const { target } = await validateWorkspacePath(root, relative)
    try { await mkdir(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const checked = await validateWorkspacePath(root, relative)
    if (!(await lstat(checked.target)).isDirectory()) fail('NOT_A_DIRECTORY')
  }
}

export async function createFile(root: string, relative: string, content = ''): Promise<{ path: string }> {
  const validated = await validateWorkspacePath(root, relative)
  if (Buffer.byteLength(content, 'utf8') > 4 * 1024 * 1024) fail('FILE_TOO_LARGE')
  await ensureParents(validated.rootReal, validated.normalized)
  const { target } = await validateWorkspacePath(validated.rootReal, validated.normalized)
  try { await writeFile(target, content, { encoding: 'utf8', flag: 'wx' }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_EXISTS')
    throw error
  }
  return { path: validated.normalized }
}

export async function createDirectory(root: string, relative: string): Promise<{ path: string }> {
  const validated = await validateWorkspacePath(root, relative)
  if (await existing(validated.target)) fail('ALREADY_EXISTS')
  await ensureParents(validated.rootReal, validated.normalized)
  const { target } = await validateWorkspacePath(validated.rootReal, validated.normalized)
  try { await mkdir(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ALREADY_EXISTS')
    throw error
  }
  return { path: validated.normalized }
}

export async function renameOrMove(root: string, fromRelative: string, toRelative: string): Promise<{ from: string; to: string }> {
  const from = await validateWorkspacePath(root, fromRelative)
  const to = await validateWorkspacePath(from.rootReal, toRelative)
  const info = await lstat(from.target)
  if (process.platform === 'win32' && from.target !== to.target && from.target.toLowerCase() === to.target.toLowerCase()) {
    const temporary = path.join(path.dirname(from.target), `.ame-rename-${randomUUID()}`)
    await rename(from.target, temporary)
    try { await rename(temporary, to.target) } catch (error) { await rename(temporary, from.target); throw error }
    return { from: from.normalized, to: to.normalized }
  }
  const relative = path.relative(from.target, to.target)
  if (!relative || (info.isDirectory() && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) fail('INVALID_MOVE')
  if (await existing(to.target)) fail('ALREADY_EXISTS')
  await ensureParents(from.rootReal, to.normalized)
  await validateWorkspacePath(from.rootReal, from.normalized)
  await validateWorkspacePath(from.rootReal, to.normalized)
  if (await existing(to.target)) fail('ALREADY_EXISTS')
  await rename(from.target, to.target)
  return { from: from.normalized, to: to.normalized }
}

export async function deletePath(root: string, relative: string): Promise<{ path: string; directory: boolean }> {
  const validated = await validateWorkspacePath(root, relative)
  const info = await lstat(validated.target)
  // rm does not follow symlinks found inside a recursively removed directory.
  await rm(validated.target, { recursive: true, force: false })
  return { path: validated.normalized, directory: info.isDirectory() }
}
