# Chặng 2 — Plan

Phân tập, lập identity cho nhân vật, lập kế hoạch cảnh/đạo cụ theo tập và viết kịch bản.
Lưu ý quan trọng: các điều kiện **bắt buộc** thật sự ít hơn thứ tự hiển thị trong trạng thái pipeline.

## Điều kiện tiên quyết thật sự (theo code)
| Bước | Bắt buộc |
|---|---|
| `build_episodes` | Đã nạp nguồn. Không cần nhân vật |
| Chân dung | Nhân vật có `face_prompt` |
| `identity_planner` | Có ít nhất 1 nhân vật, không có `build_characters` đang chạy, tập tồn tại |
| Ảnh identity | Identity đã được lập; có `appearance_details` hoặc ảnh costume; cùng nhóm tuổi thì cần chân dung gốc |
| Lập kế hoạch cảnh/đạo cụ theo tập | Chỉ cần tập tồn tại (đọc văn bản nguồn) |
| `script_writer` | Tập đã có `identity_ids` (cổng cứng) |

Chân dung và `identity_planner` độc lập nhau. Chân dung chỉ là cổng ở trạng thái pipeline và là
điều kiện của ảnh identity cùng nhóm tuổi.

## Các bước
1. **Phân tập (`build_episodes`)**: `planning_mode` là `chapters`, `ai` hoặc `ai_events`,
   mặc định `target_episodes=10`. Dự án `structured_v1` chỉ hỗ trợ `chapters`.
   Kết quả là các `NovelEpisode` trong SQLite.
2. **Chân dung**: task `character_portrait`, sinh `assets/characters/<tên>/portrait.png`
   từ `face_prompt` và `ethnicity`.
3. **Lập identity (`identity_planner`)**: chạy theo từng tập. Lọc dàn diễn viên của tập, xác định
   identity mặc định và identity theo tập, ghi `identity_ids` và `identity_default_map` lên tập,
   tạo identity trong `Character.identities`. Có thể tự động nâng cấp nhân vật.
4. **Ảnh identity**: task `identity_image`, sinh `assets/characters/<tên>/identities/<tên>.png`.
   Khác nhóm tuổi thì dùng identity portrait hoặc face prompt, không cần chân dung gốc.
5. **Cảnh và đạo cụ theo tập**: `episode_scene_planner`, `episode_prop_planner`. Phân tích văn bản
   nguồn của tập (`load_episode_planning_content`) thành `scene_menu`, `prop_menu`; đạo cụ được
   nâng thành đạo cụ toàn cục. Ảnh tham chiếu cảnh/đạo cụ là task riêng
   (`scene_reference_asset`, `prop_reference_asset`).
   Bước này không nằm trong trạng thái pipeline.
6. **Viết kịch bản (`script_writer`)**: chỉ có một chế độ viết theo từng dòng nguồn
   (`workflows/literal_script_writing.py`).
   - Tách văn bản thành dòng và khối cảnh.
   - Mỗi dòng gọi LLM một lần, giới hạn trong `identity_ids`, `scene_menu`, `prop_menu` của tập.
   - Lỗi cấu trúc: thử lại một lần, sau đó dùng beat dự phòng. Bị lọc nội dung thì thành beat im lặng.
   - Kết quả là các `VisualBeat` (số beat, `narration_segment`, `visual_description` có
     marker `{{identity_id}}` và `[[prop_id]]`, `scene_ref`, `audio_type` thuộc
     `silence|narration|dialogue`, người nói...), lưu vào bảng beats.
   - Sau đó dọn sketch cũ và gán màu sketch cho từng nhân vật.
   - Menu cảnh/đạo cụ rỗng vẫn chạy được, chỉ giảm chất lượng.
   - `beat_video_prompt` là task riêng, tạo `video_prompt` cho beat sau khi đã có kịch bản.

## Trạng thái "xong" theo pipeline
`identity_plan`: tập có `identity_ids`. `identity_images`: mọi identity của nhân vật chính trong tập
đều có file ảnh. `script`: có beat và mọi beat đều có nội dung.

## Đầu ra
Tập, identity, ảnh chân dung và identity, `scene_menu`/`prop_menu`, beats của kịch bản.
