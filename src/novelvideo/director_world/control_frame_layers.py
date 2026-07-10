"""Layer utilities for 3GS Director Render control frames.

The PlayCanvas stage exports:

    env_only.png
    actor_overlay_black.png
    actor_mask.png
    frame_meta.json

For scene-sketch generation we want the image model to edit only the
environment + actor layer. Colored props/staging markers are production
markers, so we extract their visible pixels into a transparent overlay and
paste them back after image generation.
"""

from __future__ import annotations

import json
import re
import colorsys
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageFilter

from novelvideo.utils.path_resolver import PathResolver


RGB_PNG_COMPRESS_LEVEL = 9
ALPHA_PNG_COMPRESS_LEVEL = 9
MODEL_REF_JPEG_QUALITY = 72
MODEL_REF_MAX_EDGE = 1024


def _parse_hex_color(value: str) -> tuple[int, int, int] | None:
    text = str(value or "").strip()
    match = re.search(r"#?([0-9a-fA-F]{6})", text)
    if not match:
        return None
    raw = match.group(1)
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


def _unique_marker_colors(items: Iterable[dict]) -> list[tuple[int, int, int]]:
    colors: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int, int]] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        color = _parse_hex_color(str(item.get("marker_color") or ""))
        if color is None or color in seen:
            continue
        seen.add(color)
        colors.append(color)
    return colors


def _load_prop_marker_colors(meta_path: Path) -> list[tuple[int, int, int]]:
    if not meta_path.exists():
        return []
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    props = meta.get("props") if isinstance(meta, dict) else []
    return _unique_marker_colors(props or [])


def _update_meta_paths(
    meta_path: Path,
    *,
    env_actor_only_path: Path,
    env_actor_only_ref_path: Path,
    prop_mask_path: Path,
    prop_overlay_path: Path,
    prop_color_count: int,
) -> None:
    if not meta_path.exists():
        return
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(meta, dict):
        return
    paths = meta.setdefault("paths", {})
    if not isinstance(paths, dict):
        paths = {}
        meta["paths"] = paths
    paths["env_actor_only"] = env_actor_only_path.resolve().as_posix()
    paths["env_actor_only_ref"] = env_actor_only_ref_path.resolve().as_posix()
    paths["prop_staging_mask"] = prop_mask_path.resolve().as_posix()
    paths["prop_staging_overlay"] = prop_overlay_path.resolve().as_posix()
    meta["prop_staging_overlay"] = {
        "mode": "visible_marker_pixels",
        "source": "actor_overlay_black",
        "prop_color_count": int(prop_color_count),
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _save_model_ref_jpeg(image: Image.Image, out_path: Path) -> None:
    rgb = image.convert("RGB")
    max_edge = max(rgb.size)
    if max_edge > MODEL_REF_MAX_EDGE:
        scale = MODEL_REF_MAX_EDGE / max_edge
        new_size = (
            max(1, int(round(rgb.size[0] * scale))),
            max(1, int(round(rgb.size[1] * scale))),
        )
        rgb = rgb.resize(new_size, Image.LANCZOS)
    rgb.save(
        out_path,
        format="JPEG",
        quality=MODEL_REF_JPEG_QUALITY,
        optimize=True,
        progressive=True,
    )


def _color_mask(
    image: Image.Image,
    marker_colors: Iterable[tuple[int, int, int]],
    *,
    tolerance: int = 42,
    hue_tolerance: int = 18,
) -> Image.Image:
    """Return a white-on-black mask for pixels close to any marker color."""
    rgb = image.convert("RGB")
    r, g, b = rgb.split()
    h, s, v = rgb.convert("HSV").split()
    mask = Image.new("L", rgb.size, 0)
    for cr, cg, cb in marker_colors:
        r_mask = r.point(lambda p, c=cr: 255 if abs(p - c) <= tolerance else 0)
        g_mask = g.point(lambda p, c=cg: 255 if abs(p - c) <= tolerance else 0)
        b_mask = b.point(lambda p, c=cb: 255 if abs(p - c) <= tolerance else 0)
        rgb_mask = ImageChops.multiply(ImageChops.multiply(r_mask, g_mask), b_mask)

        target_hue = int(colorsys.rgb_to_hsv(cr / 255, cg / 255, cb / 255)[0] * 255)

        def _hue_match(p: int, target: int = target_hue) -> int:
            diff = abs(p - target)
            diff = min(diff, 255 - diff)
            return 255 if diff <= hue_tolerance else 0

        hue_mask = h.point(_hue_match)
        sat_mask = s.point(lambda p: 255 if p >= 45 else 0)
        val_mask = v.point(lambda p: 255 if p >= 35 else 0)
        hsv_mask = ImageChops.multiply(ImageChops.multiply(hue_mask, sat_mask), val_mask)
        color_mask = ImageChops.lighter(rgb_mask, hsv_mask)
        mask = ImageChops.lighter(mask, color_mask)

    # Keep antialiased marker edges visible without growing the marker too much.
    if marker_colors:
        mask = mask.filter(ImageFilter.MaxFilter(3))
    return mask


def create_control_frame_layers(target_dir: Path) -> dict[str, str | int | bool]:
    """Create env_actor_only + prop/staging overlay images for one beat.

    Returns metadata with paths and the number of extracted prop/staging colors.
    The function is idempotent and safe to run whenever a director frame is used.
    """
    target_dir = Path(target_dir)
    env_only_path = target_dir / "env_only.png"
    overlay_path = target_dir / "actor_overlay_black.png"
    mask_path = target_dir / "actor_mask.png"
    meta_path = target_dir / "frame_meta.json"
    if not env_only_path.exists():
        raise FileNotFoundError(f"missing env_only: {env_only_path}")
    if not overlay_path.exists():
        raise FileNotFoundError(f"missing actor_overlay_black: {overlay_path}")
    if not mask_path.exists():
        raise FileNotFoundError(f"missing actor_mask: {mask_path}")

    env_only = Image.open(env_only_path).convert("RGB")
    overlay = Image.open(overlay_path).convert("RGB")
    actor_mask = Image.open(mask_path).convert("L").point(lambda p: 255 if p >= 8 else 0)
    if overlay.size != env_only.size:
        overlay = overlay.resize(env_only.size, Image.LANCZOS)
    if actor_mask.size != env_only.size:
        actor_mask = actor_mask.resize(env_only.size, Image.LANCZOS)

    prop_colors = _load_prop_marker_colors(meta_path)
    prop_mask = _color_mask(overlay, prop_colors)
    actor_only_mask = ImageChops.subtract(actor_mask, prop_mask)

    env_actor_only = env_only.copy()
    env_actor_only.paste(overlay, (0, 0), actor_only_mask)

    prop_overlay = overlay.convert("RGBA")
    prop_overlay.putalpha(prop_mask)

    env_actor_only_path = target_dir / "env_actor_only.png"
    env_actor_only_ref_path = target_dir / "env_actor_only_ref.jpg"
    prop_mask_path = target_dir / "prop_staging_mask.png"
    prop_overlay_path = target_dir / "prop_staging_overlay.png"
    env_actor_only.save(
        env_actor_only_path,
        optimize=True,
        compress_level=RGB_PNG_COMPRESS_LEVEL,
    )
    _save_model_ref_jpeg(env_actor_only, env_actor_only_ref_path)
    prop_mask.save(prop_mask_path, optimize=True, compress_level=ALPHA_PNG_COMPRESS_LEVEL)
    prop_overlay.save(
        prop_overlay_path,
        optimize=True,
        compress_level=ALPHA_PNG_COMPRESS_LEVEL,
    )
    _update_meta_paths(
        meta_path,
        env_actor_only_path=env_actor_only_path,
        env_actor_only_ref_path=env_actor_only_ref_path,
        prop_mask_path=prop_mask_path,
        prop_overlay_path=prop_overlay_path,
        prop_color_count=len(prop_colors),
    )

    return {
        "ok": True,
        "env_actor_only": env_actor_only_path.as_posix(),
        "env_actor_only_ref": env_actor_only_ref_path.as_posix(),
        "prop_staging_mask": str(prop_mask_path),
        "prop_staging_overlay": str(prop_overlay_path),
        "prop_color_count": len(prop_colors),
    }


def ensure_control_frame_layers_for_beat(
    project_dir: Path,
    episode: int,
    beat: int,
) -> dict[str, str | int | bool]:
    target_dir = (
        Path(project_dir)
        / "director_control_frames"
        / f"ep{int(episode):03d}"
        / f"beat_{int(beat):02d}"
    )
    return create_control_frame_layers(target_dir)


def apply_prop_staging_overlays_to_grid(
    *,
    grid_image_path: str | Path,
    project_dir: str | Path,
    episode: int,
    beat_numbers: list[int],
    rows: int,
    cols: int,
) -> dict[str, str | int | bool]:
    """Paste visible prop/staging marker overlays back onto a generated grid."""
    grid_path = Path(grid_image_path)
    if not grid_path.exists():
        raise FileNotFoundError(f"missing generated grid: {grid_path}")
    if rows <= 0 or cols <= 0:
        return {"ok": False, "applied": 0, "reason": "invalid_grid"}

    project_path = Path(project_dir)
    image = Image.open(grid_path).convert("RGBA")
    width, height = image.size
    cell_w = width // int(cols)
    cell_h = height // int(rows)
    if cell_w <= 0 or cell_h <= 0:
        return {"ok": False, "applied": 0, "reason": "invalid_cell_size"}

    applied = 0
    for idx, beat in enumerate(beat_numbers[: rows * cols]):
        row = idx // int(cols)
        col = idx % int(cols)
        overlay_path = (
            PathResolver(str(project_path), int(episode)).director_render(int(beat)).parent
            / "prop_staging_overlay.png"
        )
        if not overlay_path.exists():
            try:
                ensure_control_frame_layers_for_beat(project_path, int(episode), int(beat))
            except Exception:
                continue
        if not overlay_path.exists():
            continue

        overlay = Image.open(overlay_path).convert("RGBA")
        if overlay.getchannel("A").getbbox() is None:
            continue
        if overlay.size != (cell_w, cell_h):
            overlay = overlay.resize((cell_w, cell_h), Image.LANCZOS)
        image.alpha_composite(overlay, (col * cell_w, row * cell_h))
        applied += 1

    if not applied:
        return {"ok": True, "applied": 0, "path": str(grid_path)}

    scene_only_path = grid_path.with_name(f"{grid_path.stem}_scene_only{grid_path.suffix}")
    if not scene_only_path.exists():
        grid_path.replace(scene_only_path)
    else:
        # Preserve the previous scene-only backup and just overwrite the final grid.
        pass

    if grid_path.suffix.lower() in {".jpg", ".jpeg"}:
        image.convert("RGB").save(grid_path, quality=95)
    else:
        image.save(grid_path)
    return {
        "ok": True,
        "applied": applied,
        "path": str(grid_path),
        "scene_only_backup": str(scene_only_path),
    }
