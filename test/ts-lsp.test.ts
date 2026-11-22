import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTsLanguageService } from '../packages/ide-core/src/ts-lsp'

const math = '/** Add two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b\n}\nexport const answer = 42\n'
const app = "import * as math from './math'\nconst result: number = math.add(6, 7)\nconsole.log(result)\n"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-lsp-'))
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, types: [],
  }, include: ['src/**/*'] }))
  await writeFile(path.join(root, 'src', 'math.ts'), math)
  await writeFile(path.join(root, 'src', 'app.ts'), app)
  return { root, service: createTsLanguageService(root) }
}

test('multi-file TypeScript operations use unsaved overlays without changing disk', async () => {
  const { root, service } = await fixture()
  try {
    assert.deepEqual(await service.diagnostics(), [])
    await service.updateDocument('src/app.ts', app.replace('result: number', 'result: string'))
    const errors = await service.diagnostics('src/app.ts')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].path, 'src/app.ts')
    assert.equal(errors[0].code, 2322)
    assert.equal(errors[0].severity, 'error')
    assert.equal(errors[0].line, 2)
    assert.equal(errors[0].column, 7)
    assert.equal(errors[0].endColumn, 13)
    assert.equal(await readFile(path.join(root, 'src', 'app.ts'), 'utf8'), app)
    await service.closeDocument('src/app.ts')
    assert.deepEqual(await service.diagnostics(), [])

    const info = await service.hover('src/app.ts', 2, 29)
    assert.match(info?.display ?? '', /add\(a: number, b: number\): number/)
    assert.equal(info?.documentation, 'Add two numbers.')
    assert.equal(info?.range.line, 2)
    assert.equal(info?.range.column, 29)
    assert.equal(await service.hover('src/app.ts', -10, -10), null)
    assert.deepEqual(await service.definition('src/app.ts', 999, 999), [])
    assert.deepEqual(await service.definition('src/app.ts', 2, 29), [
      { path: 'src/math.ts', line: 2, column: 17, endLine: 2, endColumn: 20 },
    ])
    const references = await service.references('src/math.ts', 2, 17)
    assert.deepEqual(new Set(references.map(ref => ref.path)), new Set(['src/math.ts', 'src/app.ts']))
    assert.ok(references.every(ref => ref.lineText.includes('add')))
    const preview = await service.renamePreview('src/math.ts', 2, 17, 'sum')
    assert.equal(preview.canRename, true)
    assert.deepEqual(new Set(preview.edits.map(group => group.path)), new Set(['src/math.ts', 'src/app.ts']))
    assert.ok(preview.edits.every(group => group.edits.every(edit => edit.newText === 'sum')))
    assert.equal(await readFile(path.join(root, 'src', 'math.ts'), 'utf8'), math)
    assert.equal(await readFile(path.join(root, 'src', 'app.ts'), 'utf8'), app)
    for (const invalid of ['', 'has space', '1name', 'return', 'ok;bad', ' leading']) {
      const result = await service.renamePreview('src/math.ts', 2, 17, invalid)
      assert.equal(result.canRename, false, invalid)
      assert.deepEqual(result.edits, [])
    }
    for (const valid of ['tổng', 'type', 'async', 'of', '$sum', '_sum'])
      assert.equal((await service.renamePreview('src/math.ts', 2, 17, valid)).canRename, true, valid)

    await service.updateDocument('src/app.ts', "import * as math from './math'\nmath.\n")
    const completions = await service.completions('src/app.ts', 2, 6)
    assert.ok(completions.some(item => item.label === 'add'))
    assert.ok(completions.some(item => item.label === 'answer'))
    assert.ok(completions.length <= 100)
    assert.deepEqual(await service.completions('src/app.ts', 2, 999), completions)
    await service.closeDocument('src/app.ts')
    await service.updateDocument('src/math.ts', math.replace('): number {', '): string {').replace('return a + b', "return 'text'"))
    assert.ok((await service.diagnostics('src/app.ts')).some(error => error.code === 2322))
    await service.closeDocument('src/math.ts')
    assert.deepEqual(await service.diagnostics(), [])
  } finally {
    service.dispose()
    await rm(root, { recursive: true, force: true })
  }
  await assert.rejects(service.diagnostics(), /LSP_DISPOSED/)
})

test('refresh reloads config, discovers files, and drops closed virtual documents', async () => {
  const { root, service } = await fixture()
  try {
    assert.deepEqual(await service.diagnostics(), [])
    await service.updateDocument('virtual/nested/module.ts', 'export const value: number = "bad"')
    assert.ok((await service.diagnostics()).some(item => item.path === 'virtual/nested/module.ts'))
    await service.updateDocument('src/app.ts', "import { value } from '../virtual/nested/module'\nconst text: string = value\n")
    const overlayDiagnostics = await service.diagnostics('src/app.ts')
    assert.ok(overlayDiagnostics.some(item => item.code === 2322))
    assert.ok(!overlayDiagnostics.some(item => item.code === 2307))
    await service.closeDocument('src/app.ts')
    await service.closeDocument('virtual/nested/module.ts')
    assert.deepEqual(await service.diagnostics(), [])
    await writeFile(path.join(root, 'src', 'new.ts'), 'const bad: number = "bad"')
    await service.refreshFiles()
    assert.ok((await service.diagnostics()).some(item => item.path === 'src/new.ts'))
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: false, types: [],
    }, files: ['src/math.ts'] }))
    await service.refreshFiles()
    assert.deepEqual(await service.diagnostics(), [])
    await writeFile(path.join(root, 'src', 'math.ts'), math.replace('b: number', 'b'))
    await service.refreshFiles()
    assert.deepEqual(await service.diagnostics(), [])
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ['src/math.ts'] }))
    await service.refreshFiles()
    assert.ok((await service.diagnostics()).some(item => item.code === 7006))
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('invalid or missing configs fall back to JS/TS discovery while skipping generated folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-fallback-'))
  const service = createTsLanguageService(root)
  try {
    await writeFile(path.join(root, 'app.js'), 'export const value = 1\n')
    await writeFile(path.join(root, 'bad.ts'), 'const value: number = "bad"')
    for (const directory of ['node_modules', '.git', 'dist', 'out', 'build', 'coverage']) {
      await mkdir(path.join(root, directory))
      await writeFile(path.join(root, directory, 'bad.ts'), 'const bad: number = "bad"')
    }
    assert.deepEqual((await service.diagnostics()).map(item => item.path), ['bad.ts'])
    for (const content of ['{broken', '{"compilerOptions":{"target":"not-a-target"}}']) {
      await writeFile(path.join(root, 'tsconfig.json'), content)
      await service.refreshFiles()
      assert.deepEqual((await service.diagnostics()).map(item => item.path), ['bad.ts'])
    }
    await rm(path.join(root, 'tsconfig.json'))
    await writeFile(path.join(root, 'jsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, types: [] }, files: ['app.js'] }))
    await writeFile(path.join(root, 'app.js'), '/** @type {number} */\nexport const value = "bad"\n')
    await service.refreshFiles()
    assert.deepEqual((await service.diagnostics()).map(item => item.path), ['app.js'])
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('all document APIs reject traversal, absolute paths, metadata, and escaping junctions', async () => {
  const { root, service } = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-outside-'))
  try {
    await writeFile(path.join(outside, 'outside.ts'), 'export const value = 1')
    await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const relative of ['../outside.ts', 'src/../app.ts', path.join(root, 'src', 'app.ts'), '.git/config', 'link/outside.ts']) {
      for (const operation of [
        () => service.updateDocument(relative, ''), () => service.closeDocument(relative),
        () => service.diagnostics(relative), () => service.completions(relative, 1, 1),
        () => service.hover(relative, 1, 1), () => service.definition(relative, 1, 1),
        () => service.references(relative, 1, 1), () => service.renamePreview(relative, 1, 1, 'name'),
      ]) await assert.rejects(operation(), /PATH|SYMLINK/, relative)
    }
    assert.deepEqual(await service.diagnostics(), [])
    const externalImport = path.relative(path.join(root, 'src'), path.join(outside, 'outside')).split(path.sep).join('/')
    await service.updateDocument('src/app.ts', `import { value } from '${externalImport}'\nconsole.log(value)\n`)
    assert.deepEqual(await service.definition('src/app.ts', 2, 13), [])
    const references = await service.references('src/app.ts', 2, 13)
    assert.ok(references.length > 0)
    assert.ok(references.every(item => item.path === 'src/app.ts'))
    const rename = await service.renamePreview('src/app.ts', 2, 13, 'renamed')
    assert.equal(rename.canRename, true)
    assert.ok(rename.edits.every(group => group.path === 'src/app.ts'))
  } finally {
    service.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
