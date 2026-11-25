import { errorText } from './components/Primitives'

export type IssueSeverity = 'error' | 'warning' | 'change' | 'excluded'
export type AmeKitIssue = { path: string; severity: IssueSeverity; reason: string }

export function groupIssues(rawIssues: unknown[], mode?: string) {
  const groups: Record<IssueSeverity, AmeKitIssue[]> = { error: [], warning: [], change: [], excluded: [] }
  for (const value of rawIssues) {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const severity: IssueSeverity = item.severity === 'error' || item.severity === 'change' || item.severity === 'excluded' ? item.severity : 'warning'
    groups[severity].push({ path: typeof item.path === 'string' ? item.path : '', severity, reason: typeof item.reason === 'string' ? item.reason : typeof value === 'string' ? value : 'Không có mô tả' })
  }
  const defaultTab: IssueSeverity = groups.error.length ? 'error' : groups.change.length ? 'change' : groups.warning.length ? 'warning' : 'excluded'
  const suggestClaudeAdapt = mode !== 'raw' && groups.error.some(issue => /unsupported metadata:\s*tools|invalid OpenCode 2\.3\.2 agent metadata|model dependency|Claude tools/i.test(issue.reason))
  return { ...groups, defaultTab, suggestClaudeAdapt }
}

export function suggestNextVersion(versions: readonly (string | undefined)[]): string {
  let highest: bigint[] | undefined
  for (const version of versions) {
    const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/)
    if (!match) continue
    const tuple = match.slice(1, 4).map(value => BigInt(value))
    if (!highest || tuple[0] > highest[0] || (tuple[0] === highest[0] && (tuple[1] > highest[1] || (tuple[1] === highest[1] && tuple[2] > highest[2])))) highest = tuple
  }
  return highest ? `${highest[0]}.${highest[1]}.${highest[2] + 1n}` : '1.0.0'
}

const errors: Record<string, { title: string; detail?: string }> = {
  OPERATION_BUSY: { title: 'Hệ thống đang xử lý tác vụ đồng bộ tài khoản', detail: 'Vui lòng chờ giây lát rồi thử lại.' },
  MODEL_POLICY_PLUGIN_REQUIRED: { title: 'Cần đăng nhập để kích hoạt chính sách model', detail: 'Đăng nhập tài khoản AmeCode bên dưới để đồng bộ cấu hình model và bundle.' },
  MODEL_POLICY_UNAVAILABLE: { title: 'Chưa tải được chính sách model từ máy chủ', detail: 'Kiểm tra kết nối mạng hoặc bấm Kiểm tra lại.' },
  ACCOUNT_REFRESH_REQUIRED: { title: 'Phiên đăng nhập cần được làm mới', detail: 'Bấm Làm mới phiên hoặc đăng nhập lại.' },
  SESSION_STORAGE_UNAVAILABLE: { title: 'Không thể truy cập kho lưu trữ bảo mật của hệ thống', detail: 'Kiểm tra quyền keychain / credential store trên thiết bị.' },
  LOCAL_SERVER_REQUIRED: { title: 'Cần chạy OpenCode tích hợp cục bộ', detail: 'Mở Giao diện & hệ thống để khởi động lại backend tích hợp.' },
  NETWORK_ERROR: { title: 'Không thể kết nối tới máy chủ AmeCode', detail: 'Kiểm tra kết nối mạng và địa chỉ máy chủ rồi thử lại.' },
  HTTP_ERROR: { title: 'Máy chủ AmeCode trả về lỗi', detail: 'Thử lại sau vài giây hoặc kiểm tra trạng thái máy chủ.' },
  USER_DISABLED: { title: 'Tài khoản đã bị vô hiệu hóa', detail: 'Liên hệ quản trị viên để được kích hoạt lại.' },
  INVALID_ROLE: { title: 'Vai trò tài khoản không hợp lệ', detail: 'Liên hệ quản trị viên để kiểm tra phân quyền.' },
  INVALID_AUTH_RESPONSE: { title: 'Phản hồi đăng nhập từ máy chủ không hợp lệ', detail: 'Kiểm tra lại URL máy chủ AmeCode.' },
  INVALID_CREDENTIALS: { title: 'Sai tên đăng nhập hoặc mật khẩu', detail: 'Kiểm tra lại thông tin tài khoản và thử lại.' },
  UNAUTHORIZED: { title: 'Sai tên đăng nhập hoặc mật khẩu', detail: 'Kiểm tra lại thông tin tài khoản và thử lại.' },
  IMPORT_BLOCKED: { title: 'Không thể đóng gói vì còn lỗi trong thư mục nguồn', detail: 'Hãy xem tab Lỗi ở Bước 1 hoặc chuyển sang chế độ Raw + Chuẩn hóa agent Claude -> OpenCode nếu dùng gói Claude.' },
  INVALID_BUNDLE: { title: 'Máy chủ từ chối gói ZIP/manifest', detail: 'Kiểm tra phiên bản SemVer, giới hạn ≤ 10.000 tệp và kích thước ZIP ≤ 32 MiB.' },
  INVALID_PAYLOAD: { title: 'Dữ liệu cấu hình không hợp lệ', detail: 'Kiểm tra lại phiên bản và thông số đã chọn rồi thử lại.' },
  INVALID_RELEASE: { title: 'Dữ liệu bản phát hành không hợp lệ', detail: 'Kiểm tra lại phiên bản SemVer và thông số đã chọn rồi thử lại.' },
  RAW_INSTALL_CONFIRMATION_REQUIRED: { title: 'Cần xác nhận chế độ Raw trước khi đồng bộ', detail: "Bật tùy chọn 'Cho phép raw compatibility khi đồng bộ' rồi bấm Đồng bộ lại." },
  UPLOAD_LIMIT: { title: 'Đạt giới hạn tối đa 5 upload đang chờ', detail: 'Đợi các upload pending hết hạn hoặc hoàn tất xuất bản release trước khi đẩy mới.' },
  RELEASE_CONFLICT: { title: 'Phiên bản này đã tồn tại trên máy chủ', detail: 'Hãy đặt số phiên bản mới (ví dụ 1.0.1) và đóng gói lại.' },
  ACTIVATION_CONFLICT: { title: 'Revision kích hoạt đã thay đổi trên máy chủ', detail: 'Lịch sử đã được làm mới hoặc hãy bấm Cập nhật lịch sử rồi kích hoạt lại.' },
  IMPORT_REQUIRED: { title: 'Chưa có dữ liệu nhập hợp lệ', detail: 'Hãy chọn và nhập thư mục chứa agents/ và skills/ trước.' },
  AI_FIX_PROVIDER_ERROR: { title: 'Không thể sửa tệp qua máy chủ AI', detail: 'Kiểm tra kết nối và model đang dùng rồi thử lại.' },
  AI_FIX_INVALID_RESPONSE: { title: 'AI trả về bản sửa không hợp lệ', detail: 'Tệp tạm chưa thay đổi. Thử lại với model khác.' },
  AI_FIX_VALIDATION_FAILED: { title: 'Bản sửa AI vẫn còn lỗi sau khi kiểm tra lại', detail: 'Tệp tạm chưa thay đổi. Thử model khác hoặc bỏ tệp khỏi gói.' },
  AI_FIX_UNSUPPORTED_FILE: { title: 'AI không hỗ trợ sửa tệp này', detail: 'Chỉ hỗ trợ tệp văn bản UTF-8 trong agents/ và skills/.' },
  AI_FIX_FILE_TOO_LARGE: { title: 'Tệp quá lớn để sửa bằng AI', detail: 'Giới hạn mỗi tệp là 256 KiB. Chia nhỏ tệp hoặc bỏ khỏi gói.' },
  AI_FIX_NO_FIXABLE_ERRORS: { title: 'Không có tệp lỗi phù hợp để sửa bằng AI', detail: 'Kiểm tra tab Lỗi hoặc bỏ tệp không được hỗ trợ khỏi gói.' },
  IMPORT_FILE_NOT_FOUND: { title: 'Không tìm thấy tệp trong phiên nhập hiện tại', detail: 'Chọn nhập lại thư mục để cập nhật danh sách tệp.' },
  SAVE_PATH_UNSAFE: { title: 'Không thể lưu vì đường dẫn nguồn không an toàn', detail: 'Kiểm tra liên kết tượng trưng và vị trí thư mục nguồn rồi nhập lại.' },
  UNKNOWN_COMMIT_ENHANCE_SKILL: { title: 'Skill Enhance không nằm trong gói đã nhập', detail: 'Hãy chọn lại skill có trong danh sách skills/ ở Bước 1 rồi đóng gói lại.' },
  UNKNOWN_ANDROID_TRANSLATION_SKILL: { title: 'Skill Dịch Android không nằm trong gói đã nhập', detail: 'Hãy chọn lại skill trong danh sách ở Bước 1 rồi đóng gói lại.' },
  UNKNOWN_BUILD_NOTES_SKILL: { title: 'Skill Mô tả bản build không nằm trong gói đã nhập', detail: 'Hãy chọn lại skill có trong danh sách ở Bước 1 rồi đóng gói lại.' },
  NO_BUILD_CHANGES: { title: 'Không có thay đổi nào để tạo mô tả bản build', detail: 'Hãy chọn ít nhất một commit trước đó hoặc chỉnh sửa tệp chưa commit.' },
  INVALID_BUILD_BASE_COMMIT: { title: 'Mốc commit gốc không thuộc nhánh hiện tại', detail: 'Hãy chọn một commit hợp lệ trên nhánh hiện tại.' },
  EMPTY_BUILD_NOTES: { title: 'AI chưa trả về nội dung mô tả bản build', detail: 'Hãy thử lại hoặc kiểm tra model đang dùng.' },
  ANDROID_TRANSLATION_NOT_CONFIGURED: { title: 'Chưa cấu hình Dịch Android', detail: 'Nhờ quản trị viên chọn skill Dịch Android trong Cài đặt → AmeKit, xuất bản và đồng bộ bundle.' },
  TRANSLATION_SESSION_LOCKED: { title: 'Phiên dịch Android đã hoàn tất và được khóa', detail: 'Chọn Phiên dịch mới để tiếp tục dịch hoặc dùng Chat chính cho công việc lập trình.' },
  TRANSLATION_MODEL_UNAVAILABLE: { title: 'Model đã ghim của phiên dịch không còn khả dụng', detail: 'Kiểm tra kết nối và tài khoản hoặc chọn Phiên dịch mới để dùng cấu hình model hiện tại.' },
  ANDROID_TRANSLATION_SESSION_REQUIRED: { title: 'Phiên này chỉ dùng trong cửa sổ Dịch Android', detail: 'Mở Dịch Android để tiếp tục dịch hoặc chọn Cuộc trò chuyện mới trong Chat chính.' },
  PACKAGE_REQUIRED: { title: 'Chưa có gói ZIP sẵn sàng xuất bản', detail: 'Chọn thư mục nguồn và bấm Chỉ đóng gói thử trước khi xuất bản gói đã nén.' },
  ZIP_EXCEEDS_32_MIB: { title: 'Gói ZIP sau nén vượt quá giới hạn 32 MiB', detail: 'Giảm dung lượng tài nguyên trong skills/ hoặc tách bớt tệp lớn.' },
  ZIP_EXCEEDS_8_MIB: { title: 'Gói ZIP vượt quá giới hạn 8 MiB', detail: 'Giảm dung lượng tài nguyên trong skills/ hoặc tách bớt tệp lớn.' },
  OWNED_FILE_CHANGED: { title: 'Tệp do AmeKit quản lý trong .opencode/ đã bị chỉnh sửa tay', detail: 'Khôi phục tệp về nguyên bản hoặc gỡ thủ công rồi đồng bộ lại.' },
  DISCOVERY_MISMATCH: { title: 'OpenCode 2.3.2 không nạp được đủ agent/skill trong gói Native', detail: 'Kiểm tra lại metadata agent/skill trước khi kích hoạt cho team.' },
  NO_ACTIVE_RELEASE: { title: 'Máy chủ chưa có bản phát hành nào được kích hoạt', detail: 'Quản trị viên cần xuất bản và kích hoạt một bản release trước.' },
  FORBIDDEN: { title: 'Tài khoản không có quyền thực hiện thao tác quản trị này', detail: 'Cần tài khoản role admin.' },
  CANCELLED: { title: 'Bạn đã hủy hộp thoại xác nhận.' },
  AMECODE_LOGIN_REQUIRED: { title: 'Phiên đăng nhập AmeCode đã hết hạn hoặc chưa đăng nhập', detail: 'Vào tab Tài khoản để đăng nhập hoặc làm mới phiên.' },
}
errors.ZIP_EXCEEDS = errors.ZIP_EXCEEDS_32_MIB
errors.SIGNED_OUT = errors.AMECODE_LOGIN_REQUIRED
for (const code of ['PERSONAL_FILE_COLLISION', 'PERSONAL_AGENT_COLLISION', 'PERSONAL_SKILL_COLLISION', 'PERSONAL_DIRECTORY_COLLISION']) {
  errors[code] = { title: 'Xung đột với cấu hình OpenCode cá nhân trong .opencode/', detail: 'Dự án đang có tệp/agent/skill trùng tên với bundle của team; hãy dọn hoặc sao lưu tệp trùng trước khi đồng bộ.' }
}

export function formatAmeKitError(error: unknown): { code?: string; title: string; detail?: string } {
  const text = errorText(error).trim()
  const code = text.match(/\b([A-Z][A-Z0-9_]{2,79})\b/)?.[1]
  const message = code && Object.hasOwn(errors, code) ? errors[code] : undefined
  const providerDetail = code?.startsWith('AI_FIX_') ? text.slice(text.indexOf(code) + code.length).replace(/^:\s*/, '').trim() : ''
  return { ...(code ? { code } : {}), ...(message ?? { title: text }), ...(providerDetail ? { detail: providerDetail } : {}) }
}

export function formatBundleSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}
