import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { simpleGit } from 'simple-git'
import { Workspaces } from '../packages/ide-core/src/workspace'
import { searchWorkspace, replaceInWorkspace } from '../packages/ide-core/src/search'
import { executeCommitPlan, gitCommitPlanSnapshot, gitUndoLastCommit, gitStashList, gitStashDrop, gitStashApply, checkoutBranch, gitFileCommitPatch } from '../packages/ide-core/src/git-ops'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-review-regression-'))
  const ws = new Workspaces(path.join(root, 'projects.json'))
  t.after(async () => { ws.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  const git = simpleGit(repo, { trimmed: false, unsafe: { allowUnsafeProtocolOverride: true } })
  await git.raw(['init', '-b', 'main'])
  for (const [key, value] of Object.entries({ 'user.name': 'Review', 'user.email': 'review@example.invalid', 'commit.gpgSign': 'false', 'core.autocrlf': 'false', 'core.hooksPath': '' })) await git.addConfig(key, value)
  const put = (file: string, value: string) => writeFile(path.join(repo, file), value)
  const commit = async () => { await git.add('.'); await git.raw(['commit', '-m', 'fixture']) }
  await put('file', 'before\n'); await commit()
  await ws.add(repo, 'p', false)
  const plan = async (files: string[]) => {
    const snapshot = await gitCommitPlanSnapshot(repo)
    return executeCommitPlan(repo, { planID: 'regression', scope: snapshot.scope, snapshot, commits: [{ message: 'planned', files }] })
  }
  return { root, repo, git, put, commit, ws, plan }
}

test('index lock prevents publishing a working commit', async t => {
  const { repo, git, put, plan } = await fixture(t)
  const head = await git.revparse(['HEAD'])
  await put('file', 'after\n')
  await put('.git/index.lock', '')
  await assert.rejects(plan(['file']), /EEXIST/)
  assert.equal(await git.revparse(['HEAD']), head)
  assert.equal(await git.raw(['show', ':file']), 'before\n')
  assert.equal(await readFile(path.join(repo, '.git/index.lock'), 'utf8'), '')
})

test('working submodule update preserves gitlink and does not delete it', async t => {
  const { repo, root, git, commit, plan } = await fixture(t)
  const lib = path.join(root, 'lib'); await mkdir(lib)
  const child = simpleGit(lib)
  await child.init(); await child.addConfig('user.name', 'Review'); await child.addConfig('user.email', 'review@example.invalid'); await child.addConfig('commit.gpgSign', 'false')
  await writeFile(path.join(lib, 'part'), 'one'); await child.add('.'); await child.commit('one')
  await git.raw(['-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'lib']); await commit()
  const sub = simpleGit(path.join(repo, 'lib'))
  await writeFile(path.join(repo, 'lib/part'), 'two'); await sub.add('.'); await sub.raw(['-c', 'user.name=Review', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'two'])
  await plan(['lib'])
  assert.match(await git.raw(['ls-tree', 'HEAD', 'lib']), new RegExp(`160000 commit ${(await sub.revparse(['HEAD'])).trim()}`))
  assert.equal((await git.status()).isClean(), true)
})

test('ordinary post-commit switch uses real index', async t => {
  const { repo, git, put, plan } = await fixture(t)
  await git.branch(['other']); await put('file', 'planned\n')
  const hooks = path.join(repo, '.git/hooks'); await mkdir(hooks, { recursive: true })
  await writeFile(path.join(hooks, 'post-commit'), '#!/bin/sh\ngit switch -q other\n', { mode: 0o755 })
  await git.addConfig('core.hooksPath', hooks)
  await plan(['file'])
  assert.equal((await git.branch()).current, 'other')
  assert.equal((await git.status()).isClean(), true)
})

test('shallow undo preserves branch until missing parent is fetched', async t => {
  const { root, repo, git, put, commit } = await fixture(t)
  await put('file', 'second'); await commit()
  const clone = path.join(root, 'shallow')
  await git.raw(['clone', '--depth=1', pathToFileURL(repo).href, clone])
  const shallow = simpleGit(clone); const head = await shallow.revparse(['HEAD'])
  await assert.rejects(gitUndoLastCommit(clone), /GIT_SHALLOW_HISTORY/)
  assert.equal(await shallow.revparse(['HEAD']), head)
})

test('hard links and overlapping projects serialize saves by physical identity', async t => {
  const { repo, ws } = await fixture(t)
  await link(path.join(repo, 'file'), path.join(repo, 'alias'))
  await mkdir(path.join(repo, 'nested')); await writeFile(path.join(repo, 'nested/file'), 'before\n')
  await ws.add(path.join(repo, 'nested'), 'nested', false)
  for (const [first, second] of [[['p', 'file'], ['p', 'alias']], [['p', 'nested/file'], ['nested', 'file']]]) {
    const doc = await ws.read(first[0], first[1])
    const results = await Promise.allSettled([ws.save(first[0], first[1], 'one', doc.revision), ws.save(second[0], second[1], 'two', doc.revision)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.match(String((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason), /FILE_CONFLICT/)
  }
})

test('stale stash selection cannot apply or delete a newly inserted stash', async t => {
  const { repo, git, put } = await fixture(t)
  await put('file', 'A'); await git.stash(['push', '-m', 'A'])
  const [selected] = await gitStashList(repo)
  await put('file', 'B'); await git.stash(['push', '-m', 'B'])
  await assert.rejects(gitStashDrop(repo, selected.index, selected.oid), /GIT_STASH_STALE/)
  await assert.rejects(gitStashApply(repo, selected.index, true, selected.oid), /GIT_STASH_STALE/)
  assert.equal((await gitStashList(repo)).length, 2)
})

test('remote selection rejects an existing local branch tracking another remote', async t => {
  const { repo, git } = await fixture(t)
  const head = (await git.revparse(['HEAD'])).trim()
  await git.addRemote('team', repo); await git.addRemote('origin', repo)
  await git.raw(['update-ref', 'refs/remotes/team/feat', head]); await git.raw(['update-ref', 'refs/remotes/origin/feat', head])
  await git.raw(['branch', '--track', 'feat', 'team/feat'])
  await assert.rejects(checkoutBranch(repo, 'origin/feat'), /UPSTREAM_MISMATCH/)
  assert.equal((await git.branch()).current, 'main')
})

test('historical tree is an empty file side and range retains committed plus working patches', async t => {
  const { repo, git, put, commit, ws } = await fixture(t)
  const base = (await git.revparse(['HEAD'])).trim()
  await put('file', 'middle\n'); await commit(); await put('file', 'before\n')
  const range = await ws.diff('p', 'file', { kind: 'range', baseCommit: base, includeWorking: true })
  assert.match(range.patch!, /-before\n\+middle/); assert.match(range.patch!, /-middle\n\+before/)
  await rm(path.join(repo, 'file')); await mkdir(path.join(repo, 'file')); await put('file/sub', 'new'); await commit()
  const detail = await ws.diff('p', 'file', { kind: 'commit', commit: (await git.revparse(['HEAD'])).trim() })
  assert.equal(detail.modified, '')
})

test('search and replace honor ignore character classes, Unicode boundaries and BOM coordinates', async t => {
  const { repo, put } = await fixture(t)
  await put('.gitignore', 'generated-[0-9].txt\n'); await put('generated-3.txt', 'needle')
  await put('words', 'đọc sách\n'); await put('bom', '\uFEFFexport const x = 1\n')
  assert.equal((await searchWorkspace(repo, { query: 'đọc', wholeWord: true })).totalMatches, 1)
  assert.equal((await searchWorkspace(repo, { query: '^export', regex: true })).results[0].matches[0].column, 1)
  assert.equal((await searchWorkspace(repo, { query: 'needle' })).totalMatches, 0)
  await replaceInWorkspace(repo, { query: '^export', regex: true, replacement: 'declare', files: ['bom'] })
  assert.match(await readFile(path.join(repo, 'bom'), 'utf8'), /^\uFEFFdeclare/)
  await replaceInWorkspace(repo, { query: 'needle', replacement: 'changed' })
  assert.equal(await readFile(path.join(repo, 'generated-3.txt'), 'utf8'), 'needle')
  await put('astral', '😀')
  const zeroWidth = await searchWorkspace(repo, { query: '(?:)', regex: true, wholeWord: true, include: ['astral'] })
  assert.equal(zeroWidth.totalMatches, 2)
})

test('Windows case-only rename preserves file content', { skip: process.platform !== 'win32' }, async t => {
  const { repo, ws } = await fixture(t)
  await ws.renamePath('p', 'file', 'File')
  assert.equal(await readFile(path.join(repo, 'File'), 'utf8'), 'before\n')
})

test('truncated selected and working patches disclose omitted content within byte budget', async t => {
  const { repo, git, put, commit, ws } = await fixture(t)
  const base = (await git.revparse(['HEAD'])).trim()
  await put('file', 'chào 🌏\n'.repeat(500_000)); await commit()
  const head = (await git.revparse(['HEAD'])).trim()
  for (const working of [false, true]) {
    if (working) await put('file', 'đổi 🌏\n'.repeat(600_000))
    const patch = await gitFileCommitPatch(repo, 'file', [base, head], working)
    assert.ok(Buffer.byteLength(patch) <= 4 * 1024 * 1024)
    assert.ok(patch.endsWith('\n[Diff truncated at 4 MiB]\n'))
    assert.ok(!patch.includes('\ufffd'))
    const view = await ws.diff('p', 'file', { kind: 'commits', commits: [base, head], includeWorking: working })
    assert.equal(view.truncated, true)
  }
})
