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
- Gemini: server `http://localhost:6969` (container `web_ai_server`, OpenAI-compatible, điều khiển trình duyệt qua playwright). Container docker gọi nó bằng `http://host.docker.internal:6969`. Kênh `DC-custom` (type 1), key giữ chỗ `sk-local-webai`. Danh sách model của 6969: `gemini-auto`, `playwright/gemini/gemini-3.1-pro`, `.../gemini-3.5-flash`, `.../gemini-3.1-flash-lite`.
- **Model text đã chuyển gần hết sang DeepSeek** (channel `DC-deepseek`, type 43, model `deepseek-chat`, key `DEEPSEEK_API_KEY`); **3 alias cần vision đã chuyển sang Qwen** (channel `DC-qwen-vision`, type 1, base_url `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, model `qwen3.8-omni-flash`, key `QWEN_API_KEY`) — `DC-video-identity-detector-LLM`, `DC-video-prompt-optimizer-LLM`, `DC-freezone-vision-LLM`. Chi tiết đầy đủ + lý do: `docs/adr/0002-identity-planner-and-text-models-deepseek.md`. `gemini-auto`/`DC-custom` giờ chỉ còn ảnh (`gemini6969`/`LingShan-*`, xem ADR 0001) + 3 alias gốc của identity_planner không còn ai dùng (orphan, vô hại).
- **Qwen qua DashScope không dùng `tool_choice: required`** (model chạy "thinking mode", trả 400 nếu ép) — chỉ dùng cho task không cần forced tool-calling (3 alias vision ở trên dùng `output_type=str` hoặc `NativeOutput`, không gửi `tool_choice`). Đừng route task kiểu identity_planner sang Qwen.
- **Bẫy khi đổi model_mapping giữa 2 channel NewAPI**: sửa `model_mapping` của channel A để gỡ alias rồi thêm vào channel B — NewAPI route request thật (`/v1/chat/completions`) vẫn có thể bay vào channel A rỗng, trả 404 `openai_error` (bảng "abilities" nội bộ không tự đồng bộ theo `PUT /api/channel/`). Cách chắc ăn: xoá hẳn channel A (`delete_channel_by_name` trong `newapi_provisioner.py`), không chỉ sửa mapping về rỗng.
- Cập nhật ánh xạ: `POST /api/v1/model-gateway/custom/newapi/channels` (cùng tên kênh thì thành update).
- Embedding: kênh `DC-ollama` (type 4) trỏ `http://host.docker.internal:11434`, `DC-cognee-embedding` -> `bge-m3`, 1024 chiều, batch 10. Cần `ollama serve` đang chạy. Lưu preset key trước (`provider-channels`) rồi mới gọi `embedding-model`, nếu không báo `upstreamKey is required`.
- Ảnh (character portrait): channel `DC-custom` có thêm mapping `gemini6969` -> `gemini-auto`. **Không dùng chuẩn OpenAI Images API** vì `web_ai_server`/6969 không có `/images/generations`, chỉ có `/chat/completions` trả ảnh qua `artifacts[].url` (URL bị khoá session Google). Đã thêm provider riêng `gemini_webai` (dev-only, tách khỏi model production `LingShan-NB-2`/`LingShan-G2`) đọc artifact này và tải bằng cookie Playwright `~/WebAI-to-API/runtime/auth/gemini.json` (biến `.env`: `GEMINI_WEBAI_COOKIE_FILE_HOST`, mount vào container qua `docker-compose.release.yml`). Chi tiết đầy đủ + lý do: `docs/adr/0001-local-gemini-webai-image-provider.md`. Chưa có kênh video, giọng đọc.
- Claude/Anthropic không có model embedding, đừng dùng cho `DC-cognee-embedding`.
- Container `api` chạy image local đã build sẵn (`dramaclaw-local/api`), **không** `docker compose build`/`up --build` lại — Dockerfile pin `CODEX_RUNTIME_IMAGE` qua digest hiện không resolve được trên máy này (`no match for platform in manifest`), build full sẽ fail. Sửa code Python rồi muốn áp dụng ngay: `docker cp` file đã sửa vào `/app/src/novelvideo/...` trong container rồi `docker restart dramaclaw-api-1` (giữ filesystem container, không dùng `docker compose up -d` vì sẽ recreate từ image gốc và mất bản vá). Khi nào build lại được thì đổi cách này.
- Ảnh gốc `dramaclaw-local/api` cũ hơn `src/novelvideo/` hiện tại khá nhiều — không chỉ thiếu 3 file ADR 0001 nói ở trên, còn thiếu cả module (`novelvideo.brainclaw_contract`, `shared/runtime_env.uses_local_ce_runtime`...). Nếu bắt buộc phải `docker compose up -d` (ví dụ để nạp biến môi trường `.env` mới, vì `env_file` chỉ đọc lúc tạo container, `docker restart` không nạp lại): trước tiên `docker cp` toàn bộ `src/novelvideo` (không phải vài file) từ working tree vào container sau khi recreate, rồi `docker restart`. Đã làm vậy để sửa identity_planner ngày 2026-10-12; không dùng cách vá từng file một, sẽ bắt lỗi `ImportError`/`ModuleNotFoundError` lặp nhiều lần.
- `IDENTITY_PLANNER_CAST_MODEL`/`_ANALYSIS_MODEL`/`_APPEARANCE_MODEL` trong `.env` trỏ sang alias `DC-deepseek-identity-LLM`. 19 alias text khác (build_characters, script, scene/prop planner...) **không cần sửa `.env`** — map thẳng trong channel `DC-deepseek` qua tên alias gốc, NewAPI tự gỡ khỏi `DC-custom` (xem `upsert_channel`/`remove_model_keys_from_other_dc_channels` trong `newapi_provisioner.py`). Lý do + danh sách đầy đủ: ADR 0002 nói ở trên. Muốn đổi lại Gemini/Ollama cho identity_planner thì sửa 3 dòng `IDENTITY_PLANNER_*` trong `.env` rồi `docker compose up -d` (nhớ sync lại `src/novelvideo` như trên); muốn đổi lại 19 alias khác thì gọi lại `POST /custom/newapi/channels` map chúng về `gemini-auto` trên channel `DC-custom`.
- Toàn bộ ảnh sinh ra (chân dung, ảnh identity, sketch, render first-frame) default sang `gemini_webai`/`gemini6969`: `.env` có `DEFAULT_CHARACTER_IMAGE_SELECTION`/`DEFAULT_SKETCH_IMAGE_SELECTION`/`DEFAULT_RENDER_IMAGE_SELECTION=gemini_webai`. Trước đó chỉ chân dung/ảnh identity (`nanobanana_character.py`) có nhánh `gemini_webai`; đã thêm nhánh tương tự vào `generate_grid()` trong `generators/nanobanana_grid.py` (dùng chung cho sketch + render qua `regenerate_selected_beats`) để sketch/render cũng gọi được. `_render_single_panel_gemini`/`generate_batch_api` (Google Batch API, bắt buộc provider=="google") là code path khác, không ai gọi/không áp dụng ở đây.
- **Bẫy `gemini_webai` + ref ảnh JPEG: `web_ai_server` (6969) validate đuôi file khớp MIME, trả 400 `File extension '.png' is not allowed for MIME type 'image/jpeg'`** nếu ảnh tham chiếu là JPEG mà filename gửi lên vẫn hardcode `.png`. Gặp ở sketch/render (`NanoBananaGridGenerator` trong `generators/nanobanana_grid.py`, 2 nhánh `elif self.provider == "gemini_webai":` build `reference_images`) — đã vá (2026-10-13) bằng helper `_webai_ref_filename(index, mime)` dùng `mimetypes.guess_extension` thay vì hardcode `ref_{i}.png`. Các nhánh `gemini_webai` khác (character, scene, scene_360, prop) không dính bug này vì đã lấy filename/mime nhất quán từ file thật trên đĩa.
- **Cảnh báo per-project override**: ảnh nhân vật (không phải sketch/render) có cơ chế lưu riêng — lần đầu UI mở panel chọn model ảnh, giá trị được ghi cứng vào `character_image_selection` trong `project_config.json` của project đó (`/data/state/{user}/{project}/project_config.json`), **ghi đè vĩnh viễn** default `.env` cho riêng project này. Đổi `.env` không ảnh hưởng project đã có key này; phải tự xoá key `character_image_selection` khỏi file đó (không dùng được API PATCH chính thức để set `gemini_webai` vì nó validate theo danh sách hiển thị `newapi_gpt_image2`/`newapi_nanobanana2`, sẽ báo "Invalid character_image_selection"). Đã làm vậy cho `tesla_pov_short`.

## Embedding có cần không?

- Dự án mới tạo qua API luôn là `knowledge_pipeline: "structured_v1"` (`src/novelvideo/api/routes/projects.py:765`): không embedding, không đồ thị, không vector index. Ingest chỉ lưu nguồn và chia chunk.
- Chỉ dự án `cognee_legacy` (trường `knowledge_pipeline` vắng hoặc khác `structured_v1`, cố định từ lúc tạo) mới cần embedding. Xem trường này ở `GET /api/v1/projects/{id}`.
- `structured_v1` chỉ chia tập theo chương/số tập (`planning_mode: "chapters"`); thao tác Cognee báo `KnowledgePipelineUnsupported`.

## Tài liệu channel/model theo từng bước pipeline

`docs/vi/pipeline/index.html` có tab **Model & Channel** (bên cạnh tab Pipeline gốc): bảng 4 channel NewAPI đang chạy (đối chiếu `list_channels()` live), và mỗi bước pipeline dùng key `.env` nào → alias nào → channel/model thật nào, kèm chế độ output (Tool/forced tool-call, NativeOutput, str) và có cần vision hay không. Đối chiếu lúc 2026-10-13; sửa channel/alias/`.env` theo các bullet ở trên thì nhớ cập nhật lại tab này.

## Quy ước API đã gặp

- Tên dự án chỉ gồm chữ, số, gạch dưới (không có `-`). Các route dùng **project id** (ULID), không dùng tên.
- Upload nguồn: `POST /api/v1/projects/{id}/ingest/upload` (multipart `file`, tùy chọn `spine_template`), rồi `POST .../ingest/start` với `{"filename":..., "spine_template":"narrated"|"drama"}`.
- Đổi `spine_template` của dự án đã tồn tại bắt buộc `"rebuild": true`, nếu không báo "项目类型只能在重新导入时修改".
- Trạng thái: `GET .../tasks`, `GET .../pipeline/status` (bước kế tiếp: `build_characters`).

## Dự án Tesla

- `tesla_pov_short`, id `01M4QF11AY84RDH1B0FMW62W86`, kịch bản nguồn `examples/tesla-pov-short-60s.md`, mẫu `narrated`, đã ingest xong (`structured_v1`, 1 chunk).
- Bản tải lên hiện gồm cả bảng ghi chú kiểm chứng; nên tải bản chỉ có lời dẫn nếu muốn trích xuất sạch.
- `identity_plan` đã chạy xong cho tập 1 (qua DeepSeek, xem bullet `DC-deepseek-identity-LLM` ở trên): 5 identity cho Nikola Tesla (`青年时期` mặc định + 4 identity theo từng thời kỳ 1876–77 Graz/1882 Budapest/1884 New York/1893 Chicago), cả 5 đều có `appearance_details` và đã sinh ảnh identity xong qua `gemini_webai`. Bước kế tiếp theo pipeline doc: `scene_prop`/`script`.

## Đừng làm

- Đừng tìm hay in `settings.db` / token chạy của DramaClaw (hệ thống chặn thao tác dò thông tin xác thực).
