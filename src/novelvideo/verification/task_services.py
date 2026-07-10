"""Shared task helpers for verification episode-level jobs."""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from novelvideo.sqlite_store import SQLiteStore

from .report_formatter import save_verify_report
from .utils import load_all_beats

logger = logging.getLogger(__name__)


ProgressCallback = Callable[[float, str], None]
LogCallback = Callable[[str], None]


def _notify(progress_callback: ProgressCallback | None, progress: float, task: str) -> None:
    if progress_callback is not None:
        progress_callback(progress, task)


def _log(log_callback: LogCallback | None, message: str) -> None:
    if log_callback is not None:
        log_callback(message)


async def _make_sqlite_store(username: str, project: str, output_dir: str) -> SQLiteStore:
    store = SQLiteStore(f"{username}/{project}", output_dir=output_dir)
    await store.initialize()
    await store.load_graph_state()
    return store


def _load_sketch_colors(project_dir: Path, episode_num: int, store: SQLiteStore) -> dict[str, str]:
    del project_dir
    try:
        return store.get_sketch_colors(episode_num) or {}
    except Exception:
        logger.exception("failed to load sketch_colors from SQLite")
        return {}


def _promote_selected_sketches(
    *,
    project_dir: Path,
    episode_num: int,
    grids_dir: Path,
    pool: Any,
    beat_results: list[dict[str, Any]],
) -> int:
    sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
    sketches_dir.mkdir(parents=True, exist_ok=True)

    promoted = 0
    for row in beat_results:
        if row.get("recommended_action") != "accept":
            continue
        pool_id = row.get("selected_pool_id")
        if not pool_id:
            continue
        cell_path = pool.get_cell_path(pool_id)
        if not cell_path:
            continue
        src = grids_dir / cell_path
        if not src.exists():
            continue
        dst = sketches_dir / f"beat_{int(row['beat_number']):02d}.png"
        shutil.copy2(str(src), str(dst))
        promoted += 1
    return promoted


async def run_sketch_select_episode(
    *,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    episode_num: int,
    quality_threshold: float,
    score_gap_for_auto_select: float,
    color_prefilter: bool,
    fact_check: bool,
    promote_selected: bool,
    progress_callback: ProgressCallback | None = None,
    log_callback: LogCallback | None = None,
) -> dict[str, Any]:
    """Run the full sketch-select pipeline and persist its verify report."""

    _notify(progress_callback, 0.05, "加载项目数据")
    _log(log_callback, "加载 SQLiteStore 与 beats")
    store = await _make_sqlite_store(username, project, output_dir)

    beats = await load_all_beats(project_dir, episode_num, sqlite_store=store)

    _notify(progress_callback, 0.18, "加载候选池")
    from novelvideo.generators.pool_indexer import load_pool_index

    grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    pool = load_pool_index(grids_dir)
    if not pool:
        raise FileNotFoundError("No pool index found. Generate sketches first.")

    _notify(progress_callback, 0.28, "读取颜色映射")
    sketch_colors = _load_sketch_colors(project_dir, episode_num, store)

    _notify(progress_callback, 0.38, "运行草图择优")
    _log(log_callback, f"开始草图择优: {len(beats)} beats")
    from .sketch_selector import run_sketch_select

    data = await run_sketch_select(
        project_dir=project_dir,
        episode_num=episode_num,
        beats=beats,
        pool_index=pool,
        sketch_colors=sketch_colors,
        quality_threshold=quality_threshold,
        score_gap_for_auto_select=score_gap_for_auto_select,
        color_prefilter=color_prefilter,
        fact_check=fact_check,
    )

    promoted = 0
    if promote_selected:
        _notify(progress_callback, 0.84, "提升已接受草图")
        promoted = _promote_selected_sketches(
            project_dir=project_dir,
            episode_num=episode_num,
            grids_dir=grids_dir,
            pool=pool,
            beat_results=data.get("beat_results", []),
        )
        if promoted:
            _log(log_callback, f"已提升 {promoted} 张 accept 草图到 sketches/")

    data["promoted_count"] = promoted

    _notify(progress_callback, 0.96, "保存验证报告")
    report_path = save_verify_report(project_dir, episode_num, None, "sketch_select", data)
    data["report_path"] = report_path.relative_to(project_dir).as_posix()
    _log(log_callback, f"草图择优完成，报告已保存: {data['report_path']}")

    _notify(progress_callback, 1.0, "完成")
    return data
