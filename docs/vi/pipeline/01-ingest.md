# Chặng 1 — Ingest

Biến nguyên liệu thô (tiểu thuyết hoặc kịch bản) thành dữ liệu có cấu trúc, và
chuẩn bị thư viện asset ban đầu cho dự án.

## Đầu vào
- Bản thảo tiểu thuyết hoặc kịch bản (hỗ trợ cả Fountain).
- Cấu hình dự án: phong cách kể chuyện, nhóm sắc tộc nhân vật, Visual Style.

## Các bước
1. **Nạp nguồn (`ingest_fast`)**: dựng cấu trúc truyện trực tiếp từ bản thảo, không cần
   knowledge graph hay embedding. Đường Cognee (story graph) chỉ còn cho dự án cũ.
2. **Cấu hình dự án (`configure`)**: thiết lập các tham số ảnh hưởng đến mọi bước sau.
   Có thể tải ảnh tham chiếu để trích tham số Visual Style và áp cho toàn dự án.
3. **Trích xuất nhân vật (`build_characters`)**: tạo danh sách nhân vật. Runner cùng
   nhóm còn có `build_scenes` và `build_props` cho cảnh và đạo cụ
   (`task_backend/runners/graph_build.py`).

## Đầu ra
- Dữ liệu truyện có cấu trúc trong SQLite của dự án.
- Danh mục nhân vật, cảnh, đạo cụ trong thư viện asset.

## Lưu ý
- Các bước sau kiểm tra điều kiện tiên quyết (ví dụ danh mục nhân vật phải xây xong
  mới lập được identity), nên thứ tự chặng này quan trọng.
- Mã liên quan: `task_backend/runners/ingest.py`, `graph_build.py`, `novel_source.py`,
  `structured_ingest.py`.
