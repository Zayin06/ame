import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { ComposerAttachmentStrip, ComposerDropOverlay, MessageAttachmentList } from '../components/ComposerAttachments'
import { classifyBrowserFile, composePromptWithAttachments, MAX_EXTERNAL_TEXT_BYTES, MAX_MEDIA_BYTES, MAX_PROMPT_FILES, readBrowserFileAttachment, splitComposerAttachments, WORKSPACE_DRAG_MIME, type ComposerAttachment } from '../composer-mentions'
import { composerAttachmentSizeError } from '../composer-mentions'
import { attachmentBatchSizeError, encodedAttachmentBytes, MAX_ATTACHMENT_ENCODED_BYTES } from '../../../../../packages/ide-core/src/dropped-attachments'
import { humanizeIdeError } from '../components/Primitives'

const media = (id = 'image', extra: Partial<Extract<ComposerAttachment, { dataUrl: string }>> = {}): ComposerAttachment => ({
  id, kind: 'media', name: 'image (1).png', mime: 'image/png', dataUrl: 'data:image/png;base64,YQ==', size: 1, ...extra
})
function browserFile(name: string, bytes: Uint8Array, type = ''): File {
  return { name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer } as File
}

test('workspace and selection prompt context is unchanged while inline attachments leave text untouched', () => {
  const file: ComposerAttachment = { id: 'file', kind: 'file', path: 'src/App.ts' }
  const selection: ComposerAttachment = { id: 'selection', kind: 'selection', path: 'ảnh.ts', lineStart: 2, lineEnd: 4, excerpt: 'const a = 1\n```' }
  const inline = [media(), media('text', { kind: 'external-text', mime: 'text/plain' })]
  const prompt = '@src/App.ts\n\n@ảnh.ts:2-4\n````\nconst a = 1\n```\n````\n\n  question\n'
  assert.equal(composePromptWithAttachments('  question\n', [file, media(), { ...file, id: 'duplicate' }, selection]), prompt)
  assert.equal(composePromptWithAttachments('  question\n', inline), '  question\n')
  assert.equal(composePromptWithAttachments('', inline), '')
  assert.equal(composePromptWithAttachments('question', [{ ...file, path: '' }]), 'question')
})

test('split deduplicates by data URL and name, preserves mentions and caps unique inline files at eight', () => {
  const inline = Array.from({ length: MAX_PROMPT_FILES + 2 }, (_, i) => media(String(i), { name: `image ${i}.png` }))
  const attachments = Object.freeze([{ id: 'file', kind: 'file' as const, path: 'src/App.ts' }, ...inline, { ...inline[0], id: 'duplicate' }, { ...inline.at(-1)!, id: 'overflow-duplicate' }])
  const before = JSON.stringify(attachments)
  const result = splitComposerAttachments('question', attachments)
  assert.equal(result.text, '@src/App.ts\n\nquestion')
  assert.equal(result.truncatedCount, 2)
  assert.deepEqual(result.files, inline.slice(0, 8).map(item => {
    assert.ok('dataUrl' in item)
    return { uri: item.dataUrl, name: item.name, mime: item.mime, source: { type: 'inline' } }
  }))
  assert.equal(JSON.stringify(attachments), before)
  assert.deepEqual(splitComposerAttachments('text', []), { text: 'text', files: [], truncatedCount: 0 })
  assert.equal(splitComposerAttachments('', [media(), media('other', { dataUrl: 'data:image/png;base64,Yg==' })]).files.length, 2)
})

test('browser classification accepts supported media by MIME or extension and known text/code extensions', () => {
  for (const [name, type, mime] of [['image (1).png', '', 'image/png'], ['ảnh.JPG', '', 'image/jpeg'], ['x.webp', '', 'image/webp'], ['x.gif', '', 'image/gif'], ['document.pdf', '', 'application/pdf'], ['blob', 'image/png', 'image/png']] as const) {
    assert.deepEqual(classifyBrowserFile({ name, type, size: MAX_MEDIA_BYTES }), { ok: true, kind: 'media', mime })
  }
  for (const name of ['file.txt', 'README.md', 'code.TSX', 'settings.env.example', 'icon.svg', 'build.gradle', 'script.ps1']) {
    assert.deepEqual(classifyBrowserFile({ name, size: MAX_EXTERNAL_TEXT_BYTES }), { ok: true, kind: 'external-text', mime: 'text/plain' })
  }
  for (const [name, type, size, reason] of [
    ['empty.png', 'image/png', 0, /rỗng/], ['large.pdf', '', MAX_MEDIA_BYTES + 1, /6 MiB/],
    ['large.ts', '', MAX_EXTERNAL_TEXT_BYTES + 1, /512 KiB/], ['archive.zip', 'application/zip', 1, /Không hỗ trợ/],
    ['file.constructor', '', 1, /Không hỗ trợ/], ['file.bmp', 'image/bmp', 1, /Không hỗ trợ/]
  ] as const) {
    const result = classifyBrowserFile({ name, type, size })
    assert.ok(!result.ok); assert.match(result.reason, reason)
  }
})

test('browser reads preserve names and bytes in clean chunked base64 for images, PDF and text', async () => {
  for (const [name, type, content] of [
    ['image (1).png', 'image/png', Uint8Array.of(0, 255, 1)],
    ['ảnh chụp.png', '', Uint8Array.of(1, 2, 3)],
    ['document.pdf', 'application/pdf', Uint8Array.of(37, 80, 68, 70)],
    ['notes.md', '', new TextEncoder().encode('Chào thế giới\n'.repeat(8000))]
  ] as const) {
    const result = await readBrowserFileAttachment(browserFile(name, content, type))
    assert.ok(result.ok && result.kind !== 'workspace-file')
    assert.equal(result.name, name)
    assert.equal(result.size, content.length)
    assert.equal(result.kind, name.endsWith('.md') ? 'external-text' : 'media')
    assert.equal(result.mime, name.endsWith('.md') ? 'text/plain' : name.endsWith('.pdf') ? 'application/pdf' : 'image/png')
    assert.doesNotMatch(result.dataUrl, /\s/)
    assert.deepEqual(Buffer.from(result.dataUrl.split(',')[1], 'base64'), Buffer.from(content))
  }
})

test('browser reads reject empty, oversized, NUL and invalid UTF-8 files and recover from read failures', async () => {
  for (const [bytes, reason] of [[new Uint8Array(), /rỗng/], [Uint8Array.of(1, 0), /nhị phân/], [Uint8Array.of(0xc3, 0x28), /nhị phân/]] as const) {
    const result = await readBrowserFileAttachment(browserFile('file.txt', bytes))
    assert.ok(!result.ok); assert.match(result.reason, reason)
  }
  let reads = 0
  const oversized = { name: 'large.png', type: 'image/png', size: 7 * 1024 * 1024, async arrayBuffer() { reads++; return new ArrayBuffer(0) } } as File
  assert.equal((await readBrowserFileAttachment(oversized)).ok, false)
  assert.equal(reads, 0)
  const failed = await readBrowserFileAttachment({ name: 'bad.txt', size: 1, arrayBuffer: async () => { throw new Error('unreadable') } } as unknown as File)
  assert.ok(!failed.ok); assert.match(failed.reason, /Không thể đọc/)
  const growing = await readBrowserFileAttachment({ ...browserFile('growing.txt', new Uint8Array(MAX_EXTERNAL_TEXT_BYTES + 1)), size: 1 } as File)
  assert.ok(!growing.ok); assert.match(growing.reason, /512 KiB/)
})

test('7 MiB image is rejected before reading with its name and the actual encoded limit', async () => {
  const file = { name: 'ảnh lớn.png', type: 'image/png', size: 7 * 1024 * 1024, arrayBuffer() { throw new Error('must not read') } } as unknown as File
  const result = await readBrowserFileAttachment(file)
  assert.ok(!result.ok)
  assert.equal(result.name, file.name)
  assert.match(result.reason, /ảnh lớn\.png/)
  assert.match(result.reason, /6 MiB sau base64/)
  assert.match(result.reason, /4\.50 MiB/)
})

test('base64 budget includes padding and MIME prefix and accepts the exact boundary', () => {
  assert.equal(encodedAttachmentBytes(1, 'image/png'), 'data:image/png;base64,'.length + 4)
  assert.equal(encodedAttachmentBytes(3, 'image/png'), encodedAttachmentBytes(1, 'image/png'))
  assert.equal(encodedAttachmentBytes(4, 'image/png'), 'data:image/png;base64,'.length + 8)
  const mime = 'image/jpeg' // 23-byte prefix
  const size = Math.floor((MAX_ATTACHMENT_ENCODED_BYTES - encodedAttachmentBytes(0, mime)) / 4) * 3
  assert.equal(attachmentBatchSizeError([{ mime, size }]), undefined)
  assert.match(attachmentBatchSizeError([{ mime, size: size + 1 }])!, /Tổng dung lượng/)
})

test('whole draft validation catches several small images across batches without mutating attachments', () => {
  const draft = Object.freeze([media('1', { name: 'one.png', size: 2 * 1024 * 1024 }), media('2', { name: 'two.png', size: 2 * 1024 * 1024 })])
  assert.equal(composerAttachmentSizeError(draft), undefined)
  const combined = Object.freeze([...draft, media('3', { name: 'three.png', size: 2 * 1024 * 1024 })])
  const error = composerAttachmentSizeError(combined)
  assert.match(error!, /Tổng dung lượng.*vượt mức 6 MiB/)
  assert.match(error!, /bỏ bớt tệp trên bản nháp/)
  assert.equal(combined.length, 3)
  assert.equal(draft.length, 2)
  assert.equal(composerAttachmentSizeError([draft[0], { ...draft[0], id: 'duplicate' }]), undefined)
})

test('gateway payload error is explained in Vietnamese, including base64, history and how to retry', () => {
  const text = humanizeIdeError(new Error('HTTP 413 {"error":{"code":"AMECODE_REQUEST_TOO_LARGE"}}'))
  for (const detail of ['base64', '8 MiB', 'JSON', 'lịch sử', 'bỏ bớt tệp trên bản nháp', 'gửi lại']) assert.ok(text.includes(detail), detail)
  assert.doesNotMatch(text, /403|đăng nhập|quyền truy cập/)
})

test('attachment strip SSR renders image/file/selection/PDF/text chips and removal handlers', () => {
  const attachments: ComposerAttachment[] = [
    { id: 'file', kind: 'file', path: 'src/App.ts' }, { id: 'selection', kind: 'selection', path: 'src/code.ts', lineStart: 1 },
    media('image', { size: 1024 }), media('pdf', { name: 'file.pdf', mime: 'application/pdf', size: 1048576 }),
    media('text', { kind: 'external-text', name: '<notes>.txt', mime: 'text/plain', size: 12 })
  ]
  const removed: string[] = []
  const tree = ComposerAttachmentStrip({ attachments, onRemove: id => removed.push(id) })
  const markup = renderToStaticMarkup(tree)
  for (const text of ['aria-label="Tệp đính kèm"', 'attachment-chip--media', 'class="attachment-thumb"', 'alt="image (1).png"', 'src/App.ts', 'src/code.ts', 'file.pdf', '&lt;notes&gt;.txt', '(1 KiB)', '(1 MiB)', '(12 B)', 'aria-label="Bỏ đính kèm image (1).png"']) assert.ok(markup.includes(text), text)
  assert.equal((markup.match(/<img\b/g) || []).length, 1)
  for (const button of elements(tree).filter(node => node.type === 'button')) (button.props.onClick as () => void)()
  assert.deepEqual(removed, attachments.map(item => item.id))
  assert.equal(ComposerAttachmentStrip({ attachments: [], onRemove() {} }), null)
})

test('overlay and message attachments SSR have accessible status, image captions and compact fallback badges', () => {
  assert.equal(ComposerDropOverlay({ active: false }), null)
  const overlay = renderToStaticMarkup(createElement(ComposerDropOverlay, { active: true }))
  assert.match(overlay, /role="status" aria-live="polite"/)
  assert.ok(overlay.includes('Thả tệp hoặc ảnh vào đây để đính kèm'))
  assert.equal(MessageAttachmentList({}), null)
  assert.equal(MessageAttachmentList({ attachments: [] }), null)
  const markup = renderToStaticMarkup(createElement(MessageAttachmentList, { attachments: [
    { name: 'ảnh.png', mime: 'image/png', dataUrl: 'data:image/png;base64,YQ==' },
    { name: 'remote.png', mime: 'image/png', uri: 'file:///remote.png' },
    { name: 'report.pdf', mime: 'application/pdf', size: 2048 }, { name: 'empty.txt', mime: 'text/plain', size: 0 }
  ] }))
  assert.match(markup, /class="msg-user-attachments"/)
  assert.match(markup, /class="msg-user-thumb"[^>]*alt="ảnh.png"/)
  assert.ok(markup.includes('<span>ảnh.png</span>'))
  assert.ok(markup.includes('remote.png')); assert.ok(markup.includes('(2 KiB)'))
  assert.equal((markup.match(/<img\b/g) || []).length, 1)
  assert.equal((markup.match(/class="attachment-chip"/g) || []).length, 3)
  assert.ok(!markup.includes('(0 B)'))
})

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}

test('Explorer real row renders draggable files only, emits workspace/plain payloads and blocks busy drags', () => {
  const filename = new URL('../components/Inspector.tsx', import.meta.url)
  const source = readFileSync(filename, 'utf8')
  const code = ts.transpileModule(`${source}\nexport { Directory }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const entries = [{ path: 'src/file (1).ts', name: 'file (1).ts', directory: false }, { path: 'folder', name: 'folder', directory: true }]
  let cursor = 0
  const state = [entries, '', false, {}]
  const exports: Record<string, unknown> = {}
  const nativeRequire = createRequire(filename)
  runInNewContext(code, { exports, require: (name: string) => name === 'react' ? {
    useState: () => [state[cursor++], () => {}], useEffect() {}, useRef: () => ({ current: null })
  } : nativeRequire(name) })
  const Directory = exports.Directory as (props: Record<string, unknown>) => ReactNode
  for (const busy of [false, true]) {
    cursor = 0
    const tree = Directory({ projectID: 'project', path: '', generation: 0, busy, naming: null, menu: null, onOpen() {} })
    const markup = renderToStaticMarkup(tree)
    const rows = elements(tree).filter(node => node.type === 'button' && node.props.className === 'tree-row insp-row')
    assert.equal(rows.length, 2)
    for (const [index, row] of rows.entries()) {
      const entry = entries[index]
      const draggable = !entry.directory && !busy
      assert.equal(row.props.draggable, draggable)
      assert.ok(markup.includes(`title="${entry.path}"`))
      const tag = markup.match(new RegExp(`<button[^>]*title="${entry.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`))![0]
      assert.ok(tag.includes(`draggable="${draggable}"`))
      const data = new Map<string, string>()
      let prevented = false
      const transfer = { setData(type: string, value: string) { data.set(type, value) }, effectAllowed: '' }
      ;(row.props.onDragStart as (event: unknown) => void)({ dataTransfer: transfer, preventDefault() { prevented = true } })
      assert.equal(prevented, !draggable)
      assert.deepEqual([...data], draggable ? [[WORKSPACE_DRAG_MIME, entry.path], ['text/plain', `@${entry.path}`]] : [])
      assert.equal(transfer.effectAllowed, draggable ? 'copy' : '')
    }
  }
})
