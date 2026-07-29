"""Celery runners for storyboard sketch generation."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager


def _int_list(value) -> list[int]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        source = value
    else:
        source = [value]
    result: list[int] = []
    for item in source:
        try:
            result.append(int(item))
        except (TypeError, ValueError):
            continue
    return result


def _format_generation_time(value: Any) -> str:
    try:
        return f"{float(value):.1f}s"
    except (TypeError, ValueError):
        return "未知"


def _scene_refs_override_from_config(
    config: dict[str, Any], beat_numbers: list[int]
) -> dict[int, list[Any]] | None:
    refs_config = config.get("canvas_scene_refs")
    if not isinstance(refs_config, list):
        return None
    from novelvideo.utils.asset_resolver import ResolvedAssetRef

    panel_by_beat = {int(beat_num): idx for idx, beat_num in enumerate(beat_numbers, start=1)}
    refs_by_panel: dict[int, list[Any]] = {}
    for item in refs_config:
        if not isinstance(item, dict):
            continue
        image_path = str(item.get("image_path") or item.get("path") or "").strip()
        if not image_path:
            continue
        panel_index = item.get("panel_index")
        beat_num = item.get("beat_number")
        panel_idx = 1
        if panel_index is not None:
            try:
                panel_idx = int(panel_index) + 1
            except (TypeError, ValueError):
                panel_idx = 1
        elif beat_num is not None:
            try:
                panel_idx = panel_by_beat.get(int(beat_num), 1)
            except (TypeError, ValueError):
                panel_idx = 1
        refs_by_panel.setdefault(panel_idx, []).append(
            ResolvedAssetRef(
                asset_type="scene",
                base_id=str(item.get("base_id") or item.get("label") or "canvas background"),
                variant_id=str(item.get("variant_id") or "").strip() or None,
                image_paths=[image_path],
                text_description=str(item.get("text_description") or "").strip(),
                source_level=str(item.get("source_level") or "selected_background_image"),
                reference_mode=str(item.get("reference_mode") or "prompt_only").strip()
                or "prompt_only",
            )
        )
    return refs_by_panel if refs_by_panel else None


def _log(
    manager,
    ctx: ProjectContext,
    task_type: str,
    episode: int,
    scope: str | None,
    message: str,
    *,
    progress: float | None = None,
) -> None:
    manager.update_progress_for_project(
        ctx,
        task_type,
        episode,
        scope=scope,
        progress=progress,
        current_task=message,
        logs=[message],
    )


async def _ensure_scene_refs_for_beats(
    *,
    ctx: ProjectContext,
    output_dir: str,
    beats: list[dict],
    episode: int,
    director_ref_mode: str,
    director_ref_beat_numbers: list[int] | None,
    log,
) -> dict[str, int]:
    """Check scene assets for the current sketch grid.

    This intentionally does not generate scene assets. The default storyboard
    path uses master/reverse as weak references; director refs are only consumed
    when explicit per-beat DirectorWorld renders already exist.
    """
    from novelvideo.cognee import CogneeStore
    from novelvideo.models import beat_scene_id
    from novelvideo.utils.path_resolver import PathResolver, compute_scene_master_path

    requested_scene_ids: list[str] = []
    seen: set[str] = set()
    for beat in beats or []:
        scene_id = beat_scene_id(beat)
        if not scene_id or scene_id in seen:
            continue
        seen.add(scene_id)
        requested_scene_ids.append(scene_id)

    if not requested_scene_ids:
        log("当前 beats 无 scene_id，跳过场景资产检查")
        return {"requested": 0, "generated": 0, "skipped": 0, "missing": 0, "director_refs": 0}

    store = CogneeStore(ctx.owner_project_label, output_dir=output_dir)
    await store.initialize()
    await store.load_graph_state()

    skipped = 0
    missing = 0
    for requested_scene_id in requested_scene_ids:
        scene = await store.sqlite_store.get_scene(requested_scene_id)
        if not scene:
            missing += 1
            log(f"未找到场景，跳过场景资产检查: {requested_scene_id}")
            continue
        if compute_scene_master_path(Path(output_dir), scene.name):
            skipped += 1
            log(f"场景资产就绪: {scene.name} (master=yes)")
        else:
            missing += 1
            log(f"场景缺少主线资产: {scene.name} (需要 master 作为默认 sketch 场景参考)")

    prepare_director_refs = str(director_ref_mode or "off").strip().lower() not in {
        "",
        "0",
        "false",
        "off",
        "none",
    } or bool(director_ref_beat_numbers)
    director_refs = 0
    if prepare_director_refs:
        paths = PathResolver(output_dir, episode)
        selected = (
            {int(bn) for bn in director_ref_beat_numbers if bn is not None}
            if director_ref_beat_numbers is not None
            else None
        )
        for beat in beats or []:
            beat_num = int(beat.get("beat_number") or 0)
            if beat_num <= 0:
                continue
            if selected is not None and beat_num not in selected:
                continue
            if paths.director_render(beat_num).exists():
                director_refs += 1
        if director_refs:
            log(f"DirectorWorld 控制图已就绪: {director_refs} 个 beat")
        else:
            log("未发现 DirectorWorld 控制图；导演单镜不会回退到旧参考图。")

    return {
        "requested": len(requested_scene_ids),
        "generated": 0,
        "skipped": skipped,
        "missing": missing,
        "director_refs": director_refs,
    }


def _build_director_blocking_sheet_for_grid(
    *,
    project_dir: Path,
    episode: int,
    scene_id: str,
    beat_numbers: list[int],
    director_ref_beat_numbers: list[int] | None,
    rows: int,
    cols: int,
    log,
) -> str:
    if not beat_numbers:
        return ""

    import re

    from PIL import Image, ImageOps

    from novelvideo.utils.path_resolver import PathResolver

    selected = (
        {int(bn) for bn in director_ref_beat_numbers if bn is not None}
        if director_ref_beat_numbers is not None
        else {int(bn) for bn in beat_numbers if bn is not None}
    )
    grid_beat_set = {int(bn) for bn in beat_numbers if bn is not None}
    selected = {int(bn) for bn in selected if int(bn) in grid_beat_set}
    if not selected:
        return ""

    resolver = PathResolver(str(project_dir), episode)
    ref_paths: list[Path | None] = []
    missing: list[int] = []
    for beat_num in beat_numbers:
        if int(beat_num) not in selected:
            ref_paths.append(None)
            continue
        ref = resolver.director_render(int(beat_num))
        if ref.exists():
            ref_paths.append(ref)
        else:
            ref_paths.append(None)
            missing.append(int(beat_num))
    if missing:
        log(f"DirectorWorld sheet 跳过：缺少 beat refs {missing}")
        return ""

    safe_scene = re.sub(r"[/\\:*?\"<>|]+", "_", str(scene_id or "scene")).strip().strip(".")
    safe_scene = safe_scene or "scene"
    beats_key = "-".join(str(int(bn)) for bn in beat_numbers)
    selected_key = "-".join(str(int(bn)) for bn in sorted(selected))
    out_dir = project_dir / "assets" / "director_refs" / f"ep{episode:03d}" / "sheets"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{safe_scene}_{rows}x{cols}_{beats_key}_refs_{selected_key}.png"

    cell_w = 512
    cell_h = 512
    first_ref = next((path for path in ref_paths if path is not None), None)
    if first_ref:
        with Image.open(first_ref) as first:
            ratio = first.width / max(1, first.height)
        if ratio >= 1:
            cell_h = max(256, round(cell_w / ratio))
        else:
            cell_w = max(256, round(cell_h * ratio))

    sheet = Image.new("RGB", (cell_w * cols, cell_h * rows), (248, 247, 239))
    for idx, ref in enumerate(ref_paths[: rows * cols]):
        if ref is None:
            continue
        with Image.open(ref).convert("RGB") as img:
            fitted = ImageOps.contain(img, (cell_w, cell_h), Image.Resampling.LANCZOS)
            cell = Image.new("RGB", (cell_w, cell_h), (248, 247, 239))
            cell.paste(fitted, ((cell_w - fitted.width) // 2, (cell_h - fitted.height) // 2))
            sheet.paste(cell, ((idx % cols) * cell_w, (idx // cols) * cell_h))
    sheet.save(out_path, format="PNG")
    log(f"DirectorWorld sheet 已生成: {out_path}")
    return str(out_path)


async def _run_sketch_generation_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.config import (
        DEFAULT_SKETCH_IMAGE_SELECTION,
        get_grid_generation_config,
        get_sketch_generation_config,
        normalize_image_generation_selection,
    )
    from novelvideo.generators.nanobanana_grid import (
        NanoBananaGridGenerator,
        REGEN_MODE_CONFIGS,
        SKETCH_DEFAULT_MODE_KEY,
        sketch_grid_split,
        sketch_pass1_mode_key,
        sketch_scene_grid_split,
    )
    from novelvideo.generators.pool_indexer import save_grid_and_split
    from novelvideo.utils.path_resolver import PathResolver, compute_scoped_grid_filename

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "sketch_generation")
    config = dict(payload.get("config") or {})
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    scope = envelope.get("scope")
    output_dir = str(payload.get("output_dir") or ctx.output_dir)
    manager = get_task_manager()

    def log(message: str, *, progress: float | None = None) -> None:
        _log(manager, ctx, task_type, episode, scope, message, progress=progress)

    log("开始生成草图...", progress=0.02)

    beats = list(config.get("beats") or [])
    character_map = config.get("character_map") or {}
    style = config.get("style")
    ethnicity = config.get("ethnicity", "Chinese")
    grid_index = int(config.get("grid_index") or 0)
    use_scene_grouping = bool(config.get("sketch_scene_grouping"))
    sketch_aspect_ratio = str(config.get("aspect_ratio") or "2:3")
    director_ref_mode = (
        str(config.get("director_ref_mode") or config.get("sketch_director_mode") or "off")
        .strip()
        .lower()
    )
    director_mode_enabled = director_ref_mode not in {"", "0", "false", "off", "none"}
    configured_director_ref_beats = _int_list(
        config.get("director_ref_beat_numbers") or config.get("director_ref_beats")
    )
    direct_sketch_beats = bool(config.get("direct_sketch_beats"))
    scene_id = ""
    director_sheet_path = ""
    selected_director_ref_beats: list[int] = []
    use_director_refs = False

    if not beats:
        raise ValueError("没有 beats 数据")

    if direct_sketch_beats:
        requested_beat_numbers = _int_list(config.get("beat_numbers"))
        if not requested_beat_numbers:
            raise ValueError("direct_sketch_beats 模式缺少 beat_numbers")
        beat_by_number = {
            int(beat.get("beat_number", idx + 1)): beat for idx, beat in enumerate(beats)
        }
        missing = [bn for bn in requested_beat_numbers if bn not in beat_by_number]
        if missing:
            raise ValueError(f"未找到 direct sketch beats: {missing}")
        mk = str(config.get("mode_key") or config.get("grid_mode") or "")
        mk_cfg = REGEN_MODE_CONFIGS.get(mk)
        if not mk_cfg:
            raise ValueError(f"未知 direct sketch mode_key: {mk}")
        grid_rows = int(mk_cfg.get("rows") or 0)
        grid_cols = int(mk_cfg.get("cols") or 0)
        if len(requested_beat_numbers) > grid_rows * grid_cols:
            raise ValueError(f"{mk} 最多容纳 {grid_rows * grid_cols} 个 beat")
        if director_mode_enabled and (
            len(requested_beat_numbers) != 1 or grid_rows != 1 or grid_cols != 1
        ):
            raise ValueError("导演草图模式只支持单 beat 1x1")
        grid_beats = [beat_by_number[bn] for bn in requested_beat_numbers]
        beat_numbers = requested_beat_numbers
        if configured_director_ref_beats:
            selected_director_ref_beats = [
                bn for bn in beat_numbers if bn in configured_director_ref_beats
            ]
        elif director_mode_enabled:
            selected_director_ref_beats = list(beat_numbers)
        use_director_refs = bool(selected_director_ref_beats)
        start_beat_idx = min(beat_numbers) - 1
        log(
            f"导演草图模式: {grid_rows}x{grid_cols} (beats {beat_numbers}), "
            f"director_ref_mode={director_ref_mode}, "
            f"director_ref_beats={selected_director_ref_beats or 'none'}"
        )
    elif use_scene_grouping:
        loc_plan = sketch_scene_grid_split(beats, aspect_ratio=sketch_aspect_ratio)
        if grid_index >= len(loc_plan):
            raise ValueError(f"网格索引 {grid_index} 超出范围（共 {len(loc_plan)} 个网格）")
        plan_entry = loc_plan[grid_index]
        grid_rows, grid_cols = int(plan_entry["rows"]), int(plan_entry["cols"])
        grid_beats = list(plan_entry["beats"])
        beat_numbers = [int(bn) for bn in plan_entry["beat_numbers"]]
        start_beat_idx = min(beat_numbers) - 1
        scene_id = str(plan_entry["scene_id"])
        log(
            f"生成网格 {grid_index + 1}/{len(loc_plan)}: "
            f"{grid_rows}x{grid_cols} [{scene_id}] (beats {beat_numbers})"
        )
        if configured_director_ref_beats:
            selected_director_ref_beats = [
                int(bn) for bn in beat_numbers if int(bn) in configured_director_ref_beats
            ]
        elif director_ref_mode in {"all", "scene", "grid", "sheet", "director_sheet"}:
            selected_director_ref_beats = [int(bn) for bn in beat_numbers]
        use_director_refs = bool(selected_director_ref_beats)
    elif director_mode_enabled:
        raise ValueError("导演单镜参考模式必须指定 direct_sketch_beats + 单个 beat")
    else:
        grid_plan = sketch_grid_split(len(beats))
        if grid_index >= len(grid_plan):
            raise ValueError(f"网格索引 {grid_index} 超出范围（共 {len(grid_plan)} 个网格）")
        start_beat_idx = sum(r * c for r, c in grid_plan[:grid_index])
        grid_rows, grid_cols = grid_plan[grid_index]
        grid_capacity = grid_rows * grid_cols
        grid_beats = beats[start_beat_idx : start_beat_idx + grid_capacity]
        beat_numbers = [
            int(beat.get("beat_number", start_beat_idx + 1 + i))
            for i, beat in enumerate(grid_beats)
        ]

    if use_director_refs:
        stats = await _ensure_scene_refs_for_beats(
            ctx=ctx,
            output_dir=output_dir,
            beats=grid_beats,
            episode=episode,
            director_ref_mode=director_ref_mode,
            director_ref_beat_numbers=selected_director_ref_beats,
            log=log,
        )
        log(
            "当前网格场景参考图检查完成: "
            f"requested={stats['requested']}, generated={stats['generated']}, "
            f"skipped={stats['skipped']}, missing={stats['missing']}, "
            f"director_world_refs={stats.get('director_refs', 0)}"
        )
    else:
        log("普通草图网格使用场景 master + reverse 弱参考。")

    if use_scene_grouping and not direct_sketch_beats and selected_director_ref_beats:
        director_sheet_path = _build_director_blocking_sheet_for_grid(
            project_dir=Path(output_dir),
            episode=episode,
            scene_id=scene_id,
            beat_numbers=[int(bn) for bn in beat_numbers],
            director_ref_beat_numbers=selected_director_ref_beats,
            rows=int(grid_rows),
            cols=int(grid_cols),
            log=log,
        )
        use_director_refs = bool(director_sheet_path)

    scene_refs_override = _scene_refs_override_from_config(config, beat_numbers)
    log(f"角色: {len(character_map)} 个")
    paths = PathResolver(output_dir, episode)
    sketch_dir = paths.sketch_dir()
    sketch_dir.mkdir(parents=True, exist_ok=True)
    episode_grids_dir = Path(output_dir) / "grids" / f"ep{episode:03d}"

    mk = (
        str(config.get("mode_key") or config.get("grid_mode") or "")
        if direct_sketch_beats
        else str(plan_entry.get("mode_key", "")) if use_scene_grouping else ""
    )
    effective_mk = mk or SKETCH_DEFAULT_MODE_KEY

    log(f"生成 {grid_rows}x{grid_cols} 草图...", progress=0.3)
    if use_director_refs:
        generator_config = get_grid_generation_config(selection_override="openai_gpt_image2")
        import os

        generator_config["openai_image_quality"] = os.environ.get(
            "OPENAI_SKETCH_IMAGE_QUALITY", "low"
        )
        log("[Sketch Image] 3GS 导演实景草图强制使用 OpenAI provider")
    else:
        sketch_image_selection = normalize_image_generation_selection(
            config.get("image_generation_selection"),
            fallback=DEFAULT_SKETCH_IMAGE_SELECTION,
        )
        generator_config = get_sketch_generation_config(selection_override=sketch_image_selection)

    generator = NanoBananaGridGenerator(config=generator_config)
    if use_director_refs and generator.provider != "openai":
        raise RuntimeError(
            f"3GS 导演实景草图只允许使用 OpenAI provider，当前 provider={generator.provider}"
        )
    log(f"[Sketch Image] provider={generator.provider}, model={generator.model}")

    output_path = str(
        sketch_dir
        / compute_scoped_grid_filename(
            effective_mk,
            beat_numbers,
            prefix="sketch",
            ext="jpg",
        )
    )
    pass1_key = sketch_pass1_mode_key(effective_mk)
    result = None
    if pass1_key:
        target_ar = REGEN_MODE_CONFIGS.get(effective_mk, {}).get("aspect_ratio", "9:16")
        log(f"[Two-Pass] Pass 1: 生成 1:1 中间草图 (mode_key={pass1_key})")
        pass1_base = compute_scoped_grid_filename(
            effective_mk,
            beat_numbers,
            prefix="sketch",
            ext="jpg",
        )
        pass1_path = str(sketch_dir / f"{Path(pass1_base).stem}_pass1.jpg")
        result = await generator.generate_grid(
            beats=grid_beats,
            character_map=character_map,
            scene_menu=config.get("scene_menu"),
            prop_menu=config.get("prop_menu"),
            sketch_colors=config.get("sketch_colors"),
            style=style,
            ethnicity=ethnicity,
            output_path=pass1_path,
            rows=grid_rows,
            cols=grid_cols,
            sketch=True,
            beat_start_index=start_beat_idx,
            mode_key=pass1_key,
            prompt_aspect_ratio=target_ar,
            use_director_refs=use_director_refs,
            director_sheet_path=director_sheet_path,
            director_ref_beat_numbers=selected_director_ref_beats,
            scene_refs_override=scene_refs_override,
        )
        if not result.success:
            raise RuntimeError(f"草图生成失败 (Pass 1): {result.error}")
        log(f"[Two-Pass] Pass 1 完成，耗时 {_format_generation_time(result.generation_time)}")
        target_size = REGEN_MODE_CONFIGS.get(effective_mk, {}).get("image_size", "1K")
        result2 = await generator.reformat_sketch(
            source_path=pass1_path,
            output_path=output_path,
            target_aspect=target_ar,
            target_size=target_size,
            rows=grid_rows,
            cols=grid_cols,
        )
        if result2.success:
            log(
                f"[Two-Pass] Pass 2 完成，耗时 "
                f"{_format_generation_time(result2.generation_time)}"
            )
        else:
            import shutil

            log(f"[Two-Pass] Pass 2 失败 ({result2.error})，回退使用 1:1 草图")
            shutil.copy2(pass1_path, output_path)
    else:
        result = await generator.generate_grid(
            beats=grid_beats,
            character_map=character_map,
            scene_menu=config.get("scene_menu"),
            prop_menu=config.get("prop_menu"),
            sketch_colors=config.get("sketch_colors"),
            style=style,
            ethnicity=ethnicity,
            output_path=output_path,
            rows=grid_rows,
            cols=grid_cols,
            sketch=True,
            beat_start_index=start_beat_idx,
            mode_key=mk or None,
            use_director_refs=use_director_refs,
            director_sheet_path=director_sheet_path,
            director_ref_beat_numbers=selected_director_ref_beats,
            scene_refs_override=scene_refs_override,
        )
        if not result.success:
            raise RuntimeError(f"草图生成失败: {result.error}")

    log(
        f"[NanoBananaPro] 网格图生成完成，耗时 "
        f"{_format_generation_time(result.generation_time)}",
        progress=0.8,
    )
    log("[Deface] 跳过去脸后处理（SeedEdit 模型暂不可用）")
    log("切割草图入池...", progress=0.85)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    sketches_dir = paths.sketches_dir()
    sketches_dir.mkdir(parents=True, exist_ok=True)
    save_result = save_grid_and_split(
        grid_image_path=output_path,
        episode_grids_dir=str(episode_grids_dir),
        grid_type="sketch",
        mode_key=effective_mk,
        beat_nums=beat_numbers,
        preset="custom",
        rows=grid_rows,
        cols=grid_cols,
        ts=ts,
        promote_dir=str(sketches_dir),
        force_promote=direct_sketch_beats and bool(config.get("promote_direct_sketch", True)),
        beats=grid_beats,
        sketch_colors=config.get("sketch_colors"),
    )
    log(f"草图切割完成：{save_result['added']} 个 beat 图片已入池", progress=0.95)

    if direct_sketch_beats:
        total_grids = 1
    elif use_scene_grouping:
        total_grids = len(loc_plan)
    else:
        total_grids = len(grid_plan)

    result_payload = {
        "sketch_path": output_path,
        "beat_numbers": beat_numbers,
        "grid_index": grid_index,
        "grid_size": (grid_rows, grid_cols),
        "total_grids": total_grids,
    }
    log(f"✅ 草图 {grid_index + 1}/{total_grids} 生成完成！", progress=1.0)
    return result_payload


def run_sketch_generation(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    if (envelope.get("payload") or {}).get("task_kind") == "director_control_to_sketch":
        return asyncio.run(
            await_envelope_with_cancel_watch(
                _run_control_frame_to_sketch_async(envelope, ctx),
                envelope,
                task_type="sketch_generation",
            )
        )
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_sketch_generation_async(envelope, ctx),
            envelope,
            task_type="sketch_generation",
        )
    )


register_project_task_runner("sketch_generation", run_sketch_generation)


async def _run_control_frame_to_sketch_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.director_world.control_frame_to_sketch import convert_control_frame_to_sketch
    from novelvideo.utils.path_resolver import PathResolver

    payload = envelope.get("payload") or {}
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    beat_num = int(envelope.get("beat_num") or payload.get("beat_num") or 0)
    scope = envelope.get("scope")
    output_dir = str(payload.get("output_dir") or ctx.output_dir)
    state_dir = str(payload.get("state_dir") or ctx.state_dir)
    control_frames_dir = str(payload.get("control_frames_dir") or "")
    task_type = str(envelope.get("task_type") or "sketch_generation")
    manager = get_task_manager()
    _log(
        manager,
        ctx,
        task_type,
        episode,
        scope,
        f"开始 Beat {beat_num} Direct Render 转草图...",
        progress=0.05,
    )

    paths = PathResolver(output_dir, episode)
    control_frames_root = (
        Path(control_frames_dir)
        if control_frames_dir
        else Path(output_dir) / "director_control_frames"
    )
    control_frame = (
        control_frames_root / f"ep{episode:03d}" / f"beat_{beat_num:02d}" / "combined.png"
    )
    if not control_frame.exists():
        raise FileNotFoundError(f"缺少 Direct Render combined.png: {control_frame}")

    _log(manager, ctx, task_type, episode, scope, "提交图像模型生成草图...", progress=0.18)
    result = await convert_control_frame_to_sketch(
        user=ctx.owner_username,
        project=ctx.project_name,
        episode=episode,
        beat=beat_num,
        output_dir=output_dir,
        state_dir=state_dir,
        control_frames_dir=control_frames_dir or None,
    )
    promoted = result.get("promoted_sketch") or str(paths.sketch(beat_num))
    _log(manager, ctx, task_type, episode, scope, f"草图已写入: {promoted}", progress=1.0)
    return {
        **result,
        "sketch_path": promoted,
        "beat_numbers": [beat_num],
        "grid_index": beat_num - 1,
        "task_kind": "director_control_to_sketch",
    }
