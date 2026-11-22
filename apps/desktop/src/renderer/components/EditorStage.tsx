import Editor, { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useEffect, useRef, useState } from 'react'
import type { LspDiagnostic, LspRange } from '../../../../../packages/ide-core/src/ts-lsp'
import { dirty, languageFor, tabID, tabIsDirty, type Buffer, type Tab } from '../state'
import { Empty, IconButton } from './Primitives'
import { navigationPosition, type NavigationTarget } from '../workspace-paths'

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

const modelUri = (projectID: string, path: string, mode = 'file') => `ame://${encodeURIComponent(projectID)}/${mode}/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`
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
    const languages = [{ language: 'typescript', scheme: 'ame' }, { language: 'javascript', scheme: 'ame' }]
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
export function EditorStage({ projectID, tabs, active, buffer, diff, theme, dirtyPaths, target, diagnostics, breakpoints, pausedLine, onToggleBreakpoint, onNavigateLocation, onSelect, onClose, onChange, onSave, onReload, onToggleSplit, isSplit, onStatus }: {
  projectID: string; tabs: Tab[]; dirtyPaths: ReadonlySet<string>; active?: Tab; buffer?: Buffer; diff?: { original: string; modified: string }; theme: 'dark' | 'light'; target?: NavigationTarget;
  diagnostics?: LspDiagnostic[]; breakpoints?: number[]; pausedLine?: number; onToggleBreakpoint?: (line: number) => void; onNavigateLocation?: (path: string, line: number, column: number) => void;
  onSelect: (tab: Tab) => void; onClose: (tab: Tab) => void; onChange: (text: string) => void; onSave: () => void; onReload: () => void; onToggleSplit: () => void; isSplit: boolean; onStatus: (status: EditorStatus) => void
}) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
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
  return <section data-testid="editor" className="stage" data-region="File & Diff">

    <div className="editor-tabs" role="tablist" aria-label="Tệp đang mở">{tabs.map(tab => <div className={`editor-tab ${active && tabID(active) === tabID(tab) ? 'selected' : ''}`} key={tabID(tab)}><button role="tab" aria-selected={!!active && tabID(active) === tabID(tab)} onClick={() => onSelect(tab)} title={tab.path}>{tab.mode === 'diff' ? '± ' : ''}{tab.path.split(/[\\/]/).pop()}{tabIsDirty(tab, dirtyPaths) ? ' ●' : ''}</button><IconButton label={`Đóng ${tab.path}`} onClick={() => onClose(tab)}>×</IconButton></div>)}</div>
    {active ? <><div className="editor-toolbar"><span className="truncate" title={active.path}>{active.path}</span>{active.mode === 'file' && <><button onClick={onSave} disabled={!buffer || !dirty(buffer)}>Lưu</button><button onClick={onReload} disabled={!buffer}>Nạp lại</button><button onClick={onToggleSplit}>{isSplit ? 'Gộp' : 'Chia đôi'}</button></>}{active.mode === 'diff' && <button aria-label="Chế độ diff" aria-pressed={split} title="Chuyển Split / Inline" onClick={() => setSplit(value => !value)}>{split ? 'Split' : 'Inline'}</button>}</div>
      {buffer?.conflict && active.mode === 'file' && <div className="warning" role="alert">Tệp trên đĩa đã thay đổi. Bản sửa được giữ lại; nạp lại để bỏ bản sửa và lấy phiên bản mới. Không ghi đè tự động.</div>}
      <div className="editor-surface">{active.mode === 'diff' ? diff ? <DiffEditor key={uri(active.path, 'diff')} keepCurrentOriginalModel keepCurrentModifiedModel original={diff.original} modified={diff.modified} originalModelPath={uri(active.path, 'head')} modifiedModelPath={uri(active.path, 'working')} language={languageFor(active.path)} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={{ ...options, readOnly: true, originalEditable: false, renderSideBySide: split, useInlineViewWhenSpaceIsLimited: false }} loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang tải diff với HEAD…</Empty> : buffer ? <Editor key={uri(active.path)} path={uri(active.path)} value={buffer.text} language={languageFor(active.path)} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={{ ...options, glyphMargin: true }} onMount={instance => { editor.current = instance; instance.onDidDispose(() => { if (editor.current === instance) editor.current = null }); setMounted(value => value + 1) }} onChange={value => onChange(value ?? '')} keepCurrentModel saveViewState loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang đọc tệp…</Empty>}</div></> : <Empty><strong>Không có tệp đang mở</strong><p>Chọn tệp trong Explorer hoặc thay đổi trong Git.</p></Empty>}
  </section>
}
