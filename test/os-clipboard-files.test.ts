import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseWinCfHdrop, parseWinFileNameW, parseMacFilenamesPlist, parseUriList, readOsClipboardFiles,
} from '../apps/desktop/src/main/os-clipboard-files'

function hdrop(names: string[], wide = true, offset = 20, encoding: BufferEncoding = 'latin1'): Buffer {
  const header = Buffer.alloc(offset)
  header.writeUInt32LE(offset, 0)
  header.writeUInt32LE(wide ? 1 : 0, 16)
  return Buffer.concat([header, Buffer.from(names.join('\0') + '\0\0', wide ? 'utf16le' : encoding)])
}

const first = path.resolve('clipboard fixtures', 'hello world.txt')
const second = path.resolve('clipboard fixtures', '日本語 & café.txt')
const urls = [first, second].map(name => pathToFileURL(name).href)

test('CF_HDROP reads Unicode filenames at the declared DROPFILES offset', () => {
  const names = ['C:\\hello world.txt', 'C:\\日本語\\😀.png', '\\\\server\\share\\café.txt']
  assert.deepEqual(parseWinCfHdrop(hdrop(names)), names)
  assert.deepEqual(parseWinCfHdrop(hdrop(names, true, 32)), names)
})

test('CF_HDROP supports Latin-1 ANSI and valid UTF-8 names', () => {
  assert.deepEqual(parseWinCfHdrop(hdrop(['C:\\café.txt'], false)), ['C:\\café.txt'])
  assert.deepEqual(parseWinCfHdrop(hdrop(['C:\\日本語.txt'], false, 20, 'utf8')), ['C:\\日本語.txt'])
})

test('CF_HDROP decodes ANSI Windows-1252 Euro bytes', () => {
  assert.deepEqual(parseWinCfHdrop(hdrop(['C:\\price\x80.txt'], false)), ['C:\\price€.txt'])
})

test('CF_HDROP rejects truncated headers and invalid offsets without throwing', () => {
  for (let size = 0; size < 20; size++) assert.deepEqual(parseWinCfHdrop(Buffer.alloc(size)), [])
  for (const offset of [0, 1, 19, 24, 0xffffffff]) {
    const buffer = Buffer.alloc(24)
    buffer.writeUInt32LE(offset, 0)
    assert.deepEqual(parseWinCfHdrop(buffer), [])
  }
  assert.deepEqual(parseWinCfHdrop(hdrop([])), [])
  assert.deepEqual(parseWinCfHdrop(hdrop(['', 'ignored'])), [])
})

test('Windows parsers discard incomplete names and ignore data after the list terminator', () => {
  const buffer = hdrop(['one', 'two'])
  assert.deepEqual(parseWinCfHdrop(buffer.subarray(0, buffer.length - 5)), ['one'])
  assert.deepEqual(parseWinCfHdrop(Buffer.concat([hdrop(['one']), Buffer.from('ignored\0', 'utf16le')])), ['one'])
  assert.deepEqual(parseWinFileNameW(Buffer.from('C:\\😀.txt\0ignored\0', 'utf16le')), ['C:\\😀.txt'])
  for (const buffer of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(2), Buffer.from('unterminated', 'utf16le'), Buffer.from([65, 0, 0])]) {
    assert.deepEqual(parseWinFileNameW(buffer), [])
  }
})

test('macOS plist decodes predefined, numeric and Unicode XML entities', () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "example" "example.dtd"><plist version="1.0"><array>
    <string>/tmp/A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;.txt</string>
    <string>/tmp/&#26085;&#x672c;😀.txt</string><string></string><string/>
  </array></plist>`
  assert.deepEqual(parseMacFilenamesPlist(xml), ['/tmp/A & B <C> "D" \'E\'.txt', '/tmp/日本😀.txt'])
  assert.deepEqual(parseMacFilenamesPlist('<array><string>/tmp/&amp;lt;.txt</string></array>'), ['/tmp/&lt;.txt'])
})

test('macOS plist ignores missing arrays, comments, malformed strings and invalid entities', () => {
  for (const xml of ['', 'not xml', '<string>/tmp/outside</string>', '<array><string>truncated', '<array/>']) {
    assert.deepEqual(parseMacFilenamesPlist(xml), [])
  }
  assert.deepEqual(parseMacFilenamesPlist(`<array><!-- <string>/tmp/comment</string> -->
    <string>&external;</string><string>&#0;</string><string>&#x110000;</string><string>&#xD800;</string>
    <string>/tmp/bare&name</string><string>/tmp/\0bad</string><string>/tmp/good</string></array>`), ['/tmp/good'])
})

test('URI list accepts native file URLs and ignores comments, other schemes and malformed URLs', () => {
  const text = `# copied files\r\n${urls[0]}\r\n\r\n  ${urls[1]}  \nhttps://example.com/file\nnot a url\nfile:///bad%ZZ\nfile:///bad%00name\nfile:///bad%2Fname\n`
  assert.deepEqual(parseUriList(text), [first, second])
  assert.deepEqual(parseUriList(`${urls[0]}\0${urls[1]}\0`), [first, second])
  assert.deepEqual(parseUriList(''), [])
})

test('reader merges every advertised format across platforms, deduplicates and filters existence', () => {
  const values: Record<string, Buffer> = {
    CF_HDROP: hdrop([first, second]),
    FileNameW: Buffer.from(first + '\0', 'utf16le'),
    NSFilenamesPboardType: Buffer.from('<array><string>/tmp/mac-only</string></array>'),
    'public.file-url': Buffer.from(urls[1]),
    'text/uri-list': Buffer.from(urls[0] + '\n' + pathToFileURL(path.resolve('missing')).href),
  }
  const checked: string[] = []
  assert.deepEqual(readOsClipboardFiles({
    availableFormats: () => Object.keys(values).reverse(),
    readBuffer: format => values[format],
  }, name => { checked.push(name); return name !== path.resolve('missing') }), [first, second, '/tmp/mac-only'])
  assert.deepEqual(checked, [first, second, '/tmp/mac-only', path.resolve('missing')])
})

test('reader matches advertised names case insensitively and never probes unadvertised formats', () => {
  const read: string[] = []
  assert.deepEqual(readOsClipboardFiles({
    availableFormats: () => ['TEXT/URI-LIST', 'unrelated'],
    readBuffer: format => { read.push(format); return Buffer.from(urls[0]) },
  }), [first])
  assert.deepEqual(read, ['TEXT/URI-LIST'])
  assert.deepEqual(readOsClipboardFiles({ availableFormats: () => [], readBuffer: () => { throw Error('unexpected') } }), [])
})

test('reader falls back to textual reads for plist and URI formats, isolating format errors', () => {
  assert.deepEqual(readOsClipboardFiles({
    availableFormats: () => ['CF_HDROP', 'FileNameW', 'NSFilenamesPboardType', 'public.file-url', 'text/uri-list'],
    readBuffer: () => { throw Error('buffer unavailable') },
    read: format => {
      if (format === 'NSFilenamesPboardType') return '<array><string>/tmp/mac</string></array>'
      if (format === 'public.file-url') throw Error('unreadable')
      return urls[0]
    },
  }), ['/tmp/mac', first])
  assert.deepEqual(readOsClipboardFiles({ readBuffer: () => Buffer.alloc(0), read: format => format === 'text/uri-list' ? urls[1] : '' }), [second])
})

test('reader handles missing APIs, failed enumeration and existence errors', () => {
  assert.deepEqual(readOsClipboardFiles({}), [])
  assert.deepEqual(readOsClipboardFiles({ read: () => '' }), [])
  assert.deepEqual(readOsClipboardFiles({
    availableFormats: () => { throw Error('enumeration unavailable') },
    readBuffer: format => format === 'CF_HDROP' ? hdrop([first, second]) : Buffer.alloc(0),
  }, name => { if (name === first) throw Error('inaccessible'); return true }), [second])
})
