# Chặng 3 — Produce

Từ kịch bản thành hình, tiếng và video cho từng beat. Thứ tự thực tế trong code:
**gán màu → sketch → nhận diện identity → tối ưu video → first frame → giọng → video**.

## 1. Gán màu sketch (`assign-colors`)
Gọi đồng bộ, không qua hàng đợi (`generation.py`). Gán màu cho từng nhân vật và đánh dấu màu cho đạo cụ.
Phải làm **trước** khi sinh sketch, nếu chưa có màu thì `sketches/generate` báo lỗi.

## 2. Sketch (`sketch_generation`)
`POST /episodes/{ep}/sketches/generate` → `runners/sketch.py`.
- Chia beat thành các grid (có thể gộp theo cảnh), sinh ảnh grid phác thảo bằng NanoBanana
  (một số chế độ chạy hai lượt), tách ô, đưa vào image pool, rồi chọn ra `sketches/epNNN/beat_XX.png`.
- Nhận cả tham chiếu director (3GS) tùy chọn, khi đó bắt buộc dùng provider OpenAI.
- Sinh lại sketch dùng task `sketch_regen`.

## 3. Nhận diện identity và đạo cụ (`detect-identities`)
Gọi đồng bộ, tính phí. Ghép sketch thành grid tạm theo lô 25, nhờ LLM thị giác khớp theo màu
rồi lưu `detected_identities` và `detected_props` vào DB. Có thể gán thủ công.
Đây là điều kiện để bước first frame chạy được (`render_identity_guard`).

## 4. Tối ưu video toàn tập (`global_optimize_video`)
Chạy trên sketch (chưa cần first frame). Với từng beat theo thứ tự, optimizer đọc ảnh sketch,
các beat lân cận và prompt trước đó, rồi ghi `video_prompt`, đặt `video_mode="first_frame"` và
xóa `keyframe_prompt`. Không sinh file mới ngoài grid ghép.

## 5. First frame (`selected_regen`)
`POST /render/execute` hoặc `/beats/regenerate` → `runners/render.py`.
- Kiểm tra đã nhận diện identity, đảm bảo có ảnh tham chiếu cảnh.
- Sinh ảnh render theo grid bằng provider ảnh cấu hình cho render, dùng sketch làm hướng dẫn,
  tách ô và đưa vào image pool.
- Kết quả: `frames/epNNN/beat_XX.png` (grid ở `grids/epNNN/render/`).
- `grid_regenerate` sinh lại cả grid.

## 6. Giọng (`voice_setup`, `tts`)
- `voice_setup` (`system_voice_setup`): chỉ điền các giọng tham chiếu còn thiếu bằng giọng hệ thống
  Edge-TTS (giọng người dẫn ở `assets/narrator/voice.mp3`, giọng nhân vật lưu trên bản ghi nhân vật).
- `tts` (`audio_generation_indextts2`): với beat narration hoặc dialogue có chữ, clone giọng tham chiếu
  qua IndexTTS2 (fal). Các chế độ `missing_only`, `sync_changed` (mặc định), `redo_selected`, `redo_all`;
  "còn mới" được xác định bằng SHA256 của văn bản và giọng. Kết quả: `audio/epNNN/beat_XX.mp3`.
  Thiếu giọng của người nói thì kế hoạch báo lỗi.

## 7. Video (`single_video`, `video_generation`)
`POST /beats/{n}/video` → `runners/video.py`. Cần first frame tồn tại và có prompt.
- Chế độ chính là image-to-video từ first frame. Ngoài ra có `keyframe` (khung đầu và khung cuối,
  khung cuối là first frame của beat kế). Seedance 2 còn có `text_to_video` và `multimodal_reference`.
- Với Seedance 2 (model `seedance-2.0*`), prompt lấy từ `seedance2_config.final_prompt` do người dùng soạn
  chứ không phải `video_prompt`, và gửi kèm ảnh/giọng tham chiếu.
- Độ dài lấy từ độ dài mp3 (nếu có) rồi giới hạn theo từng backend (ví dụ seedance_fast/pro 4-12 giây,
  seedance_2 5-15 giây). mp3 không được gửi cho Seedance 2 làm tham chiếu mà chỉ đặt mức sàn độ dài.
- Backend: các model qua gateway (`newapi_*`, `huimeng_*`), Seedance (Volcengine), ComfyUI, LTX 2.3, Grok.
- Kết quả: `videos/beats/epNNN/beat_XX.mp4` và bản ghi trong video pool.
- `video` không phụ thuộc cứng vào `tts` trong code; trạng thái pipeline xếp `tts` trước chỉ để hiển thị.

## Trạng thái "xong" theo pipeline
sketches: có file sketch/grid. coloring: mọi beat có kết quả nhận diện. global_optimize: mọi beat có
`video_mode` và `video_prompt`. first_frames: đủ `frames/epNNN/beat_XX.png`. tts: đủ mp3 cho beat cần tiếng.
video: đủ `beat_XX.mp4`.

## Chưa xác minh
`run_batch_render` (task `batch_render`) có trong `render.py` nhưng không thấy đăng ký runner;
coi như không dùng cho đến khi kiểm chứng.
