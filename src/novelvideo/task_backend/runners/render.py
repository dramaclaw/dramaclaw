"""Celery runners for render-grid generation tasks."""

from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_backend.runners.sketch import (
    _ensure_scene_refs_for_beats,
    _scene_refs_override_from_config,
)
from novelvideo.task_state import get_task_manager


def _identity_character(identity_id: str) -> str:
    text = str(identity_id or "").strip()
    if not text:
        return ""
    return text.split("_", 1)[0] if "_" in text else text


def _identity_suffix(identity_id: str) -> str:
    text = str(identity_id or "").strip()
    if not text:
        return ""
    return text.split("_", 1)[1] if "_" in text else text


def _primary_detected_identity_by_character(beats: list[dict]) -> dict[str, str]:
    from novelvideo.models import real_detected_identities

    result: dict[str, str] = {}
    for beat in beats:
        for identity_id in real_detected_identities(beat.get("detected_identities") or []):
            character = _identity_character(identity_id)
            if character and character not in result:
                result[character] = identity_id
    return result


def _apply_canvas_identity_refs(
    character_map: dict,
    config: dict[str, Any],
    beats: list[dict],
) -> dict:
    refs = config.get("canvas_identity_refs")
    if not isinstance(refs, list) or not refs:
        return character_map
    updated = {str(name): dict(info or {}) for name, info in (character_map or {}).items()}
    primary_by_character = _primary_detected_identity_by_character(beats)

    for ref in refs:
        if not isinstance(ref, dict):
            continue
        identity_id = str(ref.get("identity_id") or "").strip()
        image_path = str(ref.get("image_path") or "").strip()
        if not identity_id or not image_path or not Path(image_path).exists():
            continue
        character = _identity_character(identity_id)
        suffix = _identity_suffix(identity_id)
        if not character:
            continue
        entry = dict(updated.get(character) or {})
        entry.setdefault("face_prompt", identity_id)
        entry.setdefault("base_prompt", entry.get("face_prompt") or identity_id)
        entry.setdefault("appearance_details", "")
        entry.setdefault("gender", "")
        entry.setdefault("body_type", "")
        primary_identity = primary_by_character.get(character)
        identity_ref_images = dict(entry.get("identity_ref_images") or {})
        if suffix and primary_identity and primary_identity != identity_id:
            identity_ref_images[suffix] = image_path
        entry["identity_ref_images"] = identity_ref_images
        if not primary_identity or primary_identity == identity_id or not entry.get("ref_path"):
            reference_mode = str(ref.get("reference_mode") or "").strip() or "composite"
            entry["ref_path"] = image_path
            entry["portrait_path"] = image_path
            entry["reference_path"] = image_path
            entry["reference_mode"] = reference_mode
        updated[character] = entry

    return updated


def _normalize_standalone_selected_beat(beat: dict, panel_index: int) -> dict:
    normalized = dict(beat or {})
    normalized["episode_number"] = 0
    raw_beat_number = normalized.get("beat_number")
    if raw_beat_number is None:
        normalized["beat_number"] = int(panel_index)
    else:
        try:
            normalized["beat_number"] = int(raw_beat_number)
        except (TypeError, ValueError):
            normalized["beat_number"] = int(panel_index)
    raw_panel_index = normalized.get("panel_index")
    if raw_panel_index is None:
        normalized["panel_index"] = int(panel_index)
    else:
        try:
            normalized["panel_index"] = int(raw_panel_index)
        except (TypeError, ValueError):
            normalized["panel_index"] = int(panel_index)
    return normalized


def _asset_refs_override_from_config(
    config: dict[str, Any],
    key: str,
    beat_numbers: list[int],
    *,
    asset_type: str,
    id_field: str,
    source_level: str,
) -> dict[int, list[Any]] | None:
    refs_config = config.get(key)
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
        base_id = str(item.get(id_field) or item.get("base_id") or item.get("label") or "").strip()
        refs_by_panel.setdefault(panel_idx, []).append(
            ResolvedAssetRef(
                asset_type=asset_type,
                base_id=base_id or "canvas reference",
                variant_id=str(item.get("variant_id") or item.get("label") or "") or None,
                image_paths=[image_path],
                text_description=str(item.get("text_description") or "").strip(),
                source_level=str(item.get("source_level") or source_level),
            )
        )
    return refs_by_panel if refs_by_panel else None


def _canvas_sketch_paths_override_from_config(
    config: dict[str, Any],
    *,
    standalone_beat_context: bool,
    has_selected_panel_indices: bool,
) -> dict[int, str] | None:
    raw_canvas_sketch_paths = config.get("canvas_sketch_paths")
    if not isinstance(raw_canvas_sketch_paths, dict):
        return None
    beat_sketch_paths_override = {}
    for beat_num, path in raw_canvas_sketch_paths.items():
        try:
            key = int(beat_num)
        except (TypeError, ValueError):
            continue
        if standalone_beat_context and not has_selected_panel_indices:
            key -= 1
        beat_sketch_paths_override[key] = str(path)
    return beat_sketch_paths_override


def _log(
    manager,
    ctx: ProjectContext,
    task_type: str,
    episode: int,
    message: str,
    *,
    progress: float | None = None,
    scope: str | None = None,
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


async def _run_batch_render_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.config import (
        DEFAULT_RENDER_IMAGE_SELECTION,
        get_render_generation_config,
        normalize_image_generation_selection,
    )
    from novelvideo.generators.nanobanana_grid import NanoBananaGridGenerator, scene_grid_split
    from novelvideo.generators.pool_indexer import (
        build_beat_sketch_paths,
        load_pool_index,
        rebuild_pool_index,
        save_pool_index,
    )
    from novelvideo.utils.path_resolver import PathResolver, compute_scoped_grid_filename

    payload = envelope.get("payload") or {}
    config = dict(payload.get("config") or {})
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    output_dir = str(payload.get("output_dir") or ctx.output_dir)
    manager = get_task_manager()

    def log(message: str, *, progress: float | None = None) -> None:
        _log(manager, ctx, "batch_render", episode, message, progress=progress)

    log("开始 Batch Render 生成...", progress=0.0)

    beats = list(config.get("beats") or [])
    character_map = config.get("character_map") or {}
    style = config.get("style")
    if not beats:
        raise ValueError("没有 beats 数据")

    scene_ref_stats = await _ensure_scene_refs_for_beats(
        ctx=ctx,
        output_dir=output_dir,
        beats=beats,
        episode=episode,
        director_ref_mode="off",
        director_ref_beat_numbers=None,
        log=log,
    )
    log(
        "场景参考图检查完成: "
        f"requested={scene_ref_stats['requested']}, "
        f"generated={scene_ref_stats['generated']}, "
        f"skipped={scene_ref_stats['skipped']}, "
        f"missing={scene_ref_stats['missing']}, "
        f"director_world_refs={scene_ref_stats.get('director_refs', 0)}"
    )

    loc_plan = scene_grid_split(beats, character_map=character_map)
    log(f"场景分组 (2x2): {len(loc_plan)} 个网格", progress=0.05)
    for index, entry in enumerate(loc_plan):
        log(
            f"网格 {index + 1}: {entry['scene_id']} "
            f"({entry['rows']}x{entry['cols']}, {len(entry['beats'])} beats)"
        )

    paths = PathResolver(output_dir, episode)
    base_dir = Path(output_dir)
    episode_grids_dir = base_dir / "grids" / f"ep{episode:03d}"
    used_mode_keys: set[str] = set()
    for entry in loc_plan:
        mk = str(entry["mode_key"])
        (episode_grids_dir / mk).mkdir(parents=True, exist_ok=True)
        used_mode_keys.add(mk)
    frames_dir = paths.frames_dir()
    frames_dir.mkdir(parents=True, exist_ok=True)
    sketch_dir = paths.sketch_dir()
    sketch_dir_str = sketch_dir.as_posix() if sketch_dir.exists() else ""

    all_beat_nums = [beat.get("beat_number", idx + 1) for idx, beat in enumerate(beats)]
    beat_sketch_paths = build_beat_sketch_paths(str(episode_grids_dir), all_beat_nums)
    render_image_selection = normalize_image_generation_selection(
        config.get("image_generation_selection"),
        fallback=DEFAULT_RENDER_IMAGE_SELECTION,
    )
    generator_config = get_render_generation_config(selection_override=render_image_selection)
    generator = NanoBananaGridGenerator(config=generator_config)
    log(f"[Render Image] provider={generator.provider}, model={generator.model}")

    batch_requests = []
    processed_beats = 0
    for grid_idx, entry in enumerate(loc_plan):
        grid_rows = int(entry["rows"])
        grid_cols = int(entry["cols"])
        grid_beats = list(entry["beats"])
        beat_numbers = [int(bn) for bn in entry["beat_numbers"]]
        mk = str(entry["mode_key"])
        output_path = str(
            episode_grids_dir
            / mk
            / compute_scoped_grid_filename(
                mk,
                beat_numbers,
                prefix="grid",
                ext="png",
            )
        )
        log(
            f"准备网格 {grid_idx + 1}/{len(loc_plan)}: "
            f"{grid_rows}x{grid_cols} ({entry['scene_id']})",
            progress=0.05 + 0.15 * (grid_idx + 1) / max(1, len(loc_plan)),
        )
        req = await generator.prepare_batch_request(
            beats=grid_beats,
            character_map=character_map,
            scene_menu=config.get("scene_menu"),
            prop_menu=config.get("prop_menu"),
            sketch_colors=config.get("sketch_colors"),
            style=style,
            output_path=output_path,
            rows=grid_rows,
            cols=grid_cols,
            sketch=False,
            beat_start_index=processed_beats,
            total_episode_beats=len(beats),
            location_beat_numbers=beat_numbers,
            sketch_dir=sketch_dir_str,
            beat_sketch_paths=beat_sketch_paths,
            mode_key=mk,
            force_image_size="0.5K" if config.get("force_half_k") else None,
        )
        batch_requests.append(req)
        processed_beats += len(grid_beats)

    log(f"提交 {len(batch_requests)} 个请求到 Batch API...", progress=0.2)

    def on_status(state):
        log(f"Batch 状态: {state}", progress=0.5)

    results = await generator.generate_batch_api(
        requests=batch_requests,
        on_status_change=on_status,
    )

    log("保存结果并入池...", progress=0.8)
    metadata_by_mode = defaultdict(list)
    for grid_idx, (entry, result) in enumerate(zip(loc_plan, results)):
        mk = str(entry["mode_key"])
        metadata_by_mode[mk].append(
            {
                "file": (
                    Path(result.grid_image_path).name
                    if result.grid_image_path
                    else f"grid_{grid_idx + 1:02d}.png"
                ),
                "rows": entry["rows"],
                "cols": entry["cols"],
                "beat_start": entry["beat_numbers"][0] if entry["beat_numbers"] else 0,
                "beat_numbers": entry["beat_numbers"],
                "padding_count": entry["padding_count"],
                "scene_id": entry["scene_id"],
                "success": result.success,
            }
        )

    for mk, grids_meta in metadata_by_mode.items():
        metadata = {"mode": mk, "grids": grids_meta, "batch_api": True}
        with open(episode_grids_dir / mk / "metadata.json", "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

    rebuild_pool_index(str(episode_grids_dir), episode)
    pool = load_pool_index(episode_grids_dir)
    if pool:
        for img in pool.images:
            if img.mode in used_mode_keys and img.cell_path:
                cell_full = episode_grids_dir / img.cell_path
                if cell_full.exists():
                    beat_num = img.original_beat
                    dst = frames_dir / f"beat_{beat_num:02d}.png"
                    shutil.copy2(str(cell_full), str(dst))
                    pool.beat_assignments[str(beat_num)] = img.id
        save_pool_index(pool, episode_grids_dir)

    successful = sum(1 for result in results if result.success)
    grid_results = []
    for entry, result in zip(loc_plan, results):
        if not result.success or not result.grid_image_path:
            continue
        rel_path = os.path.relpath(result.grid_image_path, output_dir)
        grid_results.append(
            {
                "mode_key": entry["mode_key"],
                "beat_nums": list(entry.get("beat_numbers") or []),
                "rel_path": rel_path,
            }
        )

    result_payload = {
        "total_grids": len(loc_plan),
        "successful": successful,
        "grid_results": grid_results,
    }
    log(f"✅ Batch Render 完成！{successful}/{len(loc_plan)} 成功", progress=1.0)
    return result_payload


def run_batch_render(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_batch_render_async(envelope, ctx),
            envelope,
            task_type="batch_render",
        )
    )


async def _run_selected_regen_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
    *,
    is_sketch: bool,
) -> dict[str, Any]:
    from novelvideo.generators.nanobanana_grid import regenerate_selected_beats
    from novelvideo.generators.pool_indexer import save_grid_and_split
    from novelvideo.models import beat_scene_id
    from novelvideo.task_identity import selection_scope
    from novelvideo.utils.path_resolver import PathResolver

    if is_sketch:
        from novelvideo.config import (
            DEFAULT_SKETCH_IMAGE_SELECTION as default_selection,
            get_sketch_generation_config as get_generation_config,
            normalize_image_generation_selection,
        )
    else:
        from novelvideo.config import (
            DEFAULT_RENDER_IMAGE_SELECTION as default_selection,
            get_render_generation_config as get_generation_config,
            normalize_image_generation_selection,
        )

    payload = envelope.get("payload") or {}
    config = dict(payload.get("config") or {})
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    mode_key = str(payload.get("mode_key") or config.get("mode_key") or "")
    task_type = str(envelope.get("task_type") or ("sketch_regen" if is_sketch else "selected_regen"))
    standalone_beat_context = bool(config.get("standalone_beat_context"))
    scope = envelope.get("scope")
    if not scope:
        scope = (
            f"{mode_key}:standalone"
            if standalone_beat_context
            else selection_scope(mode_key, config.get("selected_beat_numbers", []))
        )
    output_dir = str(payload.get("output_dir") or ctx.output_dir)
    manager = get_task_manager()

    def log(message: str, *, progress: float | None = None) -> None:
        _log(manager, ctx, task_type, episode, message, progress=progress, scope=scope)

    paths = PathResolver(output_dir, episode)
    episode_grids_dir = Path(output_dir) / "grids" / f"ep{episode:03d}"
    beats_data = list(config.get("beats") or [])
    selected_beat_numbers = [int(bn) for bn in config.get("selected_beat_numbers", [])]
    character_map = config.get("character_map") or {}
    style = config.get("style")
    ethnicity = config.get("ethnicity", "Chinese")

    if standalone_beat_context:
        raw_panel_indices = config.get("selected_panel_indices")
        has_selected_panel_indices = raw_panel_indices is not None
        if raw_panel_indices is None:
            raw_panel_indices = [
                int(panel_num) - 1 for panel_num in selected_beat_numbers if int(panel_num) > 0
            ]
        selected_panel_indices = []
        for panel_index in raw_panel_indices or []:
            try:
                selected_panel_indices.append(int(panel_index))
            except (TypeError, ValueError):
                continue
        if not selected_panel_indices:
            selected_panel_indices = list(range(len(beats_data)))
        selected_panel_beats = [
            (panel_index, _normalize_standalone_selected_beat(beats_data[panel_index], panel_index))
            for panel_index in selected_panel_indices
            if 0 <= panel_index < len(beats_data)
        ]
        selected_beats = [beat for _panel_index, beat in selected_panel_beats]
        selected_beat_numbers = []
        for panel_index, beat in selected_panel_beats:
            raw_beat_number = beat.get("beat_number")
            raw_panel_index = beat.get("panel_index")
            try:
                selected_beat_numbers.append(
                    int(
                        raw_beat_number
                        if raw_beat_number is not None
                        else raw_panel_index
                        if raw_panel_index is not None
                        else panel_index
                    )
                )
            except (TypeError, ValueError):
                selected_beat_numbers.append(int(panel_index))
    else:
        has_selected_panel_indices = False
        beat_by_num: dict[int, dict] = {}
        for beat in beats_data:
            try:
                beat_by_num[int(beat.get("beat_number") or 0)] = beat
            except (TypeError, ValueError):
                continue
        selected_beats = [beat_by_num[beat] for beat in selected_beat_numbers if beat in beat_by_num]
    if not selected_beats:
        raise ValueError(f"未找到选中的 beats: {selected_beat_numbers}")
    if not standalone_beat_context:
        selected_beat_numbers = [
            int(beat.get("beat_number"))
            for beat in selected_beats
            if beat.get("beat_number") is not None
        ]
    beat_sketch_paths_override = _canvas_sketch_paths_override_from_config(
        config,
        standalone_beat_context=standalone_beat_context,
        has_selected_panel_indices=has_selected_panel_indices,
    )
    character_map = _apply_canvas_identity_refs(character_map, config, selected_beats)
    scene_refs_override = _scene_refs_override_from_config(config, selected_beat_numbers)
    prop_refs_override = _asset_refs_override_from_config(
        config,
        "canvas_prop_refs",
        selected_beat_numbers,
        asset_type="prop",
        id_field="prop_id",
        source_level="canvas_prop_reference_image",
    )

    if is_sketch:
        selected_scene_ids = {beat_scene_id(beat) or "未绑定场景" for beat in selected_beats}
        if len(selected_scene_ids) > 1:
            raise ValueError(
                "草图重生一次只能包含同一场景的 beat；当前包含："
                + ", ".join(sorted(selected_scene_ids))
            )
        output_base_dir = paths.sketch_dir()
        output_base_dir.mkdir(parents=True, exist_ok=True)
        promote_dir = paths.sketches_dir()
        grid_type = "sketch"
        force_kwargs = {}
    else:
        output_base_dir = paths.render_dir()
        output_base_dir.mkdir(parents=True, exist_ok=True)
        promote_dir = paths.frames_dir()
        promote_dir.mkdir(parents=True, exist_ok=True)
        grid_type = "render"
        render_sketch_dir = (
            paths.sketch_dir().as_posix()
            if paths.has_sketch() or bool(beat_sketch_paths_override)
            else ""
        )
        force_kwargs = {
            "sketch_dir": render_sketch_dir,
            "episode_grids_dir": episode_grids_dir.as_posix(),
            "sketch_aspect_padding": config.get("sketch_aspect_padding", False),
            "force_image_size": "0.5K" if config.get("force_half_k") else None,
            "beat_sketch_paths_override": beat_sketch_paths_override,
            "scene_refs_override": scene_refs_override,
            "prop_refs_override": prop_refs_override,
        }

    log(f"模式: {mode_key}, 选中 {len(selected_beats)} 个 beats: {selected_beat_numbers}")
    image_selection = normalize_image_generation_selection(
        config.get("image_generation_selection"),
        fallback=default_selection,
    )
    generator_config = get_generation_config(selection_override=image_selection)
    image_quality = str(config.get("image_quality") or "").strip().lower()
    if image_quality in {"low", "medium", "high"}:
        generator_config["openai_image_quality"] = image_quality
        generator_config["huimeng_image_quality"] = image_quality
    log(
        f"[{'Sketch' if is_sketch else 'Render'} Image] "
        f"provider={generator_config.get('provider')}, model={generator_config.get('model')}"
    )

    scene_ref_stats = await _ensure_scene_refs_for_beats(
        ctx=ctx,
        output_dir=output_dir,
        beats=selected_beats,
        episode=episode,
        director_ref_mode="off",
        director_ref_beat_numbers=None,
        log=log,
    )
    log(
        "场景参考图检查完成: "
        f"requested={scene_ref_stats['requested']}, "
        f"generated={scene_ref_stats['generated']}, "
        f"skipped={scene_ref_stats['skipped']}, "
        f"missing={scene_ref_stats['missing']}, "
        f"director_world_refs={scene_ref_stats.get('director_refs', 0)}",
        progress=0.15,
    )

    log(f"生成 {mode_key} {'草图' if is_sketch else '网格'}...", progress=0.2)
    results = await regenerate_selected_beats(
        selected_beats=selected_beats,
        mode_key=mode_key,
        character_map=character_map,
        scene_menu=config.get("scene_menu"),
        prop_menu=config.get("prop_menu"),
        sketch_colors=config.get("sketch_colors"),
        style=style,
        output_dir=str(output_base_dir),
        ethnicity=ethnicity,
        is_sketch=is_sketch,
        generator_config=generator_config,
        **force_kwargs,
    )

    log("分割网格并更新图片池...", progress=0.7)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    updated_beats: list[int] = []
    grid_paths: dict[int, str] = {}
    grid_results: list[dict[str, Any]] = []
    failed_errors: list[str] = []
    beat_offset = 0
    for result in results:
        if not result.success or not result.grid_image_path:
            error_text = str(result.error or "unknown error")
            failed_errors.append(error_text)
            log(f"{'草图' if is_sketch else '网格'}生成失败: {error_text}")
            beat_offset += result.beat_count or 0
            continue

        rows = result.grid_rows or 1
        cols = result.grid_cols or 1
        beat_count = result.beat_count or (rows * cols)
        grid_beat_slice = selected_beats[beat_offset : beat_offset + beat_count]
        if standalone_beat_context:
            grid_beat_nums = selected_beat_numbers[beat_offset : beat_offset + beat_count]
        else:
            grid_beat_nums = [
                int(beat.get("beat_number"))
                for beat in grid_beat_slice
                if beat.get("beat_number") is not None
            ]
        beat_offset += beat_count

        if grid_beat_nums:
            rel_path = os.path.relpath(result.grid_image_path, output_dir)
            grid_paths[grid_beat_nums[0]] = rel_path
            grid_results.append(
                {
                    "first_beat": grid_beat_nums[0],
                    "beat_nums": list(grid_beat_nums),
                    "rel_path": rel_path,
                }
            )

        save_kwargs = {
            "grid_image_path": result.grid_image_path,
            "episode_grids_dir": episode_grids_dir.as_posix(),
            "grid_type": grid_type,
            "mode_key": mode_key,
            "beat_nums": grid_beat_nums,
            "preset": "custom",
            "rows": rows,
            "cols": cols,
            "ts": ts,
            "promote_dir": str(promote_dir),
            "force_promote": True,
        }
        if not bool(config.get("promote_selected_regen", True)):
            save_kwargs["force_promote"] = False
        if is_sketch:
            save_kwargs["beats"] = list(grid_beat_slice)
            save_kwargs["sketch_colors"] = config.get("sketch_colors")
        save_result = save_grid_and_split(**save_kwargs)
        for bn in grid_beat_nums[: len(save_result["cell_paths"])]:
            updated_beats.append(bn)
        log(f"入池: {save_result['added']} 新增, {save_result['skipped']} 去重跳过")

    if not updated_beats:
        label = "草图重生" if is_sketch else "Render 重生"
        detail = f"：{'; '.join(failed_errors[:3])}" if failed_errors else ""
        raise RuntimeError(
            f"{label}未生成可用图片（mode={mode_key}, beats={selected_beat_numbers}）{detail}"
        )

    result_payload = {
        "mode_key": mode_key,
        "updated_beats": updated_beats,
        "grid_paths": grid_paths,
        "grid_results": grid_results,
    }
    log(f"✅ {'草图再生' if is_sketch else 'Render 再生'}完成！更新了 {len(updated_beats)} 个 beats", progress=1.0)
    return result_payload


def run_selected_regen(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_selected_regen_async(envelope, ctx, is_sketch=False),
            envelope,
            task_type=str(envelope.get("task_type") or "selected_regen"),
        )
    )


def run_sketch_regen(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_selected_regen_async(envelope, ctx, is_sketch=True),
            envelope,
            task_type=str(envelope.get("task_type") or "sketch_regen"),
        )
    )


register_project_task_runner("selected_regen", run_selected_regen)
register_project_task_runner("sketch_regen", run_sketch_regen)


async def _run_grid_regenerate_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.config import (
        DEFAULT_RENDER_IMAGE_SELECTION,
        MODE_CONFIG,
        get_render_generation_config,
        normalize_image_generation_selection,
    )
    from novelvideo.generators import create_grid_generator
    from novelvideo.generators.pool_indexer import build_beat_sketch_paths, save_grid_and_split
    from novelvideo.task_identity import selection_scope
    from novelvideo.utils.path_resolver import PathResolver

    payload = envelope.get("payload") or {}
    config = dict(payload.get("config") or {})
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    grid_index = int(payload.get("grid_index") or 0)
    output_dir = str(payload.get("output_dir") or ctx.output_dir)
    config_beat_numbers = [int(bn) for bn in config.get("beat_numbers", []) if bn is not None]
    config_mode_key = config.get("grid_mode")
    scope = envelope.get("scope") or (
        selection_scope(config_mode_key, config_beat_numbers)
        if config_mode_key and config_beat_numbers
        else f"grid_{grid_index}"
    )
    manager = get_task_manager()

    def log(message: str, *, progress: float | None = None) -> None:
        _log(manager, ctx, "grid_regenerate", episode, message, progress=progress, scope=scope)

    paths = PathResolver(output_dir, episode)
    frames_dir = paths.frames_dir()
    episode_grids_dir = Path(output_dir) / "grids" / f"ep{episode:03d}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    episode_grids_dir.mkdir(parents=True, exist_ok=True)

    beats_data = list(config.get("beats") or [])
    character_map = config.get("character_map") or {}
    style = config.get("style")
    ethnicity = config.get("ethnicity", "Chinese")
    prompt_only = bool(config.get("prompt_only", False))
    if config.get("render_mode", "普通") == "Render" and not paths.has_sketch():
        raise RuntimeError("Render 模式需要草图，但 sketch 目录中未找到草图文件。请先生成草图。")

    render_image_selection = normalize_image_generation_selection(
        config.get("image_generation_selection"),
        fallback=DEFAULT_RENDER_IMAGE_SELECTION,
    )
    grid_config = get_render_generation_config(selection_override=render_image_selection)
    grid_mode = str(config.get("grid_mode") or grid_config.get("mode", "3x3"))
    scene_grouping = bool(config.get("scene_grouping", False))
    character_grouping = bool(config.get("character_grouping", False))
    scene_grid_plan = None

    if config_beat_numbers:
        from novelvideo.generators.nanobanana_grid import REGEN_MODE_CONFIGS

        cfg = REGEN_MODE_CONFIGS.get(grid_mode, {})
        rows_cfg = int(cfg.get("rows") or 1)
        cols_cfg = int(cfg.get("cols") or 1)
        capacity = int(cfg.get("capacity") or (rows_cfg * cols_cfg))
        beats_map = {int(beat.get("beat_number") or 0): beat for beat in beats_data}
        direct_beats = [beats_map[bn] for bn in config_beat_numbers if bn in beats_map]
        scene_grid_plan = [None] * grid_index + [
            {
                "rows": rows_cfg,
                "cols": cols_cfg,
                "mode_key": grid_mode,
                "beats": direct_beats,
                "beat_numbers": config_beat_numbers,
                "padding_count": capacity - len(direct_beats),
            }
        ]
        grid_batch_size = capacity
        grid_dir = episode_grids_dir / grid_mode
    else:
        if character_grouping:
            from novelvideo.generators.nanobanana_grid import character_grid_split

            scene_grid_plan = character_grid_split(beats_data, character_map)
            scene_grouping = False
        elif scene_grouping:
            from novelvideo.generators.nanobanana_grid import scene_grid_split

            scene_grid_plan = scene_grid_split(beats_data, character_map=character_map)

        if scene_grid_plan and grid_index < len(scene_grid_plan):
            entry = scene_grid_plan[grid_index]
            grid_dir = episode_grids_dir / entry.get("mode_key", grid_mode)
            grid_batch_size = int(entry["rows"]) * int(entry["cols"])
        else:
            if grid_mode in MODE_CONFIG:
                _, _, grid_batch_size = MODE_CONFIG[grid_mode]
            else:
                grid_batch_size = 25
            grid_dir = episode_grids_dir / grid_mode
    grid_dir.mkdir(parents=True, exist_ok=True)

    log(f"开始重新生成网格 {grid_index + 1}: mode={grid_mode}", progress=0.05)
    grid_gen = create_grid_generator(config=grid_config)
    log(f"[Render Image] provider={grid_gen.provider}, model={grid_gen.model}")

    all_beat_numbers = [beat.get("beat_number", idx + 1) for idx, beat in enumerate(beats_data)]
    beat_sketch_paths = build_beat_sketch_paths(str(episode_grids_dir), all_beat_numbers)
    result = await grid_gen.regenerate_single_grid(
        all_beats=beats_data,
        grid_index=grid_index,
        character_map=character_map,
        scene_menu=config.get("scene_menu"),
        prop_menu=config.get("prop_menu"),
        style=style,
        output_dir=str(grid_dir),
        ethnicity=ethnicity,
        grid_size=grid_batch_size,
        prompt_only=prompt_only,
        scene_grid_plan=scene_grid_plan,
        sketch_dir=str(paths.sketch_dir()) if paths.has_sketch() else "",
        beat_sketch_paths=beat_sketch_paths,
        sketch_aspect_padding=config.get("sketch_aspect_padding", False),
        force_image_size="0.5K" if config.get("force_half_k") else None,
    )
    if not result.success:
        raise RuntimeError(f"网格重新生成失败: {result.error}")

    if prompt_only:
        return {"prompt_only": True, "grid_index": grid_index}

    grid_rows = result.grid_rows or int(math.sqrt(grid_batch_size))
    grid_cols = result.grid_cols or grid_rows
    metadata_path = grid_dir / "metadata.json"
    if metadata_path.exists():
        with open(metadata_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
    else:
        metadata = {"grids": []}
    metadata["total_beats"] = len(beats_data)
    metadata["episode"] = episode
    metadata["rows"] = grid_rows
    metadata["cols"] = grid_cols
    metadata.setdefault("grids", [])

    beat_start = result.beat_start_index or 0
    grid_file_name = (
        Path(result.grid_image_path).name if result.grid_image_path else f"grid_{grid_index + 1:02d}.png"
    )
    grid_entry = {
        "file": grid_file_name,
        "rows": grid_rows,
        "cols": grid_cols,
        "beat_start": beat_start + 1,
        "beat_end": beat_start + grid_rows * grid_cols,
    }
    if config_beat_numbers:
        grid_entry["beat_numbers"] = config_beat_numbers
        grid_entry["beat_start"] = min(config_beat_numbers)
        grid_entry["beat_end"] = max(config_beat_numbers)
    if scene_grid_plan and grid_index < len(scene_grid_plan):
        plan_entry = scene_grid_plan[grid_index]
        grid_entry["beat_numbers"] = plan_entry["beat_numbers"]
        grid_entry["scene_id"] = plan_entry.get("scene_id", "")
        grid_entry["padding_count"] = plan_entry.get("padding_count", 0)

    existing_idx = next(
        (
            idx
            for idx, grid in enumerate(metadata["grids"])
            if grid.get("file") == grid_file_name
            or (
                config_beat_numbers
                and [int(beat) for beat in (grid.get("beat_numbers") or [])]
                == config_beat_numbers
            )
        ),
        None,
    )
    if existing_idx is not None:
        metadata["grids"][existing_idx] = grid_entry
    else:
        metadata["grids"].append(grid_entry)
        metadata["grids"].sort(key=lambda grid: grid["file"])
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    if scene_grid_plan and grid_index < len(scene_grid_plan):
        beat_indices = list(scene_grid_plan[grid_index]["beat_numbers"])
        effective_grid_mode = scene_grid_plan[grid_index].get("mode_key", grid_mode)
    else:
        beat_indices = [
            beat_start + offset + 1
            for offset in range(grid_rows * grid_cols)
            if beat_start + offset + 1 <= len(beats_data)
        ]
        effective_grid_mode = grid_mode

    log("切割网格到 render/ 并更新图片池...", progress=0.7)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    save_grid_and_split(
        grid_image_path=result.grid_image_path,
        episode_grids_dir=str(episode_grids_dir),
        grid_type="render",
        mode_key=effective_grid_mode,
        beat_nums=beat_indices,
        preset="custom",
        rows=grid_rows,
        cols=grid_cols,
        ts=ts,
        promote_dir=str(frames_dir),
        force_promote=True,
    )
    updated_frames = [
        str(frames_dir / f"beat_{int(bn):02d}.png")
        for bn in beat_indices
        if (frames_dir / f"beat_{int(bn):02d}.png").exists()
    ]
    if not updated_frames:
        raise RuntimeError(
            f"网格重生未生成可用图片（mode={effective_grid_mode}, grid_index={grid_index + 1}）"
        )

    result_payload = {
        "grid_index": grid_index,
        "grid_path": result.grid_image_path,
        "updated_frames": updated_frames,
        "beat_start": beat_start,
        "beat_count": len(updated_frames),
    }
    log(f"✅ 网格 {grid_index + 1} 重新生成完成", progress=1.0)
    return result_payload


def run_grid_regenerate(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_grid_regenerate_async(envelope, ctx),
            envelope,
            task_type="grid_regenerate",
        )
    )


register_project_task_runner("grid_regenerate", run_grid_regenerate)
