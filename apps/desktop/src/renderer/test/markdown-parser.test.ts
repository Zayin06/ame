import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseFileRef, parseInline, parseMarkdown, type InlineNode } from '../markdown-parser'
import { summarizeToolCall, ToolCard, type ToolCallView } from '../components/ToolCard'

const text = (value: string): InlineNode => ({ type: 'text', text: value })

test('parses all six heading levels, paragraphs and horizontal rules', () => {
  assert.deepEqual(parseMarkdown('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six'), ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((title, i) => ({ type: 'heading', level: i + 1, children: [text(title)] })))
  assert.deepEqual(parseMarkdown('## Title ##\n\nfirst\nsecond\n\n---\n***\n___'), [
    { type: 'heading', level: 2, children: [text('Title')] },
    { type: 'paragraph', children: [text('first\nsecond')] },
    { type: 'hr' }, { type: 'hr' }, { type: 'hr' },
  ])
  assert.deepEqual(parseMarkdown(''), [])
})

test('parses inline code, both emphasis spellings, strike, escaping and nested markup', () => {
  assert.deepEqual(parseInline('**bold** __bold__ *italic* _italic_ ~~gone~~ `code`'), [
    { type: 'strong', children: [text('bold')] }, text(' '), { type: 'strong', children: [text('bold')] }, text(' '),
    { type: 'em', children: [text('italic')] }, text(' '), { type: 'em', children: [text('italic')] }, text(' '),
    { type: 'del', children: [text('gone')] }, text(' '), { type: 'code', text: 'code' },
  ])
  assert.deepEqual(parseInline('**bold and *italic* text**'), [{ type: 'strong', children: [text('bold and '), { type: 'em', children: [text('italic')] }, text(' text')] }])
  assert.deepEqual(parseInline('***both***'), [{ type: 'strong', children: [{ type: 'em', children: [text('both')] }] }])
  assert.deepEqual(parseInline('**bold *italic***'), [{ type: 'strong', children: [text('bold '), { type: 'em', children: [text('italic')] }] }])
  assert.deepEqual(parseInline('*italic **bold***'), [{ type: 'em', children: [text('italic '), { type: 'strong', children: [text('bold')] }] }])
  for (const value of ['**unfinished', '__unfinished', '***unfinished', '~~unfinished', '``unfinished']) assert.deepEqual(parseInline(value), [text(value)])
  assert.deepEqual(parseInline('``a ` b``'), [{ type: 'code', text: 'a ` b' }])
  assert.deepEqual(parseInline('\\*literal\\* snake_case_name **unfinished'), [text('*literal* snake_case_name **unfinished')])
})

test('parses GFM tables with all alignments and inline content', () => {
  assert.deepEqual(parseMarkdown('| Left | Middle | Right | Plain |\n| :--- | :---: | ---: | --- |\n| **a** | `b` | c | d |'), [{
    type: 'table', align: ['left', 'center', 'right', null], headers: ['Left', 'Middle', 'Right', 'Plain'].map(value => [text(value)]),
    rows: [[[{ type: 'strong', children: [text('a')] }], [{ type: 'code', text: 'b' }], [text('c')], [text('d')]]],
  }])
})

test('tables accept optional edge pipes, escaped/code pipes, short and long rows', () => {
  assert.deepEqual(parseMarkdown('A | B\n--- | ---\na\\|b | `c|d`\nshort |\nx | y | ignored'), [{
    type: 'table', align: [null, null], headers: [[text('A')], [text('B')]],
    rows: [[[text('a|b')], [{ type: 'code', text: 'c|d' }]], [[text('short')], []], [[text('x')], [text('y')]]],
  }])
  assert.equal(parseMarkdown('a | b\n--- | invalid')[0].type, 'paragraph')
})

test('parses ordered/unordered/task lists and nested list blocks', () => {
  assert.deepEqual(parseMarkdown('- [ ] todo\n- [x] done\n- [X] also done\n- plain\n1. first\n2. second'), [
    { type: 'list', ordered: false, items: [{ checked: false, children: [text('todo')] }, { checked: true, children: [text('done')] }, { checked: true, children: [text('also done')] }, { children: [text('plain')] }] },
    { type: 'list', ordered: true, items: [{ children: [text('first')] }, { children: [text('second')] }] },
  ])
  for (const marker of ['-', '*', '+']) assert.equal(parseMarkdown(`${marker} one\n${marker} two`)[0].type, 'list')
  assert.deepEqual(parseMarkdown('- parent\n  - child\n- sibling'), [{ type: 'list', ordered: false, items: [
    { children: [text('parent')], blocks: [{ type: 'list', ordered: false, items: [{ children: [text('child')] }] }] }, { children: [text('sibling')] },
  ] }])
  assert.deepEqual(parseMarkdown('- item\n\n  continued\n\nafter'), [
    { type: 'list', ordered: false, items: [{ children: [text('item')], blocks: [{ type: 'paragraph', children: [text('continued')] }] }] },
    { type: 'paragraph', children: [text('after')] },
  ])
})

test('parses consecutive and nested blockquotes recursively', () => {
  assert.deepEqual(parseMarkdown('> first\n> second\n>\n> > ## nested\n\nafter'), [
    { type: 'blockquote', blocks: [
      { type: 'paragraph', children: [text('first\nsecond')] },
      { type: 'blockquote', blocks: [{ type: 'heading', level: 2, children: [text('nested')] }] },
    ] },
    { type: 'paragraph', children: [text('after')] },
  ])
})

test('streaming fences preserve all received content, including a bare opening fence', () => {
  for (const marker of ['```', '~~~']) {
    assert.deepEqual(parseMarkdown(`${marker}ts\nconst x = 1\n\n  tail\n`), [{ type: 'code', language: 'ts', code: 'const x = 1\n\n  tail\n', closed: false }])
    assert.deepEqual(parseMarkdown(marker), [{ type: 'code', language: '', code: '', closed: false }])
    assert.deepEqual(parseMarkdown(`${marker}ts\nvalue\n${marker}\n\nafter`), [
      { type: 'code', language: 'ts', code: 'value\n', closed: true }, { type: 'paragraph', children: [text('after')] },
    ])
  }
  assert.deepEqual(parseMarkdown('````js\r\n```\r\n~~~~\r\n`````'), [{ type: 'code', language: 'js', code: '```\n~~~~\n', closed: true }])
  assert.deepEqual(parseMarkdown('```ts\nbody\n```not-a-close'), [{ type: 'code', language: 'ts', code: 'body\n```not-a-close', closed: false }])
})

test('unsafe links stay plain text while http(s) links support balanced parentheses', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<svg/onload=alert(1)>', 'vbscript:msgbox(1)', 'file:///secret', '//example.com', 'java\tscript:alert(1)', 'https://', 'https://exa\nmple.com', 'https://example.com/\u0000']) {
    const source = `[click](${url})`
    assert.deepEqual(parseInline(source), [text(source)], url)
  }
  for (const url of ['https://example.com', 'http://example.com/a_(b)', 'HTTPS://example.com']) {
    assert.deepEqual(parseInline(`[**ok**](${url})`), [{ type: 'link', url, children: [{ type: 'strong', children: [text('ok')] }] }])
  }
  assert.deepEqual(parseInline('<script>alert(1)</script>'), [text('<script>alert(1)</script>')])
  assert.deepEqual(parseInline('`[click](javascript:alert(1))`'), [{ type: 'code', text: '[click](javascript:alert(1))' }])
})

test('file refs recognize relative source paths and valid line ranges', () => {
  assert.deepEqual(parseFileRef('src/app.ts'), { path: 'src/app.ts' })
  assert.deepEqual(parseFileRef('src/app.ts:42'), { path: 'src/app.ts', line: 42 })
  for (const suffix of [':10-20', '#L10-L20']) assert.deepEqual(parseFileRef(`packages/ide-core/src/workspace.ts${suffix}`), { path: 'packages/ide-core/src/workspace.ts', line: 10, endLine: 20 })
  assert.deepEqual(parseFileRef('src/app.ts#L10'), { path: 'src/app.ts', line: 10 })
  assert.deepEqual(parseFileRef('apps/desktop/src/renderer/App.tsx'), { path: 'apps/desktop/src/renderer/App.tsx' })
  assert.deepEqual(parseFileRef('app.ts'), { path: 'app.ts' })
  assert.deepEqual(parseFileRef('src\\app.ts:42'), { path: 'src/app.ts', line: 42 })
})

test('file refs reject URLs, traversal, absolute paths, ordinary words and invalid ranges', () => {
  for (const value of ['https://example.com/app.ts', 'http://example.com', '../secret.txt', 'src/../secret.ts', 'src\\..\\secret.ts', 'src/%2e%2e/secret.ts', '/src/app.ts', 'C:\\src\\app.ts', '\\\\server\\app.ts', 'v2.3.2', 'hello', 'true', 'null', '', ' src/app.ts', 'src/app.ts ', 'src/app.ts:0', 'src/app.ts:20-10', 'src/app.ts#L10-L0', 'src/app.ts:9007199254740992']) assert.equal(parseFileRef(value), null, value)
})

test('summarizes shell commands and file tools using aliases and metadata', () => {
  for (const name of ['bash', 'shell', 'run_command', 'terminal']) assert.deepEqual(summarizeToolCall(name, { cmd: 'npm run typecheck' }), { label: 'Chạy lệnh', target: 'npm run typecheck', isFile: false })
  assert.equal(summarizeToolCall('bash', { command: 'pwd', cmd: 'ignored' }).target, 'pwd')
  for (const name of ['read', 'read_file', 'view_file', 'write', 'write_file', 'edit', 'edit_file', 'patch']) {
    const result = summarizeToolCall(name, { file_path: 'src/app.ts' })
    assert.equal(result.target, 'src/app.ts'); assert.equal(result.isFile, true)
  }
  assert.equal(summarizeToolCall('edit', { filePath: 'src/a.ts' }, { path: 'src/b.ts' }).target, 'src/a.ts')
  assert.equal(summarizeToolCall('read', undefined, { path: 'src/app.ts' }).target, 'src/app.ts')
  assert.equal(summarizeToolCall(' READ_FILE ', 'src/app.ts').isFile, true)
})

test('summarizes search, task and unknown tools without leaking object stringification', () => {
  assert.equal(summarizeToolCall('grep', { pattern: 'TODO' }).target, 'TODO')
  assert.equal(summarizeToolCall('search', { query: 'symbol' }).target, 'symbol')
  assert.equal(summarizeToolCall('list', { path: 'src' }).target, 'src')
  assert.equal(summarizeToolCall('glob', { pattern: '**/*.ts' }).target, '**/*.ts')
  assert.equal(summarizeToolCall('task', { description: 'Inspect tests' }).target, 'Inspect tests')
  assert.equal(summarizeToolCall('subagent', { role: 'reviewer' }).target, 'reviewer')
  assert.deepEqual(summarizeToolCall('custom_tool', { nested: { data: true } }), { label: 'custom_tool', target: undefined, isFile: false })
  assert.equal(summarizeToolCall('', null).label, 'Công cụ')
  assert.equal(summarizeToolCall('read', { path: 123 }).target, undefined)
})

test('ToolCard renders escaped data, JSON panels, statuses and separate file actions', () => {
  const call: ToolCallView = { name: 'read', status: 'completed', input: { path: 'src/app.ts', count: 2 }, output: '<img src=x onerror=alert(1)>', durationMs: 1250 }
  const html = renderToStaticMarkup(createElement(ToolCard, { call, onOpenFile: () => {} }))
  assert.match(html, /tool-card__label/)
  assert.match(html, /Hoàn tất/)
  assert.match(html, /1\.3 s/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /Input/)
  assert.match(html, /Output/)
  assert.match(html, /Sao chép output công cụ/)
  assert.ok(html.indexOf('Mở tệp') < html.indexOf('<details'))
  const withoutOpen = renderToStaticMarkup(createElement(ToolCard, { call }))
  assert.doesNotMatch(withoutOpen, /Mở tệp/)
  for (const [status, label] of [['streaming', 'Đang chuẩn bị…'], ['running', 'Đang chạy…'], ['error', 'Lỗi']] as const) {
    assert.ok(renderToStaticMarkup(createElement(ToolCard, { call: { name: 'bash', status, error: 'failed', input: 'pwd', durationMs: 0 } })).includes(label))
  }
  const circular: { self?: unknown } = {}; circular.self = circular
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(ToolCard, { call: { name: 'custom', status: 'running', input: circular } })))
})
