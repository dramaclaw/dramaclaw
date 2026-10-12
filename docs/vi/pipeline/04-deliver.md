# Chặng 4 — Deliver

Ghép các thành phần đã sản xuất thành tập phim hoàn chỉnh và xuất gói thành phẩm.

## Các bước
1. **Compose tập phim (`compose_episode`)**: ghép các clip video, âm thanh và phụ đề
   của tập thành video cuối (`run_compose_episode`, cần FFmpeg; xem
   [hướng dẫn FFmpeg](../../en/guides/ffmpeg.md)).
2. **Phụ đề**: sinh file SRT từ lời dẫn của từng beat, căn thời gian theo độ dài
   file âm thanh (`export/episode_export.py`).
3. **Xuất gói**: xuất video kèm phụ đề và gói asset đầy đủ của tập.

## Đầu ra
- Video tập phim hoàn chỉnh trong `output/<user>/<project>/`.
- File phụ đề và gói asset.

## Lưu ý
- Compose chỉ có ý nghĩa khi các shot của tập đã có video và âm thanh. Endpoint trạng
  thái pipeline kiểm tra các file `beat_XX` tồn tại trước khi coi bước là hoàn tất.
- Mã liên quan: `task_backend/runners/video.py` (phần compose), `export/`.
