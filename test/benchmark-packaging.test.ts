import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
// These standalone Node CLI modules intentionally have no TypeScript declaration files.
// @ts-expect-error JavaScript helper module is outside the TypeScript source graph.
import { parseBenchmarkArgs, resolveExecutable, evaluateThresholds, formatBenchmarkMarkdown } from '../scripts/benchmark-desktop.mjs'
// @ts-expect-error JavaScript helper module is outside the TypeScript source graph.
import { findPackagedExecutable, verifyPackagedResources } from '../scripts/smoke-packaged.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceSprite = path.join(root, 'packages', 'amekit', 'src', 'assets', 'ame-chibi.png')
const thresholds = { thresholdStartupMs: 15000, thresholdHeapMb: 512 }
const metrics = { mode: 'packaged', timeToReadyMs: 1200.125, firstPaintMs: 800, jsHeapUsedMB: 100, jsHeapTotalMB: 200, processTreeRssMB: 350.5, thresholds }
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ame-benchmark-packaging-test-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
async function file(target: string, data = 'fixture') {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, data)
}

test('argument defaults, all CLI flags, and paths containing spaces', () => {
  assert.deepEqual(parseBenchmarkArgs([]), { json: false, ...thresholds })
  assert.deepEqual(parseBenchmarkArgs(['--json', '--executable', 'C:\\Ame IDE\\Ame IDE.exe', '--threshold-startup-ms', '42.5', '--threshold-heap-mb', '256']), {
    json: true, executable: 'C:\\Ame IDE\\Ame IDE.exe', thresholdStartupMs: 42.5, thresholdHeapMb: 256,
  })
})

test('argument parser rejects invalid numbers, missing values, and unknown flags', () => {
  for (const flag of ['--threshold-startup-ms', '--threshold-heap-mb']) {
    for (const value of ['0', '-1', 'NaN', 'Infinity', '', ' ', '12ms', '--json']) assert.throws(() => parseBenchmarkArgs([flag, value]), /positive finite number/)
    assert.throws(() => parseBenchmarkArgs([flag]), /positive finite number/)
  }
  for (const argv of [['--executable'], ['--executable', ''], ['--executable', '--json']]) assert.throws(() => parseBenchmarkArgs(argv), /requires a path/)
  assert.throws(() => parseBenchmarkArgs(['--unknown']), /Unknown argument/)
})

test('thresholds include equality, reject exceeded values and unavailable measurements', () => {
  assert.deepEqual(evaluateThresholds({ timeToReadyMs: 15000, jsHeapUsedMB: 512 }, thresholds), { ok: true, failures: [] })
  assert.equal(evaluateThresholds({ timeToReadyMs: 0, jsHeapUsedMB: 0 }, thresholds).ok, true)
  const failed = evaluateThresholds({ timeToReadyMs: 15000.01, jsHeapUsedMB: 512.01 }, thresholds)
  assert.equal(failed.ok, false)
  assert.equal(failed.failures.length, 2)
  assert.match(failed.failures.join('\n'), /Startup.*exceeds.*\nJS heap used.*exceeds/)
  for (const invalid of [undefined, null, NaN, Infinity, -1]) {
    assert.equal(evaluateThresholds({ ...metrics, timeToReadyMs: invalid }, thresholds).ok, false)
    assert.equal(evaluateThresholds({ ...metrics, jsHeapUsedMB: invalid }, thresholds).ok, false)
  }
  assert.equal(evaluateThresholds(metrics, { ...thresholds, thresholdHeapMb: 0 }).ok, false)
  assert.equal(evaluateThresholds({ ...metrics, processTreeRssMB: null }, thresholds).ok, true)
})

test('Markdown renders metrics, unavailable RSS/paint, and pass/fail status', () => {
  const markdown = formatBenchmarkMarkdown(metrics)
  assert.match(markdown, /\| Metric \| Value \|/)
  assert.match(markdown, /1200\.13/)
  assert.match(markdown, /RSS \(MiB\) \| 350\.50/)
  assert.match(markdown, /Threshold status: \*\*PASS\*\*/)
  const unavailable = formatBenchmarkMarkdown({ ...metrics, processTreeRssMB: null, firstPaintMs: null })
  assert.match(unavailable, /RSS \(MiB\) \| N\/A/)
  assert.match(unavailable, /navigation-relative\) \| N\/A/)
  const failed = formatBenchmarkMarkdown({ ...metrics, timeToReadyMs: 16000 })
  assert.match(failed, /\*\*FAIL\*\*/)
  assert.match(failed, /Startup.*exceeds/)
  assert.match(formatBenchmarkMarkdown({ ...metrics, thresholds: undefined, thresholdStatus: { ok: false, failures: ['example'] } }), /FAIL[\s\S]*example/)
})

test('lookup handles no build, nonexistent roots, and explicit missing overrides', async () => {
  await fixture(async directory => {
    assert.equal(findPackagedExecutable(directory, 'win32'), null)
    assert.equal(findPackagedExecutable(path.join(directory, 'missing'), 'darwin'), null)
    assert.deepEqual(resolveExecutable(undefined, directory, 'win32'), { mode: 'dev', executable: null, resourcesDir: path.join(directory, 'resources') })
    const explicit = path.join(directory, 'custom', 'Ame IDE.exe')
    assert.deepEqual(resolveExecutable(explicit, directory, 'win32'), { mode: 'packaged', executable: explicit, resourcesDir: path.join(path.dirname(explicit), 'resources') })
    assert.equal(findPackagedExecutable(directory, 'win32', explicit), null)
    await file(explicit)
    assert.deepEqual(findPackagedExecutable(directory, 'win32', explicit), { executable: explicit, resourcesDir: path.join(path.dirname(explicit), 'resources') })
  })
})

test('Windows release-* scan is deterministic, prefers release, and validates override files', async () => {
  await fixture(async directory => {
    const alternate = path.join(directory, 'release-custom', 'win-unpacked', 'Ame IDE.exe')
    const standard = path.join(directory, 'release', 'win-unpacked', 'Ame IDE.exe')
    await file(alternate)
    assert.equal(findPackagedExecutable(directory, 'win32').executable, alternate)
    await file(standard, '')
    assert.equal(findPackagedExecutable(directory, 'win32').executable, alternate)
    await rm(standard)
    await mkdir(standard)
    assert.equal(findPackagedExecutable(directory, 'win32', standard), null)
    await rm(standard, { recursive: true })
    await file(standard)
    assert.deepEqual(resolveExecutable(undefined, directory, 'win32'), { mode: 'packaged', executable: standard, resourcesDir: path.join(path.dirname(standard), 'resources') })
    assert.equal(findPackagedExecutable(directory, 'win32', alternate).executable, alternate)
    assert.equal(findPackagedExecutable(directory, 'win32', path.join(directory, 'missing.exe')), null)
    assert.equal(findPackagedExecutable(directory, 'darwin'), null)
  })
})

for (const layout of ['mac-arm64', 'mac']) {
  test(`macOS ${layout} app uses Contents/Resources for discovery and explicit overrides`, async () => {
    await fixture(async directory => {
      const contents = path.join(directory, 'release', layout, 'Ame IDE.app', 'Contents')
      const executable = path.join(contents, 'MacOS', 'Ame IDE')
      const resourcesDir = path.join(contents, 'Resources')
      await file(executable)
      assert.deepEqual(findPackagedExecutable(directory, 'darwin'), { executable, resourcesDir })
      assert.deepEqual(findPackagedExecutable(directory, 'darwin', executable), { executable, resourcesDir })
      assert.deepEqual(resolveExecutable(undefined, directory, 'darwin'), { mode: 'packaged', executable, resourcesDir })
      assert.deepEqual(resolveExecutable(executable, directory, 'darwin'), { mode: 'packaged', executable, resourcesDir })
    })
  })
}

async function resourceFixture(run: (resources: string, repository: string) => Promise<void>) {
  await fixture(async directory => {
    const repository = path.join(directory, 'repo'), resources = path.join(directory, 'resources')
    const source = path.join(repository, 'packages', 'amekit', 'src', 'assets', 'ame-chibi.png')
    await mkdir(path.dirname(source), { recursive: true })
    await copyFile(sourceSprite, source)
    await file(path.join(resources, 'opencode', 'opencode.exe'))
    await file(path.join(resources, 'amekit-models', 'server.js'))
    await copyFile(sourceSprite, path.join(resources, 'ame-chibi.png'))
    await run(resources, repository)
  })
}

test('resources pass with a real sprite and flat or actual platform-scoped runtime', async () => {
  await resourceFixture(async (resources, repository) => {
    const expected = createHash('sha256').update(await readFile(sourceSprite)).digest('hex')
    assert.deepEqual(await verifyPackagedResources(resources, repository), { ok: true, issues: [], petSpriteSha256: expected })
    await rm(path.join(resources, 'opencode', 'opencode.exe'))
    await file(path.join(resources, 'opencode', 'darwin-arm64', 'opencode'))
    assert.equal((await verifyPackagedResources(resources, repository)).ok, true)
    await rm(path.join(resources, 'opencode'), { recursive: true })
    await file(path.join(resources, 'opencode', 'opencode'))
    assert.equal((await verifyPackagedResources(resources, repository)).ok, true)
  })
})

for (const missing of ['opencode', path.join('amekit-models', 'server.js'), 'ame-chibi.png']) {
  test(`resources fail cleanly when ${missing} is absent`, async () => {
    await resourceFixture(async (resources, repository) => {
      await rm(path.join(resources, missing), { recursive: true })
      const result = await verifyPackagedResources(resources, repository)
      assert.equal(result.ok, false)
      assert.equal(result.issues.length, 1)
      assert.ok(result.issues[0].includes(path.basename(missing)))
    })
  })
}

test('resources reject tampered sprite, empty runtime/server and missing reference sprite', async () => {
  await resourceFixture(async (resources, repository) => {
    const sprite = path.join(resources, 'ame-chibi.png')
    const bytes = await readFile(sprite)
    bytes[bytes.length - 1] ^= 1
    await writeFile(sprite, bytes)
    const tampered = await verifyPackagedResources(resources, repository)
    assert.equal(tampered.ok, false)
    assert.match(tampered.issues.join('\n'), /SHA-256 mismatch/)
    await copyFile(sourceSprite, sprite)
    await writeFile(path.join(resources, 'opencode', 'opencode.exe'), '')
    await writeFile(path.join(resources, 'amekit-models', 'server.js'), '')
    await rm(path.join(repository, 'packages', 'amekit', 'src', 'assets', 'ame-chibi.png'))
    const invalid = await verifyPackagedResources(resources, repository)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.issues.length, 3)
  })
})
