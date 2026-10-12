# Chặng 3 — Produce

Chặng nặng nhất: biến kịch bản và identity thành hình ảnh, giọng đọc và video cho
từng shot (mỗi shot ứng với một beat).

## Các bước
1. **Storyboard (`sketch_generation`)**: sinh ảnh phác thảo theo từng beat; dùng grid,
   tách ô (`grid_splitter`), rồi chọn ảnh từ image pool.
2. **Tô màu và kiểm tra (`coloring`)**: lên màu theo Visual Style, phát hiện nhân vật
   và đạo cụ để đối chiếu identity (`render_identity_guard`).
3. **Tối ưu toàn tập (`global_optimize_video`)**: chỉnh prompt video cho cả tập để
   các shot liền mạch. Runner `run_beat_video_prompt` tạo prompt video cho từng beat.
4. **First frame (`selected_regen`)**: tạo khung hình đầu cho từng shot. Có thể
   regen chọn lọc các shot chưa ưng, hoặc regen cả grid.
5. **Chuẩn bị giọng (`voice_setup`)**: gán giọng cho từng nhân vật và người dẫn
   (`run_system_voice_setup`).
6. **TTS (`tts`)**: tổng hợp giọng có cảm xúc cho thoại và lời dẫn theo từng beat
   (`run_indextts2_audio`).
7. **Sinh video (`single_video`)**: image-to-video từng shot từ first frame và prompt
   (có Seedance2 và các provider khác). Độ dài và chi phí video được tính riêng.

## Đầu ra
- Ảnh phác thảo, ảnh màu, first frame theo beat.
- File âm thanh theo beat (`audio/epNNN/`).
- Clip video theo shot.

## Lưu ý
- Mã liên quan: `task_backend/runners/sketch.py`, `render.py`, `audio.py`, `video.py`,
  `generators/`, `seedance2_i2v/`, `audio/`.
- Sinh video là bước tốn model call và chi phí nhất; nên xác nhận first frame và giọng
  trước khi chạy hàng loạt.
