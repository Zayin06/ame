import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { simpleGit } from 'simple-git'
import { parseDocument } from 'yaml'
import { buildNotesSummary, checkoutBranch, createBranch, deleteBranch, discardFile, gitFetch, gitPull, gitPush, gitLog, gitCommitDetail, gitUndoLastCommit, gitStashList, gitStashPush, gitStashApply, gitStashDrop, hasRemote, mapGitNetworkError, listBranches, stageAll, stagedDiffSummary, unstageAll, validateBranchName } from '../packages/ide-core/src/git-ops'
import { gitFileCommitPatch, safeReadOnlyGitConfig, detectUntrustedGitConfig, isHeadPushed } from '../packages/ide-core/src/git-ops'

test('stage-all excludes active atomic-save temporary files', async t => {
  const { root, git, write } = await fixture(t)
  await mkdir(path.join(root, 'nested'))
  await write('keep.txt', 'keep\n')
  await write('.ame-save-active.tmp', 'in-progress\n')
  await write('nested/.ame-save-active.bak', 'backup\n')
  await stageAll(root)
  assert.deepEqual((await git.raw(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean), ['keep.txt'])
})

test('network errors distinguish local permissions, authentication and remote policy rejection', () => {
  assert.doesNotMatch(mapGitNetworkError(new Error('EACCES: permission denied, open .git/index.lock')).message, /GIT_AUTH_FAILED/)
  for (const message of ['Permission denied (publickey)', 'Permission denied (keyboard-interactive)', 'Authentication failed', 'could not read username']) assert.match(mapGitNetworkError(new Error(message)).message, /^GIT_AUTH_FAILED:/)
  assert.match(mapGitNetworkError(new Error('! [remote rejected] main -> main (protected branch)')).message, /^GIT_REMOTE_REJECTED:/)
  assert.match(mapGitNetworkError(new Error('! [rejected] main -> main (non-fast-forward)')).message, /^GIT_PUSH_REJECTED_NON_FF:/)
})

test('hex-named branches cannot impersonate commit hashes while short OIDs still work', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('a.txt', 'base\n'); await commit()
  const hash = (await git.raw(['rev-parse', 'HEAD'])).trim()
  const spoof = hash.startsWith('deadbee') ? 'cafebab' : 'deadbee'
  await git.raw(['branch', spoof])
  await assert.rejects(gitCommitDetail(root, spoof), /INVALID_COMMIT_HASH/)
  await assert.rejects(buildNotesSummary(root, { mode: 'commits', commitHashes: [spoof], includeWorking: false }), /INVALID_BUILD_BASE_COMMIT/)
  await assert.rejects(gitFileCommitPatch(root, 'a.txt', [spoof]), /INVALID_COMMIT_HASH/)
  for (const length of [7, 8, 9]) assert.equal((await gitCommitDetail(root, hash.slice(0, length))).hash, hash)
  assert.equal(await isHeadPushed(root), false)
  await git.raw(['update-ref', 'refs/remotes/origin/main', hash])
  assert.equal(await isHeadPushed(root), true)
})

test('read-only config disables local executable filters and detects untrusted entries and hooks', async t => {
  const { root, git } = await fixture(t)
  for (const [key, value] of [['filter.danger.clean', 'echo unsafe'], ['filter.danger.process', 'echo unsafe'], ['filter.danger.required', 'true'], ['diff.danger.textconv', 'echo unsafe'], ['core.sshCommand', 'unsafe'], ['core.hooksPath', 'custom-hooks'], ['credential.helper', 'unsafe']]) await git.addConfig(key, value)
  await writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
  await writeFile(path.join(root, '.git', 'included-config'), '[filter "included"]\n\tclean = echo unsafe\n[diff "included"]\n\ttextconv = echo unsafe\n')
  await git.addConfig('include.path', 'included-config')
  const config = await safeReadOnlyGitConfig(root)
  assert.ok(config.includes('filter.included.clean='))
  assert.ok(config.includes('diff.included.textconv='))
  for (const value of ['core.fsmonitor=false', 'diff.external=', 'core.pager=cat', 'core.hooksPath=', 'core.sshCommand=', 'credential.helper=', 'filter.danger.clean=', 'filter.danger.smudge=', 'filter.danger.process=', 'filter.danger.required=false', 'diff.danger.textconv=']) assert.ok(config.includes(value), value)
  const detected = await detectUntrustedGitConfig(root)
  for (const key of ['filter.danger.clean', 'filter.danger.process', 'diff.danger.textconv', 'core.sshcommand', 'core.hookspath', 'credential.helper', 'hooks/pre-commit']) assert.ok(detected.map(value => value.toLowerCase()).includes(key), key)
  assert.ok(!detected.some(value => value.endsWith('.sample')))
})

async function fixture(t: TestContext, objectFormat = 'sha1') {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ame-git-ops-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await mkdir(root)
  const git = simpleGit(root, { maxConcurrentProcesses: 1, trimmed: false }).env({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  await git.raw(['init', '--initial-branch=main', `--object-format=${objectFormat}`])
  await git.addConfig('user.name', 'Ame Git Ops Test')
  await git.addConfig('user.email', 'git-ops@example.invalid')
  await git.addConfig('commit.gpgSign', 'false')
  await git.addConfig('core.autocrlf', 'false')
  const write = (name: string, content: string) => writeFile(path.join(root, name), content, 'utf8')
  const read = (name: string) => readFile(path.join(root, name), 'utf8')
  const commit = async () => { await stageAll(root); await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'fixture']) }
  return { root, temporary, git, write, read, commit }
}

test('merge detail lists stats and patch against only the first parent', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('base.txt', 'base\n'); await commit()
  await git.raw(['checkout', '-b', 'side'])
  await write('side.txt', 'nội dung nhánh phụ\n'); await commit()
  await git.raw(['checkout', 'main'])
  await write('main.txt', 'main only\n'); await commit()
  await git.raw(['merge', '--no-ff', 'side', '-m', 'merge side'])
  const detail = await gitCommitDetail(root, (await git.raw(['rev-parse', 'HEAD'])).trim())
  assert.equal(detail.isMerge, true)
  assert.deepEqual(detail.files, [{ path: 'side.txt', status: 'A', additions: 1, deletions: 0 }])
  assert.match(detail.patch, /\+nội dung nhánh phụ/)
  assert.ok(!detail.patch.includes('main only'))
})

async function hook(root: string, name: string, body: string) {
  const hooks = path.join(root, '.git', 'plan-test-hooks')
  await mkdir(hooks, { recursive: true })
  await writeFile(path.join(hooks, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  await simpleGit(root).addConfig('core.hooksPath', hooks)
}

test('R4 #10 SHA-256 build notes accept full hashes for ranges and selected commits', async t => {
  const { root, git, write, commit } = await fixture(t, 'sha256')
  await write('a', 'base\n'); await commit()
  const base = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('a', 'next\n'); await commit()
  const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
  assert.equal(head.length, 64)
  for (const request of [{ mode: 'range' as const, baseCommit: base }, { mode: 'commits' as const, commitHashes: [head] }]) {
    const summary = await buildNotesSummary(root, { ...request, includeWorking: false })
    assert.equal(summary.additions, 1); assert.equal(summary.deletions, 1)
    assert.match(summary.diff, /\+next/)
  }
})

test('R4 #11 merge build notes use first-parent stats and patch', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('base', 'base\n'); await commit()
  await git.raw(['checkout', '-b', 'side']); await write('side', 'side only\n'); await commit()
  await git.raw(['checkout', 'main']); await write('main', 'main only\n'); await commit()
  await git.raw(['merge', '--no-ff', 'side', '-m', 'merge'])
  const summary = await buildNotesSummary(root, { mode: 'commits', commitHashes: [(await git.raw(['rev-parse', 'HEAD'])).trim()], includeWorking: false })
  assert.deepEqual(summary.files, [{ path: 'side', status: 'A', additions: 1, deletions: 0, source: 'committed' }])
  assert.equal(summary.additions, 1); assert.equal(summary.deletions, 0)
  assert.match(summary.diff, /\+side only/); assert.ok(!summary.diff.includes('main only'))
})

test('R4 #12 unborn working notes reflect post-stage edits and deletes, not index blobs', async t => {
  const { root, git, write } = await fixture(t)
  await write('edited', 'staged old\n'); await write('deleted', 'staged deleted\n'); await stageAll(root)
  await write('edited', 'latest disk\n'); await rm(path.join(root, 'deleted'))
  const index = await git.raw(['ls-files', '--stage', '-z'])
  const summary = await buildNotesSummary(root, { mode: 'commits', includeWorking: true })
  assert.deepEqual(summary.files, [{ path: 'edited', status: 'A', additions: 1, deletions: 0, source: 'working' }])
  assert.match(summary.diff, /\+latest disk/); assert.ok(!summary.diff.includes('staged'))
  assert.equal(await git.raw(['ls-files', '--stage', '-z']), index)
})

test('R4 #13 file patches select multiple commits in topo order plus current working changes', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('file.txt', 'base\n'); await commit()
  const base = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('file.txt', 'first\n'); await commit()
  const first = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('unrelated', 'not selected\n'); await commit()
  await write('file.txt', 'last\n'); await commit()
  const last = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('file.txt', 'staged\n'); await stageAll(root); await write('file.txt', 'working chào 🌏\n')
  const before = await git.raw(['status', '--porcelain=v1', '-z'])
  const patch = await gitFileCommitPatch(root, 'file.txt', [first, last, first], true)
  assert.equal((patch.match(/^# commit /gm) ?? []).length, 2)
  assert.ok(patch.indexOf(last.slice(0, 7)) < patch.indexOf(first.slice(0, 7)))
  assert.match(patch, /\+first/); assert.match(patch, /\+last/); assert.match(patch, /\+working chào 🌏/)
  assert.ok(!patch.includes('+staged')); assert.ok(!patch.includes('unrelated'))
  assert.ok(!(await gitFileCommitPatch(root, 'file.txt', [base])).includes('working'))
  await write('new.txt', 'untracked chào 🌏\n')
  assert.match(await gitFileCommitPatch(root, 'new.txt', [last], true), /\+untracked chào 🌏/)
  assert.equal(await git.raw(['status', '--porcelain=v1', '-z']), before + '?? new.txt\0')
  for (const hashes of [[], ['HEAD'], ['f'.repeat(40)], Array(51).fill(last)]) await assert.rejects(gitFileCommitPatch(root, 'file.txt', hashes), /INVALID_COMMIT_HASH/)
  await assert.rejects(gitFileCommitPatch(root, '../escape', [last]), /INVALID_PATH/)
  await git.raw(['checkout', '-f', '-b', 'foreign', base]); await write('foreign', 'foreign\n'); await commit()
  const foreign = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await git.raw(['checkout', 'main'])
  await assert.rejects(gitFileCommitPatch(root, 'file.txt', [foreign]), /INVALID_COMMIT_HASH/)
})

test('R4 #13 file patch output is bounded to 4 MiB without splitting UTF-8', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('large.txt', 'base\n'); await commit()
  const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
  const content = 'chào 🌏\n'.repeat(500_000)
  await write('large.txt', content); await write('untracked.txt', content)
  for (const file of ['large.txt', 'untracked.txt']) {
    const patch = await gitFileCommitPatch(root, file, [head], true)
    assert.ok(Buffer.byteLength(patch) <= 4 * 1024 * 1024)
    assert.ok(Buffer.byteLength(patch) > 4 * 1024 * 1024 - 4)
    assert.ok(!patch.includes('\ufffd'))
  }
})

test('build notes range and non-contiguous commits stay on HEAD and preserve metadata and net stats', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('shared.txt', 'base\n'); await commit()
  const base = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('shared.txt', 'first\n'); await stageAll(root)
  await git.raw(['-c', 'core.hooksPath=', 'commit', '-m', 'first feature', '-m', 'QC detail'])
  const first = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('skip.txt', 'not selected\n'); await commit()
  await write('last.txt', 'last\n'); await commit()
  const last = (await git.raw(['rev-parse', 'HEAD'])).trim()
  const range = await buildNotesSummary(root, { mode: 'range', baseCommit: base, includeWorking: false })
  assert.equal(range.branch, 'main'); assert.equal(range.commits.length, 3)
  assert.deepEqual(range.files.map(file => file.path), ['last.txt', 'shared.txt', 'skip.txt'])
  assert.equal(range.additions, 3); assert.equal(range.deletions, 1)
  assert.equal(range.workingFileCount, 0); assert.equal(range.truncated, false)
  assert.ok(range.diff.includes('+not selected'))
  const selected = await buildNotesSummary(root, { mode: 'commits', commitHashes: [first.slice(0, 9), last, first], includeWorking: false })
  assert.deepEqual(selected.commits.map(commit => commit.hash), [last, first])
  assert.equal(selected.commits[1].subject, 'first feature'); assert.match(selected.commits[1].body, /QC detail/)
  assert.deepEqual(selected.files.map(file => file.path).sort(), ['last.txt', 'shared.txt'])
  assert.ok(!selected.diff.includes('skip.txt')); assert.ok(selected.files.every(file => file.source === 'committed'))
  const rootCommit = await buildNotesSummary(root, { mode: 'commits', commitHashes: [base], includeWorking: false })
  assert.equal(rootCommit.files[0].status, 'A'); assert.match(rootCommit.diff, /\+base/)
  await git.raw(['checkout', '--detach', 'HEAD'])
  assert.equal((await buildNotesSummary(root, { mode: 'range', baseCommit: base, includeWorking: false })).branch, '(detached)')
})

test('build notes include staged, unstaged and UTF-8 untracked files, merge sources and omit binary content', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('shared.txt', 'base\n'); await write('deleted.txt', 'remove\n'); await commit()
  const base = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('shared.txt', 'committed\n'); await commit()
  await write('shared.txt', 'staged\n'); await stageAll(root)
  await write('shared.txt', 'local final\n'); await write('staged.txt', 'staged addition\n')
  await git.raw(['add', '--', 'staged.txt']); await rm(path.join(root, 'deleted.txt'))
  await write('lời chào.txt', 'chào 🌏\nhai\n')
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 65]))
  const before = await git.raw(['status', '--porcelain=v1', '-z'])
  const result = await buildNotesSummary(root, { mode: 'range', baseCommit: base, includeWorking: true })
  assert.equal(result.workingFileCount, 5)
  assert.equal(result.files.find(file => file.path === 'shared.txt')?.source, 'both')
  assert.equal(result.files.find(file => file.path === 'deleted.txt')?.status, 'D')
  assert.deepEqual(result.files.find(file => file.path === 'lời chào.txt'), { path: 'lời chào.txt', status: 'U', additions: 2, deletions: 0, source: 'working' })
  assert.equal(result.files.find(file => file.path === 'binary.dat')?.additions, 0)
  assert.match(result.diff, /\+local final/); assert.match(result.diff, /\+staged addition/); assert.match(result.diff, /\+chào 🌏/)
  assert.ok(!result.diff.includes('\0')); assert.equal(await git.raw(['status', '--porcelain=v1', '-z']), before)
  const committedOnly = await buildNotesSummary(root, { mode: 'range', baseCommit: base, includeWorking: false })
  assert.equal(committedOnly.workingFileCount, 0); assert.deepEqual(committedOnly.files.map(file => file.path), ['shared.txt'])
})

test('build notes reject malformed, missing and foreign-branch commits including quiet nonzero ancestor exits', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('base.txt', 'base\n'); await commit()
  await git.raw(['checkout', '-b', 'foreign']); await write('foreign.txt', 'foreign\n'); await commit()
  const foreign = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await git.raw(['checkout', 'main']); await write('main.txt', 'main\n'); await commit()
  for (const hash of ['--all', '', 'HEAD', 'abc123', 'f'.repeat(40), foreign]) {
    await assert.rejects(buildNotesSummary(root, { mode: 'range', baseCommit: hash, includeWorking: false }), /INVALID_BUILD_BASE_COMMIT/)
    await assert.rejects(buildNotesSummary(root, { mode: 'commits', commitHashes: [hash], includeWorking: false }), /INVALID_BUILD_BASE_COMMIT/)
  }
  await assert.rejects(buildNotesSummary(root, { mode: 'commits', commitHashes: Array(51).fill(foreign), includeWorking: false }), /INVALID_BUILD_BASE_COMMIT/)
  await assert.rejects(buildNotesSummary(root, { mode: 'range', commitHashes: ['--all'], includeWorking: false }), /INVALID_BUILD_BASE_COMMIT/)
})

test('build notes support staged and untracked working-only unborn repositories', async t => {
  const { root, git, write } = await fixture(t)
  await write('staged.txt', 'index\n'); await stageAll(root)
  await write('staged.txt', 'latest\n'); await write('untracked.txt', 'local\n')
  const empty = await buildNotesSummary(root, { mode: 'range', includeWorking: false })
  assert.deepEqual(empty.files, []); assert.equal(empty.branch, 'main'); assert.deepEqual(empty.commits, [])
  const summary = await buildNotesSummary(root, { mode: 'commits', includeWorking: true })
  assert.equal(summary.workingFileCount, 2); assert.match(summary.diff, /\+latest/); assert.match(summary.diff, /\+local/)
  assert.deepEqual(summary.files.find(file => file.path === 'staged.txt'), { path: 'staged.txt', status: 'A', additions: 1, deletions: 0, source: 'working' })
  await assert.rejects(buildNotesSummary(root, { mode: 'range', baseCommit: '1234567', includeWorking: true }), /INVALID_BUILD_BASE_COMMIT/)
  await assert.rejects(buildNotesSummary(root, { mode: 'commits', commitHashes: ['1234567'], includeWorking: true }), /INVALID_BUILD_BASE_COMMIT/)
  assert.equal((await git.raw(['ls-files'])).trim(), 'staged.txt')
})

test('build notes retain noisy file stats, prioritize working patches and enforce UTF-8 layered byte limits', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('base.txt', 'base\n'); await commit()
  const base = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await write('committed.txt', 'committed 🌏\n'.repeat(1000))
  await write('package-lock.json', 'lockfile secret detail\n'.repeat(300)); await write('app.min.js', 'minified detail\n'); await commit()
  await write('working.txt', 'local chào 🌏 漢字\n'.repeat(1000))
  const full = await buildNotesSummary(root, { mode: 'range', baseCommit: base, includeWorking: true })
  assert.equal(full.files.length, 4); assert.ok(full.files.find(file => file.path === 'package-lock.json')!.additions > 0)
  assert.match(full.diff, /bỏ qua chi tiết diff lockfile\/tài nguyên/)
  assert.ok(!full.diff.includes('lockfile secret detail')); assert.ok(!full.diff.includes('minified detail'))
  assert.ok(full.diff.indexOf('working.txt') < full.diff.indexOf('committed.txt')); assert.equal(full.truncated, true)
  const offset = Buffer.from(full.diff).indexOf(Buffer.from('🌏'))
  for (const limit of [0, 1, offset + 1, offset + 2, offset + 3, 700, 4096]) {
    const limited = await buildNotesSummary(root, { mode: 'range', baseCommit: base, includeWorking: true }, limit)
    assert.ok(Buffer.byteLength(limited.diff) <= limit); assert.ok(!limited.diff.includes('�')); assert.equal(limited.truncated, true)
    assert.deepEqual(limited.files, full.files)
    if (limit === 700) { assert.match(limited.diff, /\+local chào/); assert.ok(!limited.diff.includes('committed.txt')) }
  }
  await assert.rejects(buildNotesSummary(root, { mode: 'range', includeWorking: true }, -1), /INVALID_MAX_BYTES/)
})

test('build notes reject untracked symlink escapes before reading outside the repository', async t => {
  const { root, temporary, write } = await fixture(t)
  const outside = path.join(temporary, 'private'); await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'outside contents\n')
  await write('local.txt', 'local\n')
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(buildNotesSummary(root, { mode: 'range', includeWorking: true }), /INVALID_PATH/)
})

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
  for (const value of ['', '.', './', '..', '../outside.txt', '..\\outside.txt', 'nested/../keep.txt', 'nested\\..\\keep.txt', '.git/config', '.GIT\\config', 'nested/.Git/config', 'C:relative.txt', 'C:\\Windows\\win.ini', '/etc/passwd', '\\\\host\\share', ...(process.platform === 'win32' ? ['file:stream'] : []), 'nul\0.txt']) {
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
  assert.equal(full.stat, undefined)
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
  assert.ok(defaultLimit.stat?.includes('large.txt'))
  assert.ok(Buffer.byteLength(defaultLimit.diff) <= 65536)
})

async function remoteFixture(t: TestContext) {
  const local = await fixture(t)
  await local.write('file.txt', 'initial\n'); await local.commit()
  const remote = path.join(local.temporary, 'remote.git')
  await mkdir(remote)
  await simpleGit(remote).raw(['init', '--bare', '--initial-branch=main'])
  await local.git.raw(['remote', 'add', 'origin', remote])
  return { ...local, remote }
}

async function clonePeer(temporary: string, remote: string) {
  const directory = path.join(temporary, 'peer')
  await simpleGit().clone(remote, directory, ['--config', 'core.autocrlf=false'])
  const peer = simpleGit(directory)
  await peer.addConfig('user.name', 'Peer'); await peer.addConfig('user.email', 'peer@example.invalid')
  await peer.addConfig('commit.gpgSign', 'false'); await peer.addConfig('core.autocrlf', 'false')
  return { directory, peer }
}

test('remote sync sets upstream, resets ahead, fetches behind, pulls and tracks remote branches', async t => {
  const { root, temporary, remote, git, write, commit } = await remoteFixture(t)
  assert.equal(await hasRemote(root), true)
  assert.equal((await gitPush(root)).remote, 'origin')
  assert.equal((await git.status()).tracking, 'origin/main')
  const { directory, peer } = await clonePeer(temporary, remote)
  await write('local.txt', 'local\n'); await commit()
  assert.equal((await git.status()).ahead, 1)
  await gitPush(root)
  assert.equal((await git.status()).ahead, 0)
  await peer.pull()
  await writeFile(path.join(directory, 'peer.txt'), 'peer\n'); await peer.add('.'); await peer.commit('peer change'); await peer.push()
  await peer.checkoutLocalBranch('feature')
  await peer.push(['-u', 'origin', 'feature'])
  assert.equal((await gitFetch(root)).remote, 'origin')
  assert.equal((await git.status()).behind, 1)
  const branches = await listBranches(root)
  assert.equal(branches.branches[0].upstream, 'origin/main')
  assert.ok(branches.remoteBranches?.some(branch => branch.name === 'origin/feature' && branch.remote && !branch.current))
  const pulled = await gitPull(root)
  assert.equal(pulled.branch, 'main'); assert.equal(pulled.filesChanged, 1)
  assert.equal((await git.status()).behind, 0)
  await checkoutBranch(root, 'origin/feature')
  assert.equal((await git.status()).current, 'feature')
  assert.equal((await git.status()).tracking, 'origin/feature')
  await assert.rejects(deleteBranch(root, 'feature', true), /CANNOT_DELETE_CURRENT_BRANCH/)
  await checkoutBranch(root, 'main'); await checkoutBranch(root, 'origin/feature')
  await checkoutBranch(root, 'main'); await deleteBranch(root, 'feature')
  assert.ok(!(await listBranches(root)).branches.some(branch => branch.name === 'feature'))
  await gitPush(root, { setUpstream: true })
  await git.raw(['checkout', '--detach'])
  await assert.rejects(gitPush(root), /DETACHED_HEAD_PUSH_UNSUPPORTED/)
})

test('network failures classify no remote, rejected pushes, dirty pulls and real merge conflicts', async t => {
  const local = await fixture(t)
  assert.equal(await hasRemote(local.root), false)
  for (const operation of [gitFetch, gitPull, gitPush]) await assert.rejects(operation(local.root), /NO_REMOTE_CONFIGURED/)
  const { root, git, temporary, remote, write, commit } = await remoteFixture(t)
  await gitPush(root)
  const { directory, peer } = await clonePeer(temporary, remote)
  await writeFile(path.join(directory, 'file.txt'), 'peer change\n'); await peer.add('.'); await peer.commit('peer change'); await peer.push()
  await write('file.txt', 'dirty local change\n')
  await assert.rejects(gitPull(root), /GIT_DIRTY_WORKTREE/)
  await commit()
  await assert.rejects(gitPush(root), /GIT_PUSH_REJECTED_NON_FF/)
  await assert.rejects(gitPull(root), /GIT_CONFLICT.*file.txt/s)
  assert.deepEqual((await git.status()).conflicted, ['file.txt'])
  for (const [message, code] of [
    ['Authentication failed', 'GIT_AUTH_FAILED'], ['Permission denied (publickey)', 'GIT_AUTH_FAILED'],
    ['Could not resolve host', 'GIT_OFFLINE'], ['connection refused', 'GIT_OFFLINE'],
    ['non-fast-forward rejected', 'GIT_PUSH_REJECTED_NON_FF'], ['local changes would be overwritten by merge', 'GIT_DIRTY_WORKTREE'],
    ['CONFLICT in file', 'GIT_CONFLICT']
  ]) assert.ok(mapGitNetworkError({ stderr: message, message: 'wrapper' }).message.startsWith(`${code}: ${message}`))
  assert.equal(mapGitNetworkError(new Error('other failure')).message, 'other failure')
})

test('log, commit detail and undo preserve messages, literal paths, UTF-8 and the staged index', async t => {
  const { root, git, write, read } = await fixture(t)
  assert.deepEqual(await gitLog(root), [])
  await assert.rejects(gitUndoLastCommit(root), /NO_COMMIT_TO_UNDO/)
  await write('lời chào.txt', 'first\n'); await stageAll(root)
  await git.raw(['commit', '-m', 'initial subject\n\ninitial body'])
  const [initial] = await gitLog(root)
  assert.equal(initial.subject, 'initial subject'); assert.equal(initial.body.trim(), 'initial body')
  assert.ok(initial.refs.includes('HEAD -> main')); assert.ok(initial.date)
  assert.deepEqual((await gitCommitDetail(root, initial.hash)).files, [{ path: 'lời chào.txt', status: 'A', additions: 1, deletions: 0 }])
  await write('lời chào.txt', 'second\n')
  await write(process.platform === 'win32' ? 'new file.txt' : 'new\tfile.txt', 'new\n')
  await stageAll(root); await git.raw(['commit', '-m', 'second subject\n\nsecond body'])
  const log = await gitLog(root, 1)
  assert.equal(log.length, 1); assert.equal(log[0].subject, 'second subject')
  const detail = await gitCommitDetail(root, log[0].shortHash)
  assert.equal(detail.hash, log[0].hash)
  assert.ok(detail.files.some(file => file.path === 'lời chào.txt' && file.status === 'M' && file.additions === 1 && file.deletions === 1))
  assert.ok(detail.patch.includes('+second'))
  assert.equal((await gitLog(root, 0)).length, 1)
  assert.equal((await gitLog(root, Infinity)).length, 2)
  for (const hash of ['HEAD', '--all', 'abc', 'g'.repeat(40)]) await assert.rejects(gitCommitDetail(root, hash), /INVALID_COMMIT_HASH/)
  assert.deepEqual(await gitUndoLastCommit(root), { message: 'second subject\n\nsecond body' })
  assert.equal((await gitLog(root)).length, 1)
  assert.ok((await stagedDiffSummary(root)).files.includes('lời chào.txt'))
  assert.deepEqual(await gitUndoLastCommit(root), { message: 'initial subject\n\ninitial body' })
  assert.deepEqual(await gitLog(root), [])
  assert.equal(await read('lời chào.txt'), 'second\n')
  assert.ok((await git.raw(['ls-files'])).includes('new'))
  await stageAll(root); await git.raw(['commit', '-m', 'restored'])
  await write('large.txt', '🌏漢字\n'.repeat(40000)); await stageAll(root); await git.raw(['commit', '-m', 'large'])
  const large = await gitCommitDetail(root, (await gitLog(root, 1))[0].hash)
  assert.ok(Buffer.byteLength(large.patch) <= 262144)
  assert.ok(large.patch.endsWith('... (truncated)')); assert.ok(!large.patch.includes('\ufffd'))
})

test('undoing a detached root commit preserves HEAD, index and working content', async t => {
  const { root, git, write, read, commit } = await fixture(t)
  await write('file.txt', 'initial\n'); await commit()
  const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
  await git.raw(['checkout', '--detach', head])
  await write('file.txt', 'working\n')
  const index = await git.raw(['ls-files', '--stage', '-z'])
  await assert.rejects(gitUndoLastCommit(root), /GIT_DETACHED_ROOT_UNDO_UNSUPPORTED/)
  assert.equal((await git.raw(['rev-parse', 'HEAD'])).trim(), head)
  assert.equal(await git.raw(['ls-files', '--stage', '-z']), index)
  assert.equal(await read('file.txt'), 'working\n')
  assert.ok((await git.status()).files.some(file => file.path === 'file.txt'))
})

test('stash round trips tracked and untracked content, apply retains entries, pop removes and indices validate', async t => {
  const { root, git, write, read, commit } = await fixture(t)
  await write('file.txt', 'initial\n'); await commit()
  await gitStashPush(root)
  assert.deepEqual(await gitStashList(root), [])
  await write('file.txt', 'changed\n'); await write('untracked.txt', 'new\n')
  await gitStashPush(root, '  saved work  ')
  const [stash] = await gitStashList(root)
  assert.equal(stash.ref, 'stash@{0}'); assert.equal(stash.index, 0); assert.equal(stash.branch, 'main')
  assert.equal(stash.message, 'saved work'); assert.ok(stash.date)
  assert.equal((await git.status()).files.length, 0)
  await gitStashApply(root, 0)
  assert.equal(await read('file.txt'), 'changed\n'); assert.equal(await read('untracked.txt'), 'new\n')
  assert.equal((await gitStashList(root)).length, 1)
  await git.raw(['reset', '--hard']); await rm(path.join(root, 'untracked.txt'))
  await gitStashApply(root, 0, true)
  assert.equal((await gitStashList(root)).length, 0)
  await gitStashPush(root, undefined, false)
  assert.equal(await read('untracked.txt'), 'new\n')
  assert.equal((await gitStashList(root))[0].branch, 'main')
  await gitStashDrop(root, 0)
  assert.deepEqual(await gitStashList(root), [])
  for (const index of [-1, 0.5, 10001, NaN, Infinity]) {
    await assert.rejects(gitStashApply(root, index), /INVALID_STASH_INDEX/)
    await assert.rejects(gitStashDrop(root, index), /INVALID_STASH_INDEX/)
  }
})

test('release gates packaging on signing secrets, smoke tests Windows, and publishes checksummed artifacts', async () => {
  const release = await workflow('release.yml')
  const job = release.jobs.package
  const packageIndex = job.steps.findIndex((step: any) => step.name === 'Package platform artifacts without publishing')
  const guardIndex = job.steps.findIndex((step: any) => step.name === 'Require signing secrets for tag releases')
  assert.ok(guardIndex >= 0 && guardIndex < packageIndex)
  const guard = job.steps[guardIndex]
  assert.equal(guard.if, "github.event_name == 'push' && inputs.dry_run != true")
  assert.ok(guard.run.includes("'${{ matrix.platform }}' = win"))
  for (const secret of ['CSC_LINK', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.equal(guard.env[secret], '${{ secrets.' + secret + ' }}')
    assert.ok(guard.run.includes('${' + secret + ':?'))
  }
  const smokeIndex = job.steps.findIndex((step: any) => step.run === 'node scripts/smoke-packaged.mjs')
  assert.ok(smokeIndex > packageIndex)
  assert.equal(job.steps[smokeIndex].if, "matrix.platform == 'win'")
  const checksumIndex = job.steps.findIndex((step: any) => step.name === 'Generate packaged artifact checksums')
  assert.ok(checksumIndex > smokeIndex)
  const checksum = job.steps[checksumIndex].run
  assert.ok(checksum.includes('files=(*.exe *.dmg *.zip)'))
  assert.ok(checksum.includes('sha256sum "$file"') && checksum.includes('shasum -a 256 "$file"'))
  assert.ok(checksum.includes('SHA256SUMS-${{ matrix.platform }}-${{ matrix.arch }}.txt'))
  const uploadIndex = job.steps.findIndex((step: any) => step.uses === 'actions/upload-artifact@v4')
  assert.ok(uploadIndex > checksumIndex)
  for (const artifact of ['*.exe', '*.dmg', '*.zip', '*.blockmap', 'latest*.yml', 'SHA256SUMS-${{ matrix.platform }}-${{ matrix.arch }}.txt']) {
    assert.ok(job.steps[uploadIndex].with.path.split('\n').includes(`release/${artifact}`))
  }
  const publish = release.jobs.publish
  assert.equal(publish.needs, 'package')
  assert.equal(publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  assert.equal(publish.permissions.contents, 'write')
  assert.ok(publish.steps.some((step: any) => step.uses === 'actions/download-artifact@v4'))
  assert.ok(steps(publish).some(run => run.includes('gh release create "$GITHUB_REF_NAME" --verify-tag "${files[@]}"')))
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
  // The backend plugin is now built for every test run, including trusted runtime coverage.
  const backendBuild = job.steps.find((step: any) => step.run === 'npm run build:server')
  assert.equal(backendBuild.if, undefined)
  assert.ok(job.steps.indexOf(backendBuild) < job.steps.findIndex((step: any) => step.run === 'npm test'))
  assert.equal(job.steps.find((step: any) => step.run === 'npx electron-vite build').if, "env.AME_OPENCODE_CLI == ''")
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
  assert.ok(packaging.run.includes('node scripts/build-win-release.mjs --targets ' + '${{ matrix.targets }}'))
  const windowsPackaging = await readFile(path.join(repoRoot, 'scripts', 'build-win-release.mjs'), 'utf8')
  for (const value of ['CSC_LINK', 'signAndEditExecutable: true', 'icacls', '*S-1-15-2-1:(OI)(CI)(RX)']) assert.ok(windowsPackaging.includes(value), value)
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) assert.ok(packaging.env[key].includes(`secrets.${key}`), key)
  const artifact = job.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')
  assert.equal(artifact.with['if-no-files-found'], 'error')
  assert.ok(artifact.with.name.includes('matrix.arch'))
  for (const extension of ['exe', 'dmg', 'zip']) assert.ok(artifact.with.path.includes(`release/*.${extension}`))
})
