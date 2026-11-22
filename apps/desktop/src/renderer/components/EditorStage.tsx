import Editor, { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useEffect, useRef, useState } from 'react'
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
const options: monaco.editor.IStandaloneEditorConstructionOptions = { automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 16 }, wordWrap: 'off', tabSize: 2, insertSpaces: true, detectIndentation: true }
export type EditorStatus = { line: number; column: number; language: string; encoding: 'UTF-8'; indent: string; lineCount: number }
export function EditorStage({ projectID, tabs, active, buffer, diff, theme, dirtyPaths, target, onSelect, onClose, onChange, onSave, onReload, onToggleSplit, isSplit, onStatus }: {
  projectID: string; tabs: Tab[]; dirtyPaths: ReadonlySet<string>; active?: Tab; buffer?: Buffer; diff?: { original: string; modified: string }; theme: 'dark' | 'light'; target?: NavigationTarget;
  onSelect: (tab: Tab) => void; onClose: (tab: Tab) => void; onChange: (text: string) => void; onSave: () => void; onReload: () => void; onToggleSplit: () => void; isSplit: boolean; onStatus: (status: EditorStatus) => void
}) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
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
  const uri = (path: string, mode = 'file') => `ame://${encodeURIComponent(projectID)}/${mode}/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`
  return <section data-testid="editor" className="stage" data-region="File & Diff">

    <div className="editor-tabs" role="tablist" aria-label="Tệp đang mở">{tabs.map(tab => <div className={`editor-tab ${active && tabID(active) === tabID(tab) ? 'selected' : ''}`} key={tabID(tab)}><button role="tab" aria-selected={!!active && tabID(active) === tabID(tab)} onClick={() => onSelect(tab)} title={tab.path}>{tab.mode === 'diff' ? '± ' : ''}{tab.path.split(/[\\/]/).pop()}{tabIsDirty(tab, dirtyPaths) ? ' ●' : ''}</button><IconButton label={`Đóng ${tab.path}`} onClick={() => onClose(tab)}>×</IconButton></div>)}</div>
    {active ? <><div className="editor-toolbar"><span className="truncate" title={active.path}>{active.path}</span>{active.mode === 'file' && <><button onClick={onSave} disabled={!buffer || !dirty(buffer)}>Lưu</button><button onClick={onReload} disabled={!buffer}>Nạp lại</button><button onClick={onToggleSplit}>{isSplit ? 'Gộp' : 'Chia đôi'}</button></>}{active.mode === 'diff' && <button aria-label="Chế độ diff" aria-pressed={split} title="Chuyển Split / Inline" onClick={() => setSplit(value => !value)}>{split ? 'Split' : 'Inline'}</button>}</div>
      {buffer?.conflict && active.mode === 'file' && <div className="warning" role="alert">Tệp trên đĩa đã thay đổi. Bản sửa được giữ lại; nạp lại để bỏ bản sửa và lấy phiên bản mới. Không ghi đè tự động.</div>}
      <div className="editor-surface">{active.mode === 'diff' ? diff ? <DiffEditor key={uri(active.path, 'diff')} keepCurrentOriginalModel keepCurrentModifiedModel original={diff.original} modified={diff.modified} originalModelPath={uri(active.path, 'head')} modifiedModelPath={uri(active.path, 'working')} language={languageFor(active.path)} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={{ ...options, readOnly: true, originalEditable: false, renderSideBySide: split, useInlineViewWhenSpaceIsLimited: false }} loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang tải diff với HEAD…</Empty> : buffer ? <Editor key={uri(active.path)} path={uri(active.path)} value={buffer.text} language={languageFor(active.path)} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={options} onMount={instance => { editor.current = instance; setMounted(value => value + 1) }} onChange={value => onChange(value ?? '')} keepCurrentModel saveViewState loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang đọc tệp…</Empty>}</div></> : <Empty><strong>Không có tệp đang mở</strong><p>Chọn tệp trong Explorer hoặc thay đổi trong Git.</p></Empty>}
  </section>
}
