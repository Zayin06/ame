import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { findRipgrep, replaceInWorkspace, searchWorkspace } from '../packages/ide-core/src/search'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ame-search-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return { root, put }
}
const nodeEngine = { forceEngine: 'node' as const }

test('literal, case, whole-word and regex matching report every UTF-16 column and line', async t => {
  const { root, put } = await fixture(t)
  await put('src/words.txt', '😀 Cat cat scatter CAT\r\ncat cat\rsolo cat\n')
  const response = await searchWorkspace(root, { query: 'cat', caseSensitive: true }, nodeEngine)
  assert.equal(response.engine, 'node')
  assert.equal(response.filesSearched, 1)
  assert.equal(response.totalMatches, 5)
  assert.equal(response.truncated, false)
  assert.equal(response.results[0].path, 'src/words.txt')
  assert.deepEqual(response.results[0].matches.map(match => [match.line, match.column, match.length]), [[1, 8, 3], [1, 13, 3], [2, 1, 3], [2, 5, 3], [3, 6, 3]])
  assert.equal(response.results[0].matches[0].lineText, '😀 Cat cat scatter CAT')
  assert.equal(response.results[0].matches[0].matchText, 'cat')
  assert.equal((await searchWorkspace(root, { query: 'cat' }, nodeEngine)).totalMatches, 7)
  assert.equal((await searchWorkspace(root, { query: 'cat', wholeWord: true }, nodeEngine)).totalMatches, 6)
  assert.equal((await searchWorkspace(root, { query: 'cat', wholeWord: true, caseSensitive: true }, nodeEngine)).totalMatches, 4)
  const regex = await searchWorkspace(root, { query: 'c(a)t', regex: true, caseSensitive: true }, nodeEngine)
  assert.deepEqual(regex.results, response.results)
  await assert.rejects(searchWorkspace(root, { query: '[', regex: true }, nodeEngine), /INVALID_REGEX/)
  await put('literal.txt', 'a+b aab')
  assert.equal((await searchWorkspace(root, { query: 'a+b' }, nodeEngine)).totalMatches, 1)
})

test('empty query, zero-width regex and numeric limits terminate with correct truncation', async t => {
  const { root, put } = await fixture(t)
  await put('a.txt', 'foo foo\nfoo')
  await put('b.txt', 'foo')
  assert.deepEqual(await searchWorkspace(root, { query: '' }), { results: [], totalMatches: 0, filesSearched: 0, truncated: false, engine: 'node' })
  const limited = await searchWorkspace(root, { query: 'foo', maxMatches: 2 }, nodeEngine)
  assert.equal(limited.totalMatches, 2)
  assert.equal(limited.truncated, true)
  assert.equal(limited.filesSearched, 1)
  assert.deepEqual(limited.results[0].matches.map(match => match.column), [1, 5])
  const files = await searchWorkspace(root, { query: 'absent', maxFiles: 1 }, nodeEngine)
  assert.equal(files.filesSearched, 1)
  assert.equal(files.truncated, true)
  assert.equal((await searchWorkspace(root, { query: 'foo', maxFiles: 0 }, nodeEngine)).filesSearched, 0)
  assert.equal((await searchWorkspace(root, { query: 'foo', maxMatches: 0 }, nodeEngine)).totalMatches, 0)
  const zero = await searchWorkspace(root, { query: '(?=foo)', regex: true }, nodeEngine)
  assert.equal(zero.totalMatches, 4)
  assert.ok(zero.results.every(file => file.matches.every(match => match.length === 0)))
})

test('root/nested gitignore supports negation, anchoring, directory pruning and *, **, ? globs', async t => {
  const { root, put } = await fixture(t)
  await put('.gitignore', '# comment\n\n*.log\n!keep.log\ncache/\n/root.txt\ntmp?.txt\nlogs/**/secret.txt\nblocked/\n!blocked/keep.txt\n')
  await put('src/.gitignore', '/local.txt\n*.skip\n!keep.skip\n')
  for (const file of ['keep.log', 'drop.log', 'src/keep.log', 'src/drop.log', 'root.txt', 'src/root.txt', 'cache/file.txt', 'src/cache/file.txt', 'tmp1.txt', 'tmp12.txt', 'logs/secret.txt', 'logs/deep/secret.txt', 'blocked/keep.txt', 'src/local.txt', 'src/deep/local.txt', 'src/drop.skip', 'src/keep.skip', 'normal.txt']) await put(file, 'needle')
  const result = await searchWorkspace(root, { query: 'needle' }, nodeEngine)
  assert.deepEqual(result.results.map(file => file.path).sort(), ['keep.log', 'normal.txt', 'src/deep/local.txt', 'src/keep.log', 'src/keep.skip', 'src/root.txt', 'tmp12.txt'].sort())
  const dryRun = await replaceInWorkspace(root, { query: 'needle', replacement: 'changed', dryRun: true })
  assert.deepEqual(dryRun.previews.map(file => file.path).sort(), result.results.map(file => file.path).sort())
})

test('search skips default directories, junctions, binary, invalid UTF-8 and files over 2 MiB', async t => {
  const { root, put } = await fixture(t)
  for (const directory of ['.git', 'node_modules', 'dist', 'out', '.next', 'deep/.GIT']) await put(`${directory}/hidden.txt`, 'needle')
  await put('binary', Buffer.from('needle\0needle'))
  await put('invalid', Buffer.from([0xff, ...Buffer.from('needle')]))
  await put('oversized', 'needle' + 'x'.repeat(2 * 1024 * 1024))
  await put('boundary', 'needle' + 'x'.repeat(2 * 1024 * 1024 - 6))
  await put('visible.txt', 'needle')
  const outside = await mkdtemp(path.join(tmpdir(), 'ame-search-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(path.join(outside, 'outside.txt'), 'needle')
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(outside, path.join(root, '.gitignore'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await searchWorkspace(root, { query: 'needle' }, nodeEngine)
  assert.deepEqual(result.results.map(file => file.path), ['boundary', 'visible.txt'])
  assert.equal(result.filesSearched, 2)
  const replaced = await replaceInWorkspace(root, { query: 'needle', replacement: 'changed' })
  assert.equal(replaced.filesChanged, 2)
  assert.equal(await readFile(path.join(outside, 'outside.txt'), 'utf8'), 'needle')
})

test('include/exclude filters support root and nested glob matches and replacement shares filters', async t => {
  const { root, put } = await fixture(t)
  for (const file of ['root.ts', 'src/a.ts', 'src/deep/b.ts', 'src/a.test.ts', 'src/a.js', 'other/a.ts']) await put(file, 'needle')
  const response = await searchWorkspace(root, { query: 'needle', include: ['**/*.ts'], exclude: ['**/*.test.ts', '/other/**'] }, nodeEngine)
  assert.deepEqual(response.results.map(file => file.path), ['root.ts', 'src/a.ts', 'src/deep/b.ts'])
  const anchored = await searchWorkspace(root, { query: 'needle', include: ['/src/?.ts'] }, nodeEngine)
  assert.deepEqual(anchored.results.map(file => file.path), ['src/a.ts'])
  const replacement = await replaceInWorkspace(root, { query: 'needle', replacement: 'done', include: ['**/*.ts'], exclude: ['**/*.test.ts', 'other/'], dryRun: true })
  assert.deepEqual(replacement.previews.map(file => file.path), response.results.map(file => file.path))
})

test('search supports pre-abort and cancellation while asynchronous scanning is pending', async t => {
  const { root, put } = await fixture(t)
  await put('a.txt', 'needle')
  const pre = AbortSignal.abort()
  await assert.rejects(searchWorkspace(root, { query: 'needle' }, { ...nodeEngine, signal: pre }), { name: 'AbortError' })
  const controller = new AbortController()
  const pending = searchWorkspace(root, { query: 'needle' }, { ...nodeEngine, signal: controller.signal })
  setImmediate(() => controller.abort())
  await assert.rejects(pending, { name: 'AbortError' })
})

test('ripgrep discovery and missing executable fallback produce the same paths and match coordinates', async t => {
  const { root, put } = await fixture(t)
  await put('dir/a.txt', '😀 cat cat\r\nCat')
  await put('.gitignore', '*.log\n!keep.log\n')
  await put('drop.log', 'cat')
  await put('keep.log', 'cat')
  const query = { query: 'cat' }
  const expected = await searchWorkspace(root, query, nodeEngine)
  const fallback = await searchWorkspace(root, query, { forceEngine: 'ripgrep', rgPath: path.join(root, 'missing-rg') })
  assert.deepEqual(fallback, expected)
  const detected = await searchWorkspace(root, query, { forceEngine: 'ripgrep' })
  assert.deepEqual({ ...detected, engine: 'node' }, expected)
  assert.ok(detected.engine === 'node' || detected.engine === 'ripgrep')
})

test('findRipgrep respects override, platform PATH lookup, missing tools and fallback after a stale override', () => {
  const executable = path.join('tools', 'custom-rg')
  assert.equal(findRipgrep({ AME_RIPGREP_PATH: executable, PATH: 'unused' }, candidate => candidate === executable), executable)
  const candidate = path.join('second', process.platform === 'win32' ? 'rg.exe' : 'rg')
  assert.equal(findRipgrep({ PATH: ['first', 'second'].join(path.delimiter) }, value => value === candidate), candidate)
  assert.equal(findRipgrep({ AME_RIPGREP_PATH: 'missing', PATH: 'second' }, value => value === candidate), candidate)
  assert.equal(findRipgrep({ PATH: '' }, () => true), null)
  assert.equal(findRipgrep({ PATH: 'missing' }, () => false), null)
})

test('dry run returns accurate preview; allowlist replacement preserves CRLF, BOM and unchanged files', async t => {
  const { root, put } = await fixture(t)
  const original = '\ufeffcat CAT scatter\r\ncat\r\n'
  await put('a.txt', original)
  await put('b.txt', 'cat')
  const options = { query: 'cat', wholeWord: true, replacement: 'dog', files: ['a.txt'] }
  const preview = await replaceInWorkspace(root, { ...options, dryRun: true })
  assert.deepEqual(preview, { filesChanged: 1, replacements: 3, previews: [{ path: 'a.txt', revision: createHash('sha256').update(Buffer.from(original)).digest('hex'), count: 3, sampleBefore: original, sampleAfter: '\ufeffdog dog scatter\r\ndog\r\n' }], writtenFiles: [], conflicts: [], errors: [] })
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), original)
  assert.deepEqual(await replaceInWorkspace(root, options), { ...preview, writtenFiles: ['a.txt'] })
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), preview.previews[0].sampleAfter)
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'cat')
  const unchanged = await replaceInWorkspace(root, { query: 'cat', replacement: 'cat', files: ['b.txt'] })
  assert.equal(unchanged.filesChanged, 0)
  assert.equal(unchanged.replacements, 0)
  assert.deepEqual(await replaceInWorkspace(root, { query: 'cat', replacement: 'dog', files: [] }), { filesChanged: 0, replacements: 0, previews: [], writtenFiles: [], conflicts: [], errors: [] })
})

test('approved replacement plan excludes new files and reports changed, missing and successfully written files', async t => {
  const { root, put } = await fixture(t)
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await put(file, '\ufeffcat\r\ncat')
  const options = { query: 'cat', replacement: 'dog' }
  const preview = await replaceInWorkspace(root, { ...options, dryRun: true })
  assert.equal(preview.previews[0].revision, createHash('sha256').update(await readFile(path.join(root, 'a.txt'))).digest('hex'))
  await put('new.txt', 'cat')
  await put('b.txt', 'cat edited')
  await rm(path.join(root, 'c.txt'))
  const result = await replaceInWorkspace(root, options, preview.previews)
  assert.deepEqual(result.writtenFiles, ['a.txt', 'd.txt'])
  assert.deepEqual(result.conflicts, ['b.txt'])
  assert.deepEqual(result.errors.map(item => item.path), ['c.txt'])
  assert.equal(result.filesChanged, 2)
  assert.equal(result.replacements, 4)
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), '\ufeffdog\r\ndog')
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'cat edited')
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'cat')
})

test('long minified lines return bounded snippets with real columns and a hard response byte budget', async t => {
  const { root, put } = await fixture(t)
  const line = ('界'.repeat(900) + 'needle').repeat(150)
  await put('minified.js', line)
  const full = await searchWorkspace(root, { query: 'needle' }, nodeEngine)
  assert.equal(full.totalMatches, 150)
  assert.equal(full.results[0].matches.at(-1)!.column, line.lastIndexOf('needle') + 1)
  assert.ok(full.results[0].matches.every(match => match.snippetTruncated && match.lineText.length <= 208))
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < 150_000)
  const bounded = await searchWorkspace(root, { query: 'needle', maxResponseBytes: 4096 }, nodeEngine)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.totalMatches > 0 && bounded.totalMatches < 150)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096)
  const hugeMatch = await searchWorkspace(root, { query: '.+', regex: true, maxResponseBytes: 4096 }, nodeEngine)
  assert.ok(hugeMatch.results[0].matches[0].matchText.length <= 100)
  assert.equal(hugeMatch.results[0].matches[0].length, line.length)
})

test('replacement handles regex captures, literal dollars, zero-width matches, shrinking and limits', async t => {
  const { root, put } = await fixture(t)
  await put('a.txt', 'cat12 cat34\r\ncat56')
  const result = await replaceInWorkspace(root, { query: 'cat(\\d+)', regex: true, replacement: '$1-$$-$&', maxMatches: 2 })
  assert.equal(result.replacements, 2)
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), '12-$-cat12 34-$-cat34\r\ncat56')
  await put('a.txt', 'cat')
  await replaceInWorkspace(root, { query: 'cat', replacement: '$&' })
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), '$&')
  await put('a.txt', 'ab')
  await replaceInWorkspace(root, { query: '(?=.)', regex: true, replacement: '!' })
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), '!a!b')
  await replaceInWorkspace(root, { query: '.+', regex: true, replacement: '' })
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), '')
  await put('a.txt', 'cat')
  await put('b.txt', 'cat')
  assert.equal((await replaceInWorkspace(root, { query: 'cat', replacement: 'dog', maxFiles: 1 })).filesChanged, 1)
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'cat')
  await assert.rejects(replaceInWorkspace(root, { query: '[', regex: true, replacement: '' }), /INVALID_REGEX/)
})

test('replacement validates every allowlist path before any write, including empty queries and symlink ancestors', async t => {
  const { root, put } = await fixture(t)
  await put('safe.txt', 'cat')
  const outside = await mkdtemp(path.join(tmpdir(), 'ame-replace-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(path.join(outside, 'outside.txt'), 'cat')
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const unsafe of ['../outside.txt', '..\\outside.txt', '.git/config', '.GIT/config', 'safe.txt:stream', path.join(outside, 'outside.txt'), 'C:\\outside.txt', 'escape/outside.txt']) {
    for (const dryRun of [true, false]) await assert.rejects(replaceInWorkspace(root, { query: 'cat', replacement: 'dog', files: ['safe.txt', unsafe], dryRun, maxFiles: 1 }))
    await assert.rejects(replaceInWorkspace(root, { query: '', replacement: '', files: [unsafe] }))
  }
  assert.equal(await readFile(path.join(root, 'safe.txt'), 'utf8'), 'cat')
  assert.equal(await readFile(path.join(outside, 'outside.txt'), 'utf8'), 'cat')
})
