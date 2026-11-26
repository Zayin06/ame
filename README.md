# Ame IDE — working vertical slice

Ứng dụng Electron + React độc lập, triển khai luồng trọng tâm trong [architecture plan](../AME-IDE-architecture-plan.md). Layout bám HTML prototype mới trong [agy-html](../agy-html/index.html); Account/model policy và agents/skills tái sử dụng kiến trúc AmeKit trong `../opencode-amekit`. Không sửa hai source tham chiếu.

## Chạy

Phát triển/build yêu cầu Node.js **22.12+**, npm, Git và executable OpenCode **2.3.2** đáng tin cậy cho đúng nền tảng. Windows đã được kiểm thử; macOS chưa được xác nhận. Người dùng bản đóng gói không cần Node/npm hay cài/chạy OpenCode riêng. Cài dependency từ thư mục này:

```powershell
npm ci
npm run dev
```

```powershell
npm run typecheck
npm test
npm run test:desktop
npm run test:terminal
npm run package
```

`dev` và `build` tự stage OpenCode và build plugin AmeKit. Trên Windows, script có thể lấy CLI 2.3.2 từ bản OpenCode Desktop đã cài; hoặc đặt `$env:AME_OPENCODE_CLI` thành đường dẫn tuyệt đối tới executable đáng tin cậy **trước khi build**. Lần sau tái sử dụng runtime đã stage trong `resources/opencode/<platform>-<arch>`. Không tải executable khi mở ứng dụng. Manifest SHA-256 phát hiện runtime bị thay đổi sau build, không thay thế xác minh nguồn/signature của executable đầu vào.

`test:desktop` build rồi chạy Electron với profile/project tạm, kiểm tra backend tự khởi động, auth, policy, session và shutdown, bridge sandbox, Monaco/save/conflict và khôi phục theme/Inspector. Không gọi model hay Account thật. `package` tạo app directory trong `release`; Windows đang cấu hình bản unsigned (`signAndEditExecutable: false`), cần thiết lập signing trước phát hành. Windows app directory đã được chạy smoke; installer/signing và macOS chưa được xác nhận.

`test:terminal` kiểm tra Electron thật với project/profile tạm: PTY native, cwd có khoảng trắng, bàn phím, màu ANSI, resize, Ctrl+C, tabs, ẩn panel, reload renderer, thoát shell và dọn tiến trình. Đã pass trên Windows x64 ở cả build thường và app đóng gói `release-terminal/win-unpacked`; typecheck và 3 terminal unit tests cũng pass. macOS có cấu hình shell và unit tests nhưng **chưa chạy trên máy Mac**, chưa xác nhận đóng gói/signing Intel hoặc Apple Silicon. Không dùng tunnel, Account hay model ngoài cho terminal smoke.

### Windows: lỗi AppContainer khi chạy Electron

Nếu Electron báo không đọc được executable/resources do quyền AppContainer, sau khi kiểm tra và đồng ý thay đổi ACL, chỉ cấp Read/Execute cho thư mục Electron đã cài:

```powershell
icacls '.\node_modules\electron\dist' /grant '*S-1-15-2-1:(OI)(CI)(RX)'
```

Không tắt sandbox và không cấp quyền ghi. Có thể cần áp dụng lại sau khi cài lại dependency.

### Các mốc kiểm tra lịch sử

Đoạn dưới ghi lại mốc kiểm tra trước đây, không chứng nhận revision hiện tại. Chạy `npm run typecheck`, `npm test` và smoke phù hợp để lấy kết quả mới. Tại mốc đó đã chạy thành công trên Windows: `npm run typecheck`, toàn bộ **46 tests, không skip** với `node --import tsx --test --test-concurrency=1 test/*.test.ts packages/amekit/test/*.test.ts apps/desktop/src/renderer/test/*.test.ts`, build và packaged desktop smoke với Pairing tự động. `npm test` chạy song song hiện có lỗi không ổn định tại kiểm tra plugin active của runtime; test runtime chạy riêng và toàn suite tuần tự đều pass. Runtime test chạy executable thật từ resources sao chép ra ngoài workspace, xác nhận không phụ thuộc `node_modules` phát triển, auth riêng, plugin, project agent, session qua restart và shutdown. Test native nesting chạy backend thật với model OpenAI-compatible được lập trình cục bộ: gọi subagent qua ba thế hệ, chặn tầng thứ tư, nhận kết quả hoàn thành tự động qua từng parent về root; không gọi dịch vụ ngoài hoặc tiêu phí model. Desktop smoke kiểm tra cây bốn cấp trên session thật, chọn chat con, chuyển/đóng tab File–Diff và ngăn Ctrl+S lưu buffer bị ẩn, ngoài các luồng Pairing/editor/layout đã có. Build áp dụng bản sửa hẹp cho ba promise timer WordHighlighter của Monaco 0.55.1: chuyển lỗi qua handler native (bỏ cancellation dự kiến, vẫn báo lỗi thật). Không tắt highlighting hoặc lọc lỗi khỏi smoke; mọi lỗi renderer/worker vẫn làm test thất bại. MIT license và third-party notices đã được kiểm tra trong app.asar mới. Bản theo HTML mới xuất tại [release-mockup/win-unpacked/Ame IDE.exe](release-mockup/win-unpacked/Ame%20IDE.exe) và đã chạy packaged smoke; các bản cũ `release-integrated` / `release-pairing` được giữ nguyên, không thay file khi ứng dụng cũ đang chạy. Smoke kiểm tra kích thước bốn cột tại 1440×900, header 40px, composer 103px, ba resizer, không tràn ngang tại 1100px, context chip mở Diff, sticky Inspector, tìm nội dung tệp và drawer giới hạn trong Chat. Có thể đặt `AME_IDE_SMOKE_SCREENSHOT` thành đường dẫn PNG tuyệt đối để lưu ảnh native Electron; kiểm tra geometry không thay thế việc review hình ảnh. Account/bundle và model còn dùng fixture; chưa xác nhận đăng nhập hoặc suy luận trên dịch vụ thật.

## Luồng sử dụng

1. Mở project qua native picker. Explorer/Inspector mặc định ẩn ở profile mới; mở bằng nút thư mục hoặc Ctrl+Shift+E. Lựa chọn ẩn/hiện đã lưu vẫn được giữ. Mũi tên trong Inspector hướng trái để thu gọn. Explorer và Monaco đọc file thật; Ctrl/Cmd+S lưu theo revision, không âm thầm ghi đè khi file đã thay đổi trên disk.
2. Chỉ mở **Ame IDE**: ứng dụng tự chạy OpenCode 2.3.2 và plugin **amekit-models** đi kèm, chờ backend sẵn sàng rồi kết nối. Backend dùng loopback port động, mật khẩu ngẫu nhiên và config/data/cache riêng dưới Electron userData/backend; không sửa hay dừng OpenCode bên ngoài. Khi thoát ứng dụng bình thường, backend do IDE sở hữu được dừng. Nếu khởi động lỗi, mở Settings và chọn chạy lại backend. Advanced vẫn cho phép chủ động Discover/kết nối service ngoài.
3. Với project chưa có chat, nhập thẳng vào composer: lần gửi đầu tự tạo cuộc trò chuyện, không cần bấm New Chat. Nếu gửi lỗi, nội dung được giữ để thử lại trong cùng chat. Projects & Chats sắp xếp theo thời điểm cập nhật chat mới nhất từ backend (kể cả chat con/chạy nền), không đưa project lên đầu chỉ vì chọn nó; các project chưa có hoạt động giữ thứ tự ban đầu. Mở **Cài đặt → AmeKit** để đăng nhập Account tích hợp trực tiếp trong IDE; tài khoản được nhớ sẽ tự xác thực lại khi backend sẵn sàng, hoặc chọn **Làm mới**. Đổi endpoint sẽ đăng xuất tài khoản cũ. Service ngoài phải có plugin **amekit-models** tương thích; thiếu RPC báo lỗi thay vì dùng model ngoài policy. Chọn model `amecode` được cấp quyền và **Quyền thực thi** (4 chế độ) rồi gửi prompt; OpenCode tự điều phối agent, session được tạo tự động nếu chưa có. Secrets giữ ở main process, không đưa xuống renderer/localStorage.
4. Stream text/reasoning cập nhật chat; khi SSE reconnect, IDE đọc lại history vì stream không replay. **Cài đặt → Giao diện & hệ thống → Tiến trình chat** có ba preset lưu cục bộ: **Gọn** (mặc định) giữ công cụ/trạng thái đang chạy nổi bật, rồi gộp công cụ, suy nghĩ và bình luận trung gian thành một dòng khi xong; bấm dòng để xem rail hoạt động, mở tệp, chi tiết input/output/error hoặc Agent map. Câu trả lời cuối và thẻ thay đổi vẫn hiển thị. **Chi tiết** giữ bình luận inline, gộp các đoạn công cụ/suy nghĩ; **Đầy đủ** hiện từng thẻ công cụ. Permission cần người dùng duyệt; có nút interrupt.
5. Explorer hỗ trợ tạo file/thư mục và rename bằng form inline; menu từng hàng có tạo bên trong thư mục, xóa (native confirmation), copy path và reveal trong OS. Rename giữ nội dung buffer chưa lưu và cập nhật tab con; xóa đóng các tab liên quan. Search dùng backend ripgrep (nếu có) hoặc node, hỗ trợ case/whole-word/regex và Include/Exclude globs; bấm kết quả nhảy tới line:column. Replace có Preview và Replace All với native confirmation trước khi ghi. File chip trong Chat cũng mở đúng dòng trong Monaco.
6. File agent sửa trên disk được watcher thông báo; xem HEAD-versus-working diff ở chế độ Split hoặc Inline, stage/unstage từng file hoặc toàn bộ không hỏi xác nhận. Git hỗ trợ chọn/tạo branch inline, discard từng file và commit từ form soạn thông điệp. Git identity phải có sẵn; IDE không cấu hình identity toàn cục. Commit chạy Git hooks theo repository; tùy chọn No Verify chỉ bỏ các hook mà Git cho phép bỏ qua.
7. **Cài đặt → AmeKit** hỗ trợ bundles agents/skills theo [AmeKit integration](packages/amekit/docs/amekit.md). Đây là thành phần native của project, không phải extension cần cài riêng. Chỉ cài/gỡ/sync sau xác nhận; runtime phải tương thích.

## Nested subagents native

Backend riêng cấu hình `experimental.subagent_depth: 3`: root (depth 0) → con (1) → cháu (2) → chắt (3), tức **bốn cấp hiển thị**. Depth 3 không được tạo depth 4. OpenCode tự chạy nền và tự chuyển completion vào inbox parent; IDE không thay scheduler hoặc tự tạo completion. Agent vẫn cần mode/permissions cho phép gọi subagent và model có tool calling; cấu hình depth không tự nới quyền.

Panel **Agents** là cây session thực theo `parentID`, không phải danh sách agent có thể chọn. Mỗi hàng có trạng thái native và số descendant còn chạy; parent đã hoàn thành/dừng không đồng nghĩa toàn bộ cây đã xong. Chọn hàng để mở chat của tác vụ con. Composer dùng bộ chọn **Quyền thực thi** với 4 chế độ: **Mặc định**, **Hỏi trước**, **Chỉ đọc**, **Tự động cho phép**; không chọn agent chính tại đây vì OpenCode tự điều phối agent. Session được tải hết qua cursor; session mồ côi vẫn hiện nếu parent đã archive/không có trong danh sách.

### Agent Map

Bấm **Agent map** / **N subagent** trong composer hoặc **Agent map** ở đầu drawer Agents để xem sơ đồ ngang toàn bộ cây từ tác nhân gốc, kể cả khi đang mở chat con. Bấm một node để xem agent/model, trạng thái, thời gian, tokens, skills, prompt đầu tiên/gần nhất, output Markdown và công cụ đã gọi. Liên kết cha/con chuyển giữa các chi tiết; file chip mở đúng dòng trong workspace. Có thể sao chép prompt/output, mở phiên hoặc dừng agent đang chạy. Escape quay về sơ đồ, Escape lần nữa đóng hộp thoại.

Sơ đồ tự cập nhật khi mở; tối đa 200 tác nhân và 200 message gần nhất mỗi phiên. Token tổng ưu tiên thống kê native đầy đủ của phiên; prompt/output/công cụ có thể thiếu khi lịch sử vượt giới hạn. Không tải Agent Map khi chỉ hiển thị badge trong composer.

## Pairing với OpenCode Android

1. Mở Ame IDE, chờ backend tích hợp sẵn sàng.
2. Mở **Cài đặt → Pairing → Pair device**, xác nhận native dialog để bật Remote access nếu đang tắt.
3. App tự tạo HTTPS tunnel bằng SDK OpenTunnel (cùng công nghệ OpenCode Windows), không cần nhập URL/cổng hoặc chạy OpenCode/tunnel bên ngoài. Lần đầu cấp chứng chỉ có thể mất vài phút, timeout 3 phút; lỗi sẽ đóng gateway và cho phép bật lại để thử.
4. Quét QR bằng OpenCode Android; dialog có đếm ngược, **Refresh code** và **Copy link**. Link theo định dạng gốc `/auth/connect/<code>`.
5. **Remote access** bật/tắt route; **Keep screen active** giữ màn hình hoạt động trong khi app chạy. Máy phải mở và có mạng; app không tự đánh thức máy đang sleep.

Mã dùng một lần, hết hạn sau 5 phút; tự làm mới khi đang hiển thị. Token thiết bị gốc OpenCode có hiệu lực 30 ngày; khởi động lại IDE đổi mật khẩu backend và vô hiệu token cũ, cần ghép nối lại. **Tắt Remote access** đóng gateway ngay, nhưng không thu hồi token nếu bật lại trong cùng phiên. QR/link là bí mật tạm thời: không chia sẻ.

Gateway chỉ bind loopback trên cổng tự chọn, chuyển tiếp xác thực native của thiết bị, không chèn mật khẩu master. TLS kết thúc trong Ame IDE, relay không nhận plaintext. Identity/token/private key của tunnel chỉ lưu trong userData/remote-access của Ame, không dùng profile OpenTunnel/OpenCode chung; không gửi xuống renderer. Chỉ trạng thái bật và giữ màn hình được lưu trong pairing.json, không lưu QR hoặc token thiết bị. Cấu hình tunnel thủ công cũ được migrate về trạng thái tắt, cần xác nhận lại. Thiết bị đã ghép nối có toàn quyền backend (không phải chỉ xem). Đóng app/chuyển backend ngoài sẽ đóng route và gateway; tùy chọn giữ màn hình được giải phóng khi thoát. Pairing không thay thế AmeKit login/model policy.

Packaged desktop smoke đã tạo tunnel thật, refresh QR, copy link rồi redeem chính link đã copy qua HTTPS công khai, kiểm tra 401 khi chưa xác thực, token auth thành công, từ chối dùng lại mã và tắt gateway; identity test được xóa sau smoke. Chưa xác nhận thiết bị Android vật lý.

## Phạm vi và giới hạn

- Bốn cột độc lập theo HTML mới: **Projects & Chats → Project Inspector → Chat Canvas → File & Diff Stage**. Header 40px, ba thanh resize, Inspector Files/Search/Git ẩn cố định, drawer Artifacts/Agents//btw nằm trong Chat, terminal tương tác nằm dưới Stage. Resize/theme/layout lưu cục bộ; layout cũ được migrate, không lưu nội dung buffer xuống localStorage.
- Rail lọc tên project/chat và project có Diff. Project Search tìm text qua backend, mặc định tối đa 5.000 tệp / 1.000 matches, bỏ qua thư mục generated phổ biến, binary và tệp quá 2 MiB; hiển thị engine và trạng thái truncated. Preview/Replace dùng cùng bộ lọc và giới hạn; thay đổi từ tiến trình ngoài trong lúc preview/xác nhận không bị khóa. Terminal dùng trực tiếp xterm.js + node-pty, cùng nền tảng VS Code, độc lập kết nối OpenCode. Bấm **+** để mở shell tại thư mục project; chọn profile, chuyển tab hoặc **×** để dừng shell. Windows hỗ trợ PowerShell/CMD; macOS dùng `$SHELL` hoặc zsh/bash dưới dạng login shell. Ctrl+C gửi interrupt; macOS Cmd+C/V sao chép/dán, Windows Ctrl+Shift+C / Ctrl+V. Ẩn panel hoặc reload renderer giữ shell; đóng cửa sổ/app dừng shell thuộc app. Không tự mở shell khi chọn project; không lưu phiên sau khi thoát app. Artifact API, /btw, attachment/slash/mention và AI Enhance đã có tích hợp qua bridge và SDK; khả năng sử dụng phụ thuộc backend và Account/model policy.
- Có Account/model policy và bundle workflow tích hợp; Pairing dùng API/QR gốc, không thay server auth phục vụ mobile.
- Backend và gateway nghe **local HTTP loopback**; truy cập từ xa chỉ qua HTTPS tunnel tự quản lý sau khi người dùng xác nhận bật Remote access. Không giả lập remote filesystem. Giới hạn file text UTF-8 4 MiB; có dịch vụ ngôn ngữ TypeScript/JavaScript và Node debugger; chưa có binary editor hoặc extension host.
- Session history hiện lấy 200 message gần nhất; danh sách session tự tải toàn bộ session chưa archive theo cursor (100 mỗi trang), không cần pagination UI.
- Save kiểm tra revision và serialize theo danh tính file trong IDE. File thông thường được ghi vào tệp tạm, flush rồi rename; file có hard link giữ alias bằng ghi tại chỗ sau khi flush bản gốc vào `.bak`, rollback nếu lỗi và giữ bản sao khi không thể rollback. Không khóa filesystem với tiến trình ngoài. Đóng khi dirty phải xác nhận. Mất điện/crash trước khi lưu có thể mất buffer.
- Project cần là checkout Git gốc để panel SCM phản ánh đúng boundary; không thao tác parent repository từ subfolder.
- Watcher native có thể không hỗ trợ một số network filesystem; nút refresh vẫn đọc lại disk.
- Chưa xác nhận suy luận model thật, authenticated Account thật, publish thật, hoặc compatibility end-to-end mobile. Backend đóng gói được chạy thật; kiểm thử Account/inference vẫn dùng fixture, không tiêu phí model.
- Shutdown có kiểm thử khi thoát bình thường; chưa bảo đảm thu hồi backend nếu IDE bị kill/crash đột ngột. Session đã lưu nằm trong profile riêng; không tự migrate dữ liệu từ OpenCode Desktop.
- Không thay thế production IDE đã harden: signing/updater, multi-window, workspace trust nâng cao, huge repo/performance và macOS runtime cần gate tiếp theo.

Xem [architecture](docs/architecture.md), [upstream references](references/README.md) và [third-party notices](THIRD_PARTY_NOTICES.md).
