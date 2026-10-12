# Chặng 1 — Ingest

Nạp nguồn, cấu hình dự án, rồi trích nhân vật và cảnh. Với `structured_v1`, nạp nguồn
**không gọi LLM**. Việc trích xuất nằm ở các bước build riêng.

## 1. Nạp nguồn (`ingest_fast`)
- `POST /projects/{p}/ingest/upload`: kiểm tra và lưu file vào `uploads/`, giới hạn số ký tự
  và dung lượng, dựng bản xem trước chương và kiểm tra định dạng.
- `POST /projects/{p}/ingest/start`: ghi `ingest_source_filename` (và tùy chọn `spine_template`,
  `aspect_ratio`) vào `project_config.json`, rồi đưa task `ingest_fast` vào hàng đợi.
  - Template `drama` yêu cầu có tiêu đề cảnh; thiếu thì trả lỗi `screenplay_format`.
  - `spine_template` chỉ đổi được khi `rebuild`.
- Runner (`task_backend/runners/ingest.py` → `structured_ingest.py`): đọc văn bản, kiểm tra rỗng,
  chia chunk theo template (`chunk_source_text`), tạo hoặc tái dùng một analysis run
  (khóa theo hash nguồn, phiên bản schema, phiên bản pipeline, template).
- `novel.txt` được ghi **cuối cùng** và đóng vai trò dấu "đã nạp xong" cho các bước sau.

## 2. Cấu hình dự án (`configure`)
Không phải task mà là `PATCH /projects/{p}`, lưu vào `state/.../project_config.json`.
- Khóa chính: `spine_template` (`drama` hoặc `narrated`), `aspect_ratio` (mặc định 2:3,
  16:9 cho narrated), `visual_style`, `narration_style` (`first_person`/`third_person`;
  chỉ có tác dụng với dự án narrated), `ethnicity`, `rhythm`, cấu hình TTS, `grid_mode`, `grid_model`.
- `spine_template` bị khóa sau khi đã có `novel.txt`; chỉ đổi được bằng cách nạp lại.
- `visual_style` là id của một style có sẵn hoặc style tùy chỉnh của dự án; id sai sẽ bị
  bỏ qua và dùng mặc định.
- Style từ ảnh tham chiếu là bước tùy chọn: `POST /styles/analyze` (đồng bộ, dùng LLM thị giác,
  tính phí) chỉ trả gợi ý, không lưu. Client lưu bằng `POST /styles` thành style tùy chỉnh,
  sau đó mới chọn làm `visual_style`.

## 3. Trích nhân vật (`build_characters`)
`POST /projects/{p}/characters/build`, cần `novel.txt`. Luồng trong `structured_builders.py`
và `structured_extraction.py`:
1. Chia chunk, dùng lại kết quả chunk đã xong nếu nguồn không đổi.
2. Trích nhân vật bằng LLM, có kiểm chứng bằng bằng chứng trong văn bản.
3. Gộp bí danh, chức danh, cách xưng hô, rồi phân xử trùng lặp.
4. Bổ sung ngoại hình, face prompt, nhóm tuổi, giọng và đề cử người dẫn chuyện.
5. Ghi vào bảng nhân vật, **không ghi đè** nhân vật đã có (chỉ điền ô ngoại hình còn trống).

## 4. Cảnh và đạo cụ
- `build_scenes`: với template `drama`, trích cảnh từ tiêu đề cảnh rồi chuẩn hóa địa điểm;
  chỉ thêm cảnh còn thiếu, không sửa prompt do người dùng chỉnh. Với template khác trả về
  `episode_on_demand`, tức là cảnh được tìm lúc lập kế hoạch từng tập.
  Dự án narrated không áp dụng bước này.
- `build_props`: với `structured_v1` là no-op (`episode_on_demand`). Đạo cụ được tạo theo từng tập
  ở chặng Plan.

## Đầu ra
`novel.txt`, `uploads/`, dữ liệu analysis run và chunk, bảng nhân vật và cảnh trong `data.db`,
và `project_config.json`.
