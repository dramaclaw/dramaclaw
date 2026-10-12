# Tóm tắt pipeline sản xuất video (Series / XiaJi)

DramaClaw biến tiểu thuyết hoặc kịch bản thành tập phim hoàn chỉnh qua 4 chặng:
**Ingest → Plan → Produce → Deliver**. Mỗi bước là một task async độc lập có
interface riêng, nên có thể chạy tuần tự, bỏ qua bước, hoặc resume từ checkpoint.
Task Center kiểm tra điều kiện tiên quyết trước khi xếp job vào hàng đợi.

```
Ingest ──► Plan ──► Produce ──► Deliver
nạp & cấu   phân tập,   storyboard,   ghép tập,
hình, trích  kịch bản,   first frame,  phụ đề,
xuất asset   identity    giọng, video  xuất gói
```

## Các chặng

| # | Chặng | Mục tiêu | Chi tiết |
|---|---|---|---|
| 1 | Ingest | Nạp nguyên liệu, cấu hình dự án, trích xuất nhân vật/cảnh/đạo cụ | [01-ingest.md](01-ingest.md) |
| 2 | Plan | Phân tập, viết kịch bản, lập identity nhân vật | [02-plan.md](02-plan.md) |
| 3 | Produce | Tạo hình ảnh, giọng đọc và video từng shot | [03-produce.md](03-produce.md) |
| 4 | Deliver | Ghép tập phim và xuất thành phẩm | [04-deliver.md](04-deliver.md) |

## Các bước chi tiết theo thứ tự

Danh sách bước lấy từ `_STEP_MAP` trong `src/novelvideo/api/routes/pipeline.py`
(endpoint tổng hợp trạng thái pipeline).

| Bước | Task | Chặng |
|---|---|---|
| `ingest` | `ingest_fast` | Ingest |
| `configure` | (cấu hình, không có task) | Ingest |
| `characters` | `build_characters` | Ingest |
| `episodes` | `build_episodes` | Plan |
| `portraits` | (ảnh chân dung) | Plan |
| `identity_plan` | (kế hoạch identity) | Plan |
| `identity_images` | (ảnh identity) | Plan |
| `script` | `script_writer` | Plan |
| `sketches` | `sketch_generation` | Produce |
| `coloring` | (tô màu, phát hiện identity/đạo cụ) | Produce |
| `global_optimize` | `global_optimize_video` | Produce |
| `first_frames` | `selected_regen` | Produce |
| `voice_setup` | (chuẩn bị giọng) | Produce |
| `tts` | (TTS lồng tiếng) | Produce |
| `video` | `single_video` | Produce |
| `compose` | `compose_episode` | Deliver |
| `done` | (hoàn tất) | Deliver |

Việc gán các bước vào 4 chặng là cách nhóm của tài liệu này, không phải khái niệm
cứng trong code.

## Thành phần xuyên suốt

- **Model gateway**: mọi LLM, ảnh, video, audio đi qua một gateway tương thích OpenAI
  (official key hoặc gateway đi kèm).
- **Task backend (CE)**: chạy in-process bằng thread nền, có tiến độ, hủy, retry, resume.
  Không cần Redis hay Celery. Các runner nằm ở `src/novelvideo/task_backend/runners/`.
- **Lưu trữ**: SQLite theo dự án ở `state/<user>/<project>/data.db`, thành phẩm ở
  `output/<user>/<project>/`.
- **Verification**: các cổng kiểm tra chất lượng (ví dụ guard giữ identity nhất quán khi render).
- **Xia Director**: agent tích hợp, trả lời về dự án, đẩy các bước pipeline, đề xuất bước tiếp.
- **Canvas (freezone)**: nhánh khám phá tự do bằng node graph, đi song song với pipeline
  và dùng chung thư viện asset.

## Tham khảo

- [Kiến trúc (EN)](../../en/concepts/architecture.md)
- [README gốc](../../../README.md)
