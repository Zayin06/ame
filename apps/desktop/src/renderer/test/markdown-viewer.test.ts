import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isMarkdownFile, MarkdownViewer, resolveMarkdownLink } from '../components/MarkdownViewer'

test('isMarkdownFile and resolveMarkdownLink detect markdown extensions and resolve workspace paths safely', () => {
  assert.equal(isMarkdownFile('README.md'), true)
  assert.equal(isMarkdownFile('docs/guide.MDX'), true)
  assert.equal(isMarkdownFile('notes.markdown'), true)
  assert.equal(isMarkdownFile('src/App.tsx'), false)

  assert.equal(resolveMarkdownLink('docs/guide/intro.md', './setup.md#install'), 'docs/guide/setup.md')
  assert.equal(resolveMarkdownLink('docs/guide/intro.md', '../README.md?raw=1'), 'docs/README.md')
  assert.equal(resolveMarkdownLink('docs/guide/intro.md', './my%20file.md#section'), 'docs/guide/my file.md')
  assert.equal(resolveMarkdownLink('docs/guide/intro.md', '%2e%2e/%2e%2e/%2e%2e/secret.md'), null)
  assert.equal(resolveMarkdownLink('docs/guide/intro.md', 'foo%2Fbar.md'), null)
  assert.equal(resolveMarkdownLink('docs/guide/intro.md', '%E0%A4%A'), null)
  assert.equal(resolveMarkdownLink('README.md', '../outside.md'), null)
  assert.equal(resolveMarkdownLink('README.md', 'https://example.com'), null)
  assert.equal(resolveMarkdownLink('README.md', '#heading'), null)
})

test('MarkdownViewer renders GFM tables, heading slug ids, tasks, syntax-highlighted code and blocks raw script tags', () => {
  const sample = [
    '# Tài liệu hướng dẫn',
    '',
    'Đoạn ~~cũ~~ và **mới** với [liên kết ngoài](https://example.com) và [tài liệu](./other.md).',
    '',
    '- [x] Hoàn thành bước 1',
    '- [ ] Bước 2',
    '',
    '| Cột A | Cột B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const answer: number = 42',
    '```',
    '',
    '<script>alert(1)</script>',
  ].join('\n')

  const html = renderToStaticMarkup(
    createElement(MarkdownViewer, { content: sample, theme: 'dark', filePath: 'docs/README.md' }),
  )

  assert.match(html, /data-testid="md-viewer"/)
  assert.match(html, /data-theme="dark"/)
  assert.match(html, /<h1 id="tài-liệu-hướng-dẫn">Tài liệu hướng dẫn<\/h1>/)
  assert.match(html, /<del>cũ<\/del>/)
  assert.match(html, /<strong>mới<\/strong>/)
  assert.match(html, /<table/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /hljs/)
  assert.doesNotMatch(html, /<script[\s>]/i)
})
