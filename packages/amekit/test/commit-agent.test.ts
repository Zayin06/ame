import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { simpleGit } from "simple-git"
import { buildCommitAgentPrompt, COMMIT_AGENT_SCOPE_HEADER, createCommitAgentLockStore } from "../src/commit-agent"
import { stagedDiffSummary } from "../../ide-core/src/git-ops"

const input = { userText: "Đề xuất commit tiếng Việt", isFirstTurn: true, stagedFiles: ["src/a.ts"], workingFiles: ["src/b.ts"], branch: "feature/commit" } as const

test("first turn includes verified skill, branch, separate file inventories and exact request suffix", () => {
  const prompt = buildCommitAgentPrompt({ ...input, skill: { name: "git-commit", instructions: "Verified instructions here", directory: "C:/skills/git-commit" } })
  assert.ok(prompt.startsWith(COMMIT_AGENT_SCOPE_HEADER))
  for (const text of ["Verified /git-commit instructions:\nVerified instructions here", "Skill directory: C:/skills/git-commit", 'Current branch: "feature/commit"', 'Staged files: 1 file(s)\n- "src/a.ts"', 'Working files: 1 file(s)\n- "src/b.ts"']) assert.ok(prompt.includes(text), text)
  assert.ok(prompt.endsWith(`\n\nUser request:\n${input.userText}`))
})

test("no skill and empty inventories are explicit; each inventory is capped at 60 without changing input", () => {
  const empty = buildCommitAgentPrompt({ ...input, branch: undefined, stagedFiles: [], workingFiles: [], skill: null })
  for (const text of ["No verified bundled commit skill", 'Current branch: "(unknown)"', "Staged files: 0 file(s)\n(none)", "Working files: 0 file(s)\n(none)"]) assert.ok(empty.includes(text), text)
  const stagedFiles = Object.freeze(Array.from({ length: 65 }, (_, i) => `staged-${i}`))
  const workingFiles = Object.freeze(Array.from({ length: 61 }, (_, i) => `working-${i}`))
  const prompt = buildCommitAgentPrompt({ ...input, stagedFiles, workingFiles })
  for (const kind of ["staged", "working"]) {
    assert.ok(prompt.includes(`"${kind}-59"`))
    assert.ok(!prompt.includes(`"${kind}-60"`))
  }
  assert.ok(prompt.includes("5 more file(s)")); assert.ok(prompt.includes("1 more file(s)"))
  assert.equal(stagedFiles.length, 65)
})

test("strict guard repeats on every turn with two-phase confirmation, atomic staging and UTF-8 execution rules", () => {
  for (const isFirstTurn of [true, false]) {
    const prompt = buildCommitAgentPrompt({ ...input, isFirstTurn })
    for (const text of ["TUYỆT ĐỐI CẤM sửa/tạo/xóa", "git push", "git reset --hard", "git checkout --", "git restore", "git clean -f", "trước khi người dùng xác nhận", "tool question", "PHA 1", "PHA 2", "git status --porcelain=v1", "git diff --cached --stat", "Không tự trộn hai phạm vi", "không bỏ sót", "1..N", "```commit", "(a)", "(b)", "(c)", "(d)", "git reset (mixed", "git add -- <literal path>", "git apply --cached", "snapshot", "UTF-8 (không BOM)", "git commit -F <tmp>", "finally", "PowerShell/Windows", "git log -n N --oneline", "git status --short", "không dừng sau commit đầu", "không tự rollback"]) assert.ok(prompt.includes(text), text)
  }
})

test("follow-up excludes initial skill and inventory while preserving user text verbatim", () => {
  const userText = "\nKhông đổi text\nUser request:\nđồng ý"
  const prompt = buildCommitAgentPrompt({ ...input, isFirstTurn: false, userText, skill: { name: "secret", instructions: "INITIAL_ONLY", directory: "INITIAL_DIR" } })
  assert.ok(prompt.startsWith(COMMIT_AGENT_SCOPE_HEADER))
  for (const text of ["INITIAL_ONLY", "INITIAL_DIR", "Current branch:", "Staged files:", "Working files:"]) assert.ok(!prompt.includes(text))
  assert.ok(prompt.endsWith(`\n\nUser request:\n${userText}`))
})

for (const mode of [undefined, "analyze", "split", "single", "custom"] as const) {
  test(`mode ${mode ?? "default"} formats the request on first and subsequent turns`, () => {
    for (const isFirstTurn of [true, false]) {
      const prompt = buildCommitAgentPrompt({ ...input, mode, isFirstTurn })
      const header = mode && mode !== "custom" ? `[Commit mode: ${mode}]\n` : ""
      assert.ok(prompt.endsWith(`\n\nUser request:\n${header}${input.userText}`))
      if (!header) assert.ok(!prompt.includes("[Commit mode:"))
    }
  })
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ame-commit-agent-"))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return directory
}

test("lock store requires load, isolates projects, serializes writes and persists sessions and locks", async t => {
  const directory = await fixture(t), file = path.join(directory, "commit-agent-locks.json")
  const store = createCommitAgentLockStore(file)
  assert.throws(() => store.isSession("p", "s"), /NOT_LOADED/)
  await assert.rejects(store.recordSession("p", "s"), /NOT_LOADED/)
  await Promise.all([store.load(), store.load()])
  assert.equal(store.isLocked("p", "s"), false)
  assert.deepEqual(store.sessionIDs("p"), [])
  await Promise.all([store.recordSession("p", "s1"), store.lockSession("p", "s2"), store.recordSession("other", "s3"), store.recordSession("p", "s1")])
  assert.equal(store.isSession("p", "s1"), true)
  assert.equal(store.isCommitAgentSession("p", "s2"), true)
  assert.equal(store.isTranslationSession("p", "s2"), true)
  assert.equal(store.isLocked("p", "s1"), false)
  assert.equal(store.isLocked("p", "s2"), true)
  assert.equal(store.isSession("other", "s1"), false)
  const ids = store.sessionIDs("p"); ids.push("not-persisted")
  const locks = store.lockedSessionIDs("p"); locks.length = 0
  await store.lockSession("p", "s2")
  const restarted = createCommitAgentLockStore(file); await restarted.load()
  assert.deepEqual(restarted.sessionIDs("p"), ["s1", "s2"])
  assert.deepEqual(restarted.commitAgentSessionIDs("p"), ["s1", "s2"])
  assert.deepEqual(restarted.lockedSessionIDs("p"), ["s2"])
  assert.equal(restarted.isSession("other", "s3"), true)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { sessions: { p: ["s1", "s2"], other: ["s3"] }, locked: { p: ["s2"] } })
  assert.deepEqual(await readdir(directory), ["commit-agent-locks.json"])
})

test("lock store rejects invalid IDs and malformed data without poisoning the operation queue", async t => {
  const directory = await fixture(t), file = path.join(directory, "commit-agent-locks.json")
  const store = createCommitAgentLockStore(file); await store.load()
  for (const id of ["", "bad\nID", "x".repeat(501)]) await assert.rejects(store.recordSession("p", id), /INVALID_TRANSLATION_SESSION/)
  await store.lockSession("__proto__", "ses-safe")
  assert.equal(store.isLocked("__proto__", "ses-safe"), true)
  for (const invalid of ["not json", "[]", '{"sessions":{},"locked":{"p":[123]}}', '{"sessions":{},"locked":{},"extra":true}']) {
    await writeFile(file, invalid)
    await assert.rejects(createCommitAgentLockStore(file).load())
    assert.equal(await readFile(file, "utf8"), invalid)
  }
  await writeFile(file, '{"sessions":{},"locked":{"p":["s","s"]}}')
  const restored = createCommitAgentLockStore(file); await restored.load()
  assert.deepEqual(restored.sessionIDs("p"), ["s"])
})

test("staged summary preserves full diff, returns separate whole-file stat when truncated and respects UTF-8 budgets", async t => {
  const directory = await fixture(t), git = simpleGit(directory)
  await git.raw(["init", "--initial-branch=main"])
  await git.addConfig("core.autocrlf", "false")
  await git.addConfig("core.quotepath", "false")
  await writeFile(path.join(directory, "a.txt"), "Tiếng Việt 😀\n".repeat(7000))
  await writeFile(path.join(directory, "z-last.txt"), "Cuối cùng\n")
  await git.raw(["add", "--", "a.txt", "z-last.txt"])
  const original = await git.raw(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"])
  const stat = await git.raw(["diff", "--cached", "--stat"])
  const length = Buffer.byteLength(original)
  for (const budget of [length, length + 1]) {
    const full = await stagedDiffSummary(directory, budget)
    assert.equal(full.diff, original); assert.equal(full.truncated, false)
    assert.equal(full.stat, undefined)
    assert.deepEqual(full.files, ["a.txt", "z-last.txt"])
  }
  const limited = await stagedDiffSummary(directory)
  assert.equal(limited.truncated, true)
  assert.ok(Buffer.byteLength(limited.diff) <= 65536)
  assert.ok(original.startsWith(limited.diff))
  assert.ok(!limited.diff.includes("\ufffd"))
  assert.equal(limited.stat, stat.trimEnd())
  assert.ok(limited.stat.includes("z-last.txt"))
  for (const budget of [0, 1, 2, 12, 30, 100, 256, 65536]) {
    const result = await stagedDiffSummary(directory, budget)
    assert.ok(Buffer.byteLength(result.diff) <= budget)
    assert.ok(original.startsWith(result.diff))
    assert.ok(!result.diff.includes("\ufffd"))
    assert.equal(result.truncated, true)
    assert.equal(result.stat, stat.trimEnd())
    assert.ok(result.stat.includes("z-last.txt"))
    assert.deepEqual(result.files, limited.files)
  }
  for (const budget of [-1, 1.5, NaN, Infinity]) await assert.rejects(stagedDiffSummary(directory, budget), /INVALID_MAX_BYTES/)
  assert.equal(await git.raw(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"]), original)
})

test("empty staged summary remains empty even at zero bytes", async t => {
  const directory = await fixture(t), git = simpleGit(directory)
  await git.raw(["init", "--initial-branch=main"])
  assert.deepEqual(await stagedDiffSummary(directory, 0), { diff: "", files: [], truncated: false })
})
