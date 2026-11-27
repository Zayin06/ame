import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { simpleGit } from 'simple-git'
import { parseDocument } from 'yaml'
import { buildNotesSummary, checkoutBranch, createBranch, deleteBranch, discardFile, executeCommitPlan, gitCommitPlanSnapshot, gitFetch, gitPull, gitPush, gitLog, gitCommitDetail, gitUndoLastCommit, gitStashList, gitStashPush, gitStashApply, gitStashDrop, hasRemote, mapGitNetworkError, listBranches, stageAll, stagedDiffSummary, unstageAll, validateBranchName } from '../packages/ide-core/src/git-ops'
import type { CommitAgentPlan } from '../packages/protocol/src/index'
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

test('commit plan snapshots are read-only, scoped and UTF-8 byte limited', async t => {
  const { root, git, write, commit } = await fixture(t)
  const unborn = await gitCommitPlanSnapshot(root)
  assert.equal(unborn.head, '(unborn)'); assert.equal(unborn.scope, 'working')
  await write('tracked.txt', 'base\n'); await commit()
  await write('tracked.txt', 'chào 🌏\n'.repeat(100))
  await write('untracked.txt', 'untracked\n')
  const before = await git.raw(['status', '--porcelain=v1', '-z'])
  const full = await gitCommitPlanSnapshot(root)
  assert.equal(full.scope, 'working')
  assert.deepEqual(full.stagedFiles, [])
  assert.deepEqual(full.workingFiles, ['tracked.txt', 'untracked.txt'])
  assert.match(full.diffPreview, /\+chào 🌏/)
  assert.match(full.stat, /tracked.txt/)
  assert.match(full.indexHash, /^[a-f0-9]{64}$/)
  assert.match(full.workingHash, /^[a-f0-9]{64}$/)
  assert.match(full.fingerprint, /^[a-f0-9]{64}$/)
  const offset = Buffer.from(full.diffPreview).indexOf(Buffer.from('🌏'))
  for (const limit of [0, offset + 1, offset + 2, offset + 3]) {
    const limited = await gitCommitPlanSnapshot(root, limit)
    assert.equal(limited.truncated, true); assert.ok(Buffer.byteLength(limited.diffPreview) <= limit)
    assert.ok(!limited.diffPreview.includes('�')); assert.equal(limited.fingerprint, full.fingerprint)
  }
  assert.equal(await git.raw(['status', '--porcelain=v1', '-z']), before)
  for (const limit of [-1, NaN, Infinity, 1.2]) await assert.rejects(gitCommitPlanSnapshot(root, limit), /INVALID_MAX_BYTES/)
})

test('commit plan splits staged changes into two UTF-8 Vietnamese commits', async t => {
  const { root, git, write, commit, read } = await fixture(t)
  await write('base.txt', 'base\n'); await commit()
  await write('lời chào.txt', 'chào 🌏\n'); await write('-second.txt', 'thứ hai\n'); await stageAll(root)
  const snapshot = await gitCommitPlanSnapshot(root)
  const messages = ['feat: thêm lời chào 🌏\n\nNội dung tiếng Việt.', 'fix: sửa tệp thứ hai']
  const result = await executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: messages.map((message, i) => ({ message, files: [i ? '-second.txt' : 'lời chào.txt'] })) })
  assert.deepEqual(result.commits.map(commit => commit.subject), messages.map(message => message.split('\n')[0]))
  for (const [i, committed] of result.commits.entries()) {
    assert.match(committed.hash, /^[a-f0-9]+$/)
    assert.equal((await git.raw(['show', '-s', '--format=%B', committed.hash])).trimEnd(), messages[i])
    assert.deepEqual((await gitCommitDetail(root, committed.hash)).files.map(file => file.path), committed.files)
  }
  assert.equal(await git.raw(['status', '--porcelain=v1']), '')
  assert.equal(await read('lời chào.txt'), 'chào 🌏\n')
})

test('direct staged commit preserves unstaged hunks; working plans support unborn repositories', async t => {
  const { root, git, write, read } = await fixture(t)
  await write('first.txt', 'đầu tiên\n'); await write('second.txt', 'thứ hai\n')
  let snapshot = await gitCommitPlanSnapshot(root)
  await executeCommitPlan(root, { planID: 'test-plan', scope: 'working', snapshot, commits: [{ message: 'thêm đầu tiên', files: ['first.txt'] }, { message: 'thêm thứ hai', files: ['second.txt'] }] })
  await write('first.txt', 'staged\n'); await stageAll(root)
  await write('first.txt', 'unstaged\n')
  snapshot = await gitCommitPlanSnapshot(root)
  await executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'chỉ index', files: snapshot.stagedFiles }] })
  assert.equal(await git.raw(['show', 'HEAD:first.txt']), 'staged\n')
  assert.equal(await read('first.txt'), 'unstaged\n')
  assert.equal(await git.raw(['diff', '--cached', '--name-only']), '')
})

test('split staged plans preserve rename pairs and omitted staged blobs', async t => {
  const { root, git, write, commit, read } = await fixture(t)
  await write('old.txt', 'unchanged rename\n'); await commit()
  await rename(path.join(root, 'old.txt'), path.join(root, 'new.txt'))
  await write('second.txt', 'second\n'); await write('omitted.txt', 'omitted\n'); await stageAll(root)
  const snapshot = await gitCommitPlanSnapshot(root)
  assert.ok(snapshot.stagedFiles.includes('old.txt')); assert.ok(snapshot.stagedFiles.includes('new.txt'))
  const result = await executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'đổi tên', files: ['new.txt'] }, { message: 'thêm tệp', files: ['second.txt'] }] })
  assert.deepEqual(result.commits[0].files.sort(), ['new.txt', 'old.txt'])
  assert.equal(await read('new.txt'), 'unchanged rename\n')
  assert.equal(await read('omitted.txt'), 'omitted\n')
  assert.deepEqual((await git.status()).not_added, [])
  assert.equal(await git.raw(['diff', '--cached', '--name-only']), 'omitted.txt\n')
})

test('stale HEAD, index and working fingerprints reject without changing Git', async t => {
  for (const mutation of ['head', 'index', 'working'] as const) {
    const { root, git, write, commit } = await fixture(t)
    await write('file.txt', 'initial\n'); await commit()
    await write('file.txt', 'planned\n'); await stageAll(root)
    const snapshot = await gitCommitPlanSnapshot(root)
    const plan: CommitAgentPlan = { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'planned', files: ['file.txt'] }] }
    if (mutation === 'head') await git.raw(['commit', '--allow-empty', '-m', 'external'])
    if (mutation === 'index') { await write('file.txt', 'external staged\n'); await stageAll(root) }
    if (mutation === 'working') await write('file.txt', 'external unstaged\n')
    const before = await gitCommitPlanSnapshot(root)
    await assert.rejects(executeCommitPlan(root, plan), /COMMIT_PLAN_STALE/)
    assert.deepEqual(await gitCommitPlanSnapshot(root), before)
  }
})

test('invalid and out-of-scope plans reject before any write', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('first.txt', 'base\n'); await write('second.txt', 'base\n'); await commit()
  await write('first.txt', 'staged\n'); await write('second.txt', 'staged\n'); await stageAll(root)
  await write('first.txt', 'unstaged\n'); await write('outside-scope.txt', 'local\n')
  const snapshot = await gitCommitPlanSnapshot(root)
  const plan: CommitAgentPlan = { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'first', files: ['first.txt'] }, { message: 'second', files: ['second.txt'] }] }
  const cases: [CommitAgentPlan, RegExp][] = [
    [{ ...plan, commits: [{ message: 'bad', files: ['outside-scope.txt'] }] }, /COMMIT_PLAN_OUT_OF_SCOPE/],
    [{ ...plan, commits: [{ message: 'bad', files: ['../escape'] }] }, /INVALID_PATH/],
    [{ ...plan, commits: [] }, /INVALID_COMMIT_PLAN/],
    [{ ...plan, commits: Array(31).fill(plan.commits[0]) }, /INVALID_COMMIT_PLAN/],
    [{ ...plan, commits: [{ message: ' ', files: ['second.txt'] }] }, /INVALID_COMMIT_PLAN/],
    [{ ...plan, commits: [{ message: 'bad\0message', files: ['second.txt'] }] }, /INVALID_COMMIT_PLAN/],
    [{ ...plan, commits: [{ message: 'x'.repeat(10001), files: ['second.txt'] }] }, /INVALID_COMMIT_PLAN/],
    [{ ...plan, commits: [{ message: 'empty', files: [] }] }, /INVALID_COMMIT_PLAN/],
    [{ ...plan, commits: [{ message: 'duplicate', files: ['second.txt'] }, { message: 'duplicate', files: ['./second.txt'] }] }, /INVALID_COMMIT_PLAN/],
  ]
  for (const [invalid, error] of cases) {
    await assert.rejects(executeCommitPlan(root, invalid), error)
    assert.deepEqual(await gitCommitPlanSnapshot(root), snapshot)
  }
  assert.equal((await git.raw(['log', '--oneline'])).trim().split('\n').length, 1)
})

test('unborn staged splits and subset plans do not lose working files', async t => {
  const { root, git, write, read } = await fixture(t)
  await write('first.txt', 'first\n'); await write('second.txt', 'second\n'); await stageAll(root)
  const snapshot = await gitCommitPlanSnapshot(root)
  await executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'chỉ một', files: ['first.txt'] }] })
  assert.equal(await read('second.txt'), 'second\n')
  assert.equal(await git.raw(['ls-files']), 'first.txt\nsecond.txt\n')
  assert.equal(await git.raw(['show', ':second.txt']), 'second\n')
  assert.deepEqual((await git.status()).not_added, [])
})

test('#1 merge conflict and operation markers reject without changing merge metadata or index bytes', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('a', 'v0\n'); await write('b', 'v0\n'); await commit()
  await git.raw(['checkout', '-b', 'side']); await write('a', 'side\n'); await commit()
  await git.raw(['checkout', 'main']); await write('a', 'main\n'); await commit()
  await git.raw(['merge', 'side']).catch(() => {})
  await write('b', 'independent\n'); await git.raw(['add', '--', 'b'])
  const snapshot = await gitCommitPlanSnapshot(root, 0, { includeDiff: false })
  const plan: CommitAgentPlan = { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'b only', files: ['b'] }] }
  const merge = await readFile(path.join(root, '.git', 'MERGE_HEAD'))
  const index = await readFile(path.join(root, '.git', 'index'))
  const unmerged = await git.raw(['ls-files', '--unmerged', '-z'])
  assert.ok(unmerged)
  await assert.rejects(executeCommitPlan(root, plan), /COMMIT_PLAN_REPO_BUSY/)
  assert.deepEqual(await readFile(path.join(root, '.git', 'MERGE_HEAD')), merge)
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index)
  assert.equal(await git.raw(['ls-files', '--unmerged', '-z']), unmerged)
  await rm(path.join(root, '.git', 'MERGE_HEAD'))
  await assert.rejects(executeCommitPlan(root, plan), /COMMIT_PLAN_REPO_CONFLICT/)
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index)
  for (const marker of ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
    const target = path.join(root, '.git', marker)
    if (marker.startsWith('rebase')) await mkdir(target)
    else await writeFile(target, 'active\n')
    await assert.rejects(executeCommitPlan(root, plan), /COMMIT_PLAN_REPO_BUSY/)
    assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index)
    await rm(target, { recursive: true })
  }
})

test('#2 staged subset preserves HEAD/index/disk versions and split mixed hunks', async t => {
  const { root, git, write, read, commit } = await fixture(t)
  await write('a', 'v0\n'); await write('b', 'v0\n'); await commit()
  await write('a', 'v1\n'); await write('b', 'v1\n'); await stageAll(root)
  await write('b', 'v2\n'); await write('a', 'a on disk\n')
  const index = await git.raw(['ls-files', '--stage', '-z'])
  const snapshot = await gitCommitPlanSnapshot(root)
  await executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'only a', files: ['a'] }] })
  assert.equal(await git.raw(['show', 'HEAD:a']), 'v1\n')
  assert.equal(await git.raw(['show', 'HEAD:b']), 'v0\n')
  assert.equal(await git.raw(['show', ':b']), 'v1\n')
  assert.equal(await git.raw(['ls-files', '--stage', '-z']), index)
  assert.equal(await read('b'), 'v2\n'); assert.equal(await read('a'), 'a on disk\n')
})

async function hook(root: string, name: string, body: string) {
  const hooks = path.join(root, '.git', 'plan-test-hooks')
  await mkdir(hooks, { recursive: true })
  await writeFile(path.join(hooks, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  await simpleGit(root).addConfig('core.hooksPath', hooks)
}

test('R4 #3/#7 post-commit branch switches never pollute the other real index', async t => {
  for (const count of [1, 2]) await t.test(`${count} groups`, async t => {
    const { root, git, write, commit } = await fixture(t)
    await write('a', 'base a\n'); await write('b', 'base b\n'); await commit()
    await git.raw(['branch', 'other'])
    const otherHead = (await git.raw(['rev-parse', 'other'])).trim()
    await write('a', 'planned a\n'); if (count === 2) await write('b', 'planned b\n')
    const snapshot = await gitCommitPlanSnapshot(root)
    await hook(root, 'post-commit', 'unset GIT_INDEX_FILE\ngit checkout -f other')
    const plan: CommitAgentPlan = { planID: 'r4-switch', scope: 'working', snapshot, commits: ['a', 'b'].slice(0, count).map(file => ({ message: `update ${file}`, files: [file] })) }
    if (count === 1) assert.equal((await executeCommitPlan(root, plan)).commits.length, 1)
    else await assert.rejects(executeCommitPlan(root, plan), (error: any) => {
      assert.equal(error.code, 'COMMIT_PLAN_ABORTED')
      assert.equal(error.failedGroupIndex, 1); assert.equal(error.failedSubject, 'update b')
      assert.equal(error.commits.length, 1); assert.deepEqual(error.commits[0].files, ['a'])
      assert.ok(error.cause instanceof Error)
      return true
    })
    assert.equal((await git.raw(['branch', '--show-current'])).trim(), 'other')
    assert.equal((await git.raw(['rev-parse', 'other'])).trim(), otherHead)
    assert.equal(await git.raw(['diff', '--cached', '--name-only']), '')
    assert.equal(await git.raw(['show', ':a']), 'base a\n')
    assert.equal(await git.raw(['show', 'main:a']), 'planned a\n')
    assert.equal(await git.raw(['show', 'main:b']), 'base b\n')
  })
})

test('R4 #4 effective identity and commit config survive relative and conditional includes', async t => {
  for (const conditional of [false, true]) await t.test(conditional ? 'includeIf' : 'include.path', async t => {
    const { root, git, write, commit } = await fixture(t)
    await write('a', 'base\n'); await commit()
    const identityConfig = '[user]\n name = Included Author\n email = author@example.invalid\n[committer]\n name = Included Committer\n email = committer@example.invalid\n[commit]\n gpgSign = false\n[core]\n commentChar = ";"\n'
    await writeFile(path.join(root, '.git', 'identity.conf'), identityConfig)
    const key = conditional ? 'includeIf.gitdir/i:**/repo/.git.path' : 'include.path'
    await git.addConfig(key, 'identity.conf')
    const author = (await git.raw(['var', 'GIT_AUTHOR_IDENT'])).trim()
    const committer = (await git.raw(['var', 'GIT_COMMITTER_IDENT'])).trim()
    assert.match(author, /^Included Author </); assert.match(committer, /^Included Committer </)
    await write('a', 'planned\n')
    await hook(root, 'pre-commit', '[ "$(git config --get core.commentChar)" = ";" ] || exit 1')
    const snapshot = await gitCommitPlanSnapshot(root)
    await executeCommitPlan(root, { planID: 'r4-identity', scope: 'working', snapshot, commits: [{ message: 'included identity\n; ignored comment', files: ['a'] }] })
    assert.equal((await git.raw(['log', '-1', '--format=%an <%ae>%n%cn <%ce>'])).trim(), 'Included Author <author@example.invalid>\nIncluded Committer <committer@example.invalid>')
  })
})

test('R4 #5 isolated prepare-commit-msg sees annotated tags and other refs', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('a', 'base\n'); await commit()
  await git.raw(['tag', '-a', 'v1.0', '-m', 'release'])
  await git.raw(['tag', 'lightweight']); await git.raw(['branch', 'other'])
  const refs = await git.raw(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags', 'refs/heads/other'])
  await hook(root, 'prepare-commit-msg', 'git rev-parse --verify refs/tags/lightweight >/dev/null || exit 1\ngit rev-parse --verify refs/heads/other >/dev/null || exit 1\nprintf "release %s\\n" "$(git describe --tags)" > "$1"')
  await write('a', 'planned\n')
  const snapshot = await gitCommitPlanSnapshot(root)
  const result = await executeCommitPlan(root, { planID: 'r4-tags', scope: 'working', snapshot, commits: [{ message: 'original', files: ['a'] }] })
  assert.equal(result.commits[0].subject, 'release v1.0')
  assert.equal(await git.raw(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags', 'refs/heads/other']), refs)
})

test('R4 #6 working plans replace files with directories and directories with files', async t => {
  for (const fileToDir of [true, false]) await t.test(fileToDir ? 'seed -> seed/a' : 'dir/a -> dir', async t => {
    const { root, git, write, commit } = await fixture(t)
    if (fileToDir) await write('seed', 'old\n')
    else { await mkdir(path.join(root, 'dir')); await write('dir/a', 'old\n') }
    await commit()
    await rm(path.join(root, fileToDir ? 'seed' : 'dir'), { recursive: true })
    if (fileToDir) { await mkdir(path.join(root, 'seed')); await write('seed/a', 'new\n') }
    else await write('dir', 'new\n')
    const snapshot = await gitCommitPlanSnapshot(root)
    // Intentionally request additions first; update-index must reorder deletions.
    const files = fileToDir ? ['seed/a', 'seed'] : ['dir', 'dir/a']
    const result = await executeCommitPlan(root, { planID: 'r4-replacement', scope: 'working', snapshot, commits: [{ message: 'replace shape', files }] })
    assert.deepEqual(result.commits[0].files.sort(), [...files].sort())
    assert.equal(await git.raw(['show', `HEAD:${files[0]}`]), 'new\n')
    assert.equal(await git.raw(['status', '--porcelain=v1']), '')
  })
})

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

test('R3 #1 isolated hooks cannot replace, drop or add files to the approved tree', async t => {
  for (const mutation of ['replace', 'drop', 'add'] as const) {
    await t.test(mutation, async t => {
      const { root, git, write, commit } = await fixture(t)
      await write('a.txt', 'base a\n'); await write('b.txt', 'base b\n'); await commit()
      await write('a.txt', 'staged A\n'); await write('b.txt', 'staged b\n'); await stageAll(root)
      await write('a.txt', 'disk B\n')
      const snapshot = await gitCommitPlanSnapshot(root)
      const index = await readFile(path.join(root, '.git', 'index'))
      await hook(root, 'pre-commit', mutation === 'replace' ? 'git add -- a.txt' : mutation === 'drop' ? 'git reset HEAD -- b.txt' : 'printf "generated\\n" > changelog.txt\ngit add -- changelog.txt')
      await assert.rejects(executeCommitPlan(root, { planID: 'r3-hook-tree', scope: 'staged', snapshot, commits: [{ message: 'approved', files: ['a.txt', 'b.txt'] }] }), /COMMIT_PLAN_HOOK_MODIFIED_TREE/)
      assert.equal((await git.raw(['rev-parse', 'HEAD'])).trim(), snapshot.head)
      assert.equal((await git.raw(['rev-parse', 'refs/heads/main'])).trim(), snapshot.head)
      assert.equal((await git.raw(['rev-list', '--count', 'main'])).trim(), '1')
      assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index)
      assert.equal(await git.raw(['show', ':a.txt']), 'staged A\n')
      assert.equal(await git.raw(['ls-files', '--', 'changelog.txt']), '')
    })
  }
})

test('R3 #2 working blobs respect CRLF attributes and clean filters just like git add', async t => {
  for (const filter of [false, true]) {
    await t.test(filter ? 'clean filter' : 'CRLF normalization', async t => {
      const { root, git, write, read, commit } = await fixture(t)
      await write('.gitattributes', filter ? '*.txt filter=plan-clean\n' : '*.txt text eol=crlf\n')
      if (filter) {
        await git.addConfig('filter.plan-clean.clean', 'sed s/WORK/CLEAN/g')
        await git.addConfig('filter.plan-clean.smudge', 'sed s/CLEAN/WORK/g')
        await git.addConfig('filter.plan-clean.required', 'true')
      }
      await commit()
      const disk = filter ? 'WORK content\n' : 'first\r\nsecond\r\n'
      await write('a.txt', disk)
      const expectedOid = (await git.raw(['hash-object', '--path', 'a.txt', 'a.txt'])).trim()
      const snapshot = await gitCommitPlanSnapshot(root)
      await executeCommitPlan(root, { planID: 'r3-filters', scope: 'working', snapshot, commits: [{ message: 'normalized', files: ['a.txt'] }] })
      assert.equal((await git.raw(['rev-parse', 'HEAD:a.txt'])).trim(), expectedOid)
      assert.equal(await git.raw(['show', 'HEAD:a.txt']), filter ? 'CLEAN content\n' : 'first\nsecond\n')
      assert.equal(await read('a.txt'), disk)
      assert.equal(await git.raw(['status', '--porcelain=v1']), '')
    })
  }
})

test('R3 #4 real Git preserves leading-space names in staged subset commits', async t => {
  const { root, git, write } = await fixture(t)
  await write(' a.txt', 'leading space\n'); await write('a.txt', 'no space\n'); await stageAll(root)
  const snapshot = await gitCommitPlanSnapshot(root)
  const result = await executeCommitPlan(root, { planID: 'r3-leading-space', scope: 'staged', snapshot, commits: [{ message: 'leading only', files: [' a.txt'] }] })
  assert.deepEqual(result.commits[0].files, [' a.txt'])
  assert.equal(await git.raw(['ls-tree', '-r', '--name-only', '-z', 'HEAD']), ' a.txt\0')
  assert.equal(await git.raw(['diff', '--cached', '--name-only', '-z']), 'a.txt\0')
  assert.equal(await git.raw(['show', ':a.txt']), 'no space\n')
})

test('R3 #6 nested Git repositories are omitted from staged and working committable files', async t => {
  for (const scope of ['staged', 'working'] as const) {
    await t.test(scope, async t => {
      const { root, git, write } = await fixture(t)
      const nested = path.join(root, 'local-tools')
      await mkdir(nested)
      const nestedGit = simpleGit(nested)
      await nestedGit.raw(['init'])
      await write('local-tools/tool.txt', 'local tool\n')
      await nestedGit.raw(['add', '--', 'tool.txt'])
      await nestedGit.raw(['-c', 'user.name=Nested Test', '-c', 'user.email=nested@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'nested'])
      await write('a.txt', 'planned\n')
      if (scope === 'staged') await git.raw(['add', '--', 'a.txt'])
      const snapshot = await gitCommitPlanSnapshot(root)
      assert.equal(snapshot.scope, scope)
      assert.ok(!snapshot.workingFiles.some(file => file.startsWith('local-tools')))
      if (scope === 'staged') assert.equal(snapshot.untrackedHashes, undefined)
      else assert.deepEqual(Object.keys(snapshot.untrackedHashes ?? {}), ['a.txt'])
      const result = await executeCommitPlan(root, { planID: 'r3-nested-repo', scope, snapshot, commits: [{ message: 'a only', files: ['a.txt'] }] })
      assert.deepEqual(result.commits[0].files, ['a.txt'])
      assert.equal(await git.raw(['diff', 'HEAD', '--name-only']), '')
      assert.equal(await git.raw(['diff', '--cached', '--name-only']), '')
      assert.equal(await git.raw(['ls-tree', '--name-only', 'HEAD', '--', 'local-tools']), '')
      assert.equal((await nestedGit.raw(['rev-list', '--count', 'HEAD'])).trim(), '1')
    })
  }
})

test('R3 #7 working commit loop ignores unrelated untracked content changed by post-commit', async t => {
  const { root, git, write, read, commit } = await fixture(t)
  await write('base.txt', 'base\n'); await commit()
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await write(name, `${name}\n`)
  await write('unrelated.txt', 'original local\n')
  const snapshot = await gitCommitPlanSnapshot(root)
  await hook(root, 'post-commit', 'if [ "$(git rev-list --count HEAD)" = 2 ]; then printf "changed local\\n" > unrelated.txt; fi')
  const result = await executeCommitPlan(root, { planID: 'r3-unrelated-untracked', scope: 'working', snapshot, commits: ['a.txt', 'b.txt', 'c.txt'].map(file => ({ message: `add ${file}`, files: [file] })) })
  assert.equal(result.commits.length, 3)
  assert.deepEqual(result.commits.map(commit => commit.files), [['a.txt'], ['b.txt'], ['c.txt']])
  assert.equal(await read('unrelated.txt'), 'changed local\n')
  assert.equal(await git.raw(['status', '--porcelain=v1']), '?? unrelated.txt\n')
})

test('R3 #9 SHA-256 repositories support staged and working deletions and commit detail', async t => {
  for (const scope of ['staged', 'working'] as const) {
    await t.test(scope, async t => {
      const { root, git, write, commit } = await fixture(t, 'sha256')
      await write('a.txt', 'delete me\n'); await commit()
      await rm(path.join(root, 'a.txt'))
      if (scope === 'staged') await git.raw(['add', '-u'])
      const snapshot = await gitCommitPlanSnapshot(root)
      const result = await executeCommitPlan(root, { planID: 'r3-sha256', scope, snapshot, commits: [{ message: 'delete a', files: ['a.txt'] }] })
      assert.deepEqual(result.commits[0].files, ['a.txt'])
      const hash = (await git.raw(['rev-parse', 'HEAD'])).trim()
      assert.equal(hash.length, 64)
      assert.deepEqual((await gitCommitDetail(root, hash)).files.map(file => [file.path, file.status]), [['a.txt', 'D']])
      assert.equal(await git.raw(['status', '--porcelain=v1']), '')
    })
  }
})

test('R3 #10 commit result reports the actual subject rewritten by commit-msg', async t => {
  const { root, git, write } = await fixture(t)
  await write('a.txt', 'content\n'); await stageAll(root)
  await hook(root, 'commit-msg', 'printf "rewritten subject\\n\\nHook body.\\n" > "$1"')
  const snapshot = await gitCommitPlanSnapshot(root)
  const result = await executeCommitPlan(root, { planID: 'r3-actual-subject', scope: 'staged', snapshot, commits: [{ message: 'original subject', files: ['a.txt'] }] })
  assert.equal(result.commits[0].subject, 'rewritten subject')
  assert.equal(result.commits[0].subject, (await git.raw(['log', '-1', '--format=%s'])).trimEnd())
})

test('#3 post-commit mutation of the real index aborts group two and reports group one', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('a', 'v0\n'); await write('b', 'v0\n'); await commit()
  await write('a', 'v1\n'); await write('b', 'v1\n'); await stageAll(root)
  await write('unrelated', 'never commit\n')
  const snapshot = await gitCommitPlanSnapshot(root)
  await hook(root, 'post-commit', 'unset GIT_INDEX_FILE\ngit add -- unrelated')
  await assert.rejects(executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'a only', files: ['a'] }, { message: 'b only', files: ['b'] }] }), (error: any) => {
    assert.match(error.message, /COMMIT_PLAN_ABORTED.*Đã tạo 1 commit.*nhóm #2/s)
    assert.deepEqual(error.commits[0].files, ['a'])
    assert.ok(error.message.includes(error.commits[0].hash))
    return true
  })
  assert.equal((await git.raw(['rev-list', '--count', 'HEAD'])).trim(), '2')
  assert.equal(await git.raw(['show', 'HEAD:a']), 'v1\n')
  assert.equal(await git.raw(['show', 'HEAD:b']), 'v0\n')
  assert.equal(await git.raw(['ls-tree', '--name-only', 'HEAD', '--', 'unrelated']), '')
  assert.equal(await git.raw(['show', ':unrelated']), 'never commit\n')
})

test('#4 quiet commit-msg hook failure rejects without advancing HEAD or modifying the real index', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('a', 'v0\n'); await commit(); await write('a', 'v1\n'); await stageAll(root)
  const snapshot = await gitCommitPlanSnapshot(root)
  const index = await readFile(path.join(root, '.git', 'index'))
  await hook(root, 'commit-msg', 'exit 1')
  await assert.rejects(executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'blocked', files: ['a'] }] }), /GIT_COMMAND_FAILED: git commit exit 1.*Đã tạo 0 commit/s)
  assert.equal((await git.raw(['rev-parse', 'HEAD'])).trim(), snapshot.head)
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index)
})

test('working groups abort on hook edits and retain completed commits without absorbing unrelated stage entries', async t => {
  for (const mutation of ['disk', 'index'] as const) {
    const { root, git, write, commit } = await fixture(t)
    await write('a', 'v0\n'); await write('b', 'v0\n'); await commit()
    await write('a', 'v1\n'); await write('b', 'v1\n'); await write('unrelated', 'local\n')
    const snapshot = await gitCommitPlanSnapshot(root)
    await hook(root, 'post-commit', mutation === 'disk' ? 'printf "external\\n" > b' : 'unset GIT_INDEX_FILE\ngit add -- unrelated')
    await assert.rejects(executeCommitPlan(root, { planID: 'test-plan', scope: 'working', snapshot, commits: [{ message: 'a only', files: ['a'] }, { message: 'b only', files: ['b'] }] }), (error: any) => {
      assert.match(error.message, /COMMIT_PLAN_(STALE|ABORTED)/)
      assert.deepEqual(error.commits[0].files, ['a'])
      return true
    })
    assert.equal((await git.raw(['rev-list', '--count', 'main'])).trim(), '2')
    assert.equal(await git.raw(['show', 'main:b']), 'v0\n')
    assert.equal(await git.raw(['ls-tree', '--name-only', 'main', '--', 'unrelated']), '')
  }
})

test('#5 untracked content changes invalidate snapshots even with identical porcelain status', async t => {
  const { root, git, write } = await fixture(t)
  await write('new.txt', 'first\n')
  const snapshot = await gitCommitPlanSnapshot(root)
  const status = await git.raw(['status', '--porcelain=v1', '-z'])
  await write('new.txt', 'other\n')
  const changed = await gitCommitPlanSnapshot(root)
  assert.equal(await git.raw(['status', '--porcelain=v1', '-z']), status)
  assert.notEqual(snapshot.workingHash, changed.workingHash)
  assert.notEqual(snapshot.untrackedHashes?.['new.txt'], changed.untrackedHashes?.['new.txt'])
  await assert.rejects(executeCommitPlan(root, { planID: 'test-plan', scope: 'working', snapshot, commits: [{ message: 'new', files: ['new.txt'] }] }), /COMMIT_PLAN_STALE/)
  assert.equal(await git.raw(['ls-files', '--stage', '-z']), '')
})

test('#6 switching branches at identical HEAD and index invalidates the approved plan', async t => {
  const { root, git, write, commit } = await fixture(t)
  await write('a', 'v0\n'); await commit(); await write('a', 'v1\n'); await stageAll(root)
  const snapshot = await gitCommitPlanSnapshot(root)
  await git.raw(['checkout', '-b', 'alt'])
  const changed = await gitCommitPlanSnapshot(root)
  assert.equal(snapshot.branchRef, 'refs/heads/main'); assert.equal(changed.branch, 'alt')
  assert.equal(changed.head, snapshot.head); assert.equal(changed.indexHash, snapshot.indexHash)
  assert.notEqual(changed.fingerprint, snapshot.fingerprint)
  await assert.rejects(executeCommitPlan(root, { planID: 'test-plan', scope: 'staged', snapshot, commits: [{ message: 'a', files: ['a'] }] }), /COMMIT_PLAN_STALE/)
})

test('#10/#11 focused bounded previews prioritize files, preserve UTF-8 and can skip all diff presentation', async t => {
  const { root, write } = await fixture(t)
  await write('a-large', 'large 🌏\n'.repeat(200_000)); await write('z-focus', 'focused chào 🌏\n'); await stageAll(root)
  const focused = await gitCommitPlanSnapshot(root, 512, { focusFiles: ['z-focus'] })
  assert.ok(focused.diffPreview.startsWith('diff --git a/z-focus'))
  assert.match(focused.diffPreview, /focused chào 🌏/)
  assert.ok(Buffer.byteLength(focused.diffPreview) <= 512); assert.equal(focused.truncated, true)
  assert.ok(!focused.diffPreview.includes('�'))
  const noDiff = await gitCommitPlanSnapshot(root, 512, { includeDiff: false, focusFiles: ['../not-read'] })
  assert.equal(noDiff.stat, ''); assert.equal(noDiff.diffPreview, ''); assert.equal(noDiff.truncated, false)
  assert.equal(noDiff.fingerprint, focused.fingerprint)
  await assert.rejects(gitCommitPlanSnapshot(root, 512, { focusFiles: ['missing'] }), /COMMIT_PLAN_OUT_OF_SCOPE/)
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
