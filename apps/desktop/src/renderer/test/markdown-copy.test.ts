import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageContent } from '../components/MessageContent'
import { selectionToMarkdown } from '../markdown-copy'

function fixture(html: string) {
  const dom = new JSDOM(`<div class="chat-markdown">${html}<p>unselected</p></div><p id="outside">outside</p>`)
  const container = dom.window.document.querySelector<HTMLElement>('.chat-markdown')!
  const range = dom.window.document.createRange()
  range.setStart(container, 0)
  range.setEnd(container, container.childNodes.length - 1)
  return { dom, container, range, copy: () => selectionToMarkdown(container, range, 'ORIGINAL') }
}

test('paragraph and bullets preserve strong and all file chip names', () => {
  const f = fixture('<p>Kết quả:</p><ul><li><strong>toàn bộ test</strong> trong <code class="file-chip">commit-enhance.test.ts</code> và <code class="file-chip">workspace-ipc.test.ts</code> PASS.</li></ul>')
  assert.equal(f.copy(), 'Kết quả:\n\n- **toàn bộ test** trong `commit-enhance.test.ts` và `workspace-ipc.test.ts` PASS.')
})

test('ordered selection starts at actual item number and nested lists indent two spaces', () => {
  const f = fixture('<ol start="4"><li>skip</li><li>five<ul><li>nested<ol><li>deep</li></ol></li></ul></li><li value="9">nine</li></ol>')
  f.range.setStart(f.container.querySelectorAll('li')[1].firstChild!, 0)
  assert.equal(f.copy(), '5. five\n  - nested\n    1. deep\n9. nine')
})

test('task list includes checked and unchecked markers', () => {
  assert.equal(fixture('<ul><li><input type="checkbox" checked disabled>done</li><li><input type="checkbox" disabled>todo</li></ul>').copy(), '- [x] done\n- [ ] todo')
})

test('list continuation paragraphs and code retain block boundaries', () => {
  assert.equal(fixture('<ul><li>item<p>continuation</p><div class="code-block" data-language="sh"><pre><code>echo ok</code></pre></div></li></ul>').copy(), '- item\n\n  continuation\n\n  ```sh\n  echo ok\n  ```')
})

test('selecting only a child block starts directly after the list marker', () => {
  for (const tag of ['ul', 'ol']) {
    for (const block of ['<p>text</p>', '<blockquote><p>text</p></blockquote>', '<h2>text</h2>', '<div class="code-block"><pre><code>text</code></pre></div>']) {
      const f = fixture(`<${tag}><li>unselected${block}</li></${tag}>`)
      f.range.selectNodeContents(f.container.querySelector('li')!.children[0])
      const expected = block.startsWith('<blockquote') ? '> text' : block.startsWith('<h2') ? '## text' : block.startsWith('<div') ? '```\ntext\n```' : 'text'
      const marker = tag === 'ul' ? '- ' : '1. '
      assert.equal(f.copy(), marker + expected.split('\n').map((line, index) => index ? ' '.repeat(marker.length) + line : line).join('\n'))
    }
  }
})

test('unselected empty code block prevents returning original Markdown', () => {
  const f = fixture('<p>hello</p><div class="code-block"><pre><code></code></pre></div>')
  f.range.selectNodeContents(f.container.firstChild!)
  assert.equal(f.copy(), 'hello')
})

test('code block omits header and uses fence longer than code backticks', () => {
  assert.equal(fixture('<div class="code-block" data-language="sh"><div class="code-block__header">sh<button>Copy</button></div><pre><code>echo ```\necho ok</code></pre></div>').copy(), '````sh\necho ```\necho ok\n````')
})

test('GFM table preserves inline formatting, pipes and alignment', () => {
  assert.equal(fixture('<div class="gfm-table-scroll"><table class="gfm-table"><thead><tr><th>A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td><strong>x</strong></td><td>a|b</td></tr></tbody></table></div>').copy(), '| A | B |\n| --- | ---: |\n| **x** | a\\|b |')
})

test('headings, hr, blockquotes and inline constructs', () => {
  assert.equal(fixture('<h2>Title</h2><hr><blockquote><p><em>yes</em> <del>no</del></p><p><a href="https://a.test">Docs</a> <a href="https://b.test">https://b.test</a></p></blockquote>').copy(), '## Title\n\n---\n\n> *yes* ~~no~~\n> \n> [Docs](https://a.test) https://b.test')
})

test('literal Markdown punctuation remains literal outside code', () => {
  assert.equal(fixture('<p>*literal* and <code class="inline-code">a_b</code></p>').copy(), '*literal* and `a_b`')
})

test('partial plain text copies underscores, brackets and tildes without extra escapes', () => {
  const f = fixture('<p>skip git_commit_summary user_id [PASS] ~35K end</p>')
  const text = f.container.querySelector('p')!.firstChild!
  f.range.setStart(text, 5)
  f.range.setEnd(text, text.textContent!.length - 4)
  assert.equal(f.copy(), 'git_commit_summary user_id [PASS] ~35K')
})

test('narrow inline and pre code selections remain plain text', () => {
  for (const html of ['<code class="file-chip">commit-enhance.test.ts</code>', '<code class="inline-code">echo ok</code>', '<div class="code-block"><pre><code>echo one\necho two\necho three</code></pre></div>', '<strong>some text</strong>']) {
    const f = fixture(html)
    const node = f.container.querySelector('code, strong')!.firstChild!
    f.range.setStart(node, 1)
    f.range.setEnd(node, node.textContent!.length - 1)
    assert.equal(f.copy(), node.textContent!.slice(1, -1))
  }
})

test('full visible contents return exact original Markdown including ignored headers', () => {
  const source = '# Heading\n\n- **Done** `file.ts`\n\n```sh\necho ok\n```\n'
  const dom = new JSDOM(renderToStaticMarkup(createElement(MessageContent, { text: source, onOpenFile() {} })))
  const container = dom.window.document.querySelector<HTMLElement>('.chat-markdown')!
  const range = dom.window.document.createRange()
  range.setStart(container.querySelector('h1')!.firstChild!, 0)
  const code = container.querySelector('pre code')!.firstChild!
  range.setEnd(code, code.textContent!.length)
  assert.equal(selectionToMarkdown(container, range, source), source)
})

test('collapsed, header-only and cross-container selections are not intercepted', () => {
  const f = fixture('<p>hello</p><div class="code-block__header">Copy</div>')
  f.range.collapse(true)
  assert.equal(f.copy(), null)
  f.range.selectNodeContents(f.container.querySelector('.code-block__header')!)
  assert.equal(f.copy(), null)
  f.range.setStart(f.container.firstChild!.firstChild!, 0)
  f.range.setEnd(f.dom.window.document.querySelector('#outside')!.firstChild!, 3)
  assert.equal(f.copy(), null)
})
