"""图片池索引管理模块。

管理所有生成的图片（1x1, 3x3, 5x5 等），提供统一的索引和检索功能。
"""

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Union

from PIL import Image

from novelvideo.generators.grid_splitter import remove_grid_gaps
from novelvideo.utils.state_index_files import (
    ensure_state_index_from_legacy,
    index_file_lock,
    resolve_state_index_path,
    write_json_atomic,
)
from novelvideo.models import GridEntry, PoolImage, PoolIndex, beat_scene_id


import re

_POOL_INDEX_FILENAME = "pool_index.json"


def compute_beat_content_hash(
    beat: dict,
    sketch_colors: Optional[Dict[str, str]] = None,
) -> str:
    """计算影响草图生成的 beat 内容哈希。

    2.0 不再依赖 set_description，这里只纳入当前仍会影响草图的字段。
    """
    parts = [
        beat.get("visual_description", "") or "",
        beat_scene_id(beat),
        beat.get("time_of_day", "") or "",
    ]
    if sketch_colors:
        from novelvideo.models import extract_char_identities_from_markers

        try:
            char_ids = extract_char_identities_from_markers(
                beat.get("visual_description", "") or "",
                strict=False,
            )
            for identity_id in sorted(char_ids.values()):
                color = sketch_colors.get(identity_id)
                if color:
                    parts.append(f"color:{identity_id}={color}")
        except Exception:
            pass
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def is_pool_image_stale(
    img: PoolImage,
    beat_hashes: Dict[int, str],
    script_mt,
) -> bool:
    """统一 stale 判断：优先内容 hash，回退到 mtime。"""
    if img.type != "sketch":
        return False
    if img.beat_content_hash:
        current_hash = beat_hashes.get(img.original_beat)
        return current_hash is not None and current_hash != img.beat_content_hash
    return bool(script_mt and (not img.generated_at or img.generated_at < script_mt))


def build_beat_sketch_paths(
    episode_grids_dir: Union[str, Path],
    beat_numbers: List[int],
    sketches_dir: Union[str, Path] = None,
) -> Dict[int, str]:
    """从 sketches/ 目录构建 beat_num → 绝对路径映射。

    如果传入 sketches_dir，直接从该目录查找；
    否则从 episode_grids_dir 推算（向上一级 → sketches/epXXX/）。

    Returns:
        {4: "/abs/path/sketches/ep001/beat_04.png", ...}
        仅包含文件实际存在的 beat。
    """
    if sketches_dir:
        sd = Path(sketches_dir)
    else:
        # episode_grids_dir = output/grids/ep001 → output/sketches/ep001
        grids_dir = Path(episode_grids_dir)
        ep_name = grids_dir.name  # "ep001"
        sd = grids_dir.parent.parent / "sketches" / ep_name

    result = {}
    for bn in beat_numbers:
        p = sd / f"beat_{bn:02d}.png"
        if p.exists():
            result[bn] = str(p)
    return result


def build_pool_index(
    episode_grids_dir: Union[str, Path],
    episode: int,
) -> PoolIndex:
    """构建图片池索引。

    扫描 render/ 和 sketch/ 目录（flat，beat 中心命名），索引所有候选版本。

    Args:
        episode_grids_dir: 集数的 grids 目录路径（如 grids/ep001/）
        episode: 集数

    Returns:
        PoolIndex 对象
    """
    grids_dir = Path(episode_grids_dir)

    pool = PoolIndex(
        episode=episode,
        generated_at=datetime.now(),
        modes={},
        images=[],
    )

    # 扫描 render/ 目录
    render_items = sorted(
        scan_render_dir(grids_dir),
        key=lambda item: (
            item["beat_number"],
            item["timestamp"] or datetime.min,
            item["path"],
        ),
    )
    for item in render_items:
        bn = item["beat_number"]
        ts = item["timestamp"]
        ts_str = ts.strftime("%Y%m%d%H%M%S") if ts else ""
        pool_id = f"render_beat_{bn:02d}_t{ts_str}" if ts_str else f"render_beat_{bn:02d}"
        pool.images.append(
            PoolImage(
                id=pool_id,
                mode="render",
                grid_index=0,
                cell_index=0,
                grid_path="",
                cell_path=item["path"],
                row=0,
                col=0,
                original_beat=bn,
                generated_at=ts,
                type="render",
            )
        )
    if render_items:
        pool.modes["render"] = {"total_cells": len(render_items)}
        print(f"[PoolIndexer] 扫描到 {len(render_items)} 个 beat render 图")

    # 扫描 sketch/ 目录
    sketch_items = sorted(
        scan_sketch_dir(grids_dir),
        key=lambda item: (
            item["beat_number"],
            item["timestamp"] or datetime.min,
            item["path"],
        ),
    )
    for item in sketch_items:
        bn = item["beat_number"]
        ts = item["timestamp"]
        ts_str = ts.strftime("%Y%m%d%H%M%S") if ts else ""
        pool_id = f"sketch_beat_{bn:02d}_t{ts_str}" if ts_str else f"sketch_beat_{bn:02d}"
        pool.images.append(
            PoolImage(
                id=pool_id,
                mode="sketch",
                grid_index=0,
                cell_index=bn,
                grid_path="",
                cell_path=item["path"],
                row=0,
                col=0,
                original_beat=bn,
                generated_at=ts,
                type="sketch",
            )
        )
    if sketch_items:
        pool.modes["sketch"] = {"total_cells": len(sketch_items)}
        print(f"[PoolIndexer] 扫描到 {len(sketch_items)} 个 beat 草图")

    print(f"[PoolIndexer] 索引完成: episode={episode}, 共 {len(pool.images)} 张图片")
    return pool


def _pool_image_assignment_aliases(img: PoolImage) -> set[str]:
    aliases = {img.id}
    if img.cell_path:
        aliases.add(img.cell_path)

    ts_str = img.generated_at.strftime("%Y%m%d%H%M%S") if img.generated_at else ""
    beat = img.original_beat
    if ts_str:
        aliases.add(f"{img.type}_beat_{beat:02d}_t{ts_str}")
        aliases.add(f"beat_{beat:02d}_t{ts_str}_{img.type}")
    else:
        aliases.add(f"{img.type}_beat_{beat:02d}")
        aliases.add(f"beat_{beat:02d}_{img.type}")
    return aliases


def _preserve_rebuilt_assignments(
    old_pool: Optional[PoolIndex],
    new_pool: PoolIndex,
) -> None:
    if old_pool is None or not old_pool.beat_assignments:
        return

    alias_to_id: dict[str, str] = {}
    for img in new_pool.images:
        for alias in _pool_image_assignment_aliases(img):
            alias_to_id[alias] = img.id

    new_pool.beat_assignments = {
        beat: alias_to_id[pool_id]
        for beat, pool_id in old_pool.beat_assignments.items()
        if pool_id in alias_to_id
    }


def _pool_index_payload(pool: PoolIndex) -> dict:
    # 转换为可序列化的字典
    def serialize_image(img: PoolImage) -> dict:
        data = img.model_dump()
        # 将 datetime 转换为 ISO 格式字符串
        if data.get("generated_at"):
            data["generated_at"] = data["generated_at"].isoformat()
        return data

    def serialize_grid(g: GridEntry) -> dict:
        d = g.model_dump()
        if d.get("generated_at"):
            d["generated_at"] = d["generated_at"].isoformat()
        return d

    data = {
        "episode": pool.episode,
        "generated_at": pool.generated_at.isoformat(),
        "version": pool.version,
        "modes": pool.modes,
        "grids": [serialize_grid(g) for g in pool.grids],
        "images": [serialize_image(img) for img in pool.images],
        "beat_assignments": pool.beat_assignments,
    }
    return data


def _save_pool_index_unlocked(pool: PoolIndex, index_path: Path) -> Path:
    write_json_atomic(index_path, _pool_index_payload(pool))
    print(f"[PoolIndexer] 索引已保存: {index_path}")
    return index_path


def save_pool_index(
    pool: PoolIndex,
    episode_grids_dir: Union[str, Path],
) -> Path:
    """保存图片池索引到 state JSON 文件。

    旧 output/grids/epXXX/pool_index.json 会在首次访问时 move 到 state，
    后续只维护 state 里的 sidecar，避免 output 成为状态源。
    """
    grids_dir = Path(episode_grids_dir)
    index_path = resolve_state_index_path(grids_dir, _POOL_INDEX_FILENAME)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(grids_dir, _POOL_INDEX_FILENAME)
        return _save_pool_index_unlocked(pool, index_path)


def _load_pool_index_unlocked(index_path: Path) -> Optional[PoolIndex]:
    if not index_path.exists():
        return None

    with open(index_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 检查是否为旧格式（简单的 key-value 映射）
    if "episode" not in data:
        # 旧格式，返回 None 让调用者重建索引
        print(f"[load_pool_index] 旧格式 pool_index.json，需要重建索引")
        return None

    # 解析 images，处理 generated_at 字段
    def parse_image(img_data: dict) -> PoolImage:
        # 将 ISO 格式字符串转换为 datetime
        if img_data.get("generated_at") and isinstance(img_data["generated_at"], str):
            img_data["generated_at"] = datetime.fromisoformat(img_data["generated_at"])
        return PoolImage(**img_data)

    def parse_grid(g_data: dict) -> GridEntry:
        if g_data.get("generated_at") and isinstance(g_data["generated_at"], str):
            g_data["generated_at"] = datetime.fromisoformat(g_data["generated_at"])
        return GridEntry(**g_data)

    # 重建 PoolIndex 对象
    pool = PoolIndex(
        episode=data["episode"],
        generated_at=datetime.fromisoformat(data["generated_at"]),
        version=data.get("version", 1),
        modes=data.get("modes", {}),
        grids=[parse_grid(g) for g in data.get("grids", [])],
        images=[parse_image(img) for img in data.get("images", [])],
        beat_assignments=data.get("beat_assignments", {}),
    )

    return pool


def _state_pool_index_path(episode_grids_dir: Union[str, Path]) -> Path:
    return resolve_state_index_path(episode_grids_dir, _POOL_INDEX_FILENAME)


def _load_pool_index_for_update(
    episode_grids_dir: Union[str, Path],
) -> tuple[Path, Optional[PoolIndex]]:
    grids_dir = Path(episode_grids_dir)
    index_path = ensure_state_index_from_legacy(grids_dir, _POOL_INDEX_FILENAME)
    return index_path, _load_pool_index_unlocked(index_path)


def load_pool_index(
    episode_grids_dir: Union[str, Path],
) -> Optional[PoolIndex]:
    """从 state JSON 文件加载图片池索引。"""
    grids_dir = Path(episode_grids_dir)
    index_path = resolve_state_index_path(grids_dir, _POOL_INDEX_FILENAME)
    with index_file_lock(index_path):
        index_path = ensure_state_index_from_legacy(grids_dir, _POOL_INDEX_FILENAME)
        return _load_pool_index_unlocked(index_path)


def rebuild_pool_index(
    episode_grids_dir: Union[str, Path],
    episode: int,
    split_cells: bool = False,
) -> PoolIndex:
    """重建图片池索引。

    扫描 render/ 和 sketch/ 目录，构建索引并保存。

    Args:
        episode_grids_dir: 集数的 grids 目录路径
        episode: 集数
        split_cells: 已弃用，保留参数兼容

    Returns:
        新建的 PoolIndex 对象
    """
    grids_dir = Path(episode_grids_dir)

    old_pool = load_pool_index(grids_dir)
    pool = build_pool_index(grids_dir, episode)
    _preserve_rebuilt_assignments(old_pool, pool)

    # 保存索引
    save_pool_index(pool, grids_dir)

    return pool


def select_frame_from_pool(
    pool_id: str,
    episode_grids_dir: Union[str, Path],
    pool: Optional[PoolIndex] = None,
) -> Optional[str]:
    """为 beat 选择池中的图片，返回实际文件路径。

    Args:
        pool_id: 图片池 ID（如 "3x3_01_05"）
        episode_grids_dir: 集数的 grids 目录路径
        pool: 可选的 PoolIndex 对象（如果已加载）

    Returns:
        单元格的完整路径，如果不存在则返回 None
    """
    if pool is None:
        pool = load_pool_index(episode_grids_dir)

    if pool is None:
        print(f"[PoolIndexer] 警告: 无法加载池索引 {episode_grids_dir}")
        return None

    cell_path = pool.get_cell_path(pool_id)
    if cell_path is None:
        print(f"[PoolIndexer] 警告: 找不到图片 {pool_id}")
        return None

    full_path = Path(episode_grids_dir) / cell_path
    if not full_path.exists():
        print(f"[PoolIndexer] 警告: 文件不存在 {full_path}")
        return None

    return str(full_path)


def delete_cell_from_pool(
    episode_grids_dir: Union[str, Path],
    pool_id: str,
) -> bool:
    """从图片池删除指定的 cell。

    Args:
        episode_grids_dir: grids 目录路径
        pool_id: 图片池 ID（如 "3x3_01_05"）

    Returns:
        是否删除成功
    """
    grids_dir = Path(episode_grids_dir)
    index_path = _state_pool_index_path(grids_dir)

    with index_file_lock(index_path):
        # 1. 加载索引
        index_path, pool = _load_pool_index_for_update(grids_dir)
        if pool is None:
            print(f"[PoolIndexer] 警告: 无法加载池索引 {grids_dir}")
            return False

        # 2. 找到图片
        img = pool.get_image(pool_id)
        if img is None:
            print(f"[PoolIndexer] 警告: 找不到图片 {pool_id}")
            return False

        # 3. 删除 cell 文件（如果存在）
        if img.cell_path:
            cell_path = grids_dir / img.cell_path
            if cell_path.exists():
                cell_path.unlink()
                print(f"[PoolIndexer] 已删除文件: {cell_path}")

        # 4. 从索引中移除
        pool.images = [i for i in pool.images if i.id != pool_id]

        # 5. 更新模式统计
        for mode in pool.modes:
            pool.modes[mode]["total_cells"] = len([i for i in pool.images if i.mode == mode])

        # 6. 保存更新后的索引
        _save_pool_index_unlocked(pool, index_path)
    print(f"[PoolIndexer] 已从池中删除: {pool_id}")

    return True


# =============================================================================
# Beat 中心命名格式支持（render/beat_NN_t{ts}.png, sketch/{ratio}/beat_NN_t{ts}.jpg）
# =============================================================================


def _parse_beat_timestamp(filename: str) -> Optional[datetime]:
    """从 beat 中心命名的文件名解析时间戳。

    支持格式：beat_{NN}_t{YYYYMMDDHHMMSS}.{ext}

    Returns:
        datetime 对象，如果解析失败则返回 None
    """
    match = re.search(r"beat_\d+_t(\d{14})\.", filename)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y%m%d%H%M%S")
        except ValueError:
            return None
    return None


def _parse_beat_number(filename: str) -> Optional[int]:
    """从文件名解析 beat 编号。

    支持格式：beat_{NN}_t{ts}.{ext} 或 beat_{NN}_raw.{ext}
    """
    match = re.match(r"beat_(\d+)", filename)
    if match:
        return int(match.group(1))
    return None


def scan_render_dir(episode_grids_dir: Union[str, Path]) -> list[dict]:
    """扫描 render/ 目录下的 beat 中心命名文件。

    Returns:
        [{"path": "render/beat_01_t...", "beat_number": 1, "timestamp": datetime, "type": "render"}, ...]
    """
    grids_dir = Path(episode_grids_dir)
    render_dir = grids_dir / "render"
    results = []

    if not render_dir.exists():
        return results

    for f in sorted(render_dir.glob("beat_*_t*.png")):
        beat_num = _parse_beat_number(f.name)
        ts = _parse_beat_timestamp(f.name)
        if beat_num is not None:
            results.append(
                {
                    "path": f.relative_to(grids_dir).as_posix(),
                    "beat_number": beat_num,
                    "timestamp": ts,
                    "type": "render",
                }
            )

    return results


def scan_sketch_dir(episode_grids_dir: Union[str, Path]) -> list[dict]:
    """扫描 sketch/ 目录下的 beat 中心命名文件（flat 目录）。

    Returns:
        [{"path": "sketch/beat_01_t...", "beat_number": 1, "timestamp": datetime, "type": "sketch"}, ...]
    """
    grids_dir = Path(episode_grids_dir)
    sketch_base = grids_dir / "sketch"
    results = []

    if not sketch_base.exists():
        return results

    for ext in ("jpg", "png"):
        for f in sorted(sketch_base.glob(f"beat_*_t*.{ext}")):
            beat_num = _parse_beat_number(f.name)
            ts = _parse_beat_timestamp(f.name)
            if beat_num is not None:
                results.append(
                    {
                        "path": f.relative_to(grids_dir).as_posix(),
                        "beat_number": beat_num,
                        "timestamp": ts,
                        "type": "sketch",
                    }
                )

    return results


def add_beat_images_to_pool(
    pool: PoolIndex,
    episode_grids_dir: Union[str, Path],
) -> int:
    """将 render/ 和 sketch/ 中的 beat 中心命名图片加入图片池。

    仅添加尚未在池中的图片（按 path 去重）。

    Returns:
        新增的图片数量
    """
    grids_dir = Path(episode_grids_dir)
    existing_paths = {img.cell_path for img in pool.images if img.cell_path}
    added = 0

    for scan_fn in [scan_render_dir, scan_sketch_dir]:
        for item in scan_fn(grids_dir):
            if item["path"] in existing_paths:
                continue

            beat_num = item["beat_number"]
            ts = item["timestamp"]
            img_type = item["type"]

            if ts:
                ts_str = ts.strftime("%Y%m%d%H%M%S")
                pool_id = f"beat_{beat_num:02d}_t{ts_str}_{img_type}"
            else:
                pool_id = f"beat_{beat_num:02d}_{img_type}"

            pool_image = PoolImage(
                id=pool_id,
                mode="regen" if "regen" in item["path"] else img_type,
                grid_index=0,
                cell_index=0,
                grid_path="",
                cell_path=item["path"],
                row=0,
                col=0,
                original_beat=beat_num,
                generated_at=ts,
                type=img_type,
            )
            pool.images.append(pool_image)
            existing_paths.add(item["path"])
            added += 1

    if added > 0:
        print(f"[PoolIndexer] 新增 {added} 张 beat 中心命名图片到池")

    return added


def save_grid_and_split(
    grid_image_path: Union[str, Path],
    episode_grids_dir: Union[str, Path],
    grid_type: str,
    mode_key: str,
    beat_nums: list[int],
    preset: str,
    rows: int,
    cols: int,
    ts: str,
    pool: Optional[PoolIndex] = None,
    promote_dir: Optional[Union[str, Path]] = None,
    prompt_text: str = "",
    force_promote: bool = False,
    beats: Optional[list[dict]] = None,
    sketch_colors: Optional[Dict[str, str]] = None,
) -> dict:
    """保存整图到 preset 目录，切割 cell 到 cells/，注册到池。

    完整的 grid → cells 流程：
    1. 将整图移动/复制到 {preset}/{type}_{mode}_{beats}_grid_{ts}.png
    2. 保存提示词到 {preset}/{type}_{mode}_{beats}_prompt.txt
    3. 切割为 cells → cells/beat_{NN}_t{ts}.png
    4. 入池时对比去重
    5. promote 到 frames/ 或 sketches/

    Args:
        grid_image_path: 生成的整图路径
        episode_grids_dir: grids/ep001 目录
        grid_type: "render" | "sketch"
        mode_key: 如 "3x3", "1x1_9-16"
        beat_nums: beat 编号列表（与 cell 顺序对应）
        preset: "scene" | "char" | "loc" | "custom"
        rows, cols: 网格行列数
        ts: 时间戳字符串
        pool: 池索引（如果不传则自动 load）
        promote_dir: 目标 promote 目录（如 frames/ 或 sketches/）
        prompt_text: 提示词文本

    Returns:
        {"grid_path": str, "cell_paths": [Path], "added": int, "skipped": int}
    """
    import shutil
    from novelvideo.generators.grid_splitter import split_grid

    grids_dir = Path(episode_grids_dir)
    src_path = Path(grid_image_path)

    # 1. 准备 preset 目录 + 文件名
    beats_str = "-".join(str(b) for b in beat_nums)
    grid_filename = f"{grid_type}_{mode_key}_{beats_str}_grid_{ts}.png"
    preset_dir = grids_dir / preset
    preset_dir.mkdir(parents=True, exist_ok=True)
    dst_grid = preset_dir / grid_filename

    # 移动/复制整图
    if src_path.exists() and src_path != dst_grid:
        shutil.copy2(str(src_path), str(dst_grid))

    # 2. 保存提示词
    prompt_path = ""
    if prompt_text:
        prompt_filename = f"{grid_type}_{mode_key}_{beats_str}_prompt.txt"
        prompt_file = preset_dir / prompt_filename
        prompt_file.write_text(prompt_text, encoding="utf-8")
        prompt_path = prompt_file.relative_to(grids_dir).as_posix()

    # 3. 注册整图
    if pool is None:
        pool = load_pool_index(grids_dir)
    if pool is None:
        # 从目录名推断 episode 号（如 ep001 -> 1）
        import re as _re

        _m = _re.search(r"ep(\d+)", grids_dir.name)
        _episode = int(_m.group(1)) if _m else 1
        pool = build_pool_index(grids_dir, _episode)

    grid_rel = dst_grid.relative_to(grids_dir).as_posix()
    register_grid_entry(
        pool=pool,
        grid_type=grid_type,
        mode_key=mode_key,
        beat_nums=beat_nums,
        preset=preset,
        grid_path=grid_rel,
        prompt_path=prompt_path,
    )

    # 4. 切割到 render/ 或 sketch/ 目录（flat，beat 中心命名）
    target_dir = grids_dir / grid_type  # "render" or "sketch"
    target_dir.mkdir(parents=True, exist_ok=True)

    cell_paths_raw = split_grid(
        grid_image=str(dst_grid),
        output_dir=str(target_dir),
        rows=rows,
        cols=cols,
        output_format="png",
        prefix=f"tmp_{ts}_",
    )

    # 5. 预计算 beat content hash（用于 sketch stale 判断）
    beat_hash_map: Dict[int, str] = {}
    if beats:
        for beat in beats:
            beat_num = beat.get("beat_number")
            if beat_num is not None:
                beat_hash_map[beat_num] = compute_beat_content_hash(
                    beat, sketch_colors=sketch_colors
                )

    # 6. 重命名为 beat-centric + 去重入池
    added = 0
    skipped = 0
    final_cell_paths = []
    for i, raw_path in enumerate(cell_paths_raw):
        if i >= len(beat_nums):
            # padding cell
            raw_path.unlink(missing_ok=True)
            continue
        beat_num = beat_nums[i]
        cell_name = f"beat_{beat_num:02d}_t{ts}.png"
        cell_path = target_dir / cell_name
        raw_path.replace(cell_path)

        result = add_cell_with_dedup(
            pool=pool,
            cell_path=cell_path,
            episode_grids_dir=grids_dir,
            beat_num=beat_num,
            ts=ts,
            img_type=grid_type,
            mode=mode_key,
            grid_index=0,
            cell_index=i + 1,
            grid_path=grid_rel,
            row=i // cols,
            col=i % cols,
            beat_content_hash=beat_hash_map.get(beat_num, ""),
        )
        if result:
            added += 1
        else:
            skipped += 1

        final_cell_paths.append(cell_path)

        # 7. Promote
        # force_promote=True: regen/render 等用户明确指定的操作，覆盖已有
        # force_promote=False: 批量抽卡草图，不覆盖用户手动选图结果
        if promote_dir and cell_path.exists():
            promote = Path(promote_dir)
            promote.mkdir(parents=True, exist_ok=True)
            dst = promote / f"beat_{beat_num:02d}.png"
            if force_promote or not dst.exists():
                shutil.copy2(str(cell_path), str(dst))

        # 重复则删除新 cell（promote 之后再删）
        if not result:
            cell_path.unlink(missing_ok=True)

    save_pool_index(pool, grids_dir)

    return {
        "grid_path": str(dst_grid),
        "cell_paths": final_cell_paths,
        "added": added,
        "skipped": skipped,
    }


def assign_beat_image(
    episode_grids_dir: Union[str, Path],
    beat_num: int,
    image_path: str,
    img_type: str = "render",
) -> bool:
    """为 beat 分配图片（render 或 sketch），同时 copy 到 frames/。

    Args:
        episode_grids_dir: grids 目录
        beat_num: beat 编号
        image_path: 图片相对路径（相对于 grids_dir）
        img_type: "render" 或 "sketch"

    Returns:
        是否成功
    """
    import shutil

    grids_dir = Path(episode_grids_dir)
    index_path = _state_pool_index_path(grids_dir)
    with index_file_lock(index_path):
        index_path, pool = _load_pool_index_for_update(grids_dir)
        if pool is None:
            print(f"[PoolIndexer] 警告: 无法加载池索引 {grids_dir}")
            return False

        if img_type != "sketch":
            pool.beat_assignments[str(beat_num)] = image_path
            # 同时 copy 到 frames/beat_XX.png 兼容下游
            src = grids_dir / image_path
            if src.exists():
                # grids_dir 格式: output/{user}/{project}/grids/ep001
                # frames 目录: output/{user}/{project}/frames/ep001
                frames_dir = grids_dir.parent.parent / "frames" / grids_dir.name
                frames_dir.mkdir(parents=True, exist_ok=True)
                dst = frames_dir / f"beat_{beat_num:02d}.png"
                shutil.copy2(str(src), str(dst))
                print(f"[PoolIndexer] 已 copy 到 frames: {dst}")

        _save_pool_index_unlocked(pool, index_path)
    print(f"[PoolIndexer] Beat {beat_num} ({img_type}) → {image_path}")
    return True


# =============================================================================
# Phase 2: 内容哈希 + 去重
# =============================================================================


def compute_image_hash(image_path: Union[str, Path]) -> str:
    """计算图片内容哈希（用于去重）。

    使用 MD5 哈希文件内容。快速且足够用于去重判断。

    Args:
        image_path: 图片文件路径

    Returns:
        MD5 哈希字符串
    """
    path = Path(image_path)
    if not path.exists():
        return ""
    return hashlib.md5(path.read_bytes()).hexdigest()


def add_cell_with_dedup(
    pool: PoolIndex,
    cell_path: Path,
    episode_grids_dir: Path,
    beat_num: int,
    ts: str,
    img_type: str = "render",
    mode: str = "",
    grid_index: int = 0,
    cell_index: int = 0,
    grid_path: str = "",
    row: int = 0,
    col: int = 0,
    beat_content_hash: str = "",
) -> Optional[PoolImage]:
    """将 cell 入池，入池前检查去重。

    对比同 beat 位置已有的图片：
    - 如果池里已有相同 beat 且内容一致的图 → 跳过
    - 否则添加新条目

    Args:
        pool: 池索引对象
        cell_path: cell 文件绝对路径
        episode_grids_dir: grids 根目录
        beat_num: beat 编号
        ts: 时间戳字符串
        img_type: render | sketch
        mode: 生成模式
        grid_index: 网格索引
        cell_index: cell 索引
        grid_path: 网格图片相对路径
        row: 行号
        col: 列号

    Returns:
        新增的 PoolImage，如果重复则返回 None
    """
    content_hash = compute_image_hash(cell_path)

    if content_hash and pool.has_duplicate_cell(beat_num, content_hash):
        print(f"[PoolIndexer] 去重：Beat {beat_num} 已存在内容相同的图片，跳过")
        return None

    rel_path = cell_path.relative_to(episode_grids_dir).as_posix()
    pool_id = f"beat_{beat_num:02d}_t{ts}_{img_type}"

    pool_image = PoolImage(
        id=pool_id,
        mode=mode or img_type,
        grid_index=grid_index,
        cell_index=cell_index,
        grid_path=grid_path,
        cell_path=rel_path,
        row=row,
        col=col,
        original_beat=beat_num,
        generated_at=datetime.now(),
        type=img_type,
        content_hash=content_hash,
        beat_content_hash=beat_content_hash or None,
    )
    pool.images.append(pool_image)
    return pool_image


def register_grid_entry(
    pool: PoolIndex,
    grid_type: str,
    mode_key: str,
    beat_nums: list[int],
    preset: str,
    grid_path: str,
    prompt_path: str = "",
) -> GridEntry:
    """注册整图元数据到池索引。

    Args:
        pool: 池索引对象
        grid_type: render | sketch
        mode_key: 如 3x3, 1x1_9-16
        beat_nums: 包含的 beat 编号列表
        preset: scene / char / loc / custom
        grid_path: 整图相对路径
        prompt_path: 提示词相对路径

    Returns:
        新增的 GridEntry
    """
    entry = GridEntry(
        type=grid_type,
        mode_key=mode_key,
        beat_nums=beat_nums,
        preset=preset,
        grid_path=grid_path,
        prompt_path=prompt_path,
        generated_at=datetime.now(),
    )
    pool.add_grid(entry)
    return entry


def scan_preset_dirs(episode_grids_dir: Union[str, Path]) -> list[dict]:
    """扫描 preset 目录下的整图文件。

    Returns:
        [{"path": "scene/render_3x3_1-2-3_grid_ts.png", "type": "render",
          "mode_key": "3x3", "beat_nums": [1,2,3], "preset": "scene"}, ...]
    """
    grids_dir = Path(episode_grids_dir)
    results = []
    preset_names = ("scene", "char", "loc", "custom")

    grid_pattern = re.compile(r"^(render|sketch)_(.+?)_([\d-]+)_grid_(\d{14})\.png$")

    for preset in preset_names:
        preset_dir = grids_dir / preset
        if not preset_dir.exists():
            continue
        for f in sorted(preset_dir.glob("*_grid_*.png")):
            m = grid_pattern.match(f.name)
            if m:
                grid_type = m.group(1)
                mode_key = m.group(2)
                beats_str = m.group(3)
                ts_str = m.group(4)
                beat_nums = [int(b) for b in beats_str.split("-")]
                try:
                    ts = datetime.strptime(ts_str, "%Y%m%d%H%M%S")
                except ValueError:
                    ts = None
                results.append(
                    {
                        "path": f.relative_to(grids_dir).as_posix(),
                        "type": grid_type,
                        "mode_key": mode_key,
                        "beat_nums": beat_nums,
                        "preset": preset,
                        "timestamp": ts,
                    }
                )

    return results
