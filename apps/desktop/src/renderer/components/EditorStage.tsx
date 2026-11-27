import Editor, { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { LspDiagnostic, LspRange } from '../../../../../packages/ide-core/src/ts-lsp'
import { dirty, languageFor, tabID, tabTitle, tabIsDirty, type Buffer, type Tab } from '../state'
import { Empty, IconButton } from './Primitives'
import { Icon } from './Icon'
import { navigationPosition, type NavigationTarget } from '../workspace-paths'
import { modelUri, synchronizeCleanFileModel } from '../editor-model-lifecycle'
import type { DiffContent } from '../../../../../packages/protocol/src/index'
import { ensureMonacoShikiLanguage, shikiThemeName } from '../monaco-shiki'
import { isMarkdownFile } from '../markdown-files'

const LazyMarkdownViewer = lazy(() => import('./MarkdownViewerPane'))

self.MonacoEnvironment = { getWorker(_moduleID: string, label: string) {
  if (label === 'json') return new JsonWorker()
  if (['css', 'scss', 'less'].includes(label)) return new CssWorker()
  if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker()
  if (['typescript', 'javascript'].includes(label)) return new TsWorker()
  return new EditorWorker()
} }
loader.config({ monaco })
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true })
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true })

function fileLocation(uri: monaco.Uri) {
  if (uri.scheme !== 'ame' || !uri.path.startsWith('/file/') || uri.query || uri.fragment) return null
  // Monaco parses percent escapes already; decode the serialized components exactly once.
  const encoded = /^ame:\/\/([^/]+)\/file\/([^?#]+)$/.exec(uri.toString())
  if (!encoded) return null
  try {
    const projectID = uri.authority
    const parts = encoded[2].split('/').map(decodeURIComponent)
    if (!projectID || projectID.includes('\0') || parts.some(part => !part || part === '.' || part === '..' || /[\\/\0:]/.test(part))) return null
    return { projectID, relativePath: parts.join('/') }
  } catch { return null }
}
const lspRange = (range: LspRange) => new monaco.Range(range.line, range.column, range.endLine, range.endColumn)
async function requestLsp<T>(model: monaco.editor.ITextModel, token: monaco.CancellationToken, request: (projectID: string, path: string) => Promise<T>): Promise<T | null> {
  const location = fileLocation(model.uri)
  if (!location || token.isCancellationRequested || model.isDisposed()) return null
  const version = model.getVersionId()
  try {
    await window.ame.lspUpdateDocument(location.projectID, location.relativePath, model.getValue())
    if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null
    const result = await request(location.projectID, location.relativePath)
    return token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version ? null : result
  } catch { return null }
}
const completionKinds: Record<string, monaco.languages.CompletionItemKind> = {
  method: monaco.languages.CompletionItemKind.Method, function: monaco.languages.CompletionItemKind.Function,
  constructor: monaco.languages.CompletionItemKind.Constructor, property: monaco.languages.CompletionItemKind.Property,
  getter: monaco.languages.CompletionItemKind.Property, setter: monaco.languages.CompletionItemKind.Property,
  class: monaco.languages.CompletionItemKind.Class, interface: monaco.languages.CompletionItemKind.Interface,
  enum: monaco.languages.CompletionItemKind.Enum, 'enum member': monaco.languages.CompletionItemKind.EnumMember,
  module: monaco.languages.CompletionItemKind.Module, keyword: monaco.languages.CompletionItemKind.Keyword,
  const: monaco.languages.CompletionItemKind.Constant, 'type parameter': monaco.languages.CompletionItemKind.TypeParameter,
}
type LocationOpener = (source: monaco.editor.ICodeEditor, projectID: string, path: string, line: number, column: number) => boolean
const locationOpeners = new Set<LocationOpener>()
let lspRegistrations: monaco.IDisposable[] | undefined
function retainLspProviders(opener: LocationOpener) {
  locationOpeners.add(opener)
  if (!lspRegistrations) {
    const languages = [{ language: 'typescript', scheme: 'ame' }, { language: 'tsx', scheme: 'ame' }, { language: 'javascript', scheme: 'ame' }, { language: 'jsx', scheme: 'ame' }]
    lspRegistrations = [
      monaco.languages.registerCompletionItemProvider(languages, {
        triggerCharacters: ['.'],
        async provideCompletionItems(model, position, _context, token) {
          const word = model.getWordUntilPosition(position)
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          const items = await requestLsp(model, token, (project, path) => window.ame.lspCompletions(project, path, position.lineNumber, position.column))
          return { suggestions: (items ?? []).map(item => ({ label: item.label, kind: completionKinds[item.kind] ?? monaco.languages.CompletionItemKind.Variable, detail: item.detail, insertText: item.insertText ?? item.label, sortText: item.sortText, range })) }
        },
      }),
      monaco.languages.registerHoverProvider(languages, {
        async provideHover(model, position, token) {
          const hover = await requestLsp(model, token, (project, path) => window.ame.lspHover(project, path, position.lineNumber, position.column))
          if (!hover) return null
          return { range: lspRange(hover.range), contents: [{ value: `\`\`\`typescript\n${hover.display}\n\`\`\`` }, ...(hover.documentation ? [{ value: hover.documentation, isTrusted: false }] : [])] }
        },
      }),
      monaco.languages.registerDefinitionProvider(languages, {
        async provideDefinition(model, position, token) {
          const source = fileLocation(model.uri)
          if (!source) return null
          const locations = await requestLsp(model, token, (project, path) => window.ame.lspDefinition(project, path, position.lineNumber, position.column))
          return locations?.map(location => ({ uri: monaco.Uri.parse(modelUri(source.projectID, location.path)), range: lspRange(location) })) ?? null
        },
      }),
      monaco.languages.registerReferenceProvider(languages, {
        async provideReferences(model, position, context, token) {
          const source = fileLocation(model.uri)
          if (!source) return null
          const locations = await requestLsp(model, token, (project, path) => window.ame.lspReferences(project, path, position.lineNumber, position.column))
          return locations?.filter(location => context.includeDeclaration || !location.isDefinition).map(location => ({ uri: monaco.Uri.parse(modelUri(source.projectID, location.path)), range: lspRange(location) })) ?? null
        },
      }),
      monaco.editor.registerEditorOpener({
        openCodeEditor(source, resource, selection) {
          const location = fileLocation(resource)
          if (!location) return false
          const line = selection && 'startLineNumber' in selection ? selection.startLineNumber : selection?.lineNumber ?? 1
          const column = selection && 'startColumn' in selection ? selection.startColumn : selection?.column ?? 1
          for (const open of locationOpeners) if (open(source, location.projectID, location.relativePath, line, column)) return true
          return false
        },
      }),
    ]
  }
  return () => {
    locationOpeners.delete(opener)
    if (!locationOpeners.size) {
      lspRegistrations?.forEach(registration => registration.dispose())
      lspRegistrations = undefined
    }
  }
}
const markerOwners = new Map<monaco.editor.ITextModel, number>()
const options: monaco.editor.IStandaloneEditorConstructionOptions = { automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 16 }, wordWrap: 'off', tabSize: 2, insertSpaces: true, detectIndentation: true }
export type EditorStatus = { line: number; column: number; language: string; encoding: 'UTF-8'; indent: string; lineCount: number }
export function EditorStage({ projectID, tabs, active, buffer, loadError, diff, theme, dirtyPaths, target, diagnostics, breakpoints, pausedLine, onToggleBreakpoint, onNavigateLocation, onSelect, onClose, onChange, onSave, onOverwrite, onReload, onToggleSplit, isSplit, onStatus, isMac, onReveal }: {
  projectID: string; tabs: Tab[]; dirtyPaths: ReadonlySet<string>; active?: Tab; buffer?: Buffer; loadError?: string; diff?: DiffContent; theme: 'dark' | 'light'; target?: NavigationTarget;
  diagnostics?: LspDiagnostic[]; breakpoints?: number[]; pausedLine?: number; onToggleBreakpoint?: (line: number) => void; onNavigateLocation?: (path: string, line: number, column: number) => void;
  isMac?: boolean; onReveal?: (path: string) => void;
  onOverwrite?: () => void;
  onSelect: (tab: Tab) => void; onClose: (tab: Tab) => void; onChange: (text: string) => void; onSave: () => void; onReload: () => void; onToggleSplit: () => void; isSplit: boolean; onStatus: (status: EditorStatus) => void
}) {
  const revealLabel = isMac ? 'Show in Finder' : 'Show in File Explorer'
  const activeLang = active ? languageFor(active.path) : 'plaintext'
  const [shikiReady, setShikiReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void ensureMonacoShikiLanguage(monaco, 'plaintext').then(ready => {
      if (!cancelled && ready) setShikiReady(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    let cancelled = false
    void ensureMonacoShikiLanguage(monaco, activeLang).then(ready => {
      if (!cancelled && ready) setShikiReady(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [activeLang, active?.path, active?.mode])
  useEffect(() => {
    monaco.editor.setTheme(shikiThemeName(theme, shikiReady))
  }, [theme, shikiReady])
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const bufferRef = useRef(buffer); bufferRef.current = buffer
  const navigationRef = useRef({ projectID, active, onNavigateLocation, onToggleBreakpoint })
  navigationRef.current = { projectID, active, onNavigateLocation, onToggleBreakpoint }
  useEffect(() => retainLspProviders((source, project, path, line, column) => {
    const current = navigationRef.current
    if (source !== editor.current || current.active?.mode !== 'file' || current.projectID !== project || !current.onNavigateLocation) return false
    current.onNavigateLocation(path, line, column)
    return true
  }), [])
  const [mounted, setMounted] = useState(0)
  const [split, setSplit] = useState(true)
  const [markdownPreviewTabs, setMarkdownPreviewTabs] = useState<ReadonlySet<string>>(() => new Set())
  const revealedTargetNonce = useRef<number | undefined>(undefined)
  const activeTabId = active ? tabID(active) : ''
  const canPreviewMarkdown = active?.mode === 'file' && isMarkdownFile(active.path)
  const isMarkdownPreview = !!(canPreviewMarkdown && buffer && markdownPreviewTabs.has(activeTabId))
  useEffect(() => {
    const position = navigationPosition(target, projectID, active?.path, active?.mode)
    if (!position || !target || revealedTargetNonce.current === target.nonce) return
    revealedTargetNonce.current = target.nonce
    if (markdownPreviewTabs.has(activeTabId)) {
      setMarkdownPreviewTabs(current => {
        if (!current.has(activeTabId)) return current
        const next = new Set(current)
        next.delete(activeTabId)
        return next
      })
    }
  }, [target, projectID, active?.path, active?.mode, activeTabId, markdownPreviewTabs])
  useEffect(() => {
    setMarkdownPreviewTabs(current => {
      if (current.size === 0) return current
      const openIds = new Set(tabs.map(tabID))
      let changed = false
      const next = new Set<string>()
      for (const id of current) {
        if (openIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : current
    })
  }, [tabs])
  const applied = useRef<{ editor: monaco.editor.IStandaloneCodeEditor; nonce: number } | undefined>(undefined)
  useEffect(() => {
    const position = navigationPosition(target, projectID, active?.path, active?.mode)
    const instance = editor.current
    if (!position || !target || !buffer || !instance || instance.getModel()?.uri.toString() !== monaco.Uri.parse(uri(target.path)).toString()) return
    if (applied.current?.editor === instance && applied.current.nonce === target.nonce) return
    instance.revealLineInCenter(position.lineNumber)
    instance.setPosition(position)
    instance.focus()
    applied.current = { editor: instance, nonce: target.nonce }
  }, [target, projectID, active?.path, active?.mode, buffer, mounted])
  const statusRef = useRef(onStatus); statusRef.current = onStatus
  useEffect(() => {
    const instance = editor.current
    if (!instance || active?.mode !== 'file' || !buffer) return
    const publish = () => {
      const model = instance.getModel(), position = instance.getPosition()
      if (!model || !position) return
      const settings = model.getOptions()
      statusRef.current({ line: position.lineNumber, column: position.column, language: model.getLanguageId(), encoding: 'UTF-8', indent: settings.insertSpaces ? `Spaces: ${settings.tabSize}` : `Tabs: ${settings.tabSize}`, lineCount: model.getLineCount() })
    }
    publish()
    const subscriptions = [instance.onDidChangeCursorPosition(publish), instance.onDidChangeModel(publish), instance.onDidChangeModelContent(publish), instance.onDidChangeModelOptions(publish)]
    return () => subscriptions.forEach(subscription => subscription.dispose())
  }, [mounted, active?.path, active?.mode, !!buffer])
  useEffect(() => {
    const instance = editor.current
    if (!instance || active?.mode !== 'file' || !buffer) return
    const subscription = instance.onMouseDown(event => {
      const model = instance.getModel()
      const location = model && fileLocation(model.uri)
      const current = navigationRef.current
      const line = event.target.position?.lineNumber
      if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line && Number.isSafeInteger(line) && line > 0 && model && line <= model.getLineCount()
        && location?.projectID === current.projectID && location.relativePath === current.active?.path.replace(/\\/g, '/') && current.active.mode === 'file') current.onToggleBreakpoint?.(line)
    })
    return () => subscription.dispose()
  }, [mounted, projectID, active?.path, active?.mode, !!buffer])
  useEffect(() => {
    const model = editor.current?.getModel()
    if (!model || model.isDisposed() || active?.mode !== 'file' || !buffer || model.uri.toString() !== monaco.Uri.parse(modelUri(projectID, active.path)).toString()) return
    markerOwners.set(model, (markerOwners.get(model) ?? 0) + 1)
    monaco.editor.setModelMarkers(model, 'ame-ts-lsp', (diagnostics ?? []).filter(item => item.path.replace(/\\/g, '/') === active.path.replace(/\\/g, '/')).map(item => ({
      startLineNumber: item.line, startColumn: item.column, endLineNumber: item.endLine, endColumn: item.endColumn,
      message: item.message, source: item.source, code: String(item.code),
      severity: item.severity === 'error' ? monaco.MarkerSeverity.Error : item.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
    })))
    return () => {
      const remaining = (markerOwners.get(model) ?? 1) - 1
      if (remaining) markerOwners.set(model, remaining)
      else {
        markerOwners.delete(model)
        if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'ame-ts-lsp', [])
      }
    }
  }, [mounted, projectID, active?.path, active?.mode, !!buffer, diagnostics])
  useEffect(() => {
    const instance = editor.current, model = instance?.getModel()
    if (!instance || !model || model.isDisposed() || active?.mode !== 'file' || !buffer || model.uri.toString() !== monaco.Uri.parse(modelUri(projectID, active.path)).toString()) return
    const decorations = instance.createDecorationsCollection()
    const update = () => {
      const validLine = (line: number) => Number.isSafeInteger(line) && line > 0 && line <= model.getLineCount()
      const entries: monaco.editor.IModelDeltaDecoration[] = [...new Set(breakpoints ?? [])].filter(validLine).map(line => ({
        range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'ame-breakpoint-glyph', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      }))
      if (pausedLine !== undefined && validLine(pausedLine)) entries.push({
        range: new monaco.Range(pausedLine, 1, pausedLine, 1),
        options: { isWholeLine: true, className: 'ame-debug-paused-line', glyphMarginClassName: 'ame-debug-paused-glyph', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      })
      decorations.set(entries)
    }
    update()
    const subscription = model.onDidChangeContent(update)
    return () => { subscription.dispose(); decorations.clear() }
  }, [mounted, projectID, active?.path, active?.mode, !!buffer, breakpoints, pausedLine])
  const uri = (path: string, mode = 'file') => modelUri(projectID, path, mode)
  const unavailable = diff && (diff.binary || diff.tooLarge)
  return <section data-testid="editor" className="stage" data-region="File & Diff">

    <div className="editor-tabs" role="tablist" aria-label="Tệp đang mở">{tabs.map(tab => <div className={`editor-tab ${active && tabID(active) === tabID(tab) ? 'selected' : ''}`} key={tabID(tab)}><button role="tab" data-tab-id={tabID(tab)} data-tab-path={tab.path} data-tab-mode={tab.mode} aria-selected={!!active && tabID(active) === tabID(tab)} onClick={() => onSelect(tab)} title={tab.mode === 'file' ? tab.path : `${tab.path} · ${tabTitle(tab)}`}>{tab.mode === 'diff' ? '± ' : ''}{tabTitle(tab)}{tabIsDirty(tab, dirtyPaths) ? ' ●' : ''}</button><IconButton label={`Đóng ${tabTitle(tab)}`} onClick={() => onClose(tab)}>×</IconButton></div>)}</div>
    {active ? <><div className="editor-toolbar"><span className="truncate" title={active.path}>{active.path}</span>{active.mode === 'file' && <>{canPreviewMarkdown && <button type="button" className={isMarkdownPreview ? 'is-active' : undefined} data-testid="editor-md-viewer-btn" aria-pressed={isMarkdownPreview} title={isMarkdownPreview ? 'Chuyển sang sửa mã nguồn' : 'Mở MD Viewer'} disabled={!buffer} onClick={() => setMarkdownPreviewTabs(current => { const next = new Set(current); if (next.has(activeTabId)) next.delete(activeTabId); else next.add(activeTabId); return next })}>{isMarkdownPreview ? 'Mã nguồn' : 'MD Viewer'}</button>}<button onClick={onSave} disabled={!buffer || !dirty(buffer)}>Lưu</button><button onClick={onReload} disabled={!buffer}>Nạp lại</button><button onClick={onToggleSplit}>{isSplit ? 'Gộp' : 'Chia đôi'}</button></>}{active.mode === 'diff' && diff?.patch === undefined && <button aria-label="Chế độ diff" aria-pressed={split} title="Chuyển Split / Inline" onClick={() => setSplit(value => !value)}>{split ? 'Split' : 'Inline'}</button>}</div>
      {buffer?.conflict && active.mode === 'file' && <div className="warning" role="alert">Tệp trên đĩa đã thay đổi. Bản sửa được giữ lại; nạp lại để bỏ bản sửa và lấy phiên bản mới. Không ghi đè tự động.<button type="button" onClick={onOverwrite}>Lưu đè</button><button type="button" onClick={onReload}>Nạp lại</button></div>}
      <div className="editor-surface">{active.mode === 'diff' && unavailable ? <Empty><strong>Không có bản xem trước: {active.path}</strong><p>Gốc: {diff.originalSize ?? 0} bytes · Thay đổi: {diff.modifiedSize ?? 0} bytes</p><p>{diff.reason || (diff.tooLarge ? 'Tệp vượt giới hạn 4 MiB.' : 'Tệp nhị phân không thể hiển thị dưới dạng văn bản.')}</p>{onReveal && <div className="button-row"><button type="button" className="editor-reveal-btn" data-testid="editor-reveal-btn" onClick={() => onReveal(active.path)}><Icon name="folder" /><span>{revealLabel}</span></button></div>}</Empty> : active.mode === 'diff' ? diff?.patch !== undefined ? <pre className="git-commit-patch" data-testid="diff-patch-view">{diff.patch}</pre> : diff ? <DiffEditor key={uri(tabID(active), 'diff')} keepCurrentOriginalModel keepCurrentModifiedModel original={diff.original} modified={diff.modified} originalModelPath={uri(tabID(active), 'original')} modifiedModelPath={uri(tabID(active), 'modified')} language={activeLang} theme={shikiThemeName(theme, shikiReady)} options={{ ...options, readOnly: true, originalEditable: false, renderSideBySide: split, useInlineViewWhenSpaceIsLimited: false }} loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang tải diff…</Empty> : buffer ? isMarkdownPreview ? <Suspense fallback={<Empty>Đang tải MD Viewer…</Empty>}><LazyMarkdownViewer content={buffer.text} theme={theme} filePath={active.path} onOpenFile={onNavigateLocation ? targetPath => onNavigateLocation(targetPath, 1, 1) : undefined} /></Suspense> : <Editor key={uri(active.path)} path={uri(active.path)} value={buffer.text} language={activeLang} theme={shikiThemeName(theme, shikiReady)} options={{ ...options, glyphMargin: true }} beforeMount={api => {
        const current = bufferRef.current
        if (current) synchronizeCleanFileModel(api.editor.getModel(api.Uri.parse(modelUri(current.projectID, current.path))), current)
      }} onMount={instance => { editor.current = instance; instance.onDidDispose(() => { if (editor.current === instance) editor.current = null }); setMounted(value => value + 1) }} onChange={value => onChange(value ?? '')} keepCurrentModel saveViewState loading={<Empty>Đang tải Monaco…</Empty>} /> : loadError ? <div className="editor-load-error" role="alert"><strong>Không thể mở tệp</strong><p>{loadError}</p><div className="button-row"><button type="button" onClick={onReload}>Thử lại</button>{onReveal && <button type="button" className="editor-reveal-btn" data-testid="editor-reveal-btn" onClick={() => onReveal(active.path)}><Icon name="folder" /><span>{revealLabel}</span></button>}<button type="button" onClick={() => onClose(active)}>Đóng tab</button></div></div> : <Empty>Đang đọc tệp…</Empty>}</div></> : <Empty><strong>Không có tệp đang mở</strong><p>Chọn tệp trong Explorer hoặc thay đổi trong Git.</p></Empty>}
  </section>
}
