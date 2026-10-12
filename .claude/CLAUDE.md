# DramaClaw local setup notes (Claude Code)

Máy này đã cài và cấu hình sẵn. Đọc file này trước khi cài/cấu hình lại để khỏi mất thời gian. Không ghi bí mật vào đây; mật khẩu root NewAPI nằm ở `NEWAPI_ROOT_PASSWORD` trong `.env` (gitignored).

## Chạy stack

- Dùng image dựng sẵn, không cần clone gateway: `docker compose -f docker-compose.release.yml up -d` (api, newapi, web).
- Nếu Docker chưa chạy: `open -a Docker`, chờ `docker info` thành công.
- Cổng: web `http://localhost:8080`, API `http://localhost:8780`, trang admin NewAPI `http://127.0.0.1:30000`.
- Cổng 3000 trên máy bị container `stub-server-stub-1` chiếm, nên `.env` đặt `ST_NEWAPI_PORT=30000`. Đừng bỏ dòng này.
- `/health` của API trả 404 (bình thường). Dùng `docker compose -f docker-compose.release.yml ps` (api phải `healthy`) và `GET /api/v1/projects`.
- `docker compose up` lần đầu pull image rất lâu (hơn 10 phút); chạy nền.

## Cấu hình model (mode `custom`, đã làm qua API, không cần DC key)

- Khởi tạo NewAPI: `POST /api/v1/model-gateway/custom/newapi/init` (đã chạy; username `root`).
- Gemini: server `http://localhost:6969` (container `web_ai_server`, OpenAI-compatible, điều khiển trình duyệt qua playwright). Container docker gọi nó bằng `http://host.docker.internal:6969`. Kênh `DC-custom` (type 1), key giữ chỗ `sk-local-webai`, cả 24 model `DC-*-LLM` ánh xạ sang `gemini-auto`. Danh sách model của 6969: `gemini-auto`, `playwright/gemini/gemini-3.1-pro`, `.../gemini-3.5-flash`, `.../gemini-3.1-flash-lite`.
- Cập nhật ánh xạ: `POST /api/v1/model-gateway/custom/newapi/channels` (cùng tên kênh thì thành update).
- Embedding: kênh `DC-ollama` (type 4) trỏ `http://host.docker.internal:11434`, `DC-cognee-embedding` -> `bge-m3`, 1024 chiều, batch 10. Cần `ollama serve` đang chạy. Lưu preset key trước (`provider-channels`) rồi mới gọi `embedding-model`, nếu không báo `upstreamKey is required`.
- Ảnh (character portrait): channel `DC-custom` có thêm mapping `gemini6969` -> `gemini-auto`. **Không dùng chuẩn OpenAI Images API** vì `web_ai_server`/6969 không có `/images/generations`, chỉ có `/chat/completions` trả ảnh qua `artifacts[].url` (URL bị khoá session Google). Đã thêm provider riêng `gemini_webai` (dev-only, tách khỏi model production `LingShan-NB-2`/`LingShan-G2`) đọc artifact này và tải bằng cookie Playwright `~/WebAI-to-API/runtime/auth/gemini.json` (biến `.env`: `GEMINI_WEBAI_COOKIE_FILE_HOST`, mount vào container qua `docker-compose.release.yml`). Chi tiết đầy đủ + lý do: `docs/adr/0001-local-gemini-webai-image-provider.md`. Chưa có kênh video, giọng đọc.
- Claude/Anthropic không có model embedding, đừng dùng cho `DC-cognee-embedding`.
- Container `api` chạy image local đã build sẵn (`dramaclaw-local/api`), **không** `docker compose build`/`up --build` lại — Dockerfile pin `CODEX_RUNTIME_IMAGE` qua digest hiện không resolve được trên máy này (`no match for platform in manifest`), build full sẽ fail. Sửa code Python rồi muốn áp dụng ngay: `docker cp` file đã sửa vào `/app/src/novelvideo/...` trong container rồi `docker restart dramaclaw-api-1` (giữ filesystem container, không dùng `docker compose up -d` vì sẽ recreate từ image gốc và mất bản vá). Khi nào build lại được thì đổi cách này.

## Embedding có cần không?

- Dự án mới tạo qua API luôn là `knowledge_pipeline: "structured_v1"` (`src/novelvideo/api/routes/projects.py:765`): không embedding, không đồ thị, không vector index. Ingest chỉ lưu nguồn và chia chunk.
- Chỉ dự án `cognee_legacy` (trường `knowledge_pipeline` vắng hoặc khác `structured_v1`, cố định từ lúc tạo) mới cần embedding. Xem trường này ở `GET /api/v1/projects/{id}`.
- `structured_v1` chỉ chia tập theo chương/số tập (`planning_mode: "chapters"`); thao tác Cognee báo `KnowledgePipelineUnsupported`.

## Quy ước API đã gặp

- Tên dự án chỉ gồm chữ, số, gạch dưới (không có `-`). Các route dùng **project id** (ULID), không dùng tên.
- Upload nguồn: `POST /api/v1/projects/{id}/ingest/upload` (multipart `file`, tùy chọn `spine_template`), rồi `POST .../ingest/start` với `{"filename":..., "spine_template":"narrated"|"drama"}`.
- Đổi `spine_template` của dự án đã tồn tại bắt buộc `"rebuild": true`, nếu không báo "项目类型只能在重新导入时修改".
- Trạng thái: `GET .../tasks`, `GET .../pipeline/status` (bước kế tiếp: `build_characters`).

## Dự án Tesla

- `tesla_pov_short`, id `01M4QF11AY84RDH1B0FMW62W86`, kịch bản nguồn `examples/tesla-pov-short-60s.md`, mẫu `narrated`, đã ingest xong (`structured_v1`, 1 chunk).
- Bản tải lên hiện gồm cả bảng ghi chú kiểm chứng; nên tải bản chỉ có lời dẫn nếu muốn trích xuất sạch.

## Đừng làm

- Đừng tìm hay in `settings.db` / token chạy của DramaClaw (hệ thống chặn thao tác dò thông tin xác thực).
