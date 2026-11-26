# AME Core

Repository này **không đóng gói các tệp agents/skills riêng tư của người dùng** và không cung cấp bundle `bundles/ame-core/import`.

Người dùng sở hữu, tự duy trì và nhập thư mục agents/skills của mình từ máy cục bộ qua **Settings → AmeKit → Bundle**.

Schema/layout, quyền, model tier mặc định và đoạn system prompt `ame-orchestrator` bên dưới **chỉ là mẫu tham khảo** cho native OpenCode 2.3.2, với **2 agents + 1 skill**:

- `agents/ame-explorer.md`: khảo sát rộng, chỉ đọc, trả tóm tắt ngắn có bằng chứng.
- `agents/ame-reviewer.md`: review độc lập các thay đổi đáng kể hoặc có rủi ro.
- `skills/systematic-debugging/SKILL.md`: AME gỡ lỗi trực tiếp trong phiên hiện tại, không có agent Debugger.

## Import

Chọn thư mục cục bộ của bạn chứa layout tham khảo ở trên, không chọn thư mục tài liệu này. `test/ame-core-bundle.test.ts` tự tạo fixture bundle tạm, biệt lập để kiểm tra khả năng tương thích runtime; fixture đó không phải bundle riêng tư được phân phối trong repository.

Chỉ người dùng thực hiện import, publish hoặc activate. Việc tạo bundle không tự thực hiện các thao tác đó, không thay đổi tài khoản hay API server.

## Quyền và model tier

Hai agent dùng danh sách quyền có thứ tự, **deny-by-default**: chỉ mở đọc, glob và grep; đọc `*.env` / `*.env.*` cần hỏi, ngoại lệ `*.env.example` được phép. Explorer được dùng web khi thực sự cần tài liệu ngoài. Reviewer được mở shell để kiểm chứng.

**Giới hạn shell của reviewer là quy tắc prompt, không phải sandbox**: quyền `shell: *` không tự cưỡng chế chỉ chạy tests, typecheck hoặc git diff, cũng không bảo đảm lệnh không ghi tệp. Reviewer phải tuân thủ giới hạn không sửa nguồn/không ghi tệp và báo khi không thể kiểm chứng an toàn.

`amecode/haiku` cho explorer và `amecode/sonnet` cho reviewer là **mặc định ban đầu có thể cấu hình**, không phải lựa chọn tối ưu đã đo lường cho AME. Đây là tier, không khóa model cụ thể.

## Quy tắc Orchestrator

Khối mẫu dưới đây có thể ghép vào prompt của **một `ame-orchestrator` chính thức duy nhất trên API server của người dùng**. Mẫu tham khảo không tạo hay kích hoạt orchestrator riêng.

```text
Bạn là AME, ame-orchestrator chính thức duy nhất trên API server của người dùng.

- Tự lập kế hoạch, thiết kế, viết mã và kiểm chứng trực tiếp trong phiên hiện tại; chịu trách nhiệm về kết quả cuối cùng.
- Tác vụ nhỏ hoặc phụ thuộc tuần tự thì làm trực tiếp. Không áp đặt pipeline hay bắt buộc gọi subagent cho mọi nhiệm vụ.
- Chỉ dùng ame-explorer khi cần khảo sát mã nguồn/tài liệu đủ rộng; giao phạm vi rõ ràng, chỉ đọc và yêu cầu tóm tắt ngắn có bằng chứng.
- Dùng ame-reviewer để review độc lập thay đổi đáng kể hoặc có rủi ro. Cung cấp diff, mục tiêu, ràng buộc và các kiểm tra đã chạy; không chuyển toàn bộ lịch sử suy luận. Tự đánh giá findings trước khi sửa.
- Khi gỡ lỗi, nạp systematic-debugging và thực hiện trực tiếp trong phiên hiện tại. Không tạo agent Debugger.
- Chỉ chạy song song công việc độc lập; tránh ghi chồng cùng tệp hoặc cùng vùng mã. Không dùng song song để bỏ qua phụ thuộc.
- Chỉ AME ở level-0 quản lý master todo. Subagent báo kết quả trong phạm vi được giao, không tạo hoặc quản lý master todo riêng.
- Không tạo hoặc dùng agent Planner, Architect, Verifier hay Implementer. Không fallback sang explore, general hoặc plan.
- Nếu thiếu ame-explorer, ame-reviewer hoặc systematic-debugging cần dùng, báo rõ thành phần thiếu và giới hạn ảnh hưởng; không âm thầm thay bằng agent/skill khác. Chỉ tiếp tục phần AME có thể làm trực tiếp an toàn trong phạm vi đã được giao.
- Không tự import, publish, activate bundle hoặc thao tác tài khoản/server; các thao tác đó thuộc người dùng.
```
