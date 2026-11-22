import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { simpleGit } from 'simple-git'
import { parseDocument } from 'yaml'
import { checkoutBranch, createBranch, discardFile, listBranches, stageAll, stagedDiffSummary, unstageAll, validateBranchName } from '../packages/ide-core/src/git-ops'

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ame-git-ops-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await mkdir(root)
  const git = simpleGit(root, { maxConcurrentProcesses: 1, trimmed: false }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  await git.raw(['init', '--initial-branch=main'])
  await git.addConfig('user.name', 'Ame Git Ops Test')
  await git.addConfig('user.email', 'git-ops@example.invalid')
  await git.addConfig('commit.gpgSign', 'false')
  await git.addConfig('core.autocrlf', 'false')
  const write = (name: string, content: string) => writeFile(path.join(root, name), content, 'utf8')
  const read = (name: string) => readFile(path.join(root, name), 'utf8')
  const commit = async () => { await stageAll(root); await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'fixture']) }
  return { root, temporary, git, write, read, commit }
}

test('unborn repository lists cleanly and unstages all without losing newer working content', async t => {
  const { root, git, write, read } = await fixture(t)
  assert.deepEqual(await listBranches(root), { current: 'main', branches: [] })
  assert.deepEqual(await stagedDiffSummary(root), { diff: '', files: [], truncated: false })
  await unstageAll(root)
  await write('new.txt', 'staged\n')
  await mkdir(path.join(root, 'nested'))
  await write('nested/second.txt', 'second\n')
  await stageAll(root)
  await write('new.txt', 'newer working content\n')
  assert.deepEqual((await stagedDiffSummary(root)).files, ['nested/second.txt', 'new.txt'])
  await unstageAll(root)
  assert.equal(await git.raw(['ls-files']), '')
  assert.equal(await read('new.txt'), 'newer working content\n')
  assert.equal(await read('nested/second.txt'), 'second\n')
  assert.deepEqual((await listBranches(root)).branches, [])
})

test('stageAll and unstageAll include modifications, deletions and new files after initial commit', async t => {
  const { root, git, write, read, commit } = await fixture(t)
  await write('changed.txt', 'before\n'); await write('deleted.txt', 'before\n'); await commit()
  await write('changed.txt', 'after\n'); await rm(path.join(root, 'deleted.txt')); await write('new.txt', 'new\n')
  await stageAll(root)
  assert.deepEqual((await stagedDiffSummary(root)).files, ['changed.txt', 'deleted.txt', 'new.txt'])
  await unstageAll(root)
  assert.deepEqual(await stagedDiffSummary(root), { diff: '', files: [], truncated: false })
  assert.equal(await read('changed.txt'), 'after\n')
  assert.equal(await read('new.txt'), 'new\n')
  await assert.rejects(read('deleted.txt'), { code: 'ENOENT' })
  assert.equal((await git.status()).files.length, 3)
})

test('discard restores tracked modifications, deleted files and staged deletions without touching neighbors', async t => {
  const { root, git, write, read, commit } = await fixture(t)
  for (const name of ['file with space.txt', 'deleted.txt', 'staged-delete.txt', 'keep.txt']) await write(name, 'original\n')
  await commit()
  await write('keep.txt', 'keep working edits\n')
  await write('file with space.txt', 'modified\n')
  await discardFile(root, 'file with space.txt')
  assert.equal(await read('file with space.txt'), 'original\n')
  await rm(path.join(root, 'deleted.txt'))
  await discardFile(root, 'deleted.txt')
  assert.equal(await read('deleted.txt'), 'original\n')
  await git.raw(['rm', '--', 'staged-delete.txt'])
  await discardFile(root, 'staged-delete.txt')
  assert.equal(await read('staged-delete.txt'), 'original\n')
  assert.equal(await read('keep.txt'), 'keep working edits\n')
})

test('discard uses index for staged additions and staged modifications, including unborn repositories', async t => {
  const { root, write, read, commit } = await fixture(t)
  await write('added.txt', 'index addition\n'); await stageAll(root)
  await write('added.txt', 'unstaged edit\n'); await discardFile(root, 'added.txt')
  assert.equal(await read('added.txt'), 'index addition\n')
  await rm(path.join(root, 'added.txt')); await discardFile(root, 'added.txt')
  assert.equal(await read('added.txt'), 'index addition\n')
  await commit()
  await write('added.txt', 'staged edit\n'); await stageAll(root)
  await write('added.txt', 'working edit\n'); await discardFile(root, 'added.txt')
  assert.equal(await read('added.txt'), 'staged edit\n')
  await write('new-after-head.txt', 'new index entry\n'); await stageAll(root)
  await rm(path.join(root, 'new-after-head.txt')); await discardFile(root, 'new-after-head.txt')
  assert.equal(await read('new-after-head.txt'), 'new index entry\n')
})

test('discard removes only the literal untracked file, accepts option-like names and rejects directories', async t => {
  const { root, write, read } = await fixture(t)
  await write('untracked.txt', 'remove\n'); await write('keep.txt', 'keep\n')
  await discardFile(root, 'untracked.txt')
  await assert.rejects(read('untracked.txt'), { code: 'ENOENT' })
  await discardFile(root, 'missing.txt')
  await write('-option.txt', 'index\n'); await stageAll(root)
  await write('-option.txt', 'working\n'); await discardFile(root, '-option.txt')
  assert.equal(await read('-option.txt'), 'index\n')
  await mkdir(path.join(root, 'directory')); await write('directory/child.txt', 'keep child\n')
  await assert.rejects(discardFile(root, 'directory'), /INVALID_PATH/)
  assert.equal(await read('directory/child.txt'), 'keep child\n')
  if (process.platform !== 'win32') {
    await write('literal*.txt', 'literal index\n'); await stageAll(root)
    await write('literal-other.txt', 'neighbor\n'); await write('literal*.txt', 'changed\n')
    await discardFile(root, 'literal*.txt')
    assert.equal(await read('literal*.txt'), 'literal index\n')
    assert.equal(await read('literal-other.txt'), 'neighbor\n')
    await write('literal*.txt', 'remove from index\n')
    const git = simpleGit(root)
    await git.raw(['rm', '-f', '--cached', '--', ':(literal)literal*.txt'])
    await discardFile(root, 'literal*.txt')
    assert.equal(await read('literal-other.txt'), 'neighbor\n')
  }
  assert.equal(await read('keep.txt'), 'keep\n')
})

test('discard rejects traversal, metadata, alternate streams and symlink escapes even for missing children', async t => {
  const { root, temporary, write, read } = await fixture(t)
  await write('keep.txt', 'keep\n')
  await writeFile(path.join(temporary, 'outside.txt'), 'outside\n')
  const metadata = await readFile(path.join(root, '.git', 'config'), 'utf8')
  for (const value of ['', '.', './', '..', '../outside.txt', '..\\outside.txt', 'nested/../keep.txt', 'nested\\..\\keep.txt', '.git/config', '.GIT\\config', 'nested/.Git/config', 'C:relative.txt', 'C:\\Windows\\win.ini', '/etc/passwd', '\\\\host\\share', 'file:stream', 'nul\0.txt']) {
    await assert.rejects(discardFile(root, value), /INVALID_PATH/, value)
  }
  await symlink(temporary, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(path.join(root, '.git'), path.join(root, 'metadata'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const value of ['escape', 'escape/outside.txt', 'escape/missing/file.txt', 'metadata/config', 'metadata/missing']) await assert.rejects(discardFile(root, value), /INVALID_PATH/, value)
  await mkdir(path.join(root, 'inside'))
  await write('inside/child.txt', 'inside\n')
  await symlink(path.join(root, 'inside'), path.join(root, 'safe-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await discardFile(root, 'safe-link/child.txt')
  await assert.rejects(read('inside/child.txt'), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(temporary, 'outside.txt'), 'utf8'), 'outside\n')
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf8'), metadata)
  assert.equal(await read('keep.txt'), 'keep\n')
})

test('all repository operations require .git at the selected root, not an ancestor', async t => {
  const { root, write } = await fixture(t)
  await mkdir(path.join(root, 'child'))
  await write('child/keep.txt', 'keep\n')
  const child = path.join(root, 'child')
  for (const operation of [() => stageAll(child), () => unstageAll(child), () => discardFile(child, 'keep.txt'), () => listBranches(child), () => checkoutBranch(child, 'main'), () => createBranch(child, 'feature'), () => stagedDiffSummary(child)]) await assert.rejects(operation(), /GIT_ROOT_REQUIRED/)
})

test('branch validation rejects Git-invalid and option-like names without trimming silently', () => {
  for (const value of ['', ' ', '-branch', '--orphan', '.hidden', 'tail.', 'tail/', 'name.lock', 'a.lock/b', 'a/.hidden', 'a..b', 'a@{b', 'a\\b', 'a b', ' a', 'a ', 'a\tb', 'a\nb', 'a\0b', 'a\x1fb', 'a\x7fb', 'a//b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', '@', 'HEAD', '/leading']) assert.throws(() => validateBranchName(value), /INVALID_BRANCH_NAME/, JSON.stringify(value))
  for (const value of ['main', 'feature/git-ops', 'release-2.3.2', 'nhánh/mới', 'a@b', 'name.locked', 'topic;safe']) assert.equal(validateBranchName(value), value)
})

test('creates branches with and without checkout, switches safely and lists commits and current flags', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('file.txt', 'initial\n'); await commit()
  const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await createBranch(root, 'feature/no-checkout', false)
  assert.equal((await listBranches(root)).current, 'main')
  await createBranch(root, 'feature/active')
  assert.deepEqual(await listBranches(root), {
    current: 'feature/active',
    branches: [
      { name: 'feature/active', current: true, commit: head },
      { name: 'feature/no-checkout', current: false, commit: head },
      { name: 'main', current: false, commit: head }
    ]
  })
  await checkoutBranch(root, 'feature/no-checkout')
  assert.equal((await listBranches(root)).current, 'feature/no-checkout')
  // A file sharing the branch name must not turn branch checkout into path checkout.
  await write('main', 'leave alone\n')
  await checkoutBranch(root, 'main')
  assert.equal((await listBranches(root)).current, 'main')
  for (const value of ['--orphan', 'bad..name', 'bad name']) {
    await assert.rejects(createBranch(root, value), /INVALID_BRANCH_NAME/)
    await assert.rejects(checkoutBranch(root, value), /INVALID_BRANCH_NAME/)
  }
  await git.raw(['checkout', '--detach', head])
  const detached = await listBranches(root)
  assert.equal(detached.current, '(detached)')
  assert.ok(detached.branches.every(branch => !branch.current))
})

test('diff summary preserves exact staged names, index content and UTF-8 byte boundaries', async t => {
  const { root, write } = await fixture(t)
  const content = 'chào 🌏 漢字\n'.repeat(1000)
  await write('lời chào.txt', content)
  await write('plain.txt', 'staged\n'); await stageAll(root)
  await write('plain.txt', 'not staged\n')
  const full = await stagedDiffSummary(root)
  assert.deepEqual(full.files, ['lời chào.txt', 'plain.txt'])
  assert.ok(full.diff.includes('+staged'))
  assert.ok(!full.diff.includes('+not staged'))
  assert.equal(full.truncated, false)
  const bytes = Buffer.from(full.diff)
  const multibyte = bytes.indexOf(Buffer.from('🌏'))
  assert.ok(multibyte > 0)
  for (const limit of [0, 1, multibyte + 1, multibyte + 2, multibyte + 3, multibyte + 4, 200]) {
    const result = await stagedDiffSummary(root, limit)
    assert.equal(result.truncated, true)
    assert.ok(Buffer.byteLength(result.diff) <= limit)
    assert.ok(full.diff.startsWith(result.diff))
    assert.ok(!result.diff.includes('\ufffd'))
    assert.deepEqual(result.files, full.files)
  }
  assert.equal((await stagedDiffSummary(root, bytes.length)).truncated, false)
  for (const limit of [-1, 1.5, NaN, Infinity]) await assert.rejects(stagedDiffSummary(root, limit), /INVALID_MAX_BYTES/)
  await write('large.txt', 'x'.repeat(70000)); await stageAll(root)
  const defaultLimit = await stagedDiffSummary(root)
  assert.equal(defaultLimit.truncated, true)
  assert.ok(Buffer.byteLength(defaultLimit.diff) <= 65536)
})

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
async function workflow(name: string) {
  const source = await readFile(path.join(repoRoot, '.github', 'workflows', name), 'utf8')
  const document = parseDocument(source, { uniqueKeys: true })
  assert.deepEqual(document.errors, [])
  return document.toJS() as Record<string, any>
}
function steps(job: any): string[] { return job.steps.map((step: any) => step.run ?? '') }

test('CI YAML runs Node 22 checks and runtime-free builds on Windows and macOS', async () => {
  const ci = await workflow('ci.yml')
  assert.deepEqual(ci.on.push.branches, ['main', 'master'])
  assert.ok('pull_request' in ci.on && 'workflow_dispatch' in ci.on)
  assert.equal(ci.concurrency['cancel-in-progress'], true)
  assert.ok(ci.concurrency.group.includes('github.ref'))
  const job = ci.jobs.check
  assert.deepEqual(job.strategy.matrix.os, ['windows-latest', 'macos-latest'])
  assert.equal(job['runs-on'], '${{ matrix.os }}')
  assert.ok(job.steps.some((step: any) => step.uses === 'actions/checkout@v4'))
  const node = job.steps.find((step: any) => step.uses === 'actions/setup-node@v4')
  assert.equal(node.with['node-version'], '22')
  assert.equal(node.with.cache, 'npm')
  assert.equal(node.with['cache-dependency-path'], 'package-lock.json')
  const commands = steps(job)
  for (const command of ['npm ci', 'npm run typecheck', 'npm test', 'npm run build:server', 'npx electron-vite build', 'npm run runtime:prepare', 'npm run build']) assert.ok(commands.includes(command), command)
  for (const command of ['npm run build:server', 'npx electron-vite build']) assert.equal(job.steps.find((step: any) => step.run === command).if, "env.AME_OPENCODE_CLI == ''")
  for (const command of ['npm run runtime:prepare', 'npm run build']) assert.equal(job.steps.find((step: any) => step.run === command).if, "env.AME_OPENCODE_CLI != ''")
})

test('release YAML covers target native rebuild, pinned runtime, signing and architecture-specific artifacts', async () => {
  const release = await workflow('release.yml')
  assert.deepEqual(release.on.push.tags, ['v*'])
  assert.equal(release.on.workflow_dispatch.inputs.dry_run.type, 'boolean')
  const job = release.jobs.package
  assert.deepEqual(job.strategy.matrix.include.map((entry: any) => [entry.os, entry.arch, entry.targets]), [
    ['windows-latest', 'x64', 'nsis portable'], ['macos-latest', 'x64', 'dmg zip'], ['macos-latest', 'arm64', 'dmg zip']
  ])
  assert.equal(job['runs-on'], '${{ matrix.os }}')
  const node = job.steps.find((step: any) => step.uses === 'actions/setup-node@v4')
  assert.equal(node.with['node-version'], '22')
  assert.equal(node.with.architecture, '${{ matrix.arch }}')
  assert.equal(node.with['cache-dependency-path'], 'package-lock.json')
  const commands = steps(job)
  for (const command of ['npm ci', 'npx electron-builder install-app-deps --arch=${{ matrix.arch }}', 'npm run typecheck', 'npm test', 'npm run runtime:prepare', 'npm run build']) assert.ok(commands.includes(command), command)
  assert.ok(commands.indexOf('npm test') < commands.indexOf('npx electron-builder install-app-deps --arch=${{ matrix.arch }}'))
  const download = commands.find(command => command.includes("createHash('sha256')"))!
  assert.ok(download.includes("url.protocol !== 'https:'"))
  assert.ok(download.includes("redirect: 'error'"))
  assert.ok(download.indexOf("throw new Error('Runtime SHA-256 mismatch')") < download.indexOf('await writeFile(file, bytes)'))
  const prepareIndex = job.steps.findIndex((step: any) => step.run === 'npm run runtime:prepare')
  assert.ok(prepareIndex > job.steps.findIndex((step: any) => step.run === download))
  const packaging = job.steps.find((step: any) => step.run?.includes('npx electron-builder --${{ matrix.platform }}'))
  assert.ok(packaging.run.includes('--publish never'))
  assert.ok(packaging.run.includes('--${{ matrix.arch }}'))
  assert.ok(packaging.run.includes('--config.win.signAndEditExecutable=true'))
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) assert.ok(packaging.env[key].includes(`secrets.${key}`), key)
  const artifact = job.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')
  assert.equal(artifact.with['if-no-files-found'], 'error')
  assert.ok(artifact.with.name.includes('matrix.arch'))
  for (const extension of ['exe', 'dmg', 'zip']) assert.ok(artifact.with.path.includes(`release/*.${extension}`))
})
