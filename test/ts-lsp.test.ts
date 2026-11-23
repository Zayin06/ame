import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
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

test('shared worker keeps workspace diagnostics isolated when another service is disposed', async t => {
  const workers = new Set<Worker>()
  const postMessage = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
    workers.add(this)
    return postMessage.apply(this, args)
  })
  const rootA = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-shared-a-'))
  const rootB = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-shared-b-'))
  const serviceA = createTsLanguageService(rootA)
  const serviceB = createTsLanguageService(rootB)
  try {
    for (const root of [rootA, rootB]) {
      await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ['*.ts'] }))
    }
    await writeFile(path.join(rootA, 'b.ts'), 'export const value: number = 1\n')
    await writeFile(path.join(rootB, 'b.ts'), 'export const value: number = "bad"\n')
    const [diagnosticsA, diagnosticsB] = await Promise.all([serviceA.diagnostics(), serviceB.diagnostics()])
    assert.deepEqual(diagnosticsA, [])
    assert.deepEqual(diagnosticsB.map(item => [item.path, item.code]), [['b.ts', 2322]])
    assert.equal(workers.size, 1)
    await [...workers][0].terminate()
    const recovered = await Promise.all([serviceA.diagnostics(), serviceB.diagnostics()])
    assert.deepEqual(recovered, [diagnosticsA, diagnosticsB])
    assert.equal(workers.size, 2)

    const rejected = assert.rejects(serviceA.diagnostics(), /LSP_DISPOSED/)
    const stillRunning = serviceB.diagnostics()
    serviceA.dispose()
    serviceA.dispose()
    await rejected
    await assert.rejects(serviceA.diagnostics(), /LSP_DISPOSED/)
    assert.deepEqual(await stillRunning, diagnosticsB)
    assert.deepEqual(await serviceB.diagnostics(), diagnosticsB)
    assert.equal(workers.size, 2)
  } finally {
    serviceA.dispose()
    serviceB.dispose()
    await Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })])
  }
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
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [],
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

test('worker discovery and diagnostics keep the main event loop responsive and skip generated trees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-worker-'))
  const service = createTsLanguageService(root)
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await service.refreshFiles()
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ['**/*.ts'] }))
    for (let index = 0; index < 60; index++) {
      await writeFile(path.join(root, `module${index}.ts`), index === 0 ? 'export const value0: number = 0\n'
        : `import { value${index - 1} } from './module${index - 1}'\nexport const value${index}: number = value${index - 1} + 1\n`)
    }
    for (const directory of ['release', '.venv', 'release-example']) {
      await mkdir(path.join(root, directory))
      await writeFile(path.join(root, directory, 'broken.ts'), 'export const broken: number = "bad"\n')
    }
    let last = performance.now(), maxLagMs = 0, samples = 0
    timer = setInterval(() => {
      const now = performance.now()
      maxLagMs = Math.max(maxLagMs, now - last - 10)
      last = now
      samples++
    }, 10)
    await service.refreshFiles()
    const diagnostics = await service.diagnostics()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(diagnostics, [])
    assert.ok(samples > 0)
    assert.ok(maxLagMs < 100, `main event-loop lag ${maxLagMs.toFixed(1)}ms`)
  } finally { clearInterval(timer); service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('concurrent refresh callers all observe newly discovered files', async () => {
  const { root, service } = await fixture()
  try {
    await service.refreshFiles()
    await writeFile(path.join(root, 'src', 'new.ts'), 'export const value: number = "bad"\n')
    await Promise.all(Array.from({ length: 10 }, () => service.refreshFiles()))
    const diagnostics = await service.diagnostics()
    assert.deepEqual(diagnostics.map(item => [item.path, item.code]), [['src/new.ts', 2322]])
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('Windows mixed-case roots and config paths retain included files and overlay identity', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'Ame-Ts-Case-'))
  let service: ReturnType<typeof createTsLanguageService> | undefined
  try {
    await mkdir(path.join(root, 'Source'))
    await writeFile(path.join(root, 'Source', 'Mixed.ts'), 'export const value: number = "bad"\n')
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ['source/mixed.ts'] }))
    service = createTsLanguageService(root.toLowerCase())
    await service.refreshFiles()
    assert.ok((await service.diagnostics()).some(item => item.code === 2322 && item.path.toLowerCase() === 'source/mixed.ts'))
    await service.updateDocument('Source/Mixed.ts', 'export const value: number = 1\n')
    assert.deepEqual(await service.diagnostics('source/mixed.ts'), [])
    await service.closeDocument('SOURCE/MIXED.ts')
    assert.ok((await service.diagnostics('Source/Mixed.ts')).some(item => item.code === 2322))
  } finally { service?.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('disposing a busy worker rejects pending and future operations', async () => {
  const { root, service } = await fixture()
  try {
    const pending = service.diagnostics()
    const rejected = assert.rejects(pending, /LSP_DISPOSED/)
    service.dispose()
    await rejected
    await assert.rejects(service.refreshFiles(), /LSP_DISPOSED/)
    await assert.rejects(service.updateDocument('src/app.ts', app), /LSP_DISPOSED/)
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('safety caches never hide junctions introduced between operations', async () => {
  const { root, service } = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ame-ts-new-link-'))
  try {
    assert.deepEqual(await service.diagnostics(), [])
    await writeFile(path.join(outside, 'math.ts'), 'export const value: number = "bad"\n')
    await rm(path.join(root, 'src'), { recursive: true })
    await symlink(outside, path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(service.diagnostics('src/math.ts'), /SYMLINK/)
    assert.deepEqual(await service.diagnostics(), [])
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
