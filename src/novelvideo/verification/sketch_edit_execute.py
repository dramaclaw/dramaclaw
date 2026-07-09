"""Execute batch sketch edits from teacher-produced labels.jsonl."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from datetime import datetime
from json import JSONDecodeError
from pathlib import Path, PurePath
from typing import Any

from novelvideo.generators.grid_splitter import combine_to_grid
from novelvideo.generators.nanobanana_grid import (
    REGEN_MODE_CONFIGS,
    generate_reference_edit_image,
    get_sketch_nxn_modes,
)
from novelvideo.generators.pool_indexer import save_grid_and_split
from novelvideo.config import get_grid_generation_config
from novelvideo.verification.sketch_edit_label_validation import (
    LabelsValidationError,
    validate_labels_jsonl,
)

ProgressCallback = Callable[[float, str], None]
LogCallback = Callable[[str], None]


_STICK_FIGURE_STYLE_LOCK = (
    "STYLE LOCK (applies to every panel, non-negotiable):\n"
    "- Color-coded stick figure storyboard only; every panel must remain minimal line-art.\n"
    "- Named characters: round head + single-line torso + stick limbs only.\n"
    "- No facial features (no eyes, nose, mouth detail); no hair detail; no hands or fingers detail; no feet detail.\n"
    "- No clothing folds, no costume ornament, no fabric detail, no body volume, no muscles.\n"
    "- No realistic anatomy, no shading, no gradients, no semi-realistic human forms.\n"
    "- Unnamed extras remain neutral gray stick figures; do not promote extras to illustrated characters.\n"
    "- Preserve the original minimal line-art rendering of every retained panel; do NOT upgrade any panel to illustrated / rendered / shaded style even if that panel's specific instruction is silent on style.\n"
    "- If the current input panel already looks illustrated, correct it back to the stick-figure storyboard style while preserving the requested identities and staging."
)


def _rel_posix(path: Any, base: Path) -> str:
    """Contract-facing relative path: always posix separators."""
    return PurePath(os.path.relpath(str(path), base)).as_posix()


def _ensure_empty_cell_png(edit_dir: Path, reference_sketch_path: str) -> Path:
    """Return a cached pure-white PNG the same size as the reference sketch.

    Used to pad under-full sketch_edit grids so empty grid cells show as visually
    blank white tiles (instead of black fills from combine_to_grid), reinforcing
    the EMPTY panel instructions injected in _compose_edit_prompt.
    """
    empty_path = edit_dir / "_empty_cell.png"
    if empty_path.exists():
        return empty_path
    from PIL import Image  # Local import: executed only when padding is needed.
    with Image.open(reference_sketch_path) as ref:
        size = ref.size
    Image.new("RGB", size, color=(255, 255, 255)).save(empty_path)
    return empty_path


def _notify(progress_callback: ProgressCallback | None, progress: float, task: str) -> None:
    if progress_callback is not None:
        progress_callback(progress, task)


def _log(log_callback: LogCallback | None, message: str) -> None:
    if log_callback is not None:
        log_callback(message)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                rows.append(json.loads(text))
            except JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON ({exc})") from exc
    return rows


def resolve_labels_jsonl(project_dir: Path, episode_num: int, labels_name: str = "labels.jsonl") -> Path:
    reports_dir = project_dir / "verify_reports" / f"ep{episode_num:03d}"
    candidates = [
        reports_dir / labels_name,
        reports_dir / "labels.jsonl",
        reports_dir / "sketch_edit_labels.jsonl",
        reports_dir / "sketch_edit_labels.debug.jsonl",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    raise FileNotFoundError(f"No labels.jsonl found under {reports_dir}")


def _normalize_aspect_ratio(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = text.replace("-", ":").replace(" ", "")
    parts = normalized.split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return ""
    return f"{int(parts[0])}:{int(parts[1])}"


def _supported_sketch_aspect_ratios() -> list[str]:
    ratios = {
        _normalize_aspect_ratio(str(cfg.get("aspect_ratio") or ""))
        for mode_key, cfg in REGEN_MODE_CONFIGS.items()
        if mode_key.endswith("_sketch")
    }
    return sorted(ratio for ratio in ratios if ratio)


def _closest_supported_aspect_ratio(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return ""
    observed = width / height
    best_ratio = ""
    best_delta = float("inf")
    for ratio in _supported_sketch_aspect_ratios():
        w_text, h_text = ratio.split(":")
        target = int(w_text) / int(h_text)
        delta = abs(observed - target)
        if delta < best_delta:
            best_delta = delta
            best_ratio = ratio
    return best_ratio


def _infer_aspect_ratio_from_sketch_path(sketch_path: str) -> str:
    if not sketch_path:
        return ""
    try:
        from PIL import Image
    except ImportError:
        return ""
    try:
        with Image.open(sketch_path) as image:
            width, height = image.size
    except OSError:
        return ""
    return _closest_supported_aspect_ratio(width, height)


def _load_episode_sketch_aspect_ratio(project_dir: Path, episode_num: int) -> str:
    config_path = project_dir / "project_config.json"
    if not config_path.exists():
        try:
            from novelvideo.config import OUTPUT_DIR, STATE_DIR

            rel = project_dir.resolve().relative_to(Path(OUTPUT_DIR).resolve())
            config_path = Path(STATE_DIR).resolve() / rel / "project_config.json"
        except ValueError:
            pass
    if not config_path.exists():
        return ""
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    by_episode = payload.get("sketch_aspect_ratio_by_episode") or {}
    if isinstance(by_episode, dict):
        episode_ratio = _normalize_aspect_ratio(str(by_episode.get(str(episode_num)) or ""))
        if episode_ratio:
            return episode_ratio
    for key in ("sketch_aspect_ratio", "aspect_ratio"):
        ratio = _normalize_aspect_ratio(str(payload.get(key) or ""))
        if ratio:
            return ratio
    return ""


def _resolve_sketch_aspect_ratio(
    project_dir: Path,
    episode_num: int,
    revise_rows: list[dict[str, Any]],
) -> str:
    for row in revise_rows:
        ratio = _infer_aspect_ratio_from_sketch_path(str(row.get("sketch_path") or "").strip())
        if ratio:
            return ratio
    ratio = _load_episode_sketch_aspect_ratio(project_dir, episode_num)
    if ratio:
        return ratio
    return "2:3"


def _pick_batch_mode(remaining: int, aspect_ratio: str) -> tuple[str, int, int, int]:
    sketch_modes = get_sketch_nxn_modes(aspect_ratio=aspect_ratio)
    if remaining <= 0:
        return f"1x1_{aspect_ratio.replace(':', '-')}_sketch", 1, 1, 1
    # Match sketch grid batching:
    # - use the largest full page (5x5=25) while there are more than 25 panels left
    # - otherwise use the smallest NxN grid that can hold the remainder
    cap, mode_key, rows, cols = sketch_modes[-1]
    if remaining > cap:
        return mode_key, rows, cols, cap
    for cap, mode_key, rows, cols in sketch_modes:
        if remaining <= cap:
            return mode_key, rows, cols, cap
    cap, mode_key, rows, cols = sketch_modes[-1]
    return mode_key, rows, cols, cap


def _chunk_revise_rows(rows: list[dict[str, Any]], aspect_ratio: str) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    ordered = sorted(rows, key=lambda row: int(row.get("beat_number") or 0))
    max_batch_size_raw = os.environ.get("SKETCH_EDIT_MAX_BATCH_SIZE", "").strip()
    max_batch_size = 0
    if max_batch_size_raw:
        try:
            max_batch_size = max(1, int(max_batch_size_raw))
        except ValueError:
            raise ValueError(
                f"SKETCH_EDIT_MAX_BATCH_SIZE must be an integer, got {max_batch_size_raw!r}"
            ) from None
    index = 0
    while index < len(ordered):
        remaining = len(ordered) - index
        mode_remaining = min(remaining, max_batch_size) if max_batch_size else remaining
        mode_key, rows_n, cols_n, capacity = _pick_batch_mode(mode_remaining, aspect_ratio)
        batch_size = min(remaining, capacity, max_batch_size or capacity)
        batch = ordered[index:index + batch_size]
        chunks.append(
            {
                "mode_key": mode_key,
                "rows": rows_n,
                "cols": cols_n,
                "capacity": capacity,
                "rows_data": batch,
                "aspect_ratio": aspect_ratio,
                "execution_mode": "polish",
            }
        )
        index += len(batch)
    return chunks


def _get_sketch_edit_generation_config() -> dict[str, Any]:
    """Resolve the image-edit backend for sketch correction/director passes."""
    selection = os.environ.get("SKETCH_EDIT_IMAGE_SELECTION", "huimeng_gpt_image2")
    quality = os.environ.get("SKETCH_EDIT_IMAGE_QUALITY", "low")
    config = get_grid_generation_config(
        selection_override=selection,
        image_size_override=os.environ.get("SKETCH_EDIT_IMAGE_SIZE", "1K"),
    )
    config["openai_image_quality"] = quality
    config["openai_sketch_image_quality"] = quality
    config["huimeng_image_quality"] = quality
    config["image_size"] = os.environ.get("SKETCH_EDIT_IMAGE_SIZE", "1K")
    return config


def _compose_edit_prompt(
    batch_rows: list[dict[str, Any]],
    rows: int,
    cols: int,
    capacity: int | None = None,
    registry_negative_clause: str = "",
    director_reference_note: str = "",
) -> str:
    revisions = len(batch_rows)
    if capacity is None:
        capacity = rows * cols
    if capacity < revisions:
        capacity = revisions
    header = (
        f"Edit this {rows}x{cols} storyboard sketch grid with {capacity} panel slots "
        f"({revisions} with revisions, the rest are intentionally empty)."
        if capacity > revisions
        else f"Edit this {rows}x{cols} storyboard sketch grid."
    )
    lines = [
        header,
        "Keep panel order, panel count, identities, and scene continuity unchanged unless a panel-specific instruction says otherwise.",
        "Output exactly the requested grid layout and nothing else: no comparison sheet, no alternate variants, no split-screen, no inset panels, no reference thumbnails.",
        "For a 1x1 grid, return one single full-bleed storyboard panel only.",
        "Treat each panel edit as a replacement of the panel composition, not as an additive overlay on top of the old panel.",
        "If a panel-specific instruction removes, reduces, or narrows subjects, you must delete the superseded old figures instead of keeping them.",
        "Obey subject count strictly: if the instruction implies exactly one visible main figure in a layer or area, do not leave duplicates.",
        "Do not preserve outdated figures, duplicate silhouettes, or old staging that conflicts with the new instruction.",
        "Named identity colors are a HARD requirement in edit mode.",
        "Every named figure must use its exact assigned sketch identity color, not a nearby variant.",
        "Do not drift an identity toward a neighboring hue family such as pink, purple, blue, orange, or gray when a different exact identity color was requested.",
        "Do not apply the identity color only to tiny accents such as nails, lips, ornaments, or a small patch.",
        "The named figure's visible body must read clearly in its assigned identity color.",
        "Unnamed extras must stay neutral gray.",
        "When a panel-specific instruction describes a one-sided interaction such as grabbing, restraining, feeding, forcing, handing-over, or pressing, do not render it as a symmetric or mutual gesture.",
        "Keep the active actor active and the passive actor passive; do not turn unilateral contact into a handshake, mirrored reach, or equal two-way pose.",
        "If the instruction says only one arm, one hand, or one visible gesture should come from a figure, do not invent a matching opposite-side limb.",
        _STICK_FIGURE_STYLE_LOCK,
    ]
    if director_reference_note:
        lines.append(director_reference_note)
    if registry_negative_clause:
        lines.append(registry_negative_clause)
    lines.extend([
        "Return one edited storyboard grid image with the same grid layout.",
        "Panel-specific revisions:",
    ])
    for idx, row in enumerate(batch_rows, start=1):
        beat_number = int(row.get("beat_number") or 0)
        instruction = (
            ((row.get("result") or {}).get("edit_instruction"))
            or ""
        ).strip()
        if not instruction:
            instruction = "Keep this panel unchanged."
        lines.append(f"- Panel {idx} / beat {beat_number}: {instruction}")
        color_tokens = []
        for color_row in row.get("sketch_colors") or []:
            identity = str(color_row.get("identity") or "").strip()
            color_value = str(color_row.get("color_value") or "").strip()
            if identity and color_value:
                color_tokens.append(f"{identity} {color_value}")
        if color_tokens:
            lines.append(f"  Required identity colors: {' | '.join(color_tokens)}")
            lines.append(
                "  Use these colors only for the named figures that should remain visible after the edit; "
                "if the instruction deletes or removes a figure, do not keep it just because its color is listed."
            )
    for idx in range(revisions + 1, capacity + 1):
        lines.append(
            f"- Panel {idx}: EMPTY — render a solid blank white panel, no figures, no props, "
            "no background marks, no text. Do not fill this panel with any content."
        )
    lines.append("Do not add text overlays or watermarks.")
    return "\n".join(lines)


def _derive_saved_prompt_relpath(mode_key: str, beat_numbers: list[int]) -> str:
    beats_str = "-".join(str(beat) for beat in beat_numbers)
    return str(Path("edit") / f"sketch_{mode_key}_{beats_str}_prompt.txt")


def _derive_execute_artifact_names(labels_path: Path) -> tuple[str, str]:
    stem = labels_path.stem
    if stem == "storyboard_labels":
        return "storyboard_director_execute_summary.json", "storyboard_director_execute_audit"
    return "sketch_edit_execute_summary.json", "sketch_edit_execute_audit"


def derive_audit_dir_name(summary_name: str) -> str:
    """Inverse of the summary→audit pairing in _derive_execute_artifact_names.

    Gate + copy_back both need to resolve the audit dir from the summary
    filename alone; without this, director-phase runs silently wrote gate
    audit + read copy-back from the correction-phase audit dir.
    """
    if summary_name.endswith("_summary.json"):
        return summary_name[: -len("_summary.json")] + "_audit"
    return "sketch_edit_execute_audit"


def _write_batch_audit(
    *,
    reports_dir: Path,
    audit_dir_name: str,
    ts: str,
    batch_index: int,
    execution_mode: str,
    beat_numbers: list[int],
    payload: dict[str, Any],
) -> Path:
    audit_dir = reports_dir / audit_dir_name
    audit_dir.mkdir(parents=True, exist_ok=True)
    beats_str = "-".join(str(beat) for beat in beat_numbers)
    audit_path = audit_dir / f"batch_{batch_index:02d}_{execution_mode}_{beats_str}_{ts}.json"
    audit_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return audit_path


def execute_sketch_edit_batches(
    *,
    project_dir: Path,
    episode_num: int,
    labels_path: Path,
    progress_callback: ProgressCallback | None = None,
    log_callback: LogCallback | None = None,
) -> dict[str, Any]:
    project_dir = project_dir.expanduser().resolve()
    labels_path = labels_path.expanduser().resolve()
    if not labels_path.is_relative_to(project_dir):
        raise ValueError(f"labels_path escapes project dir: {labels_path} is not under {project_dir}")
    reports_dir = project_dir / "verify_reports" / f"ep{episode_num:03d}"
    summary_name, audit_dir_name = _derive_execute_artifact_names(labels_path)
    episode_grids_dir = project_dir / "grids" / f"ep{episode_num:03d}"
    edit_dir = episode_grids_dir / "edit"
    reports_dir.mkdir(parents=True, exist_ok=True)
    episode_grids_dir.mkdir(parents=True, exist_ok=True)
    edit_dir.mkdir(parents=True, exist_ok=True)

    _notify(progress_callback, 0.03, "校验 labels.jsonl")
    try:
        validate_labels_jsonl(labels_path)
    except LabelsValidationError as exc:
        raise ValueError(str(exc)) from exc

    _notify(progress_callback, 0.05, "读取 labels.jsonl")
    rows = _read_jsonl(labels_path)
    revise_rows = [
        row for row in rows
        if ((row.get("result") or {}).get("decision") or "").strip().lower() == "revise"
    ]
    if not revise_rows:
        raise ValueError(f"No revise rows found in {labels_path}")
    sketch_aspect_ratio = _resolve_sketch_aspect_ratio(project_dir, episode_num, revise_rows)
    _notify(progress_callback, 0.12, "拆分 edit batches")
    batches: list[dict[str, Any]] = []
    for batch in _chunk_revise_rows(revise_rows, sketch_aspect_ratio):
        batches.append(batch)
    generator_results: list[dict[str, Any]] = []
    updated_beats: list[int] = []
    ts = datetime.now().strftime("%Y%m%d%H%M%S")

    import asyncio as _asyncio_registry
    from novelvideo.verification.failure_registry import (
        load_negative_clause_for_project,
    )

    registry_layers = ["correction"]
    if labels_path.stem == "storyboard_labels":
        registry_layers.append("director")
    registry_negative_clauses: list[str] = []
    for registry_layer in registry_layers:
        clause = _asyncio_registry.run(
            load_negative_clause_for_project(str(project_dir), registry_layer)
        )
        if clause:
            registry_negative_clauses.append(clause)
    registry_negative_clause = "\n".join(registry_negative_clauses)
    edit_generator_config = _get_sketch_edit_generation_config()
    edit_image_quality = str(
        os.environ.get("SKETCH_EDIT_IMAGE_QUALITY")
        or edit_generator_config.get("huimeng_image_quality")
        or edit_generator_config.get("openai_image_quality")
        or "low"
    )
    edit_image_size = str(os.environ.get("SKETCH_EDIT_IMAGE_SIZE") or "1K")

    # Director-OS phase 2: deterministic run_id shared by every trace in
    # this execute() invocation. Each beat in each batch gets its own
    # trace_id with this as grouping key, so `find_traces_for_run` later
    # returns the full {beat → trace_id} map for gate / copy-back hooks.
    source_run_id_for_traces = f"edit_exec__{ts}"

    for batch_index, batch in enumerate(batches, start=1):
        batch_rows = batch["rows_data"]
        beat_numbers = [int(row.get("beat_number") or 0) for row in batch_rows]
        mode_key = str(batch["mode_key"])
        rows_n = int(batch["rows"])
        cols_n = int(batch["cols"])
        execution_mode = str(batch.get("execution_mode") or "polish")
        beats_str = "-".join(str(beat) for beat in beat_numbers)
        progress = 0.12 + (batch_index - 1) / max(len(batches), 1) * 0.75
        _notify(progress_callback, progress, f"{execution_mode} batch {batch_index}/{len(batches)}")
        batch_logs = [f"batch {batch_index}: execution_mode={execution_mode}, mode={mode_key}, beats={beat_numbers}"]
        _log(log_callback, batch_logs[-1])

        sketch_paths = [str(row.get("sketch_path") or "").strip() for row in batch_rows]
        for path in sketch_paths:
            if not path or not Path(path).exists():
                raise FileNotFoundError(f"Missing sketch_path in batch {batch_index}: {sketch_paths}")
            resolved = Path(path).resolve()
            if not resolved.is_relative_to(project_dir):
                raise ValueError(
                    f"sketch_path escapes project dir: {path} is not under {project_dir}"
                )

        input_grid_path: Path | None = None
        output_grid_path = edit_dir / f"edit_output_{mode_key}_{beats_str}_{ts}.png"
        image_size = edit_image_size or REGEN_MODE_CONFIGS.get(mode_key, {}).get("image_size", "1K")
        aspect_ratio = REGEN_MODE_CONFIGS.get(mode_key, {}).get("aspect_ratio", "2:3")
        reference_images: list[str] = []
        prompt_text = ""
        submitted_prompt_file: Path | None = None
        import asyncio

        capacity = int(batch.get("capacity") or rows_n * cols_n)
        director_reference_note = ""
        grid_paths = list(sketch_paths)
        if len(grid_paths) < capacity:
            empty_cell_path = _ensure_empty_cell_png(edit_dir, grid_paths[0])
            grid_paths.extend([str(empty_cell_path)] * (capacity - len(grid_paths)))

        input_grid_path = edit_dir / f"edit_input_{mode_key}_{beats_str}_{ts}.png"
        combine_to_grid(grid_paths, input_grid_path, rows=rows_n, cols=cols_n)
        reference_images = [str(input_grid_path)]
        prompt_text = _compose_edit_prompt(
            batch_rows,
            rows_n,
            cols_n,
            capacity=capacity,
            registry_negative_clause=registry_negative_clause,
            director_reference_note=director_reference_note,
        )
        # Director-OS phase 2: per-beat-attempt trace capture (stage 1).
        # One TraceHandle per beat in the batch; they share source_run_id
        # + prompt_text + input grid but have distinct trace_ids.
        from novelvideo.verification import replay_capture as _trace_mod

        trace_handles: list[_trace_mod.TraceHandle] = []
        for row in batch_rows:
            bn = int(row.get("beat_number") or 0)
            try:
                handle = _trace_mod.begin_trace_for_beat_sync(
                    project_dir=project_dir,
                    episode_number=episode_num,
                    beat_number=bn,
                    source_run_id=source_run_id_for_traces,
                    model_name=str(edit_generator_config.get("model") or "sketch_edit_default"),
                    trace_kind="live",
                    edit_instruction=((row.get("result") or {}).get("edit_instruction") or "").strip() or None,
                    input_sketch_path=Path(str(row.get("sketch_path") or "")).resolve()
                    if row.get("sketch_path")
                    else None,
                    input_grid_path=input_grid_path,
                )
            except Exception as exc:  # noqa: BLE001
                # Best-effort capture; pipeline continues regardless.
                _log(log_callback, f"trace_begin_failed beat={bn}: {exc}")
                handle = _trace_mod._disabled_handle()
            trace_handles.append(handle)

        retry_count_raw = os.environ.get("SKETCH_EDIT_IMAGE_RETRIES", "1").strip()
        try:
            retry_count = max(0, int(retry_count_raw))
        except ValueError:
            raise ValueError(
                f"SKETCH_EDIT_IMAGE_RETRIES must be an integer, got {retry_count_raw!r}"
            ) from None
        last_error: Exception | None = None
        for attempt in range(retry_count + 1):
            try:
                asyncio.run(
                    generate_reference_edit_image(
                        prompt=prompt_text,
                        reference_images=reference_images,
                        output_path=str(output_grid_path),
                        aspect_ratio=aspect_ratio,
                        image_size=image_size,
                        quality=edit_image_quality,
                        config=edit_generator_config,
                    )
                )
                last_error = None
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt >= retry_count:
                    break
                _log(
                    log_callback,
                    f"image_generation_retry beat(s)={beat_numbers} "
                    f"attempt={attempt + 1}/{retry_count + 1}: {exc}",
                )
        if last_error is not None:
            raise last_error

        # Stage 2: record the (shared) prompt for every beat. The
        # content-addressable store dedups — N beats in this batch all
        # point at the same prompt artifact bytes.
        for handle in trace_handles:
            try:
                _trace_mod.record_prompt_and_response_sync(
                    handle,
                    prompt_text=prompt_text,
                )
            except Exception as exc:  # noqa: BLE001
                _log(log_callback, f"trace_prompt_record_failed trace_id={handle.trace_id}: {exc}")
        batch_logs.append(
            f"polish reference edit with input grid -> {input_grid_path.relative_to(project_dir)}"
        )
        _log(log_callback, batch_logs[-1])

        save_result = save_grid_and_split(
            grid_image_path=output_grid_path,
            episode_grids_dir=str(episode_grids_dir),
            grid_type="sketch",
            mode_key=mode_key,
            beat_nums=beat_numbers,
            preset="edit",
            rows=rows_n,
            cols=cols_n,
            ts=ts,
            prompt_text=prompt_text,
        )
        if submitted_prompt_file is None and prompt_text:
            submitted_prompt_file = episode_grids_dir / _derive_saved_prompt_relpath(mode_key, beat_numbers)

        rel_path = _rel_posix(save_result["grid_path"], project_dir)
        cell_paths_abs = [Path(str(cell_path)) for cell_path in (save_result.get("cell_paths") or [])]
        rel_cell_paths = [
            _rel_posix(str(cell_path), project_dir) for cell_path in cell_paths_abs
        ]
        batch_logs.append(f"完成 batch {batch_index}: {rel_path}")
        _log(log_callback, batch_logs[-1])

        # Stage 2.5: write per-beat output artifact onto each trace row.
        # save_grid_and_split returns cell_paths in beat_nums order; zip
        # against our trace handles which were built in batch_rows order.
        for handle, cell_path in zip(trace_handles, cell_paths_abs):
            try:
                _trace_mod.record_execute_output_sync(
                    handle,
                    output_sketch_path=cell_path,
                    output_grid_path=Path(str(save_result["grid_path"])),
                )
            except Exception as exc:  # noqa: BLE001
                _log(log_callback, f"trace_exec_output_record_failed trace_id={handle.trace_id}: {exc}")
        audit_payload = {
            "project_dir": str(project_dir),
            "episode_num": episode_num,
            "batch_index": batch_index,
            "execution_mode": execution_mode,
            "aspect_ratio": str(batch.get("aspect_ratio") or sketch_aspect_ratio),
            "mode_key": mode_key,
            "beat_numbers": beat_numbers,
            "submitted_prompt_text": prompt_text,
            "submitted_prompt_file": (
                _rel_posix(str(submitted_prompt_file), project_dir)
                if submitted_prompt_file and submitted_prompt_file.exists()
                else None
            ),
            "submitted_reference_images": [
                _rel_posix(path, project_dir) for path in reference_images
            ],
            "image_provider": edit_generator_config.get("provider"),
            "image_model": edit_generator_config.get("model"),
            "image_size": image_size,
            "image_quality": edit_image_quality,
            "batch_logs": batch_logs,
            "saved_grid_path": rel_path,
            "candidate_cell_paths": rel_cell_paths,
        }
        audit_path = _write_batch_audit(
            reports_dir=reports_dir,
            audit_dir_name=audit_dir_name,
            ts=ts,
            batch_index=batch_index,
            execution_mode=execution_mode,
            beat_numbers=beat_numbers,
            payload=audit_payload,
        )
        generator_results.append(
            {
                "batch_index": batch_index,
                "execution_mode": execution_mode,
                "aspect_ratio": str(batch.get("aspect_ratio") or sketch_aspect_ratio),
                "mode_key": mode_key,
                "beat_nums": beat_numbers,
                "input_grid_path": (
                    _rel_posix(str(input_grid_path), project_dir) if input_grid_path else None
                ),
                "output_grid_path": _rel_posix(str(output_grid_path), project_dir),
                "submitted_prompt_text": prompt_text,
                "submitted_prompt_file": audit_payload["submitted_prompt_file"],
                "submitted_reference_images": audit_payload["submitted_reference_images"],
                "image_provider": audit_payload["image_provider"],
                "image_model": audit_payload["image_model"],
                "image_size": audit_payload["image_size"],
                "image_quality": audit_payload["image_quality"],
                "batch_logs": batch_logs,
                "audit_json": _rel_posix(str(audit_path), project_dir),
                "saved_grid_path": rel_path,
                "candidate_cell_paths": rel_cell_paths,
            }
        )
        updated_beats.extend(beat_numbers)

    _notify(progress_callback, 0.94, "写入 edit 执行摘要")
    summary = {
        "project_dir": str(project_dir),
        "episode_num": episode_num,
        "labels_jsonl": str(labels_path),
        "sketch_aspect_ratio": sketch_aspect_ratio,
        "batch_count": len(generator_results),
        "revised_beats": updated_beats,
        "candidate_beats": updated_beats,
        "updated_beats": updated_beats,
        "grid_results": generator_results,
        # Director-OS phase 2: let downstream gate / copy-back find the
        # trace rows this execute pass created.
        "source_run_id": source_run_id_for_traces,
    }
    summary_path = reports_dir / summary_name
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["summary_json"] = str(summary_path)
    _notify(progress_callback, 1.0, "完成")
    return summary
