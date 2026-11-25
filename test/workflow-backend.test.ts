import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

type Step = { name?: string; run?: string; if?: string; env?: Record<string, string>; 'continue-on-error'?: boolean }

async function workflow(file: string) {
  const document = parseDocument(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'), { uniqueKeys: true })
  assert.deepEqual(document.errors, [], `${file} must be valid YAML`)
  const value = document.toJS()
  assert.ok(value.on && value.jobs, `${file} must define triggers and jobs`)
  return value
}

function before(steps: Step[], first: string, second: string) {
  const a = steps.findIndex(step => step.run === first)
  const b = steps.findIndex(step => step.run === second)
  assert.ok(a >= 0 && b > a, `${first} must precede ${second}`)
}

// Match the prerequisites used by runtime.test.ts and native-nesting.test.ts.
// Unlike their optional local coverage, release must fail if either is absent.
async function requireBackend(resources: string) {
  const executable = path.join(resources, 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  for (const file of [executable, path.join(resources, 'amekit-models', 'server.js')]) {
    const info = await stat(file)
    assert.ok(info.isFile() && info.size > 0, `Required backend resource is not a nonempty file: ${file}`)
  }
  await access(executable, constants.X_OK)
}

test('required backend coverage cannot silently skip missing runtime or plugin', async () => {
  if (process.env.AME_REQUIRE_BACKEND_TESTS !== '1') return
  await requireBackend(path.resolve('resources'))
})

test('backend prerequisite guard rejects clean, partial and empty resource trees', async () => {
  const resources = await mkdtemp(path.join(os.tmpdir(), 'ame-workflow-backend-'))
  try {
    await assert.rejects(requireBackend(resources), /ENOENT/)
    const executable = path.join(resources, 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    const plugin = path.join(resources, 'amekit-models', 'server.js')
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, 'fixture', { mode: 0o755 })
    await assert.rejects(requireBackend(resources), /ENOENT/)
    await mkdir(path.dirname(plugin), { recursive: true })
    await writeFile(plugin, '')
    await assert.rejects(requireBackend(resources), /nonempty file/)
    await writeFile(plugin, 'fixture')
    await requireBackend(resources)
    await writeFile(executable, '')
    await assert.rejects(requireBackend(resources), /nonempty file/)
  } finally { await rm(resources, { recursive: true, force: true }) }
})

test('required backend mode exits nonzero on a clean checkout without resources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ame-workflow-clean-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, AME_REQUIRE_BACKEND_TESTS: '1' }
    // Start an independent runner rather than inheriting the parent's test worker.
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), '--test',
      '--test-name-pattern', '^required backend coverage cannot silently skip',
      fileURLToPath(import.meta.url),
    ], { cwd: directory, env, encoding: 'utf8', timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('npm test includes all gateway tests for local, CI and release coverage', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.scripts.test.split(/\s+/).includes('packages/amekit-server/test/*.test.ts'))
  for (const [file, job] of [['ci.yml', 'check'], ['release.yml', 'package']]) {
    const value = await workflow(file)
    const steps: Step[] = value.jobs[job].steps
    const tests = steps.find(step => step.run === 'npm test')
    assert.ok(tests, `${file} must run npm test`)
    assert.equal(tests.if, undefined, `${file} must run npm test unconditionally`)
    assert.ok(!tests['continue-on-error'], `${file} must fail on test errors`)
  }
})

test('release prepares real backend before tests and preserves Node to Electron ABI order', async () => {
  const release = await workflow('release.yml')
  const steps: Step[] = release.jobs.package.steps
  before(steps, 'npm ci', 'npm run runtime:prepare')
  before(steps, 'npm run runtime:prepare', 'npm run build:server')
  before(steps, 'npm run build:server', 'npm test')
  before(steps, 'npm test', 'npx electron-builder install-app-deps --arch=${{ matrix.arch }}')
  before(steps, 'npx electron-builder install-app-deps --arch=${{ matrix.arch }}', 'npm run build')
  const tests = steps.find(step => step.run === 'npm test')!
  assert.equal(tests.env?.AME_REQUIRE_BACKEND_TESTS, '1')
  for (const command of ['npm run runtime:prepare', 'npm run build:server', 'npm test']) {
    const step = steps.find(step => step.run === command)!
    assert.equal(step.if, undefined, `${command} must be unconditional in release`)
    assert.ok(!step['continue-on-error'], `${command} must fail hard`)
  }
  const prepare = steps.findIndex(step => step.run === 'npm run runtime:prepare')
  for (const name of ['Provision pinned OpenCode 2.3.2 archive when no custom runtime is configured', 'Acquire pinned runtime if no trusted local path is configured']) {
    const index = steps.findIndex(step => step.name === name)
    assert.ok(index >= 0 && index < prepare, `${name} must precede runtime preparation`)
  }
})

test('CI validates configured runtime before tests and makes optional coverage explicit', async () => {
  const ci = await workflow('ci.yml')
  const steps: Step[] = ci.jobs.check.steps
  before(steps, 'npm run runtime:prepare', 'npm run build:server')
  before(steps, 'npm run build:server', 'npm test')
  const prepare = steps.find(step => step.run === 'npm run runtime:prepare')!
  assert.equal(prepare.if, "env.AME_OPENCODE_CLI != ''")
  assert.ok(!prepare['continue-on-error'])
  const tests = steps.find(step => step.run === 'npm test')!
  assert.equal(tests.env?.AME_REQUIRE_BACKEND_TESTS, "${{ env.AME_OPENCODE_CLI != '' && '1' || '0' }}")
  assert.equal(tests.if, undefined)
  assert.ok(!tests['continue-on-error'])
  assert.ok(steps.some(step => step.if === "env.AME_OPENCODE_CLI == ''" && step.run?.includes('tests may skip')))
})

test('macOS packaging workflow remains valid YAML with architecture-scoped runtime preparation', async () => {
  const mac = await workflow('build-mac.yml')
  const steps: Step[] = mac.jobs['package-mac'].steps
  assert.ok(steps.some(step => step.run === 'npm run runtime:prepare'))
})
