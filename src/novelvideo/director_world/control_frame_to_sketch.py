"""Convert a Director Render control frame into the selected beat sketch.

This is the explicit "3GS control frame -> production sketch" bridge used by
the PlayCanvas director stage. It keeps the render pipeline unified: downstream
rendering consumes sketches/epNNN/beat_MM.png, never the raw 3GS screenshot.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from novelvideo.config import OUTPUT_DIR, STATE_DIR, get_sketch_generation_config
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.generators.nanobanana_grid import REGEN_MODE_CONFIGS, NanoBananaGridGenerator
from novelvideo.generators.pool_indexer import save_grid_and_split
from novelvideo.project_config import load_project_config_file
from novelvideo.services.character_ref_service import build_character_map_for_grid
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.utils.path_resolver import PathResolver, compute_scoped_grid_filename


def _json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _character_dicts(store: SQLiteStore, project_dir: Path) -> list[dict[str, Any]]:
    characters: list[dict[str, Any]] = []
    for character in store.get_all_characters():
        item = character.model_dump()
        item["portrait_path"] = str(
            project_dir / "assets" / "characters" / character.name / "portrait.png"
        )
        item["identities"] = [identity.model_dump() for identity in character.identities]
        characters.append(item)
    return characters


def _mode_key_for_aspect(aspect_ratio: str | None) -> str:
    normalized = (aspect_ratio or "").strip()
    if normalized == "16:9":
        return "1x1_16-9_sketch"
    if normalized == "9:16":
        return "1x1_9-16_sketch"
    if normalized == "1:1":
        return "1x1_1-1_sketch"
    return "1x1_2-3_sketch"


def _control_frame_aspect_ratio(control_frame: Path) -> str:
    """Pick the closest supported 1x1 sketch aspect from combined.png itself."""

    try:
        from PIL import Image

        with Image.open(control_frame) as img:
            width, height = img.size
    except Exception:
        return ""

    if width <= 0 or height <= 0:
        return ""
    ratio = width / height
    supported = {
        "16:9": 16 / 9,
        "9:16": 9 / 16,
        "1:1": 1.0,
        "2:3": 2 / 3,
    }
    return min(supported, key=lambda key: abs(ratio - supported[key]))


def _director_control_mode_key(
    *,
    control_frame: Path,
    requested_mode_key: str,
    requested_aspect_ratio: str,
) -> tuple[str, str]:
    """Pick a 1x1 sketch mode for director-control conversion."""

    if requested_mode_key:
        key = _validate_mode_key(requested_mode_key)
        return key, str(REGEN_MODE_CONFIGS[key].get("aspect_ratio") or "")
    if requested_aspect_ratio:
        key = _validate_mode_key(_mode_key_for_aspect(requested_aspect_ratio))
        return key, str(REGEN_MODE_CONFIGS[key].get("aspect_ratio") or "")

    frame_aspect = _control_frame_aspect_ratio(control_frame)
    aspect = frame_aspect or (requested_aspect_ratio or "").strip() or "16:9"
    key = _validate_mode_key(_mode_key_for_aspect(aspect))
    return key, aspect


def _validate_mode_key(mode_key: str) -> str:
    key = (mode_key or "").strip() or "1x1_2-3_sketch"
    cfg = REGEN_MODE_CONFIGS.get(key)
    if not cfg:
        raise ValueError(f"unknown sketch mode_key: {key}")
    if int(cfg.get("rows") or 0) != 1 or int(cfg.get("cols") or 0) != 1:
        raise ValueError(f"director control conversion only supports 1x1 modes, got: {key}")
    return key


def _load_json(path: Path) -> dict[str, Any] | list[Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _beat_nav_items(value: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if "episode" in value and "beat" in value:
            items.append(value)
        for child in value.values():
            items.extend(_beat_nav_items(child))
    elif isinstance(value, list):
        for child in value:
            items.extend(_beat_nav_items(child))
    return items


def _director_visual_description(project_dir: Path, episode: int, beat: int) -> str:
    """Prefer the live DirectorWorld beat context over stale generated script text."""

    nav = _load_json(project_dir / "director_blockings" / "beat_nav.json")
    for item in _beat_nav_items(nav):
        if int(item.get("episode") or 0) == episode and int(item.get("beat") or 0) == beat:
            text = str(item.get("visual_description") or "").strip()
            if text:
                return text

    overlay = _load_json(
        project_dir / "director_blockings" / f"ep{episode:03d}" / f"beat_{beat:02d}.json"
    )
    if isinstance(overlay, dict):
        text = str(overlay.get("visual_description") or "").strip()
        if text:
            return text
    return ""


def _resolve_control_frames_dir(project_dir: Path, control_frames_dir: str | Path | None) -> Path:
    default_dir = project_dir / "director_control_frames"
    if not control_frames_dir:
        return default_dir
    candidate = Path(control_frames_dir).resolve()
    allowed = {
        default_dir.resolve(),
        (project_dir / "freezone" / "director_control_frames").resolve(),
    }
    if candidate not in allowed:
        raise ValueError(f"control_frames_dir does not match project: {candidate}")
    return candidate


def _resolve_control_frame_path(
    *,
    project_dir: Path,
    episode: int,
    beat: int,
    control_frames_dir: str | Path | None,
    control_frame_path: str | Path | None,
) -> tuple[Path, Path]:
    control_frames_root = _resolve_control_frames_dir(project_dir, control_frames_dir)
    if not control_frame_path:
        return (
            control_frames_root / f"ep{episode:03d}" / f"beat_{beat:02d}" / "combined.png",
            control_frames_root,
        )

    candidate = Path(control_frame_path).resolve()
    project_root = project_dir.resolve()
    try:
        candidate.relative_to(project_root)
    except ValueError as exc:
        raise ValueError(f"control_frame_path escapes project: {candidate}") from exc

    for root in (
        (project_dir / "director_control_frames").resolve(),
        (project_dir / "freezone" / "director_control_frames").resolve(),
    ):
        try:
            candidate.relative_to(root)
            return candidate, root
        except ValueError:
            continue
    return candidate, control_frames_root


def _hex_from_color_string(value: str) -> str:
    import re

    match = re.search(r"#[0-9A-Fa-f]{6}", str(value or ""))
    return match.group(0).lower() if match else ""


def _canonical_actor_colors(
    *,
    frame_meta: dict[str, Any],
    sketch_colors: dict[str, str],
) -> dict[str, str]:
    colors: dict[str, str] = {}
    for actor in frame_meta.get("actors") or []:
        if not isinstance(actor, dict):
            continue
        identity_id = str(
            actor.get("identity_id") or actor.get("name") or actor.get("id") or ""
        ).strip()
        if not identity_id:
            continue
        canonical = _hex_from_color_string(sketch_colors.get(identity_id, ""))
        if canonical:
            colors[identity_id] = canonical
    return colors


def _write_canonical_director_ref(
    *,
    control_frame: Path,
    frame_meta: dict[str, Any],
    sketch_colors: dict[str, str],
) -> Path:
    """Create combined_sketch_ref.png with actor marker colors matching sketch_colors.

    The PlayCanvas stage may contain stale/manual marker colors. For sketch
    conversion, the image reference, prompt COLOR LAW, and downstream render
    color detection must use the same canonical identity colors.
    """

    from PIL import Image

    canonical_by_identity = _canonical_actor_colors(
        frame_meta=frame_meta, sketch_colors=sketch_colors
    )
    if not canonical_by_identity:
        return control_frame

    actual_to_canonical: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    for actor in frame_meta.get("actors") or []:
        if not isinstance(actor, dict):
            continue
        identity_id = str(
            actor.get("identity_id") or actor.get("name") or actor.get("id") or ""
        ).strip()
        actual_hex = _hex_from_color_string(str(actor.get("marker_color") or ""))
        canonical_hex = canonical_by_identity.get(identity_id, "")
        if not actual_hex or not canonical_hex:
            continue
        actual = tuple(int(actual_hex[i : i + 2], 16) for i in (1, 3, 5))
        canonical = tuple(int(canonical_hex[i : i + 2], 16) for i in (1, 3, 5))
        actual_to_canonical[actual] = canonical

    if not actual_to_canonical:
        return control_frame

    img = Image.open(control_frame).convert("RGBA")
    mask_path = control_frame.with_name("actor_mask.png")
    mask = Image.open(mask_path).convert("L") if mask_path.exists() else None
    pixels = img.load()
    mask_pixels = mask.load() if mask else None
    width, height = img.size
    threshold = 72

    for y in range(height):
        for x in range(width):
            if mask_pixels is not None and mask_pixels[x, y] < 8:
                continue
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            best: tuple[int, int, int] | None = None
            best_dist = 10**9
            for actual, canonical in actual_to_canonical.items():
                dist = abs(r - actual[0]) + abs(g - actual[1]) + abs(b - actual[2])
                if dist < best_dist:
                    best_dist = dist
                    best = canonical
            if best is not None and best_dist <= threshold:
                pixels[x, y] = (best[0], best[1], best[2], a)

    out = control_frame.with_name("combined_sketch_ref.png")
    img.save(out)
    manifest = {
        "source": str(control_frame),
        "output": str(out),
        "reason": "canonicalize actor marker colors for 3GS control -> sketch",
        "actor_colors": [
            {
                "identity_id": actor.get("identity_id") or actor.get("name") or actor.get("id"),
                "source_marker_color": actor.get("marker_color"),
                "canonical_marker_color": canonical_by_identity.get(
                    str(
                        actor.get("identity_id") or actor.get("name") or actor.get("id") or ""
                    ).strip()
                ),
            }
            for actor in frame_meta.get("actors") or []
            if isinstance(actor, dict)
        ],
    }
    out.with_name("combined_sketch_ref.manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return out


def _director_augmented_beat(
    *,
    beat_payload: dict[str, Any],
    project_dir: Path,
    episode: int,
    beat: int,
    frame_meta: dict[str, Any],
) -> dict[str, Any]:
    payload = dict(beat_payload)
    visual_description = _director_visual_description(project_dir, episode, beat)
    if visual_description:
        payload["visual_description"] = visual_description
    if frame_meta.get("scene_id") and not payload.get("scene_id"):
        payload["scene_id"] = frame_meta.get("scene_id")
    actor_ids = [
        str(actor.get("identity_id") or "").strip()
        for actor in frame_meta.get("actors") or []
        if isinstance(actor, dict) and str(actor.get("identity_id") or "").strip()
    ]
    if actor_ids:
        payload["director_control_identities"] = actor_ids
    staging_items: list[dict[str, str]] = []
    for prop in frame_meta.get("props") or []:
        if not isinstance(prop, dict):
            continue
        prop_type = str(prop.get("type") or "").strip()
        category = str(prop.get("category") or "").strip()
        shape_hint = str(prop.get("shape_hint") or "").strip()
        is_staging = prop_type == "prop_staging" or category == "staging"
        if not is_staging:
            continue
        label = str(
            prop.get("semantic_label")
            or prop.get("name")
            or prop.get("prop_id")
            or prop.get("id")
            or ""
        ).strip()
        if not label:
            continue
        staging_items.append(
            {
                "label": label,
                "shape_hint": shape_hint,
                "marker_color": str(prop.get("marker_color") or "").strip(),
                "attached_to": str(prop.get("attached_to") or "").strip(),
                "scale": ", ".join(str(v) for v in (prop.get("scale") or []) if v is not None),
            }
        )
    if staging_items:
        payload["director_staging_items"] = staging_items
    return payload


async def convert_control_frame_to_sketch(
    *,
    user: str,
    project: str,
    episode: int,
    beat: int,
    mode_key: str = "",
    aspect_ratio: str = "",
    output_dir: str | Path | None = None,
    state_dir: str | Path | None = None,
    control_frames_dir: str | Path | None = None,
    control_frame_path: str | Path | None = None,
    require_control_frame_path: bool = False,
    candidate_output_path: str | Path | None = None,
    promote: bool = True,
    egress_context: TrustedEgressContext | None = None,
) -> dict[str, Any]:
    """把控制帧转成草图。**会出网**：下游经 NanoBananaGridGenerator 请求图像 provider。

    `egress_context` 声明的是这个事实——`freezone.py:FREEZONE_LEAF_EGRESS` 判本函数
    为 NETWORK 的依据就是它，没有它签名就在谎称「本函数不出网」。

    它**不**继续往 `generate_grid` 里传：那个方法 39 个形参、没有这一项，穿进去等于
    对整条内部链路做一次签名扫荡。也不需要——身份已由
    `task_backend/run_core.py:695` 的 `model_gateway_scope_for_runner(envelope)` 在
    派发处中心绑定，`nanobanana_grid.py:_call_newapi_image_api_with_egress`（`generate_grid`
    的 newapi 分支经它出网）在显式参数为 None 时读作用域。

    这条前提在 OI-52 修好之前对本路径是**假的**：`generate_grid` 当时根本不经过任何
    闸门，组织流量在这里无 claim、无组织凭证。钉住它的是
    `tests/test_p0g4i_freezone_leaf_classification.py`（作用域可达）与
    `tests/test_p0g4k_grid_family_image_egress.py`（`generate_grid` 真的读了它），
    不是默认成立。
    """

    del egress_context
    user = (user or "").strip()
    project = (project or "").strip()
    if not user or not project:
        raise ValueError("missing user/project")
    if episode <= 0:
        raise ValueError("episode must be positive")
    if beat <= 0:
        raise ValueError("beat must be positive")

    project_name = f"{user}/{project}"
    project_dir = Path(output_dir or (Path(OUTPUT_DIR) / user / project)).resolve()
    state_project_dir = Path(state_dir or (Path(STATE_DIR) / user / project)).resolve()
    paths = PathResolver(str(project_dir), episode)
    if require_control_frame_path and not control_frame_path:
        raise ValueError("control_frame_path is required for canvas-connected skill runs")
    control_frame, control_frames_root = _resolve_control_frame_path(
        project_dir=project_dir,
        episode=episode,
        beat=beat,
        control_frames_dir=control_frames_dir,
        control_frame_path=control_frame_path,
    )
    if not control_frame.exists():
        raise FileNotFoundError(
            f"missing Director Render control frame; export it first: {control_frame}"
        )

    effective_mode_key, effective_aspect_ratio = _director_control_mode_key(
        control_frame=control_frame,
        requested_mode_key=mode_key,
        requested_aspect_ratio=aspect_ratio,
    )
    cfg = REGEN_MODE_CONFIGS[effective_mode_key]
    rows = int(cfg.get("rows") or 1)
    cols = int(cfg.get("cols") or 1)

    store = SQLiteStore(
        project_name,
        output_dir=str(project_dir),
        state_dir=str(state_project_dir),
    )
    try:
        await store.initialize()
        await store.load_graph_state()
        script = await store.get_script_as_dict(episode)
        if not script or not script.get("beats"):
            raise ValueError(f"episode {episode} has no beats")

        beats_all = list(script.get("beats") or [])
        beat_by_number = {
            int(item.get("beat_number") or idx + 1): item for idx, item in enumerate(beats_all)
        }
        if beat not in beat_by_number:
            raise ValueError(f"beat {beat} not found in episode {episode}")

        frame_meta_path = control_frame.parent / "frame_meta.json"
        frame_meta_raw = _load_json(frame_meta_path)
        frame_meta = frame_meta_raw if isinstance(frame_meta_raw, dict) else {}

        sketch_colors = dict(script.get("sketch_colors") or store.get_sketch_colors(episode) or {})
        if not sketch_colors:
            raise ValueError("missing sketch_colors; assign sketch colors before conversion")
        # Do not color-correct the screenshot here. Marker identity/color must be
        # correct in the PlayCanvas state and frame_meta before export; this
        # conversion only turns the current control frame into a sketch.
        director_ref = control_frame

        style_config = load_project_config_file(user, project)
        style = style_config.get("visual_style", "chinese_period_drama")
        characters = _character_dicts(store, project_dir)
        character_map = build_character_map_for_grid(
            beats_all,
            characters,
            Path(OUTPUT_DIR) / user,
            project,
            sketch_colors=sketch_colors,
        )

        beat_payload = _director_augmented_beat(
            beat_payload=beat_by_number[beat],
            project_dir=project_dir,
            episode=episode,
            beat=beat,
            frame_meta=frame_meta,
        )
        scene_menu = list(script.get("scene_menu") or [])
        prop_menu = list(script.get("prop_menu") or [])

        director_selection = os.environ.get(
            "DIRECTOR_CONTROL_SKETCH_IMAGE_SELECTION"
        ) or style_config.get("sketch_image_selection")
        generator_config = get_sketch_generation_config(
            selection_override=director_selection,
        )
        generator_config["image_size"] = os.environ.get(
            "DIRECTOR_CONTROL_SKETCH_IMAGE_SIZE",
            generator_config.get("image_size") or "1K",
        )
        sketch_quality = os.environ.get("DIRECTOR_CONTROL_SKETCH_IMAGE_QUALITY", "low")
        generator_config["openai_image_quality"] = sketch_quality
        generator_config["openai_sketch_image_quality"] = sketch_quality
        generator_config["huimeng_image_quality"] = sketch_quality
        generator_config["quality"] = sketch_quality
        generator = NanoBananaGridGenerator(config=generator_config)
        if generator.provider not in {"openai", "huimeng", "openrouter", "google", "newapi"}:
            raise RuntimeError(
                "director control sketch conversion requires an image provider, "
                f"got provider={generator.provider}"
            )

        if candidate_output_path:
            output_path = Path(candidate_output_path).resolve()
            try:
                output_path.relative_to(project_dir)
            except ValueError as exc:
                raise ValueError(f"candidate_output_path escapes project: {output_path}") from exc
        else:
            sketch_dir = paths.sketch_dir()
            sketch_dir.mkdir(parents=True, exist_ok=True)
            output_path = sketch_dir / compute_scoped_grid_filename(
                effective_mode_key,
                [beat],
                prefix="sketch",
                ext="jpg",
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)

        effective_control_frames_root = control_frames_root
        expected_control_frame = (
            Path(control_frames_root) / f"ep{episode:03d}" / f"beat_{beat:02d}" / "combined.png"
        ).resolve()
        if control_frame.resolve() != expected_control_frame:
            staged_root = output_path.parent / "_director_control_refs"
            staged_dir = staged_root / f"ep{episode:03d}" / f"beat_{beat:02d}"
            staged_dir.mkdir(parents=True, exist_ok=True)
            staged_control_frame = staged_dir / "combined.png"
            shutil.copy2(control_frame, staged_control_frame)
            for sidecar_name in ("frame_meta.json", "actor_mask.png"):
                sidecar = control_frame.parent / sidecar_name
                if sidecar.exists() and sidecar.is_file():
                    shutil.copy2(sidecar, staged_dir / sidecar_name)
            effective_control_frames_root = staged_root

        result = await generator.generate_grid(
            beats=[beat_payload],
            character_map=character_map,
            scene_menu=scene_menu,
            prop_menu=prop_menu,
            sketch_colors=sketch_colors,
            style=style,
            output_path=str(output_path),
            explicit_episode_number=episode,
            sketch_dir=str(paths.sketch_dir()),
            rows=rows,
            cols=cols,
            sketch=True,
            beat_start_index=beat - 1,
            mode_key=effective_mode_key,
            use_director_refs=True,
            director_ref_beat_numbers=[beat],
            director_control_frames_dir=str(effective_control_frames_root),
        )
        if not result.success:
            raise RuntimeError(result.error or "director control sketch generation failed")

        save_result: dict[str, Any] = {}
        promoted_path: Path | None = None
        if promote:
            episode_grids_dir = project_dir / "grids" / f"ep{episode:03d}"
            ts = datetime.now().strftime("%Y%m%d%H%M%S")
            save_result = save_grid_and_split(
                grid_image_path=str(output_path),
                episode_grids_dir=str(episode_grids_dir),
                grid_type="sketch",
                mode_key=effective_mode_key,
                beat_nums=[beat],
                preset="custom",
                rows=rows,
                cols=cols,
                ts=ts,
                promote_dir=str(paths.sketches_dir()),
                force_promote=True,
                beats=[beat_payload],
                sketch_colors=sketch_colors,
            )
            promoted_path = paths.sketch(beat)
        return {
            "ok": True,
            "user": user,
            "project": project,
            "episode": episode,
            "beat": beat,
            "mode_key": effective_mode_key,
            "aspect_ratio": effective_aspect_ratio,
            "control_frame": str(control_frame),
            "director_ref": str(director_ref),
            "visual_description": beat_payload.get("visual_description", ""),
            "grid_path": str(output_path),
            "output_path": str(output_path),
            "promoted_sketch": str(promoted_path) if promoted_path else "",
            "promoted": bool(promote),
            "pool": {
                "grid_path": save_result.get("grid_path"),
                "added": save_result.get("added"),
                "skipped": save_result.get("skipped"),
                "cell_paths": [str(path) for path in save_result.get("cell_paths", [])],
            },
            "generation_time": result.generation_time,
        }
    finally:
        await store.close()


async def run(args: argparse.Namespace) -> dict[str, Any]:
    return await convert_control_frame_to_sketch(
        user=args.user,
        project=args.project,
        episode=int(args.episode),
        beat=int(args.beat),
        mode_key=args.mode_key,
        aspect_ratio=args.aspect_ratio,
        output_dir=args.output_dir or None,
        state_dir=args.state_dir or None,
        control_frames_dir=args.control_frames_dir or None,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert Director Render combined.png into sketches/epNNN/beat_MM.png."
    )
    parser.add_argument("--user", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--episode", type=int, required=True)
    parser.add_argument("--beat", type=int, required=True)
    parser.add_argument("--mode-key", default="")
    parser.add_argument("--aspect-ratio", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--state-dir", default="")
    parser.add_argument("--control-frames-dir", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = asyncio.run(run(args))
        print(json.dumps(result, ensure_ascii=False, default=_json_default))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
