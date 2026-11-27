import { createHash, randomUUID } from 'node:crypto'
import { existsSync, watch, realpath as fsRealpath, type FSWatcher } from 'node:fs'
import { readFile, readdir, realpath, stat, lstat, writeFile, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { diffContent, diffPreviewLimit, readDiffSide, type DiffSide } from './diff-content'
import type { BuildNotesRequest, Project, FileDocument, FileEntry, GitState, GitBranches, GitCommitOptions, GitPushOptions, SearchQuery, SearchResponse, ReplaceOptions, ReplaceResult } from '../../protocol/src/index'
import * as workspaceFs from './workspace-fs'
import { searchWorkspace, replaceInWorkspace } from './search'
import * as gitOps from './git-ops'
import { saveFileSafely, renameWithRetry } from './file-save'
import type { DiffTarget } from '../../protocol/src/index'
import { isValidGitCommitHash } from '../../protocol/src/index'

const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])
const MAX_BOM_CACHE = 2000
export class Workspaces {
  private projects = new Map<string, Project>()
  private watchers = new Map<string, FSWatcher>()
  private gitWatchers = new Map<string, FSWatcher[]>()
  private gitWatchVersions = new Map<string, symbol>()
  private searchControllers = new Map<string, AbortController>()
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private saves = new Map<string, Promise<unknown>>()
  private statusReads = new Map<string, Promise<GitState>>()
  private bom = new Map<string, boolean>()
  private setBom(id: string, key: string, hasBom: boolean) {
    this.bom.set(id + '\0' + key, hasBom)
    if (this.bom.size > MAX_BOM_CACHE) this.bom.delete(this.bom.keys().next().value!)
  }
  private projectQueue: Promise<unknown> = Promise.resolve()
  constructor(private storage: string, private onChanged: (projectID: string) => void = () => {}) {}
  private changed(id: string) {
    this.statusReads.delete(id)
    this.onChanged(id)
  }
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
  async add(directory: string, id: string = randomUUID(), persist = true): Promise<Project> {
    return this.queueProject(async () => {
      const resolved = await realpath(directory)
      if (!(await stat(resolved)).isDirectory()) throw new Error('NOT_A_DIRECTORY')
      const existing = this.list().find(p => p.directory === resolved)
      if (existing) return existing
      const project = { id, name: path.basename(resolved), directory: resolved }
      if (persist) await this.writeProjectsAtomic([...this.list(), project])
      this.projects.set(id, project)
      try {
        const watcher = watch(resolved, { recursive: true }, (_event, file) => {
          if (file && String(file).replace(/\\/g, '/').toLowerCase() === '.git') {
            void this.refreshGitWatchers(id, resolved)
            this.scheduleWatchChange(id)
            return
          }
          if (file && /(^|[\\/])(node_modules|\.git|dist|out|build|coverage|release|release-[^\\/]+|\.next|\.nuxt|\.turbo|\.cache|\.plasmo|\.vite|\.parcel-cache|storybook-static|\.venv|venv|__pycache__|target|vendor|\.pm)([\\/]|$)/i.test(String(file))) return
          this.scheduleWatchChange(id)
        })
        watcher.on('error', () => this.scheduleWatchChange(id))
        this.watchers.set(id, watcher)
      } catch { /* Read/save remain available on filesystems without recursive watch. */ }
      await this.refreshGitWatchers(id, resolved)
      return project
    })
  }
  private queueProject<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.projectQueue.catch(() => {}).then(operation)
    this.projectQueue = task
    return task
  }
  private async refreshGitWatchers(id: string, root: string) {
    const version = Symbol()
    this.gitWatchVersions.set(id, version)
    const directories = new Set<string>()
    try {
      const marker = path.join(root, '.git')
      const info = await stat(marker)
      let gitDir = marker
      if (info.isFile()) {
        const match = /^gitdir: (.+)\s*$/i.exec((await readFile(marker, 'utf8')).trim())
        if (!match) throw new Error('INVALID_GIT_MARKER')
        gitDir = path.resolve(root, match[1])
      }
      directories.add(await realpath(gitDir))
      try { directories.add(await realpath(path.resolve(gitDir, (await readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()))) }
      catch { /* Ordinary checkouts have no separate common directory. */ }
    } catch { /* Git can be initialized after opening the project. */ }
    if (!this.projects.has(id) || this.gitWatchVersions.get(id) !== version) return
    const watchers: FSWatcher[] = []
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { recursive: true }, (_event, file) => {
          const relative = file && String(file).replace(/\\/g, '/')
          // Ignore objects, reflogs and transient locks: Git status reads may update them.
          if (!relative || /^(?:HEAD|index|packed-refs|config|shallow|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|refs(?:\/.*)?|rebase-merge(?:\/.*)?|rebase-apply(?:\/.*)?)$/.test(relative) && !relative.endsWith('.lock')) this.scheduleWatchChange(id)
        })
        watcher.on('error', () => this.scheduleWatchChange(id))
        watchers.push(watcher)
      } catch { /* Refresh remains available on filesystems without recursive watch. */ }
    }
    this.gitWatchers.get(id)?.forEach(watcher => watcher.close())
    this.gitWatchers.set(id, watchers)
  }
  private scheduleWatchChange(id: string) {
    // A request arriving after a filesystem change needs a fresh snapshot, even
    // when an older read is still running or the notification is debounced.
    this.statusReads.delete(id)
    clearTimeout(this.watchTimers.get(id))
    this.watchTimers.set(id, setTimeout(() => {
      this.watchTimers.delete(id)
      if (this.projects.has(id)) this.changed(id)
    }, 150))
  }
  async remove(id: string): Promise<void> {
    return this.queueProject(async () => {
      this.get(id)
      await this.writeProjectsAtomic(this.list().filter(project => project.id !== id))
      clearTimeout(this.watchTimers.get(id))
      this.watchTimers.delete(id)
      this.watchers.get(id)?.close()
      this.watchers.delete(id)
      this.gitWatchVersions.delete(id)
      this.gitWatchers.get(id)?.forEach(watcher => watcher.close())
      this.gitWatchers.delete(id)
      this.searchControllers.get(id)?.abort()
      this.searchControllers.delete(id)
      this.statusReads.delete(id)
      this.projects.delete(id)
      for (const key of this.bom.keys()) if (key.startsWith(id + '\0')) this.bom.delete(key)
    })
  }
  private async writeProjectsAtomic(projects: Project[]): Promise<void> {
    await mkdir(path.dirname(this.storage), { recursive: true })
    const temporary = `${this.storage}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(projects), { encoding: 'utf8', flag: 'wx' })
      // Never unlink the destination: failed replacement must preserve stored projects.
      await renameWithRetry(temporary, this.storage)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
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
  async listFiles(id: string): Promise<string[]> {
    const root = this.get(id).directory
    const ignored = new Set(['.git', 'node_modules', 'dist', 'out', '.next', 'build', 'coverage', 'release', '.nuxt', '.turbo', '.cache', '.plasmo', '.vite', '.parcel-cache', 'storybook-static', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.pm'])
    const files: string[] = [], pending = [root]
    while (pending.length && files.length < 20000) {
      const directory = pending.pop()!
      try {
        if ((await lstat(directory)).isSymbolicLink()) continue
        const actual = await realpath(directory)
        this.inside(root, actual)
        const entries = (await readdir(actual, { withFileTypes: true }))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        const directories: string[] = []
        for (const entry of entries) {
          if (ignored.has(entry.name.toLowerCase()) || entry.isSymbolicLink() || (entry.isDirectory() && entry.name.toLowerCase().startsWith('release-'))) continue
          const target = path.join(actual, entry.name)
          if (entry.isDirectory()) directories.push(target)
          else if (entry.isFile()) {
            files.push(path.relative(root, target).split(path.sep).join('/'))
            if (files.length === 20000) break
          }
        }
        pending.push(...directories.reverse())
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    return files.sort()
  }
  private async fileKey(id: string, resolvedTarget: string): Promise<string> {
    const nativePath = await promisify(fsRealpath.native)(resolvedTarget).catch(() => resolvedTarget)
    const info = await stat(resolvedTarget, { bigint: true })
    return info.ino !== 0n ? `ino:${info.dev}:${info.ino}` : process.platform === 'win32' ? nativePath.toLowerCase() : nativePath
  }
  async read(id: string, relative: string): Promise<FileDocument> {
    const target = await this.resolve(id, relative)
    const info = await stat(target)
    if (info.isDirectory()) throw new Error('IS_DIRECTORY')
    if (info.size > 4 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
    const bytes = await readFile(target)
    if (bytes.includes(0)) throw new Error('BINARY_FILE')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const fileRevision = revision(bytes)
    this.setBom(id, JSON.stringify([relative, fileRevision]), bytes.subarray(0, 3).equals(utf8Bom))
    this.setBom(id, JSON.stringify([await this.fileKey(id, target), fileRevision]), bytes.subarray(0, 3).equals(utf8Bom))
    return { path: relative, content, revision: fileRevision }
  }
  private async withPathSaveLock<T>(id: string, relative: string, operation: () => Promise<T>): Promise<T> {
    const target = await this.resolve(id, relative)
    const key = `path:${process.platform === 'win32' ? target.toLowerCase() : target}`
    const task = (this.saves.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.saves.set(key, task)
    try { return await task } finally { if (this.saves.get(key) === task) this.saves.delete(key) }
  }
  async save(id: string, relative: string, content: string, expected: string): Promise<FileDocument> {
    return this.withPathSaveLock(id, relative, () => this.saveUnlocked(id, relative, content, expected))
  }
  private async saveUnlocked(id: string, relative: string, content: string, expected: string): Promise<FileDocument> {
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
    const resolvedTarget = await this.resolve(id, relative)
    const key = await this.fileKey(id, resolvedTarget)
    const previous = this.saves.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      const target = await this.resolve(id, relative)
      if (await this.fileKey(id, target) !== key) throw new Error('FILE_CONFLICT: File was replaced before saving.')
      const current = await readFile(target)
      if (revision(current) !== expected) throw new Error('FILE_CONFLICT: File changed on disk. Reload before saving.')
      const hasBom = this.bom.get(id + '\0' + JSON.stringify([key, expected])) ?? this.bom.get(id + '\0' + JSON.stringify([relative, expected])) ?? current.subarray(0, 3).equals(utf8Bom)
      const bytes = Buffer.from(hasBom && !content.startsWith('\uFEFF') ? '\uFEFF' + content : content, 'utf8')
      if (bytes.length > 4 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
      await saveFileSafely(target, bytes, current, async () => {
        const checked = await this.resolve(id, relative)
        if (checked !== target || await this.fileKey(id, checked) !== key || revision(await readFile(checked)) !== expected) throw new Error('FILE_CONFLICT: File changed while preparing the save.')
      })
      this.changed(id)
      return { path: relative, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: revision(bytes) }
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
    const directory = this.get(id).directory
    this.searchControllers.get(id)?.abort()
    const controller = new AbortController()
    this.searchControllers.set(id, controller)
    try { return await searchWorkspace(directory, query, { signal: controller.signal }) }
    finally { if (this.searchControllers.get(id) === controller) this.searchControllers.delete(id) }
  }
  async replaceInProject(id: string, options: ReplaceOptions, plan?: ReplaceResult['previews']): Promise<ReplaceResult> {
    const result = await replaceInWorkspace(this.get(id).directory, options, plan, async (file, operation) => this.withPathSaveLock(id, file, async () => {
      const key = await this.fileKey(id, await this.resolve(id, file))
      const task = (this.saves.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (await this.fileKey(id, await this.resolve(id, file)) !== key) throw Object.assign(new Error('FILE_CONFLICT'), { code: 'FILE_CONFLICT' })
        await operation()
      })
      this.saves.set(key, task)
      try { await task } finally { if (this.saves.get(key) === task) this.saves.delete(key) }
    }))
    if (options.dryRun !== true && result.filesChanged > 0) this.changed(id)
    return result
  }
  async stagedDiffSummary(id: string, maxBytes?: number) {
    return gitOps.stagedDiffSummary(this.get(id).directory, maxBytes)
  }
  async copyPath(targetID: string, sourceID: string, sourceRelative: string, targetDir: string) {
    const result = await workspaceFs.copyEntry(this.get(sourceID).directory, sourceRelative, this.get(targetID).directory, targetDir)
    this.changed(targetID)
    return result
  }
  async movePath(targetID: string, sourceID: string, sourceRelative: string, targetDir: string) {
    const { sameRoot: _sameRoot, ...result } = await workspaceFs.moveEntry(this.get(sourceID).directory, sourceRelative, this.get(targetID).directory, targetDir)
    const sameProject = sourceID === targetID
    if (result.moved) {
      this.changed(targetID)
      if (!sameProject) this.changed(sourceID)
    }
    return { ...result, sameProject }
  }
  async pasteExternalPaths(targetID: string, absolutePaths: readonly string[], targetDir: string) {
    const result = await workspaceFs.copyExternalEntries(absolutePaths, this.get(targetID).directory, targetDir)
    if (result.paths.length) this.changed(targetID)
    return result
  }
  async buildNotesSummary(id: string, request: BuildNotesRequest, maxDiffBytes?: number) {
    return gitOps.buildNotesSummary(this.get(id).directory, request, maxDiffBytes)
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
  async gitDeleteBranch(id: string, name: string, force?: boolean) {
    await gitOps.deleteBranch(this.get(id).directory, name, force)
    this.changed(id)
  }
  async gitFetch(id: string) {
    const result = await gitOps.gitFetch(this.get(id).directory)
    this.changed(id)
    return result
  }
  async gitPull(id: string) {
    const result = await gitOps.gitPull(this.get(id).directory)
    this.changed(id)
    return result
  }
  async gitPush(id: string, options?: GitPushOptions) {
    const result = await gitOps.gitPush(this.get(id).directory, options)
    this.changed(id)
    return result
  }
  async gitLog(id: string, limit?: number) {
    return gitOps.gitLog(this.get(id).directory, limit)
  }
  async gitCommitDetail(id: string, hash: string) {
    return gitOps.gitCommitDetail(this.get(id).directory, hash)
  }
  async gitUndoLastCommit(id: string) {
    const result = await gitOps.gitUndoLastCommit(this.get(id).directory)
    this.changed(id)
    return result
  }
  async gitStashList(id: string) {
    return gitOps.gitStashList(this.get(id).directory)
  }
  async gitStashPush(id: string, message?: string, includeUntracked?: boolean) {
    await gitOps.gitStashPush(this.get(id).directory, message, includeUntracked)
    this.changed(id)
  }
  async gitStashApply(id: string, index: number, pop?: boolean, expectedOid?: string) {
    await gitOps.gitStashApply(this.get(id).directory, index, pop, expectedOid)
    this.changed(id)
  }
  async gitStashDrop(id: string, index: number, expectedOid?: string) {
    await gitOps.gitStashDrop(this.get(id).directory, index, expectedOid)
    this.changed(id)
  }
  private git(id: string) {
    const directory = this.get(id).directory
    if (!existsSync(path.join(directory, '.git'))) throw new Error('GIT_ROOT_REQUIRED: Open the repository root for source control.')
    return simpleGit(directory, { maxConcurrentProcesses: 1, trimmed: false, config: ['core.fsmonitor=false'], timeout: { block: 10000 } }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  }
  private async readOnlyGit(id: string) {
    this.git(id) // Retain the repository-root guard.
    const directory = this.get(id).directory
    return simpleGit(directory, { maxConcurrentProcesses: 1, trimmed: false, config: await gitOps.safeReadOnlyGitConfig(directory), timeout: { block: 10000 } }).env({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
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
    this.get(id)
    const pending = this.statusReads.get(id)
    if (pending) return pending
    const request = this.readStatus(id).finally(() => {
      if (this.statusReads.get(id) === request) this.statusReads.delete(id)
    })
    this.statusReads.set(id, request)
    return request
  }
  private async readStatus(id: string): Promise<GitState> {
    const git = await this.readOnlyGit(id)
    const result = await git.status()
    const root = this.get(id).directory
    const gitDir = path.resolve(root, (await git.raw(['rev-parse', '--git-dir'])).trim())
    const hasRemote = await gitOps.hasRemote(git)
    const merging = result.conflicted.length > 0 || existsSync(path.join(gitDir, 'MERGE_HEAD')) || existsSync(path.join(gitDir, 'REBASE_HEAD'))
    const renamed = new Map(result.renamed.map(file => [file.to, file.from]))
    return { branch: result.current ?? '(unborn)', changes: result.files.map(f => ({ path: f.path, index: f.index, working: f.working_dir, ...(renamed.has(f.path) ? { from: renamed.get(f.path)! } : {}) })), tracking: result.tracking ?? null, ahead: result.ahead ?? 0, behind: result.behind ?? 0, hasRemote, merging }
  }
  async diff(id: string, relative: string, target?: DiffTarget) {
    const file = await this.gitPath(id, relative)
    const git = typeof this.readOnlyGit === "function" ? await this.readOnlyGit(id) : this.git(id)
    if (target && (!['staged', 'working', 'commit', 'range', 'commits'].includes(target.kind) ||
      (target.kind === 'commit' && !isValidGitCommitHash(target.commit)) ||
      (target.kind === 'range' && !isValidGitCommitHash(target.baseCommit)) ||
      (target.kind === 'commits' && (!Array.isArray(target.commits) || target.commits.length < 1 || target.commits.length > 50 || !target.commits.every(isValidGitCommitHash))))) throw new Error('INVALID_DIFF_TARGET')
    const from = target?.from === undefined ? file : await this.gitPath(id, target.from)
    // A missing path is an empty side; a failed read of an existing blob is not.
    const empty: DiffSide = { content: '', size: 0 }
    const blob = async (ref: string, blobPath = file): Promise<DiffSide> => {
      const spec = `${ref}:./${blobPath}`
      const objectType = await git.raw(['cat-file', '-t', spec]).then(value => value.trim(), () => '')
      if (objectType === 'tree') return empty
      let size: number
      try { size = Number((await git.raw(['cat-file', '-s', spec])).trim()) } catch {
        const tracked = await git.raw(ref === ''
          ? ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', blobPath]
          : ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', ref, '--', blobPath])
        if (tracked) throw new Error('GIT_DIFF_READ_FAILED')
        return empty
      }
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('GIT_DIFF_READ_FAILED')
      return readDiffSide(size, async () => {
        const safeConfig = await gitOps.safeReadOnlyGitConfig(this.get(id).directory)
        const { stdout } = await promisify(execFile)('git', [...safeConfig.flatMap(value => ['-c', value]), 'cat-file', '-p', spec], {
          cwd: this.get(id).directory, encoding: 'buffer', maxBuffer: diffPreviewLimit + 1, timeout: 10000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
        })
        return stdout
      })
    }
    if (target?.kind === 'commits' && (target.commits.length !== 1 || target.includeWorking)) {
      const patch = await gitOps.gitFileCommitPatch(this.get(id).directory, file, target.commits, !!target.includeWorking)
      return { original: '', modified: '', patch, truncated: patch.endsWith('\n[Diff truncated at 4 MiB]\n') }
    }
    if (target?.kind === 'commit' || target?.kind === 'commits') {
      // Resolve once, validating existence and distinguishing root commits from read errors.
      const commit = target.kind === 'commit' ? target.commit : target.commits[0]
      const hash = await gitOps.resolveCommitHash(git, commit)
      const parents = (await git.raw(['rev-list', '--parents', '-n', '1', hash])).trim().split(/\s+/)
      return diffContent(parents[1] ? await blob(`${hash}^`, from) : empty, await blob(hash))
    }
    const head = async () => {
      const exists = await git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
      return exists ? blob('HEAD', from) : empty
    }
    if (target?.kind === 'staged') return diffContent(await head(), await blob(''))
    let base: string | undefined
    if (target?.kind === 'range') {
      try {
        base = await gitOps.resolveCommitHash(git, target.baseCommit)
        await git.raw(['merge-base', '--is-ancestor', base, 'HEAD'])
        if ((await git.raw(['merge-base', base, 'HEAD'])).trim() !== base) throw new Error('INVALID_DIFF_TARGET')
      } catch { throw new Error('INVALID_DIFF_TARGET') }
      if (!target.includeWorking) return diffContent(await blob(base, from), await blob('HEAD'))
      const hashes = (await git.raw(['rev-list', '--topo-order', `${base}..HEAD`, '--'])).trim().split(/\s+/).filter(Boolean)
      if (hashes.length > 0) {
        const patch = await gitOps.gitFileCommitPatch(this.get(id).directory, file, hashes, true, hashes.length)
        return { original: '', modified: '', patch, truncated: patch.endsWith('\n[Diff truncated at 4 MiB]\n') }
      }
    }
    const original = base ? await blob(base, from) : target?.kind === 'working' ? await blob('', from) : await head()
    let modified = empty
    try {
      const disk = await this.resolve(id, relative), info = await stat(disk)
      if (info.isDirectory()) throw new Error('IS_DIRECTORY')
      modified = await readDiffSide(info.size, () => readFile(disk))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return diffContent(original, modified)
  }
  async stage(id: string, relative: string, staged: boolean, from?: string) {
    const file = await this.gitPath(id, relative)
    const files = [file]
    if (from !== undefined) {
      const source = await this.gitPath(id, from)
      if (!staged || existsSync(path.join(this.get(id).directory, source)) || await (await this.readOnlyGit(id)).raw(['ls-files', '--stage', '-z', '--', `:(literal)${source}`])) files.push(source)
    }
    const specs = [...new Set(files)].map(value => `:(literal)${value}`)
    if (staged) await this.git(id).raw(['add', '-A', '--', ...specs])
    else {
      const head = await (await this.readOnlyGit(id)).raw(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
      await this.git(id).raw(head ? ['reset', 'HEAD', '--', ...specs] : ['rm', '--cached', '--', ...specs])
    }
    this.changed(id)
  }
  async commit(id: string, message: string, options?: GitCommitOptions) {
    if (!message.trim() || message.length > 10000 || message.includes('\0')) throw new Error('INVALID_COMMIT_MESSAGE')
    this.git(id)
    const commitGit = simpleGit(this.get(id).directory, { maxConcurrentProcesses: 1, trimmed: false, config: ['core.fsmonitor=false'], timeout: { block: 60000 } }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
    await commitGit.raw(['commit', ...(options?.amend ? ['--amend'] : []), ...(options?.noVerify ? ['--no-verify'] : []), '-m', message])
    this.changed(id)
  }
  dispose() {
    this.statusReads.clear()
    for (const controller of this.searchControllers.values()) controller.abort()
    this.searchControllers.clear()
    this.gitWatchVersions.clear()
    for (const watchers of this.gitWatchers.values()) for (const watcher of watchers) watcher.close()
    this.gitWatchers.clear()
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    this.watchTimers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.bom.clear()
  }
}
