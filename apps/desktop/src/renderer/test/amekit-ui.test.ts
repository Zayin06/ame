import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAmeKitError, formatBundleSize, groupIssues } from '../amekit-ui'

test('import inspector prioritizes blocking Archive (5) errors over leading excluded files', () => {
  const grouped = groupIssues([
    { path: 'Archive (5)/.DS_Store', severity: 'excluded', reason: 'OS metadata' },
    { path: 'Archive (5)/__MACOSX/agents/._helper.md', severity: 'excluded', reason: 'OS metadata' },
    { path: 'agents/helper.md', severity: 'error', reason: 'unsupported metadata: tools' },
    { path: 'agents/other.md', severity: 'error', reason: 'invalid OpenCode 2.3.2 agent metadata' },
    { path: 'agents/converted.md', severity: 'change', reason: 'normalized' },
  ], 'native')
  assert.equal(grouped.defaultTab, 'error')
  assert.equal(grouped.suggestClaudeAdapt, true)
  assert.deepEqual(grouped.error.map(issue => issue.path), ['agents/helper.md', 'agents/other.md'])
  assert.equal(grouped.excluded.length, 2)
  assert.equal(grouped.change.length, 1)
})

test('issue groups normalize malformed records and unknown severity without dropping items', () => {
  const values = [null, undefined, 12, 'plain warning', {}, { path: 4, severity: 'fatal', reason: false }, { path: 'file', severity: '__proto__', reason: 'future severity' }]
  const grouped = groupIssues(values)
  assert.equal(grouped.defaultTab, 'warning')
  assert.equal(grouped.suggestClaudeAdapt, false)
  assert.equal(grouped.warning.length, values.length)
  assert.deepEqual(grouped.warning[3], { path: '', severity: 'warning', reason: 'plain warning' })
  assert.deepEqual(grouped.warning[5], { path: '', severity: 'warning', reason: 'Không có mô tả' })
  assert.deepEqual(grouped.warning[6], { path: 'file', severity: 'warning', reason: 'future severity' })
  assert.equal(groupIssues([]).defaultTab, 'excluded')
  assert.equal(groupIssues([{ severity: 'excluded' }]).defaultTab, 'excluded')
  assert.equal(groupIssues([{ severity: 'warning' }, { severity: 'excluded' }, { severity: 'change' }]).defaultTab, 'change')
})

test('Claude adaptation is suggested only for matching blocking errors outside raw mode', () => {
  for (const reason of ['unsupported metadata: tools', 'Unsupported metadata:   tools', 'invalid OpenCode 2.3.2 agent metadata', 'model dependency: inherit', 'Claude tools cannot load']) {
    for (const mode of [undefined, 'native']) assert.equal(groupIssues([{ severity: 'error', reason }], mode).suggestClaudeAdapt, true, `${mode}: ${reason}`)
    assert.equal(groupIssues([{ severity: 'error', reason }], 'raw').suggestClaudeAdapt, false)
    assert.equal(groupIssues([{ severity: 'warning', reason }], 'native').suggestClaudeAdapt, false)
  }
  assert.equal(groupIssues([{ severity: 'error', reason: 'unsafe path' }]).suggestClaudeAdapt, false)
})

test('AmeKit errors unwrap Electron IPC wrappers and provide practical Vietnamese guidance', () => {
  const cases: [string, RegExp, RegExp | undefined][] = [
    ['IMPORT_BLOCKED', /lỗi trong thư mục nguồn/, /tab Lỗi.*Raw \+ Chuẩn hóa/],
    ['INVALID_BUNDLE', /ZIP\/manifest/, /SemVer.*1023.*8 MiB/],
    ['RAW_INSTALL_CONFIRMATION_REQUIRED', /xác nhận chế độ Raw/, /Cho phép raw compatibility.*Đồng bộ/],
    ['UPLOAD_LIMIT', /tối đa 5 upload/, /pending.*release/],
    ['RELEASE_CONFLICT', /đã tồn tại/, /1\.0\.1/],
    ['ACTIVATION_CONFLICT', /Revision kích hoạt/, /lịch sử.*kích hoạt lại/i],
    ['IMPORT_REQUIRED', /Chưa có dữ liệu nhập/, /agents\/.*skills\/.*Bước 1/],
    ['PACKAGE_REQUIRED', /Chưa có gói ZIP/, /Bước 2/],
    ['ZIP_EXCEEDS_8_MIB', /vượt quá giới hạn 8 MiB/, /tệp lớn/],
    ['ZIP_EXCEEDS', /vượt quá giới hạn 8 MiB/, /tệp lớn/],
    ...['PERSONAL_FILE_COLLISION', 'PERSONAL_AGENT_COLLISION', 'PERSONAL_SKILL_COLLISION', 'PERSONAL_DIRECTORY_COLLISION'].map(code => [code, /cấu hình OpenCode cá nhân/, /sao lưu.*đồng bộ/] as [string, RegExp, RegExp]),
    ['OWNED_FILE_CHANGED', /chỉnh sửa tay/, /nguyên bản.*đồng bộ/],
    ['DISCOVERY_MISMATCH', /OpenCode 2\.3\.2/, /metadata agent\/skill/],
    ['NO_ACTIVE_RELEASE', /chưa có bản phát hành/, /Quản trị viên/],
    ['FORBIDDEN', /không có quyền/, /role admin/],
    ['CANCELLED', /đã hủy hộp thoại/, undefined],
    ['AMECODE_LOGIN_REQUIRED', /hết hạn hoặc chưa đăng nhập/, /tab Tài khoản/],
    ['SIGNED_OUT', /hết hạn hoặc chưa đăng nhập/, /tab Tài khoản/],
  ]
  for (const [code, title, detail] of cases) {
    const formatted = formatAmeKitError(new Error(`Error invoking remote method 'ame:account': Error: ${code}`))
    assert.equal(formatted.code, code)
    assert.match(formatted.title, title)
    if (detail) assert.match(formatted.detail!, detail)
    else assert.equal(formatted.detail, undefined)
    assert.doesNotMatch(formatted.title, /Error invoking/)
  }
})

test('unknown errors preserve cleaned text and the first uppercase code without unsafe lookups', () => {
  assert.deepEqual(formatAmeKitError(new Error("Error invoking remote method 'ame:account': Error: NEW_SERVER_CODE: retry later")), { code: 'NEW_SERVER_CODE', title: 'NEW_SERVER_CODE: retry later' })
  assert.deepEqual(formatAmeKitError('  Connection lost  '), { title: 'Connection lost' })
  assert.deepEqual(formatAmeKitError('RELEASE_CONFLICT followed by FORBIDDEN'), { code: 'RELEASE_CONFLICT', title: 'Phiên bản này đã tồn tại trên máy chủ', detail: 'Hãy đặt số phiên bản mới (ví dụ 1.0.1) và đóng gói lại.' })
  assert.deepEqual(formatAmeKitError(null), { title: 'null' })
  assert.deepEqual(formatAmeKitError(undefined), { title: 'undefined' })
  assert.deepEqual(formatAmeKitError('AB'), { title: 'AB' })
  assert.deepEqual(formatAmeKitError('A'.repeat(81)), { title: 'A'.repeat(81) })
  assert.deepEqual(formatAmeKitError('constructor'), { title: 'constructor' })
})

test('bundle sizes use readable binary units at boundaries and handle invalid inputs', () => {
  const cases: [number, string][] = [[0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1.0 KiB'], [1536, '1.5 KiB'], [1024 * 1024 - 1, '1024.0 KiB'], [1024 * 1024, '1.00 MiB'], [1.25 * 1024 * 1024, '1.25 MiB'], [8 * 1024 * 1024, '8.00 MiB'], [-1, '0 B'], [NaN, '0 B'], [Infinity, '0 B']]
  for (const [bytes, expected] of cases) assert.equal(formatBundleSize(bytes), expected)
})
