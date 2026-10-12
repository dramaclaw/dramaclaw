# Pipeline sản xuất video (Series / XiaJi) — trạng thái hiện tại

Tài liệu mô tả code hiện tại trong `src/novelvideo/`, đọc tĩnh, chưa chạy thực tế.
Chỉ nói đến luồng mặc định: dự án tạo qua API đều dùng `knowledge_pipeline: structured_v1`.
Luồng Cognee cũ nằm ngoài phạm vi.

DramaClaw biến tiểu thuyết hoặc kịch bản thành tập phim qua 4 chặng:
**Ingest → Plan → Produce → Deliver**. Việc gán bước vào 4 chặng là cách nhóm của tài liệu,
không phải khái niệm trong code. Code chỉ có danh sách bước và danh sách task.

| # | Chặng | Nội dung | Chi tiết |
|---|---|---|---|
| 1 | Ingest | Nạp nguồn, cấu hình dự án, trích nhân vật/cảnh | [01-ingest.md](01-ingest.md) |
| 2 | Plan | Phân tập, identity nhân vật, kế hoạch cảnh/đạo cụ, kịch bản | [02-plan.md](02-plan.md) |
| 3 | Produce | Sketch, first frame, giọng đọc, video từng beat | [03-produce.md](03-produce.md) |
| 4 | Deliver | Ghép tập phim, SRT, gói zip | [04-deliver.md](04-deliver.md) |
| — | MCP | Điều khiển pipeline từ agent ngoài | [05-mcp.md](05-mcp.md) |

## Trạng thái và bước kế tiếp

Endpoint trạng thái pipeline (`api/routes/pipeline.py`) suy ra tiến độ từ file và dữ liệu
trong DB, không lưu cờ riêng.

- **Cổng toàn dự án**, theo thứ tự: `ingest → configure → characters → episodes → portraits`.
  `portraits` xong khi mọi nhân vật chính có file chân dung.
- **Theo từng tập**, tập mục tiêu là tập đầu tiên chưa có `epNNN_final.mp4`. Thứ tự:
  `identity_plan → identity_images → script → sketches → coloring → global_optimize →
  first_frames → tts → video`, rồi `compose`, rồi `done`. Bước đầu tiên chưa xong là `next_step`.
- `voice_setup` không phải bước lưu trữ. Nó được chèn làm `next_step` khi bước kế là `tts`
  mà còn thiếu giọng tham chiếu.
- `configure` gần như luôn "xong", vì mặc định đã có `ethnicity="Chinese"`.
- `done` nghĩa là file `epNNN_final.mp4` tồn tại, không kiểm tra gì thêm.

Đây là thứ tự để hiển thị trạng thái. Thứ tự bắt buộc thật sự của từng task nằm trong
các điều kiện tiên quyết của task, mô tả ở từng chặng.

## Thành phần xuyên suốt

- **Task backend (CE)**: `InlineTaskBackend`, mỗi loại hàng đợi (`QUEUE_KINDS`, ví dụ `ffmpeg`)
  có một thread pool riêng (`ports/local/tasks.py`). Runner nằm ở `task_backend/runners/`.
  Không dùng Celery hay Redis trong CE.
  - Tiến độ: polling và SSE qua `/tasks`.
  - Hủy: `DELETE /tasks/{type}/{ep}`. Cờ hủy nằm trong bộ nhớ nên mất khi restart.
  - Không có resume-from-checkpoint hay retry ở mức task. Muốn chạy lại thì đẩy task lại,
    các bước dựa vào việc kiểm tra file/dữ liệu đã có.
- **Lưu trữ**: gốc dữ liệu `NOVELVIDEO_DATA_ROOT` (mặc định `.`), gồm `state/`, `output/`, `runtime/`.
  - `state/<user>/<project>/`: `data.db` (SQLite), `project_config.json`.
  - `output/<user>/<project>/`: `novel.txt`, `uploads/`, `assets/`, `sketches/`, `grids/`,
    `frames/`, `audio/`, `videos/`, `prompts/`, `scripts/`, `verify_reports/`.
  - Sơ đồ đường dẫn: `utils/path_resolver.py`.
- **Model gateway** (`model_gateway_runtime.py`): mỗi runner chạy trong một scope gateway;
  client LLM/model được tạo theo từng request; tiến trình con chỉ nhận môi trường bị giới hạn.
- **Verification** (`verification/`): các verifier và route kiểm tra cho sketch, frame,
  tính nhất quán và liên tục giữa các beat. Không có kiểm tra nào cho video thành phẩm.
- **Xia Director** (`chat/`, trong code xuất hiện là 虾导): agent chat điều khiển pipeline qua
  công cụ MCP. `chat/director_auto.py` là bộ điều phối tự động theo `next_step`,
  lưu bền trong SQLite. Backend chat có adapter Claude, Codex và Hermes.
- **MCP**: server stdio (`chat/dramaclaw_mcp.py`) bọc REST API cho agent ngoài, xem [05-mcp.md](05-mcp.md).
- **Canvas (freezone)**: nhánh khám phá tự do bằng node graph, tách khỏi pipeline series.
