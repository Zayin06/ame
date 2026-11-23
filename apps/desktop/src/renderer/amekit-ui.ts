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

const errors: Record<string, { title: string; detail?: string }> = {
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
  INVALID_BUNDLE: { title: 'Máy chủ từ chối gói ZIP/manifest', detail: 'Kiểm tra phiên bản SemVer, giới hạn ≤ 1023 tệp và kích thước ZIP ≤ 8 MiB.' },
  RAW_INSTALL_CONFIRMATION_REQUIRED: { title: 'Cần xác nhận chế độ Raw trước khi đồng bộ', detail: "Bật tùy chọn 'Cho phép raw compatibility khi đồng bộ' rồi bấm Đồng bộ lại." },
  UPLOAD_LIMIT: { title: 'Đạt giới hạn tối đa 5 upload đang chờ', detail: 'Đợi các upload pending hết hạn hoặc hoàn tất xuất bản release trước khi đẩy mới.' },
  RELEASE_CONFLICT: { title: 'Phiên bản này đã tồn tại trên máy chủ', detail: 'Hãy đặt số phiên bản mới (ví dụ 1.0.1) và đóng gói lại.' },
  ACTIVATION_CONFLICT: { title: 'Revision kích hoạt đã thay đổi trên máy chủ', detail: 'Lịch sử đã được làm mới hoặc hãy bấm Cập nhật lịch sử rồi kích hoạt lại.' },
  IMPORT_REQUIRED: { title: 'Chưa có dữ liệu nhập hợp lệ', detail: 'Hãy chọn thư mục chứa agents/ và skills/ ở Bước 1 trước.' },
  AI_FIX_PROVIDER_ERROR: { title: 'Không thể sửa tệp qua máy chủ AI', detail: 'Kiểm tra kết nối và model đang dùng rồi thử lại.' },
  AI_FIX_INVALID_RESPONSE: { title: 'AI trả về bản sửa không hợp lệ', detail: 'Tệp tạm chưa thay đổi. Thử lại với model khác.' },
  AI_FIX_VALIDATION_FAILED: { title: 'Bản sửa AI vẫn còn lỗi sau khi kiểm tra lại', detail: 'Tệp tạm chưa thay đổi. Thử model khác hoặc bỏ tệp khỏi gói.' },
  AI_FIX_UNSUPPORTED_FILE: { title: 'AI không hỗ trợ sửa tệp này', detail: 'Chỉ hỗ trợ tệp văn bản UTF-8 trong agents/ và skills/.' },
  AI_FIX_FILE_TOO_LARGE: { title: 'Tệp quá lớn để sửa bằng AI', detail: 'Giới hạn mỗi tệp là 256 KiB. Chia nhỏ tệp hoặc bỏ khỏi gói.' },
  AI_FIX_NO_FIXABLE_ERRORS: { title: 'Không có tệp lỗi phù hợp để sửa bằng AI', detail: 'Kiểm tra tab Lỗi hoặc bỏ tệp không được hỗ trợ khỏi gói.' },
  IMPORT_FILE_NOT_FOUND: { title: 'Không tìm thấy tệp trong phiên nhập hiện tại', detail: 'Chọn nhập lại thư mục để cập nhật danh sách tệp.' },
  SAVE_PATH_UNSAFE: { title: 'Không thể lưu vì đường dẫn nguồn không an toàn', detail: 'Kiểm tra liên kết tượng trưng và vị trí thư mục nguồn rồi nhập lại.' },
  UNKNOWN_COMMIT_ENHANCE_SKILL: { title: 'Skill Enhance không nằm trong gói đã nhập', detail: 'Hãy chọn lại skill có trong danh sách skills/ ở Bước 1 rồi đóng gói lại.' },
  PACKAGE_REQUIRED: { title: 'Chưa có gói ZIP sẵn sàng xuất bản', detail: 'Nhập phiên bản và bấm Đóng gói ZIP ở Bước 2 trước.' },
  ZIP_EXCEEDS_8_MIB: { title: 'Gói ZIP vượt quá giới hạn 8 MiB', detail: 'Giảm dung lượng tài nguyên trong skills/ hoặc tách bớt tệp lớn.' },
  OWNED_FILE_CHANGED: { title: 'Tệp do AmeKit quản lý trong .opencode/ đã bị chỉnh sửa tay', detail: 'Khôi phục tệp về nguyên bản hoặc gỡ thủ công rồi đồng bộ lại.' },
  DISCOVERY_MISMATCH: { title: 'OpenCode 2.3.2 không nạp được đủ agent/skill trong gói Native', detail: 'Kiểm tra lại metadata agent/skill trước khi kích hoạt cho team.' },
  NO_ACTIVE_RELEASE: { title: 'Máy chủ chưa có bản phát hành nào được kích hoạt', detail: 'Quản trị viên cần xuất bản và kích hoạt một bản release trước.' },
  FORBIDDEN: { title: 'Tài khoản không có quyền thực hiện thao tác quản trị này', detail: 'Cần tài khoản role admin.' },
  CANCELLED: { title: 'Bạn đã hủy hộp thoại xác nhận.' },
  AMECODE_LOGIN_REQUIRED: { title: 'Phiên đăng nhập AmeCode đã hết hạn hoặc chưa đăng nhập', detail: 'Vào tab Tài khoản để đăng nhập hoặc làm mới phiên.' },
}
errors.ZIP_EXCEEDS = errors.ZIP_EXCEEDS_8_MIB
errors.SIGNED_OUT = errors.AMECODE_LOGIN_REQUIRED
for (const code of ['PERSONAL_FILE_COLLISION', 'PERSONAL_AGENT_COLLISION', 'PERSONAL_SKILL_COLLISION', 'PERSONAL_DIRECTORY_COLLISION']) {
  errors[code] = { title: 'Xung đột với cấu hình OpenCode cá nhân trong .opencode/', detail: 'Dự án đang có tệp/agent/skill trùng tên với bundle của team; hãy dọn hoặc sao lưu tệp trùng trước khi đồng bộ.' }
}

export function formatAmeKitError(error: unknown): { code?: string; title: string; detail?: string } {
  const text = errorText(error).trim()
  const code = text.match(/\b([A-Z][A-Z0-9_]{2,79})\b/)?.[1]
  const message = code && Object.hasOwn(errors, code) ? errors[code] : undefined
  return { ...(code ? { code } : {}), ...(message ?? { title: text }) }
}

export function formatBundleSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}
