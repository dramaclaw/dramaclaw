# Chặng 4 — Deliver

## Ghép tập phim (`compose_episode`)
`POST /projects/{p}/episodes/{n}/videos/compose` đưa task vào hàng đợi `ffmpeg`
(runner `run_compose_episode` trong `runners/video.py`, cần FFmpeg).
- Lấy `videos/beats/epNNN/beat_NN.mp4` và `audio/epNNN/beat_NN.mp3`. Beat không có video bị bỏ qua.
- Mỗi beat được mã hóa lại (libx264 + aac). Âm thanh lấy từ mp3 của beat, nếu không có thì
  từ track âm thanh của clip, nếu không có nữa thì thêm im lặng.
- Beat nào lỗi ffmpeg bị bỏ qua; chỉ thất bại khi không còn clip nào.
- Các clip được scale/pad về độ phân giải đích (mặc định `720x1280`) rồi nối cứng bằng `concat`.
  **Không có transition.**
- Kết quả: `videos/episodes/epNNN_final.mp4`.
- Các tham số `add_subtitles` và `add_bgm` được API nhận nhưng **không có tác dụng** lên video:
  không đốt phụ đề, không trộn nhạc nền.

## Phụ đề (SRT)
`GET .../export/srt` tạo SRT tại chỗ từ `narration_segment` của từng beat. Thời lượng mỗi cue là
độ dài mp3 của beat (mặc định 5 giây nếu thiếu file); beat không có lời dẫn bị bỏ qua và không cộng giờ.
Vì compose dùng độ dài clip và có cả beat im lặng, SRT có thể lệch so với video.

## Xuất và tải
- `GET .../export/video`: tải `epNNN_final.mp4`.
- `POST .../export/zip`: gói tạm gồm video/âm thanh từng beat, video cuối, `frames/`, `grids/` và SRT.
- `GET .../episodes/{n}/final`: cho biết video cuối đã tồn tại chưa.

## Hoàn tất
`done` nghĩa là `epNNN_final.mp4` tồn tại. Không kiểm tra độ dài, đồng bộ âm thanh, phụ đề, và không
phát hiện file cũ sau khi các beat được sinh lại. Hiện không có bước verification nào cho video thành phẩm.
