# Chặng 2 — Plan

Biến dữ liệu truyện đã cấu trúc thành kế hoạch sản xuất: tập nào chứa gì, kịch bản
từng tập, và nhân vật xuất hiện với ngoại hình nào.

## Các bước
1. **Phân tập (`build_episodes`)**: chia chương, lập beat, dựng mạch truyện nhiều tập.
2. **Chân dung nhân vật (`portraits`)**: sinh ảnh chân dung gốc cho từng nhân vật.
3. **Kế hoạch identity (`identity_plan`)**: quyết định từng tập mỗi nhân vật có những
   biến thể nào (trang phục, ngoại hình). Cần danh mục nhân vật đã xây xong
   (`run_identity_planner`).
4. **Ảnh identity (`identity_images`)**: sinh ảnh cho các biến thể trên
   (`run_character_image`). Đây là nền để giữ nhân vật nhất quán giữa các tập.
5. **Asset theo tập**: lập kế hoạch cảnh và đạo cụ cho từng tập
   (`run_episode_asset_planner`), tạo ảnh tham chiếu cho cảnh và đạo cụ.
6. **Viết kịch bản (`script_writer`)**: tạo kịch bản từng tập theo một trong ba chế độ
   `adaptive`, `literal`, `staged`, kèm vòng review rồi sửa lại.

## Đầu ra
- Danh sách tập, beat của từng tập, kịch bản.
- Bộ ảnh chân dung và identity, ảnh tham chiếu cảnh/đạo cụ.

## Lưu ý
- Mã liên quan: `workflows/script_writing.py`, `workflows/literal_script_writing.py`,
  `task_backend/runners/script.py`, `identity.py`, `character_image.py`,
  `episode_assets.py`, `scene_reference.py`, `prop_reference.py`.
- Thứ tự giữa kịch bản và các bước identity do Task Center kiểm tra qua điều kiện
  tiên quyết, không cố định cứng trong tài liệu này.
