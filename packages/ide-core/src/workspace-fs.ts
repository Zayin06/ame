import { copyFile, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { renameWithRetry } from './file-save'
import { constants, createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
function isGitSegment(part: string) { return part.replace(/[. ]+$/, '').toLowerCase() === '.git' }
function hasGitSegment(parts: readonly string[]) { return parts.some(isGitSegment) }
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
  if (hasGitSegment(parts)) fail('PATH_OUTSIDE_WORKSPACE')
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
    const resolved = await realpath(current)
    inside(rootReal, resolved)
    const resolvedParts = path.relative(rootReal, resolved).split(path.sep).filter(Boolean)
    if (hasGitSegment(resolvedParts)) fail('PATH_OUTSIDE_WORKSPACE')
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
    await renameWithRetry(from.target, temporary)
    try { await renameWithRetry(temporary, to.target) } catch (error) { await renameWithRetry(temporary, from.target); throw error }
    return { from: from.normalized, to: to.normalized }
  }
  const relative = path.relative(from.target, to.target)
  if (!relative || (info.isDirectory() && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) fail('INVALID_MOVE')
  if (await existing(to.target)) fail('ALREADY_EXISTS')
  await ensureParents(from.rootReal, to.normalized)
  await validateWorkspacePath(from.rootReal, from.normalized)
  await validateWorkspacePath(from.rootReal, to.normalized)
  if (await existing(to.target)) fail('ALREADY_EXISTS')
  await renameWithRetry(from.target, to.target)
  return { from: from.normalized, to: to.normalized }
}

export async function deletePath(root: string, relative: string): Promise<{ path: string; directory: boolean }> {
  const validated = await validateWorkspacePath(root, relative)
  const info = await lstat(validated.target)
  // rm does not follow symlinks found inside a recursively removed directory.
  await rm(validated.target, { recursive: true, force: false })
  return { path: validated.normalized, directory: info.isDirectory() }
}

export const MAX_COPY_ENTRIES = 5000
export const MAX_COPY_BYTES = 512 * 1024 * 1024

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function directoryTarget(root: string, relative: string) {
  const validated = await validateWorkspacePath(root, relative, { allowRoot: true })
  const info = await existing(validated.target)
  if (!info) fail('NOT_FOUND')
  if (!info.isDirectory()) fail('NOT_A_DIRECTORY')
  return validated
}

async function childName(directory: string, desiredName: string, forceCopySuffix: boolean, directoryEntry?: boolean) {
  if (typeof desiredName !== 'string' || !desiredName || /[\\/]/.test(desiredName) || desiredName === '.' || desiredName === '..') fail('INVALID_PATH')
  await validateWorkspacePath(directory, desiredName)
  const info = await existing(path.join(directory, desiredName))
  if (!forceCopySuffix && !info) return desiredName
  const extension = (directoryEntry ?? info?.isDirectory()) ? '' : path.extname(desiredName)
  const stem = desiredName.slice(0, desiredName.length - extension.length)
  for (let index = 1; ; index++) {
    const name = `${stem} copy${index === 1 ? '' : ` ${index}`}${extension}`
    await validateWorkspacePath(directory, name)
    if (!await existing(path.join(directory, name))) return name
  }
}

export async function uniqueChildName(directoryTarget: string, desiredName: string, options?: { forceCopySuffix?: boolean }): Promise<string> {
  await directoryTargetCheck(directoryTarget)
  return childName(directoryTarget, desiredName, options?.forceCopySuffix === true)
}

async function directoryTargetCheck(directory: string) {
  if (!(await stat(await realpath(directory))).isDirectory()) fail('NOT_A_DIRECTORY')
}

/** External paths are read-only inputs: inspect every ancestor before resolving aliases. */
async function externalSource(absolute: string) {
  if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || absolute.includes('\0')) fail('INVALID_PATH')
  const parts = absolute.slice(path.parse(absolute).root.length).split(/[\\/]/)
  if (hasGitSegment(parts)) fail('PATH_OUTSIDE_WORKSPACE')
  if (parts.some(part => part.includes(':') || part !== '.' && part !== '..' && /[. ]$/.test(part))) fail('INVALID_PATH')
  let current = path.parse(absolute).root
  for (const part of parts) {
    current = path.join(current, part)
    const info = await existing(current)
    if (!info) fail('NOT_FOUND')
    if (info.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED')
  }
  return realpath(absolute)
}

type CopyNode = { source: string; relative: string; directory: boolean; size: number; digest?: string }
type CopyBudget = { entries: number; bytes: number }
async function digest(target: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target)) hash.update(chunk)
  return hash.digest('hex')
}

async function inspectTree(source: string, budget: CopyBudget, enforceLimits = true): Promise<CopyNode[]> {
  const nodes: CopyNode[] = [], pending = [{ source, relative: '' }]
  while (pending.length) {
    const node = pending.pop()!
    await externalSource(node.source)
    const info = await lstat(node.source)
    if (!info.isDirectory() && !info.isFile()) fail('INVALID_PATH')
    budget.entries++
    budget.bytes += info.isFile() ? info.size : 0
    if (enforceLimits && (budget.entries > MAX_COPY_ENTRIES || budget.bytes > MAX_COPY_BYTES)) fail('COPY_TOO_LARGE')
    nodes.push({ ...node, directory: info.isDirectory(), size: info.isFile() ? info.size : 0 })
    if (info.isDirectory()) {
      for (const name of (await readdir(node.source)).sort().reverse()) {
        // Also validate names on POSIX that would be interpreted differently on Windows.
        await validateWorkspacePath(node.source, name)
        pending.push({ source: path.join(node.source, name), relative: node.relative ? `${node.relative}/${name}` : name })
      }
    }
  }
  return nodes
}

async function copyTree(nodes: CopyNode[], root: string, relative: string) {
  let claimed = false
  const destination = (await validateWorkspacePath(root, relative)).target
  try {
    for (const node of nodes) {
      await externalSource(node.source)
      const sourceInfo = await lstat(node.source)
      if (sourceInfo.isDirectory() !== node.directory || !node.directory && (!sourceInfo.isFile() || sourceInfo.size !== node.size)) fail('COPY_SOURCE_CHANGED')
      const target = await validateWorkspacePath(root, node.relative ? `${relative}/${node.relative}` : relative)
      if (node.directory) await mkdir(target.target)
      else {
        node.digest = await digest(node.source)
        await copyFile(node.source, target.target, constants.COPYFILE_EXCL)
        if (!node.relative) claimed = true
        if ((await lstat(target.target)).size !== node.size || await digest(target.target) !== node.digest) fail('COPY_SOURCE_CHANGED')
      }
      if (!node.relative) claimed = true
    }
    // Verify the complete source manifest again, including additions/removals and content.
    const checked = await inspectTree(nodes[0].source, { entries: 0, bytes: 0 })
    if (checked.length !== nodes.length || checked.some((node, index) => node.relative !== nodes[index].relative || node.directory !== nodes[index].directory || node.size !== nodes[index].size)) fail('COPY_SOURCE_CHANGED')
    for (const node of nodes) if (!node.directory && await digest(node.source) !== node.digest) fail('COPY_SOURCE_CHANGED')
  } catch (error) {
    if (claimed) await rm(destination, { recursive: true, force: true })
    throw error
  }
}

export async function copyEntry(sourceRoot: string, sourceRelative: string, targetRoot: string, targetDirRelative: string): Promise<{ path: string; directory: boolean }> {
  const source = await validateWorkspacePath(sourceRoot, sourceRelative)
  const target = await directoryTarget(targetRoot, targetDirRelative)
  const info = await existing(source.target)
  if (!info) fail('NOT_FOUND')
  if (info.isDirectory() && contains(source.target, target.target)) fail('INVALID_COPY')
  const nodes = await inspectTree(source.target, { entries: 0, bytes: 0 })
  const name = await childName(target.target, path.basename(source.target), false, info.isDirectory())
  const relative = target.normalized ? `${target.normalized}/${name}` : name
  await copyTree(nodes, target.rootReal, relative)
  return { path: relative, directory: info.isDirectory() }
}

export async function moveEntry(sourceRoot: string, sourceRelative: string, targetRoot: string, targetDirRelative: string): Promise<{ from: string; to: string; directory: boolean; sameRoot: boolean; moved: boolean }> {
  const source = await validateWorkspacePath(sourceRoot, sourceRelative)
  const target = await directoryTarget(targetRoot, targetDirRelative)
  const info = await existing(source.target)
  if (!info) fail('NOT_FOUND')
  const sameRoot = path.relative(source.rootReal, target.rootReal) === ''
  const to = [target.normalized, path.basename(source.target)].filter(Boolean).join('/')
  if (sameRoot && path.relative(source.target, path.join(target.rootReal, to)) === '') return { from: source.normalized, to, directory: info.isDirectory(), sameRoot, moved: false }
  if (info.isDirectory() && contains(source.target, target.target)) fail('INVALID_MOVE')
  // A renamed directory must not smuggle metadata or links into the destination either.
  if (sameRoot) {
    await inspectTree(source.target, { entries: 0, bytes: 0 }, false)
    await renameOrMove(source.rootReal, source.normalized, to)
    return { from: source.normalized, to, directory: info.isDirectory(), sameRoot, moved: true }
  }
  const copied = await copyEntry(source.rootReal, source.normalized, target.rootReal, target.normalized)
  await deletePath(source.rootReal, source.normalized)
  return { from: source.normalized, to: copied.path, directory: copied.directory, sameRoot, moved: true }
}

export async function copyExternalPaths(targetRoot: string, targetDirRelative: string, absolutePaths: readonly string[]): Promise<{ paths: string[] }> {
  const target = await directoryTarget(targetRoot, targetDirRelative)
  const budget = { entries: 0, bytes: 0 }
  const plans: CopyNode[][] = []
  for (const absolute of absolutePaths) {
    const source = await externalSource(absolute)
    const nodes = await inspectTree(source, budget)
    if (nodes[0].directory && contains(source, target.target)) fail('INVALID_COPY')
    plans.push(nodes)
  }
  const paths: string[] = []
  try {
    for (const nodes of plans) {
      const name = await childName(target.target, path.basename(nodes[0].source), false, nodes[0].directory)
      const relative = target.normalized ? `${target.normalized}/${name}` : name
      await copyTree(nodes, target.rootReal, relative)
      paths.push(relative)
    }
  } catch (error) {
    for (const relative of paths.reverse()) await rm(path.join(target.rootReal, relative), { recursive: true, force: true })
    throw error
  }
  return { paths }
}

export async function copyExternalEntries(externalPaths: readonly string[], targetRoot: string, targetDirRelative: string): Promise<{ paths: string[] }> {
  return copyExternalPaths(targetRoot, targetDirRelative, externalPaths)
}
