# Điều khiển pipeline qua MCP

DramaClaw có sẵn một MCP server để agent (Claude Code, Codex...) chạy pipeline từ ngoài.
Hướng dẫn cài đặt đầy đủ: [mcp-claude-code.md](../../en/guides/mcp-claude-code.md).
Tài liệu này chỉ nói tool nào tương ứng với bước nào của pipeline.

## Cách hoạt động
- Server: `src/novelvideo/chat/dramaclaw_mcp.py`, kênh stdio. Mỗi tool là một lời gọi HTTP tới
  REST API của instance đang chạy (mặc định `http://localhost:8780`), nên dùng chung auth,
  kiểm tra dự án và hàng đợi task với giao diện web.
- Danh sách tool được nạp từ plugin `.hermes/plugins/dramaclaw` (có plugin `freezone` riêng cho canvas),
  không khai báo trực tiếp trong file server.
- **Phạm vi tool phụ thuộc `DRAMACLAW_PROJECT_ID`**: không đặt thì chỉ có 4 tool chung
  (`dramaclaw_get`, `dramaclaw_post`, `dramaclaw_patch`, `dramaclaw_delete`); đặt rồi mới có đủ tool theo bước.
- Repo có sẵn `.mcp.json` (lệnh `uv run python -m novelvideo.chat.dramaclaw_mcp`,
  `DRAMACLAW_CE_OWNER=1`). CE chỉ chấp nhận địa chỉ loopback; EE dùng `DRAMACLAW_AGENT_TOKEN`.
- Các tác vụ sinh nội dung chạy **bất đồng bộ**: tool chỉ khởi động task, agent phải theo dõi
  bằng `dramaclaw_pipeline_status`, `dramaclaw_list_tasks`, `dramaclaw_get_task`.

## Tool theo chặng
Việc ghép tool với bước dựa vào tên tool trong plugin và hướng dẫn gốc, chưa kiểm chứng từng tool.

| Chặng | Bước | Tool |
|---|---|---|
| Ingest | nạp nguồn | `dramaclaw_list_ingest_uploads`, và `dramaclaw_post` tới `/ingest/upload`, `/ingest/start` |
| Ingest | nhân vật | `dramaclaw_build_characters` |
| Plan | phân tập | `dramaclaw_plan_episodes` |
| Plan | identity | `dramaclaw_plan_identities`, `dramaclaw_generate_portrait`, `dramaclaw_generate_identity_image`, `dramaclaw_update_character_face_prompt` |
| Plan | cảnh/đạo cụ | `dramaclaw_plan_scenes`, `dramaclaw_plan_props`, `dramaclaw_generate_scene_master`, `dramaclaw_generate_scene_reverse` |
| Plan | kịch bản | `dramaclaw_generate_script`, `dramaclaw_get_episode_script` |
| Produce | sketch | `dramaclaw_generate_sketches`, `dramaclaw_get_sketches`, `dramaclaw_get_sketch_candidates` |
| Produce | nhận diện identity | `dramaclaw_detect_sketch_identities` |
| Produce | tối ưu video | `dramaclaw_optimize_video_global` |
| Produce | first frame | `dramaclaw_render_first_frames`, `dramaclaw_get_first_frames` |
| Produce | giọng | `dramaclaw_prepare_system_voices`, `dramaclaw_generate_audio` |
| Produce | video | `dramaclaw_start_single_video`, `dramaclaw_start_video_batch` |
| Deliver | ghép và lấy kết quả | `dramaclaw_compose_episode`, `dramaclaw_get_final_video` |
| Xuyên suốt | trạng thái, task | `dramaclaw_pipeline_status`, `dramaclaw_list_tasks`, `dramaclaw_get_task`, `dramaclaw_control_episode_auto` |
| Xuyên suốt | đọc media | `dramaclaw_get_character_media`, `dramaclaw_get_episode_media`, `dramaclaw_get_scene_images` |
| Canvas | freezone | `dramaclaw_list_freezone_canvases`, `dramaclaw_get_freezone_canvas`, `dramaclaw_save_freezone_canvas`, `dramaclaw_run_freezone_skill`... |

Bước không có tool riêng, ví dụ cấu hình dự án (`PATCH /projects/{p}`) hoặc gán màu sketch
(`assign-colors`), đi qua tool chung `dramaclaw_patch` / `dramaclaw_post`. `dramaclaw_control_episode_auto`
liên quan tới chế độ tự động `chat/director_auto.py`; mình chưa đọc chi tiết tham số của nó.

## Lưu ý an toàn
CE-owner mode cấp quyền chủ sở hữu đầy đủ cho instance mà nó trỏ tới, chỉ dùng với CE cục bộ của bạn.
