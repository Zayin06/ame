import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBuildNotesError, markdownToPlainText, summarizeBuildScope } from '../build-notes-ui'
import { formatGitError } from '../git-ui'
import type { BuildNotesPreview } from '../../../../../packages/protocol/src/index'

test('markdownToPlainText converts headings, emphasis, links, tasks and nested bullets for chat', () => {
  assert.equal(markdownToPlainText([
    '# Tổng quan', '', '## **Tính năng** ##',
    '**Bold** and __strong__, *italic*, _emphasis_, ~~removed~~, `inline_code`.',
    '- [x] **Done**', '* [X] Checked', '+ [ ] Pending', '* Bullet', '  + Nested',
    '1. Ordered', '[Release notes](https://example.com/release_notes)',
  ].join('\r\n')), [
    'Tổng quan', '', 'Tính năng',
    'Bold and strong, italic, emphasis, removed, inline_code.',
    '- ☑ Done', '- ☑ Checked', '- ☐ Pending', '- Bullet', '  - Nested',
    '1. Ordered', 'Release notes (https://example.com/release_notes)',
  ].join('\n'))
})

test('markdownToPlainText removes fences but preserves code and ordinary identifier underscores', () => {
  assert.equal(markdownToPlainText([
    '### Example', '```ts', '# not a heading', 'const build_notes = "**literal**"',
    '- [x] literal task', '```', 'After `some_value` and ``a*b`` in plain_text_name.',
    '~~~text', '__literal__', '~~~',
  ].join('\n')), [
    'Example', '# not a heading', 'const build_notes = "**literal**"',
    '- [x] literal task', 'After some_value and a*b in plain_text_name.', '__literal__',
  ].join('\n'))
  assert.equal(markdownToPlainText('````md\n```ts\nconst x = 1\n```\n````'), '```ts\nconst x = 1\n```')
  assert.equal(markdownToPlainText('```ts\nconst x = 1'), 'const x = 1')
  assert.equal(markdownToPlainText('  \r\n '), '')
  assert.equal(markdownToPlainText(''), '')
  assert.equal(markdownToPlainText('Plain notes\n\nTwo lines.'), 'Plain notes\n\nTwo lines.')
  assert.equal(markdownToPlainText('[**Notes**](https://example.com/_draft_/notes)'), 'Notes (https://example.com/_draft_/notes)')
})

const errors: [string, string, string][] = [
  ['NO_BUILD_CHANGES', 'Không có thay đổi để tạo ghi chú bản build', 'Chọn commit hoặc bao gồm các thay đổi chưa commit.'],
  ['INVALID_BUILD_BASE_COMMIT', 'Commit được chọn không hợp lệ', 'Chọn tối đa 50 commit thuộc lịch sử nhánh hiện tại.'],
  ['EMPTY_BUILD_NOTES', 'Mô hình chưa trả về ghi chú bản build', 'Hãy thử tạo lại ghi chú.'],
  ['AMECODE_LOGIN_REQUIRED', 'Cần đăng nhập AmeCode', 'Đăng nhập AmeCode trước khi tạo ghi chú bản build.'],
  ['MODEL_POLICY_UNAVAILABLE', 'Không thể sử dụng mô hình đã cấu hình', 'Kiểm tra cấu hình và quyền truy cập mô hình rồi thử lại.'],
]

test('formatBuildNotesError maps build and model errors directly and through Electron IPC', () => {
  for (const [code, title, detail] of errors) {
    for (const input of [code, new Error(code), `${code}: internal context`, new Error(`Error invoking remote method 'ame:build-notes': Error: ${code}`), `Error invoking remote method "ame:build-notes": Error: ${code}: context\nmore`]) {
      assert.deepEqual(formatBuildNotesError(input), { title, detail })
    }
  }
})

test('formatBuildNotesError delegates Git and unknown failures without substring matches', () => {
  for (const input of [new Error('GIT_OFFLINE: remote unreachable'), 'GIT_CONFLICT', 'pre-commit failed', 'NO_BUILD_CHANGES_EXTRA', 'fatal: EMPTY_BUILD_NOTES', null, undefined, 42, '']) {
    assert.deepEqual(formatBuildNotesError(input), formatGitError(input))
  }
})

test('summarizeBuildScope counts combined files once and retains independent working totals', () => {
  const preview: Pick<BuildNotesPreview, 'commitCount' | 'files' | 'workingFileCount' | 'additions' | 'deletions'> = {
    commitCount: 3,
    files: [
      { path: 'committed.ts', status: 'M', source: 'committed', additions: 2, deletions: 1 },
      { path: 'shared.ts', status: 'M', source: 'both', additions: 3, deletions: 2 },
      { path: 'local.ts', status: 'U', source: 'working', additions: 4, deletions: 0 },
    ],
    workingFileCount: 2, additions: 9, deletions: 3,
  }
  const snapshot = structuredClone(preview)
  assert.equal(summarizeBuildScope(preview), '3 commit · 3 tệp · 2 tệp chưa commit · +9 -3')
  assert.deepEqual(preview, snapshot)
  assert.equal(summarizeBuildScope({ commitCount: 0, files: [], workingFileCount: 0, additions: 0, deletions: 0 }), '0 commit · 0 tệp · 0 tệp chưa commit · +0 -0')
})
