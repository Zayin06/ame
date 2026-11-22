import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyComposerCompletion, composePromptWithAttachments, detectComposerTrigger, filterFileMentions, filterSlashEntries, type ComposerAttachment } from '../composer-mentions'
import { rankQuickOpenFiles } from '../quick-open'

test('detects mentions and slash tokens only at whitespace boundaries', () => {
  for (const [text, kind, query] of [['@', '@', ''], ['@src/App', '@', 'src/App'], ['  /test', '/', 'test'], ['hello\n\t/技能', '/', '技能'], ['ask @ỨngDụng', '@', 'ỨngDụng'], ['ask /help', '/', 'help']] as const) {
    assert.deepEqual(detectComposerTrigger(text, text.length), { kind, start: text.lastIndexOf(kind), end: text.length, query })
  }
  for (const text of ['a@b.com', 'foo/bar', 'https://a/b', 'https://a/@user', '(@file', 'text ', '@two words', '/two words']) {
    assert.equal(detectComposerTrigger(text, text.length), null)
  }
  assert.equal(detectComposerTrigger('@file', 0), null)
  assert.equal(detectComposerTrigger('@file', -1), null)
  assert.equal(detectComposerTrigger('@file', NaN), null)
  assert.deepEqual(detectComposerTrigger('ask @file suffix', 7), { kind: '@', start: 4, end: 7, query: 'fi' })
  assert.deepEqual(detectComposerTrigger('@file', 999), { kind: '@', start: 0, end: 5, query: 'file' })
})

test('completion replaces only the trigger range and supplies exactly one separator', () => {
  const complete = (text: string, cursor: number, replacement: string) => applyComposerCompletion(text, detectComposerTrigger(text, cursor)!, replacement)
  assert.deepEqual(complete('ask @sr', 7, '@src/App.ts'), { text: 'ask @src/App.ts ', cursor: 16 })
  assert.deepEqual(complete('@fi next', 3, '@file'), { text: '@file next', cursor: 6 })
  assert.deepEqual(complete('/he', 3, '/help '), { text: '/help ', cursor: 6 })
  assert.deepEqual(complete('@fi\nnext', 3, '@file'), { text: '@file\nnext', cursor: 6 })
  assert.deepEqual(complete('@文', 2, '@目录/文件.ts'), { text: '@目录/文件.ts ', cursor: 10 })
  assert.deepEqual(complete('@foTAIL', 3, '@foo'), { text: '@foo TAIL', cursor: 5 })
})

test('slash entries merge commands and skills, rank prefixes, dedupe names case insensitively and use skill IDs', () => {
  const commands = Object.freeze([{ name: 'restart' }, { name: 'test', description: 'Run tests' }, { name: 'TEST' }])
  const skills = Object.freeze([{ id: 'skills/test', name: 'Test' }, { id: 'unit-tests', name: 'testing', description: 'Testing skill' }, { id: 'write', name: 'writing' }])
  assert.deepEqual(filterSlashEntries('te', commands, skills), [
    { kind: 'command', name: 'test', description: 'Run tests', insertText: '/test' },
    { kind: 'skill', name: 'testing', description: 'Testing skill', insertText: '/unit-tests' }
  ])
  assert.deepEqual(filterSlashEntries('/TE', commands, skills).map(entry => entry.name), ['test', 'testing'])
  assert.deepEqual(filterSlashEntries('st', commands, skills).map(entry => entry.name), ['restart', 'test', 'testing'])
  assert.equal(filterSlashEntries('', commands, skills).length, 4)
  assert.deepEqual(filterSlashEntries('missing', commands, skills), [])
  assert.equal(filterSlashEntries('技能', [], [{ id: '中文', name: '技能' }])[0].insertText, '/中文')
})

test('file mentions preserve quick open ordering, Windows paths, recency and limits', () => {
  const files = ['src\\App.ts', 'lib/App.ts', '目录/文件.ts']
  assert.deepEqual(filterFileMentions('App', files, ['lib/App.ts'], 1), rankQuickOpenFiles('App', files, ['lib/App.ts'], 1))
  assert.equal(filterFileMentions('', files, ['目录/文件.ts'])[0].path, '目录/文件.ts')
})

test('attachments prepend context, preserve prompt, deduplicate context and do not add empty blocks', () => {
  assert.equal(composePromptWithAttachments('  question\n', []), '  question\n')
  const file: ComposerAttachment = { id: '1', kind: 'file', path: 'src\\App.ts' }
  const selection: ComposerAttachment = { id: '2', kind: 'selection', path: '目录/文件.ts', lineStart: 2, lineEnd: 4, excerpt: 'const x = 1\n```\n<text>' }
  assert.equal(composePromptWithAttachments('question', [file, { ...file, id: 'copy' }, selection]), '@src\\App.ts\n\n@目录/文件.ts:2-4\n````\nconst x = 1\n```\n<text>\n````\n\nquestion')
  assert.equal(composePromptWithAttachments('', [file]), '@src\\App.ts')
  assert.equal(composePromptWithAttachments('question', [{ ...file, path: '' }]), 'question')
  assert.equal(composePromptWithAttachments('', [{ ...file, path: 'a\nforged', excerpt: '' }]), '@a forged')
  assert.equal(composePromptWithAttachments('', [{ ...file, lineStart: 0, lineEnd: 0 }]), '@src\\App.ts:1-1')
})
