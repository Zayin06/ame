import Editor, { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useEffect } from 'react'
import { dirty, languageFor, tabID, tabIsDirty, type Buffer, type Tab } from '../state'
import { Empty, IconButton } from './Primitives'

self.MonacoEnvironment = { getWorker(_moduleID: string, label: string) {
  if (label === 'json') return new JsonWorker()
  if (['css', 'scss', 'less'].includes(label)) return new CssWorker()
  if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker()
  if (['typescript', 'javascript'].includes(label)) return new TsWorker()
  return new EditorWorker()
} }
loader.config({ monaco })
const options: monaco.editor.IStandaloneEditorConstructionOptions = { automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 16 }, wordWrap: 'off' }
export function EditorStage({ projectID, tabs, active, buffer, diff, theme, dirtyPaths, onSelect, onClose, onChange, onSave, onReload, onHide }: {
  projectID: string; tabs: Tab[]; dirtyPaths: ReadonlySet<string>; active?: Tab; buffer?: Buffer; diff?: { original: string; modified: string }; theme: 'dark' | 'light';
  onSelect: (tab: Tab) => void; onClose: (tab: Tab) => void; onChange: (text: string) => void; onSave: () => void; onReload: () => void; onHide: () => void
}) {
  useEffect(() => () => {
    const models = monaco.editor.getModels()
    // Child editor cleanup must finish before releasing retained models.
    queueMicrotask(() => { for (const model of models) if (!model.isDisposed()) model.dispose() })
  }, [])
  const uri = (path: string, mode = 'file') => `ame://${encodeURIComponent(projectID)}/${mode}/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`
  return <section data-testid="editor" className="stage" data-region="File & Diff">

    <div className="editor-tabs" role="tablist" aria-label="Tệp đang mở">{tabs.map(tab => <div className={`editor-tab ${active && tabID(active) === tabID(tab) ? 'selected' : ''}`} key={tabID(tab)}><button role="tab" aria-selected={!!active && tabID(active) === tabID(tab)} onClick={() => onSelect(tab)} title={tab.path}>{tab.mode === 'diff' ? '± ' : ''}{tab.path.split(/[\\/]/).pop()}{tabIsDirty(tab, dirtyPaths) ? ' ●' : ''}</button><IconButton label={`Đóng ${tab.path}`} onClick={() => onClose(tab)}>×</IconButton></div>)}</div>
    {active ? <><div className="editor-toolbar"><span className="truncate" title={active.path}>{active.path}</span>{active.mode === 'file' && <><button onClick={onSave} disabled={!buffer || !dirty(buffer)}>Lưu</button><button onClick={onReload} disabled={!buffer}>Nạp lại</button></>}</div>
      {buffer?.conflict && active.mode === 'file' && <div className="warning" role="alert">Tệp trên đĩa đã thay đổi. Bản sửa được giữ lại; nạp lại để bỏ bản sửa và lấy phiên bản mới. Không ghi đè tự động.</div>}
      <div className="editor-surface">{active.mode === 'diff' ? diff ? <DiffEditor key={uri(active.path, 'diff')} keepCurrentOriginalModel keepCurrentModifiedModel original={diff.original} modified={diff.modified} originalModelPath={uri(active.path, 'head')} modifiedModelPath={uri(active.path, 'working')} language={languageFor(active.path)} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={{ ...options, readOnly: true, originalEditable: false, renderSideBySide: true }} loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang tải diff với HEAD…</Empty> : buffer ? <Editor key={uri(active.path)} path={uri(active.path)} value={buffer.text} language={languageFor(active.path)} theme={theme === 'dark' ? 'vs-dark' : 'light'} options={options} onChange={value => onChange(value ?? '')} keepCurrentModel saveViewState loading={<Empty>Đang tải Monaco…</Empty>} /> : <Empty>Đang đọc tệp…</Empty>}</div></> : <Empty><strong>Không có tệp đang mở</strong><p>Chọn tệp trong Explorer hoặc thay đổi trong Git.</p></Empty>}
  </section>
}
