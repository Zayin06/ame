import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { validateWorkspacePath } from './workspace-fs'

export type LspSeverity = 'error' | 'warning' | 'info'
export type LspRange = { line: number; column: number; endLine: number; endColumn: number }
export type LspDiagnostic = LspRange & { path: string; severity: LspSeverity; code: number; message: string; source: 'ts' }
export type LspCompletion = { label: string; kind: string; detail?: string; insertText?: string; sortText?: string }
export type LspHover = { display: string; documentation?: string; range: LspRange }
export type LspLocation = LspRange & { path: string }
export type LspReference = LspLocation & { lineText: string; isDefinition?: boolean }
export type LspTextEdit = LspRange & { newText: string }
export type LspRenameResult = { canRename: boolean; reason?: string; edits: { path: string; edits: LspTextEdit[] }[] }
export type TsLanguageService = {
  updateDocument(relativePath: string, content: string, version?: number): Promise<void>
  closeDocument(relativePath: string): Promise<void>
  refreshFiles(): Promise<void>
  diagnostics(relativePath?: string): Promise<LspDiagnostic[]>
  completions(relativePath: string, line: number, column: number): Promise<LspCompletion[]>
  hover(relativePath: string, line: number, column: number): Promise<LspHover | null>
  definition(relativePath: string, line: number, column: number): Promise<LspLocation[]>
  references(relativePath: string, line: number, column: number): Promise<LspReference[]>
  renamePreview(relativePath: string, line: number, column: number, newName: string): Promise<LspRenameResult>
  dispose(): void
}

const excluded = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage'])
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i

/** In-memory overlays and rename previews never write workspace files; refresh reloads disk/config state. */
export function createTsLanguageService(workspaceRoot: string): TsLanguageService {
  const root = fs.realpathSync(workspaceRoot)
  const overlays = new Map<string, { text: string; version: number }>()
  let files: string[] = [], projectVersion = 0, initialized = false, disposed = false
  let initializing: Promise<void> | undefined
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true,
  }
  let options = { ...defaults }
  const assertLive = () => { if (disposed) throw new Error('LSP_DISPOSED') }
  async function checked(relative: string) {
    assertLive()
    if (typeof relative !== 'string' || relative.replace(/\\/g, '/').split('/').includes('..')) throw new Error('PATH_OUTSIDE_WORKSPACE')
    return validateWorkspacePath(root, relative)
  }
  function sourceFile(file: string) {
    return sourceExtension.test(file) && !/^lib\..*\.d\.ts$/i.test(path.basename(file))
      && !path.relative(root, file).split(path.sep).some(part => excluded.has(part.toLowerCase()))
  }
  // The synchronous compiler host must also reject links introduced after discovery.
  function safeWorkspaceFile(file: string) {
    const relative = path.relative(root, file)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return true
    let current = root
    for (const part of relative.split(path.sep)) {
      if (part.toLowerCase() === '.git') return false
      current = path.join(current, part)
      try { if (fs.lstatSync(current).isSymbolicLink()) return false } catch { break }
    }
    return true
  }
  const read = (file: string) => safeWorkspaceFile(file) ? overlays.get(path.normalize(file))?.text ?? ts.sys.readFile(file) : undefined
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
    getScriptFileNames: () => [...new Set([...files, ...overlays.keys()])],
    getScriptVersion: file => `${projectVersion}:${overlays.get(path.normalize(file))?.version ?? 0}`,
    getProjectVersion: () => String(projectVersion),
    getScriptSnapshot: file => { const text = read(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text) },
    fileExists: file => safeWorkspaceFile(file) && (overlays.has(path.normalize(file)) || ts.sys.fileExists(file)),
    readFile: read,
    readDirectory: ts.sys.readDirectory,
    directoryExists: directory => safeWorkspaceFile(directory) && (ts.sys.directoryExists(directory)
      || [...overlays.keys()].some(file => file.startsWith(`${path.normalize(directory)}${path.sep}`))),
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    realpath: ts.sys.realpath,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  async function refreshFiles() {
    assertLive()
    let discovered: string[] = []
    async function walk(directory: string) {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase())) continue
        const absolute = path.join(directory, entry.name)
        const valid = await checked(path.relative(root, absolute))
        if (entry.isDirectory()) await walk(valid.target)
        else if (entry.isFile() && sourceFile(valid.target)) discovered.push(valid.target)
      }
    }
    await walk(root)
    options = { ...defaults }
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const config = await checked(name)
      if (!fs.existsSync(config.target)) continue
      // TypeScript's JSON diagnostic attachment expects compiler-style separators on Windows.
      try {
        const loaded = ts.readConfigFile(config.target.split(path.sep).join('/'), read)
        if (!loaded.error) {
          const parsed = ts.parseJsonConfigFileContent(loaded.config, { ...ts.sys, readFile: read, fileExists: host.fileExists }, root)
          if (!parsed.errors.length) {
            options = { ...parsed.options, noEmit: true }
            const allowed = new Set(discovered)
            discovered = parsed.fileNames.map(file => path.normalize(file)).filter(file => allowed.has(file))
          }
        }
      } catch {
        options = { ...defaults }
      }
      break
    }
    assertLive()
    files = discovered
    projectVersion++
    initialized = true
  }
  async function ready() {
    assertLive()
    if (!initialized) {
      initializing ??= refreshFiles().finally(() => { initializing = undefined })
      await initializing
    }
  }
  async function document(relative: string) {
    const valid = await checked(relative)
    await ready()
    if (!sourceFile(valid.target)) throw new Error('LSP_UNSUPPORTED_FILE')
    const text = read(valid.target)
    if (text === undefined) throw new Error('LSP_FILE_NOT_FOUND')
    if (!files.includes(valid.target) && !overlays.has(valid.target)) { files.push(valid.target); projectVersion++ }
    const source = ts.createSourceFile(valid.target, text, ts.ScriptTarget.Latest, true)
    return { ...valid, source, text }
  }
  function offset(source: ts.SourceFile, line: number, column: number) {
    const starts = source.getLineStarts()
    const boundedLine = Math.min(starts.length - 1, Math.max(0, Number.isFinite(line) ? Math.trunc(line) - 1 : 0))
    const start = starts[boundedLine]
    let end = starts[boundedLine + 1] ?? source.text.length
    while (end > start && /[\r\n]/.test(source.text[end - 1])) end--
    return Math.min(end, start + Math.max(0, Number.isFinite(column) ? Math.trunc(column) - 1 : 0))
  }
  function range(source: ts.SourceFile, span: ts.TextSpan): LspRange {
    const start = source.getLineAndCharacterOfPosition(Math.min(source.text.length, span.start))
    const end = source.getLineAndCharacterOfPosition(Math.min(source.text.length, span.start + span.length))
    return { line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 }
  }
  async function location(file: string, span: ts.TextSpan): Promise<LspLocation | null> {
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (relative.split('/').some(part => excluded.has(part.toLowerCase())) || !sourceExtension.test(relative)) return null
    try {
      const doc = await document(relative)
      return { path: doc.normalized, ...range(doc.source, span) }
    } catch { return null }
  }
  return {
    async updateDocument(relative, content, version) {
      const valid = await checked(relative)
      await ready()
      if (!sourceFile(valid.target)) throw new Error('LSP_UNSUPPORTED_FILE')
      const previous = overlays.get(valid.target)?.version ?? 0
      overlays.set(valid.target, { text: content, version: Math.max(previous + 1, Number.isFinite(version) ? version! : 0) })
      projectVersion++
    },
    async closeDocument(relative) {
      const valid = await checked(relative)
      overlays.delete(valid.target)
      projectVersion++
    },
    refreshFiles,
    async diagnostics(relative) {
      await ready()
      const targets = relative === undefined ? [...new Set([...files, ...overlays.keys()])] : [(await document(relative)).target]
      const result: LspDiagnostic[] = []
      for (const target of targets) {
        const doc = await document(path.relative(root, target))
        for (const diagnostic of [...service.getSyntacticDiagnostics(target), ...service.getSemanticDiagnostics(target)]) {
          if (!diagnostic.file) continue
          result.push({ path: doc.normalized, ...range(doc.source, { start: diagnostic.start ?? 0, length: diagnostic.length ?? 0 }),
            severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
            code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), source: 'ts' })
        }
      }
      return result
    },
    async completions(relative, line, column) {
      const doc = await document(relative)
      const position = offset(doc.source, line, column)
      const entries = service.getCompletionsAtPosition(doc.target, position, {})?.entries ?? []
      return entries.slice(0, 100).map(entry => ({ label: entry.name, kind: entry.kind, insertText: entry.insertText, sortText: entry.sortText }))
    },
    async hover(relative, line, column) {
      const doc = await document(relative)
      const info = service.getQuickInfoAtPosition(doc.target, offset(doc.source, line, column))
      return info ? { display: ts.displayPartsToString(info.displayParts), documentation: ts.displayPartsToString(info.documentation), range: range(doc.source, info.textSpan) } : null
    },
    async definition(relative, line, column) {
      const doc = await document(relative)
      const definitions = service.getDefinitionAtPosition(doc.target, offset(doc.source, line, column)) ?? []
      const locations = await Promise.all(definitions.map(item => location(item.fileName, item.textSpan)))
      return locations.filter((item): item is LspLocation => item !== null)
    },
    async references(relative, line, column) {
      const doc = await document(relative)
      const symbols = service.findReferences(doc.target, offset(doc.source, line, column)) ?? []
      const result: LspReference[] = []
      const seen = new Set<string>()
      for (const symbol of symbols) for (const ref of symbol.references) {
        const hit = await location(ref.fileName, ref.textSpan)
        if (!hit) continue
        const key = `${hit.path}:${hit.line}:${hit.column}`
        if (seen.has(key)) continue
        seen.add(key)
        const source = await document(hit.path)
        result.push({ ...hit, lineText: source.text.split(/\r?\n/)[hit.line - 1] ?? '', isDefinition: ref.isDefinition })
      }
      return result
    },
    async renamePreview(relative, line, column, newName) {
      const doc = await document(relative)
      const position = offset(doc.source, line, column)
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, newName)
      const token = scanner.scan()
      const identifier = token === ts.SyntaxKind.Identifier || (token >= ts.SyntaxKind.AbstractKeyword
        && token <= ts.SyntaxKind.LastKeyword && token !== ts.SyntaxKind.AwaitKeyword)
      if (!newName || !identifier || scanner.getTokenText() !== newName || scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
        return { canRename: false, reason: 'INVALID_IDENTIFIER', edits: [] }
      const info = service.getRenameInfo(doc.target, position)
      if (!info.canRename) return { canRename: false, reason: info.localizedErrorMessage, edits: [] }
      const locations = service.findRenameLocations(doc.target, position, false, false, { providePrefixAndSuffixTextForRename: false }) ?? []
      const groups = new Map<string, LspTextEdit[]>()
      for (const item of locations) {
        const hit = await location(item.fileName, item.textSpan)
        if (!hit) continue
        const { path: file, ...span } = hit
        const edits = groups.get(file) ?? []
        if (!edits.some(edit => edit.line === span.line && edit.column === span.column)) edits.push({ ...span, newText: newName })
        groups.set(file, edits)
      }
      return { canRename: true, edits: [...groups].map(([file, edits]) => ({ path: file, edits: edits.sort((a, b) => a.line - b.line || a.column - b.column) })) }
    },
    dispose() { disposed = true; service.dispose(); overlays.clear(); files = [] },
  }
}
