import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeCommitMessage, filterBranches, formatGitError, formatRelativeGitDate, syncBadgeSummary } from '../git-ui'
import type { GitBranchesLike, GitStatusLike } from '../git-ui'

const codedErrors: [string, string, string?][] = [
  ['NO_REMOTE_CONFIGURED', 'Chưa cấu hình remote Git', 'Thêm remote origin hoặc mở Terminal để gắn repository từ xa.'],
  ['GIT_AUTH_FAILED', 'Xác thực Git với remote thất bại'],
  ['GIT_OFFLINE', 'Không thể kết nối tới remote Git'],
  ['GIT_PUSH_REJECTED_NON_FF', 'Push bị từ chối do remote có commit mới', 'Hãy Pull về trước rồi thử Push lại.'],
  ['GIT_CONFLICT', 'Phát sinh xung đột (merge conflict)', 'Giải quyết xung đột trong mã nguồn, stage các tệp đã sửa rồi commit để hoàn tất.'],
  ['GIT_DIRTY_WORKTREE', 'Có thay đổi cục bộ chưa commit sẽ bị ghi đè', 'Hãy Commit hoặc Stash thay đổi trước khi Pull / chuyển nhánh.'],
  ['GIT_ROOT_REQUIRED', 'Thư mục dự án không phải gốc Git (.git)'],
  ['CANNOT_DELETE_CURRENT_BRANCH', 'Không thể xóa nhánh đang mở', 'Chuyển sang nhánh khác trước khi xóa.'],
  ['INVALID_BRANCH_NAME', 'Tên nhánh không hợp lệ theo quy tắc Git'],
  ['DETACHED_HEAD_PUSH_UNSUPPORTED', 'Đang ở trạng thái Detached HEAD', 'Tạo hoặc checkout một nhánh cục bộ trước khi Push.'],
  ['NO_COMMIT_TO_UNDO', 'Chưa có commit nào để hoàn tác'],
  ['GIT_DETACHED_ROOT_UNDO_UNSUPPORTED', 'Không thể hoàn tác commit đầu tiên khi đang Detached HEAD', 'Checkout hoặc tạo một nhánh cục bộ trước khi hoàn tác.']
]

for (const [code, title, detail] of codedErrors) {
  test(`formatGitError translates ${code} directly and through Electron IPC`, () => {
    const expected = detail ? { title, detail } : { title }
    for (const input of [code, new Error(code), `Error invoking remote method 'ame:git': Error: ${code}`, new Error(`Error invoking remote method "ame:git": Error: ${code}`)]) {
      assert.deepEqual(formatGitError(input), expected)
    }
  })
}

test('formatGitError preserves network details, including colons and newlines', () => {
  for (const [code, title] of codedErrors.filter(([code]) => ['GIT_AUTH_FAILED', 'GIT_OFFLINE'].includes(code))) {
    assert.deepEqual(formatGitError(new Error(`Error invoking remote method 'ame:git': Error: ${code}:  remote: unavailable\nretry later  `)), { title, detail: 'remote: unavailable\nretry later' })
    assert.deepEqual(formatGitError(`${code}:  `), { title })
  }
  assert.deepEqual(formatGitError('GIT_CONFLICT: pre-commit hook failed'), { title: codedErrors[4][1], detail: codedErrors[4][2] })
})

test('formatGitError recognizes hooks and cleans fallback messages without losing content', () => {
  for (const message of ['HOOK rejected this commit', 'pre-commit failed', 'commit-msg exited with code 1']) {
    assert.deepEqual(formatGitError(`Error invoking remote method 'ame:commit': Error: ${message}`), { title: 'Git hook chặn commit', detail: message })
  }
  assert.deepEqual(formatGitError(' Error: Error: fatal: invalid repository \n'), { title: 'fatal: invalid repository' })
  assert.deepEqual(formatGitError(new Error('unknown failure\nsecond line')), { title: 'unknown failure\nsecond line' })
  assert.deepEqual(formatGitError('GIT_OFFLINE_EXTRA: unknown'), { title: 'GIT_OFFLINE_EXTRA: unknown' })
  assert.deepEqual(formatGitError('fatal: mentions GIT_OFFLINE'), { title: 'fatal: mentions GIT_OFFLINE' })
  assert.deepEqual(formatGitError(null), { title: 'null' })
  assert.deepEqual(formatGitError(undefined), { title: 'undefined' })
  assert.deepEqual(formatGitError(42), { title: '42' })
  assert.deepEqual(formatGitError(''), { title: '' })
})

test('analyzeCommitMessage chooses the first nonempty line and preserves subject spacing', () => {
  assert.deepEqual(analyzeCommitMessage(''), { subject: '', subjectLength: 0, subjectOverLimit: false, lineCount: 1, charCount: 0 })
  const message = '\r\n  \r\n  subject  \r\n\r\nbody\r\n'
  assert.deepEqual(analyzeCommitMessage(message), { subject: '  subject  ', subjectLength: 11, subjectOverLimit: false, lineCount: 6, charCount: message.length })
  assert.deepEqual(analyzeCommitMessage(' \n\n'), { subject: ' ', subjectLength: 1, subjectOverLimit: false, lineCount: 3, charCount: 3 })
  assert.equal(analyzeCommitMessage('subject\r').subject, 'subject')
})

test('analyzeCommitMessage uses a 72-code-point subject limit and UTF-16 total count', () => {
  for (const character of ['a', 'ệ', '😀']) {
    const subject = character.repeat(72)
    assert.equal(analyzeCommitMessage(subject).subjectLength, 72)
    assert.equal(analyzeCommitMessage(subject).subjectOverLimit, false)
    assert.equal(analyzeCommitMessage(subject + character).subjectLength, 73)
    assert.equal(analyzeCommitMessage(subject + character).subjectOverLimit, true)
  }
  assert.deepEqual(analyzeCommitMessage('😀\nbody'), { subject: '😀', subjectLength: 1, subjectOverLimit: false, lineCount: 2, charCount: 7 })
  assert.equal(analyzeCommitMessage('short\n' + 'a'.repeat(100)).subjectOverLimit, false)
})

test('formatRelativeGitDate handles relative boundaries, future dates and locale fallback', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  const minute = 60_000, hour = 60 * minute, day = 24 * hour
  const cases: [number, string][] = [
    [-minute, 'Vừa xong'], [0, 'Vừa xong'], [minute - 1, 'Vừa xong'],
    [minute, '1 phút trước'], [2 * minute + 1, '2 phút trước'], [hour - 1, '59 phút trước'],
    [hour, '1 giờ trước'], [2 * hour + 1, '2 giờ trước'], [day - 1, '23 giờ trước'],
    [day, '1 ngày trước'], [2 * day + 1, '2 ngày trước'], [30 * day - 1, '29 ngày trước']
  ]
  for (const [elapsed, expected] of cases) assert.equal(formatRelativeGitDate(new Date(now - elapsed).toISOString(), now), expected)
  const oldDate = new Date(now - 30 * day)
  assert.equal(formatRelativeGitDate(oldDate.toISOString(), now), oldDate.toLocaleDateString('vi-VN'))
  assert.equal(formatRelativeGitDate('not-a-date', now), 'not-a-date')
  assert.equal(formatRelativeGitDate('', now), '')
  assert.equal(formatRelativeGitDate(new Date(Date.now() + hour).toISOString()), 'Vừa xong')
})

test('filterBranches matches local and remote names independently without modifying input', () => {
  const branches: GitBranchesLike = {
    current: 'main',
    branches: [{ name: 'main', current: true, commit: 'abc' }, { name: 'Feature/Login', upstream: 'origin/Feature/Login' }],
    remoteBranches: [{ name: 'origin/main', remote: true }, { name: 'origin/FEATURE/login', remote: true }]
  }
  const snapshot = structuredClone(branches)
  Object.freeze(branches.branches)
  Object.freeze(branches.remoteBranches)
  assert.deepEqual(filterBranches(branches, '  LOGIN  '), { local: [branches.branches[1]], remote: [branches.remoteBranches![1]] })
  assert.deepEqual(filterBranches(branches, 'origin/'), { local: [], remote: branches.remoteBranches })
  assert.deepEqual(filterBranches(branches, 'no match'), { local: [], remote: [] })
  const all = filterBranches(branches, '   ')
  assert.deepEqual(all, { local: branches.branches, remote: branches.remoteBranches })
  assert.notEqual(all.local, branches.branches)
  assert.notEqual(all.remote, branches.remoteBranches)
  assert.deepEqual(branches, snapshot)
  assert.deepEqual(filterBranches(undefined, ''), { local: [], remote: [] })
  assert.deepEqual(filterBranches({ branches: [{ name: 'main' }] }, 'MAIN'), { local: [{ name: 'main' }], remote: [] })
})

test('syncBadgeSummary disables sync without a remote, including legacy status', () => {
  const expected = { canSync: false, needsPublish: false, ahead: 0, behind: 0, pushLabel: 'Push', pullLabel: 'Pull', statusText: 'Chưa có remote' }
  assert.deepEqual(syncBadgeSummary(), expected)
  assert.deepEqual(syncBadgeSummary({ branch: 'main', changes: [] }), expected)
  assert.deepEqual(syncBadgeSummary({ branch: 'main', changes: [], hasRemote: false, tracking: 'origin/main' }), expected)
})

test('syncBadgeSummary offers publish for remote repositories without tracking', () => {
  for (const tracking of [undefined, null, '']) {
    assert.deepEqual(syncBadgeSummary({ branch: 'main', changes: [], hasRemote: true, tracking }), {
      canSync: true, needsPublish: true, ahead: 0, behind: 0, pushLabel: 'Publish', pullLabel: 'Pull', statusText: 'Chưa publish nhánh'
    })
  }
  assert.equal(syncBadgeSummary({ branch: 'main', changes: [], hasRemote: true, ahead: 3 }).pushLabel, 'Publish')
})

test('syncBadgeSummary formats synchronized, ahead, behind and diverged branches', () => {
  const base: GitStatusLike = { branch: 'main', changes: [], hasRemote: true, tracking: 'origin/main' }
  assert.deepEqual(syncBadgeSummary(base), { canSync: true, needsPublish: false, ahead: 0, behind: 0, pushLabel: 'Push', pullLabel: 'Pull', statusText: 'Đã đồng bộ' })
  assert.deepEqual(syncBadgeSummary({ ...base, ahead: 2 }), { canSync: true, needsPublish: false, ahead: 2, behind: 0, pushLabel: 'Push ↑2', pullLabel: 'Pull', statusText: '↑2' })
  assert.deepEqual(syncBadgeSummary({ ...base, behind: 3 }), { canSync: true, needsPublish: false, ahead: 0, behind: 3, pushLabel: 'Push', pullLabel: 'Pull ↓3', statusText: '↓3' })
  assert.deepEqual(syncBadgeSummary({ ...base, ahead: 2, behind: 3 }), { canSync: true, needsPublish: false, ahead: 2, behind: 3, pushLabel: 'Push ↑2', pullLabel: 'Pull ↓3', statusText: '↑2 ↓3' })
})
