import { createHash, randomUUID } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile, readdir, realpath, stat, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import type { Project, FileDocument, FileEntry, GitState, GitBranches, SearchQuery, SearchResponse, ReplaceOptions, ReplaceResult } from '../../protocol/src/index'
import * as workspaceFs from './workspace-fs'
import { searchWorkspace, replaceInWorkspace } from './search'
import * as gitOps from './git-ops'

const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export class Workspaces {
  private projects = new Map<string, Project>()
  private watchers = new Map<string, FSWatcher>()
  private saves = new Map<string, Promise<unknown>>()
  constructor(private storage: string, private changed: (projectID: string) => void = () => {}) {}
  async load() {
    let stored: unknown
    try { stored = JSON.parse(await readFile(this.storage, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!Array.isArray(stored)) throw new Error('INVALID_PROJECT_STORAGE')
    for (const item of stored) {
      if (!item || typeof item.id !== 'string' || typeof item.directory !== 'string') continue
      try { await this.add(item.directory, item.id, false) } catch { /* Removed or unavailable workspace. */ }
    }
  }
  list() { return [...this.projects.values()] }
  async add(directory: string, id = randomUUID(), persist = true): Promise<Project> {
    const resolved = await realpath(directory)
    if (!(await stat(resolved)).isDirectory()) throw new Error('NOT_A_DIRECTORY')
    const existing = this.list().find(p => p.directory === resolved)
    if (existing) return existing
    const project = { id, name: path.basename(resolved), directory: resolved }
    this.projects.set(id, project)
    try {
      const watcher = watch(resolved, { recursive: true }, (_event, file) => {
        if (file && /(^|[\\/])(node_modules|\.git|dist|out)([\\/]|$)/.test(String(file))) return
        this.changed(id)
      })
      watcher.on('error', () => this.changed(id))
      this.watchers.set(id, watcher)
    } catch { /* Read/save remain available on filesystems without recursive watch. */ }
    if (persist) { await mkdir(path.dirname(this.storage), { recursive: true }); await writeFile(this.storage, JSON.stringify(this.list()), 'utf8') }
    return project
  }
  async remove(id: string): Promise<void> {
    this.get(id)
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    this.projects.delete(id)
    await mkdir(path.dirname(this.storage), { recursive: true })
    await writeFile(this.storage, JSON.stringify(this.list()), 'utf8')
  }
  get(id: string) { const project = this.projects.get(id); if (!project) throw new Error('UNKNOWN_PROJECT'); return project }
  async resolve(id: string, relative: string): Promise<string> {
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.includes(':')) throw new Error('INVALID_PATH')
    const root = this.get(id).directory
    const target = path.resolve(root, relative)
    this.inside(root, target)
    const actual = await realpath(target)
    this.inside(root, actual)
    return actual
  }
  private inside(root: string, target: string) {
    const rel = path.relative(root, target)
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || rel.split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('PATH_OUTSIDE_WORKSPACE')
  }
  async entries(id: string, relative = ''): Promise<FileEntry[]> {
    const target = await this.resolve(id, relative)
    const entries = await readdir(target, { withFileTypes: true })
    return entries.filter(e => e.name !== '.git' && e.name !== 'node_modules' && !e.isSymbolicLink()).map(e => ({ path: path.join(relative, e.name).split(path.sep).join('/'), name: e.name, directory: e.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  }
  async read(id: string, relative: string): Promise<FileDocument> {
    const target = await this.resolve(id, relative)
    if ((await stat(target)).size > 4 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
    const bytes = await readFile(target)
    if (bytes.includes(0)) throw new Error('BINARY_FILE')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { path: relative, content, revision: revision(bytes) }
  }
  async save(id: string, relative: string, content: string, expected: string): Promise<FileDocument> {
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
    const key = `${id}:${relative}`
    const previous = this.saves.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      const target = await this.resolve(id, relative)
      const current = await readFile(target)
      if (revision(current) !== expected) throw new Error('FILE_CONFLICT: File changed on disk. Reload before saving.')
      await writeFile(target, content, 'utf8')
      this.changed(id)
      return this.read(id, relative)
    })
    this.saves.set(key, task)
    try { return await task } finally { if (this.saves.get(key) === task) this.saves.delete(key) }
  }
  async createFile(id: string, relative: string, content?: string): Promise<{ path: string }> {
    const result = await workspaceFs.createFile(this.get(id).directory, relative, content)
    this.changed(id)
    return result
  }
  async createDirectory(id: string, relative: string): Promise<{ path: string }> {
    const result = await workspaceFs.createDirectory(this.get(id).directory, relative)
    this.changed(id)
    return result
  }
  async renamePath(id: string, fromRelative: string, toRelative: string): Promise<{ from: string; to: string }> {
    const result = await workspaceFs.renameOrMove(this.get(id).directory, fromRelative, toRelative)
    this.changed(id)
    return result
  }
  async deletePath(id: string, relative: string): Promise<{ path: string; directory: boolean }> {
    const result = await workspaceFs.deletePath(this.get(id).directory, relative)
    this.changed(id)
    return result
  }
  async searchProject(id: string, query: SearchQuery): Promise<SearchResponse> {
    return searchWorkspace(this.get(id).directory, query)
  }
  async replaceInProject(id: string, options: ReplaceOptions): Promise<ReplaceResult> {
    const result = await replaceInWorkspace(this.get(id).directory, options)
    if (options.dryRun !== true && result.filesChanged > 0) this.changed(id)
    return result
  }
  async stagedDiffSummary(id: string, maxBytes?: number) {
    return gitOps.stagedDiffSummary(this.get(id).directory, maxBytes)
  }
  async stageAll(id: string): Promise<void> {
    await gitOps.stageAll(this.get(id).directory)
    this.changed(id)
  }
  async unstageAll(id: string): Promise<void> {
    await gitOps.unstageAll(this.get(id).directory)
    this.changed(id)
  }
  async discardFile(id: string, relative: string): Promise<void> {
    await gitOps.discardFile(this.get(id).directory, relative)
    this.changed(id)
  }
  async gitBranches(id: string): Promise<GitBranches> {
    return gitOps.listBranches(this.get(id).directory)
  }
  async checkoutBranch(id: string, name: string): Promise<void> {
    await gitOps.checkoutBranch(this.get(id).directory, name)
    this.changed(id)
  }
  async createBranch(id: string, name: string, checkout?: boolean): Promise<void> {
    await gitOps.createBranch(this.get(id).directory, name, checkout)
    this.changed(id)
  }
  private git(id: string) {
    const directory = this.get(id).directory
    if (!existsSync(path.join(directory, '.git'))) throw new Error('GIT_ROOT_REQUIRED: Open the repository root for source control.')
    return simpleGit(directory, { maxConcurrentProcesses: 1, trimmed: false }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  }
  private async gitPath(id: string, relative: string) {
    const root = this.get(id).directory
    const target = path.resolve(root, relative)
    if (!relative || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\0')) throw new Error('INVALID_PATH')
    this.inside(root, target)
    try { await this.resolve(id, relative) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      let parent = path.dirname(target)
      for (;;) {
        try { this.inside(root, await realpath(parent)); break } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; parent = path.dirname(parent) }
      }
    }
    return path.relative(root, target).split(path.sep).join('/')
  }
  async status(id: string): Promise<GitState> {
    const result = await this.git(id).status()
    return { branch: result.current ?? '(unborn)', changes: result.files.map(f => ({ path: f.path, index: f.index, working: f.working_dir })) }
  }
  async diff(id: string, relative: string) {
    const file = await this.gitPath(id, relative)
    let original = ''
    try { original = await this.git(id).show([`HEAD:./${file}`]) } catch {
      const tracked = await this.git(id).raw(['ls-tree', '-r', '--name-only', 'HEAD', '--', file]).catch(() => '')
      if (tracked.trim()) throw new Error('GIT_DIFF_READ_FAILED')
    }
    let modified = ''
    try { modified = (await this.read(id, relative)).content } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return { original, modified }
  }
  async stage(id: string, relative: string, staged: boolean) {
    const file = await this.gitPath(id, relative)
    if (staged) await this.git(id).raw(['add', '--', file])
    else {
      const head = await this.git(id).raw(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
      await this.git(id).raw(head ? ['reset', 'HEAD', '--', file] : ['rm', '--cached', '--', file])
    }
    this.changed(id)
  }
  async commit(id: string, message: string) {
    if (!message.trim() || message.length > 10000 || message.includes('\0')) throw new Error('INVALID_COMMIT_MESSAGE')
    await this.git(id).raw(['-c', 'core.hooksPath=', 'commit', '-m', message])
    this.changed(id)
  }
  dispose() { for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear() }
}
