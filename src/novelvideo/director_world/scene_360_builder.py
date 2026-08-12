#!/usr/bin/env python3
"""Generate a 2:1 equirectangular 360 scene panorama.

The production route is master/text -> pano_360.png -> pano_sharp PLY -> 3GS.
Voxel worlds are generated from the separate spatial_layout asset, not from this
rendered panorama.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import mimetypes
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from novelvideo.config import (
    HUIMENG_IMAGE_MODEL,
    NEWAPI_IMAGE_MODEL,
    OPENAI_IMAGE_MODEL,
    OPENROUTER_GPT_IMAGE2_MODEL,
    OUTPUT_DIR,
    SCENE_360_HUIMENG_MODEL,
    SCENE_360_IMAGE_MODEL,
    SCENE_360_IMAGE_PROVIDER,
    SCENE_360_PROVIDER,
    get_style_preset,
)
from novelvideo.generators.nanobanana_grid import (
    _call_huimeng_image_api,
    _call_newapi_image_api,
    _call_openai_image_api,
    _call_openrouter_image_api,
)

# Demo defaults for standalone/manual runs. In production stage_asset_tasks
# always passes absolute --output-dir/--master, so these defaults are never used.
# PROJECT_DIR also seeds get_style_preset's project inference (relative to OUTPUT_DIR).
PROJECT_DIR = Path(OUTPUT_DIR) / "admin/xuanchuanpian"
SCENE_NAME = "兰州拉面馆"
SCENE_DIR = PROJECT_DIR / "assets/scenes" / SCENE_NAME
DEFAULT_MASTER = SCENE_DIR / "master.png"
DEFAULT_OUTPUT_DIR = SCENE_DIR / "scene_360_gpt_image2_master_style_v1"
DEFAULT_SCENE_DESCRIPTION = (
    "A compact interior environment with fixed architecture, entrances, windows, "
    "work surfaces, furniture groups, circulation aisles, ceiling/floor/wall materials, "
    "and no people or story action."
)
SCENE_360_DEFAULT_QUALITY = "medium"
SCENE_360_DEFAULT_IMAGE_SIZE = "2K"
SCENE_360_MASTER_REF_MAX_SIDE = 1600
SCENE_360_MASTER_REF_JPEG_QUALITY = 92
SCENE_360_MASTER_THUMB_MAX_SIDE = 768
SCENE_360_MASTER_THUMB_JPEG_QUALITY = 70
SPATIAL_CONTRACT_SCHEMA_VERSION = "scene_spatial_contract_v8_topology_only_locks"
SAFE_SEAM_SPHERE_YAW_DEG = -90.0


def load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv()


def repo_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (Path.cwd() / path).resolve()


def image_tuple(path: Path) -> tuple[str, bytes, str]:
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    return path.name, path.read_bytes(), mime_type


def make_master_reference(
    master_path: Path,
    output_dir: Path,
    *,
    filename: str,
    max_side: int,
    quality: int,
) -> Path:
    """Create an aspect-preserving JPEG reference for model input or debugging."""
    image = Image.open(master_path).convert("RGB")
    image.thumbnail(
        (max_side, max_side),
        Image.Resampling.LANCZOS,
    )
    ref_path = output_dir / filename
    image.save(ref_path, "JPEG", quality=quality, optimize=True)
    return ref_path


def font(size: int) -> ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def build_prompt(
    *,
    scene_name: str,
    scene_description: str,
    style: str,
    has_master: bool,
    has_reverse: bool = False,
    has_direction_guide: bool = False,
    has_topology_strip: bool = False,
    has_overlap_guide: bool = False,
    has_spatial_layout: bool = False,
    spatial_contract_prompt_insert: str = "",
    overlap_prompt_insert: str = "",
    layer_mode: str = "full",
) -> str:
    style_preset = get_style_preset(style, project_dir=str(PROJECT_DIR))
    style_instructions = (
        style_preset.get("gemini_style_instructions") or style_preset.get("style_keywords") or ""
    )
    avoid_instructions = (
        style_preset.get("gemini_avoid_instructions") or style_preset.get("negative_prompt") or ""
    )
    reference_lines = ["INPUT IMAGE ROLES:"]
    if has_master:
        reference_lines.extend(
            [
                "- Reference image 1 (master.png) = PRIMARY VISUAL BIBLE.",
                "- It locks the scene identity, art style, linework density, material treatment,",
                "  color palette, lighting mood, front-half design, and visible fixed fixtures.",
                "- It shows the FRONT-FACING HEMISPHERE of the scene: front center plus the",
                "  visible left-side half and visible right-side half. It does NOT show the",
                "  back hemisphere behind the camera.",
                "- Preserve the recognizable visual DNA of master.png. The generated panorama must",
                "  look like the same uploaded scene expanded into 360 degrees, not a new location.",
                "- Do NOT treat master as a narrow 90-degree face. It is a 180-degree front",
                "  hemisphere anchor. Its raw x-axis placement follows the topology map when attached.",
            ]
        )
    if has_reverse:
        reference_lines.extend(
            [
                "- Reference image 2 (reverse_master.png) = BACK-HALF VISUAL BIBLE.",
                "- It locks the BACK-FACING HEMISPHERE of the same scene: back center plus the",
                "  visible left-side half and visible right-side half from the 180-degree",
                "  yaw-rotated reverse camera.",
                "- It must be stitched with master.png into one continuous physical space:",
                "  reverse left edge connects to master right edge, and reverse right edge",
                "  connects to master left edge.",
                "- Do NOT place reverse_master as another forward/diagonal view near master.",
                "  It is the exact yaw-180 opposite direction of master.",
                "- Do NOT let scene text invent a different back side when reverse_master.png",
                "  already shows the back-half visual facts.",
            ]
        )
    if has_direction_guide:
        guide_ref_index = 3 if has_reverse else 2 if has_master else 1
        reference_lines.extend(
            [
                f"- Reference image {guide_ref_index} (direction_alignment_guide.jpg) = DIRECTION MAP.",
                "- It is NOT visual style reference. Use it only to understand screen-left,",
                "  screen-right, front center, and back center.",
                "- Do NOT render its labels, arrows, colored guide lines, or typography into",
                "  the final panorama.",
                "- Use this guide to prevent left/right mirroring of unique fixtures such as",
                "  fire-hose cabinets, elevator panels, plaques, doors, lamps, ads, and signs.",
            ]
        )
    if has_topology_strip:
        topology_ref_index = 1 + int(has_master) + int(has_reverse) + int(has_direction_guide)
        reference_lines.extend(
            [
                f"- Reference image {topology_ref_index} (topology_strip_2to1.jpg) = ABSTRACT 360 TOPOLOGY MAP.",
                "- This is the most important spatial/topology reference when master+reverse are attached.",
                "- It is an abstract placement diagram, not a visual panorama and not a style reference.",
                "- Use it to understand the panorama x-axis placement exactly:",
                "  x=0% left edge and x=100% right edge are the SAME low-detail LEFT SIDE seam.",
                "  x=25% is master front center.",
                "  x=50% is the side join where master right edge merges with reverse left edge.",
                "  x=75% is reverse back center.",
                "  The generated raw image is intentionally yaw-shifted; viewer/PLY correction will",
                f"  use sphere yaw {SAFE_SEAM_SPHERE_YAW_DEG:.0f}° so default front still shows master.",
                "- Do NOT copy this diagram visually. Do NOT render its labels, colored blocks, axis lines,",
                "  arrows, or typography into the final panorama.",
            ]
        )
    if has_overlap_guide:
        overlap_ref_index = (
            1
            + int(has_master)
            + int(has_reverse)
            + int(has_direction_guide)
            + int(has_topology_strip)
        )
        reference_lines.extend(
            [
                f"- Reference image {overlap_ref_index} (overlap_continuation_guide.jpg) = SIDE-JOIN ANALYSIS MAP.",
                "- It is NOT visual style reference. Use it only to understand which side-edge",
                "  objects are shared overlap anchors and which surfaces are continuation zones.",
                "- Do NOT render its labels, colored text, panel layout, or typography into the final panorama.",
                "- Use this guide to avoid duplicating shared side-edge windows, doors, signs, shelves,",
                "  tables, counters, panels, or fixtures when master/reverse are stitched.",
            ]
        )
    if has_spatial_layout:
        spatial_ref_index = (
            1
            + int(has_master)
            + int(has_reverse)
            + int(has_direction_guide)
            + int(has_topology_strip)
            + int(has_overlap_guide)
        )
        reference_lines.extend(
            [
                f"- Reference image {spatial_ref_index} (spatial_layout.png) = GEOMETRY / LAYOUT GROUND TRUTH.",
                "- It is the top-down empty floorplan of the same scene, covering all 360 degrees",
                "  around the camera. The camera sits at the center of the floorplan.",
                "- Floorplan convention: top edge = FRONT wall, bottom edge = BACK wall,",
                "  left edge = LEFT wall, right edge = RIGHT wall.",
                "- Map each top-down wall/door/window/fixture to its 360 azimuth using this convention:",
                "    front wall  -> center column of the 2:1 panorama",
                "    right wall  -> 1/4 column (90° right of center)",
                "    back wall   -> the seam (panorama's left edge AND right edge — they connect)",
                "    left wall   -> 3/4 column (90° left of center)",
                "- EVERY opening, door, window, and fixture drawn in spatial_layout MUST appear in the",
                "  panorama at its corresponding azimuth, even if it is not visible in the master.",
                "- spatial_layout's visual style (white background, black lines, gray icons) is",
                "  IRRELEVANT — do NOT carry its line-art look into the panorama; only use it for",
                "  topology and azimuth placement.",
            ]
        )
    if not has_master and not has_reverse and not has_spatial_layout:
        reference_lines.extend(
            [
                "- No image reference is attached.",
                "- Build the scene only from the scene description and project style preset.",
            ]
        )
    reference_block = "\n".join(reference_lines)
    scene_description = clean_scene_description_for_360(scene_description)
    layer_mode = str(layer_mode or "full").strip().lower()
    if layer_mode == "shell_only":
        layer_contract = """LAYER MODE: SCENE SHELL ONLY
- Generate the empty architectural/environment shell only.
- Keep fixed architecture and built-in fixtures: walls, floor, ceiling, doors,
  windows, lighting, signs, wall surfaces, built-in work surfaces, shelves that
  are attached to the wall, material texture, and overall scene atmosphere.
- REMOVE independent movable foreground objects that can occlude later camera
  views: freestanding dining tables, stools, chairs, removable boxes, trash
  bins, loose countertop clutter, loose small props, and any story props.
- Do not leave ghost silhouettes or blurry smears where removed objects were.
- Fill removed areas with plausible continuous floor/wall/counter-base surfaces.
- The result will become an empty scene shell for camera/blocking tests; do not
  imply or reserve any later object-layer reconstruction."""
    else:
        layer_contract = """LAYER MODE: FULL ENVIRONMENT
- Generate the complete environment, including only the fixed architecture,
  fixtures, furniture/object groups, and reusable action zones represented by
  the scene description and master visual reference.
- Do not add extra furniture, counters, fixtures, doors, windows, props, clutter,
  or set dressing because of genre/location expectations.
- No people, no characters, no story action."""
    if has_master and has_reverse:
        spatial_contract = (
            f"""SCENE SPATIAL CONTRACT:
{spatial_contract_prompt_insert.strip()}"""
            if spatial_contract_prompt_insert.strip()
            else ""
        )
        overlap_contract = (
            f"""MASTER/REVERSE OVERLAP + CONTINUATION ANALYSIS:
{overlap_prompt_insert.strip()}"""
            if overlap_prompt_insert.strip()
            else ""
        )
        scene_block = f"""SCENE CONTRACT (SECONDARY):
{scene_description}

Use this text only as semantic validation, directional naming, seam continuity guidance,
and negative constraints. Do NOT redraw or replace the visual facts already established
by master.png and reverse_master.png."""
        geometry_priority = """GEOMETRY / STYLE PRIORITY:
- Master image is the visual/geometry ground truth for the FRONT HEMISPHERE:
  front center + visible left-side half + visible right-side half.
- Reverse master image is the visual/geometry ground truth for the BACK HEMISPHERE:
  back center + visible left-side half + visible right-side half from the opposite view.
- Environment text is a secondary spatial contract: use it to verify direction labels,
  fill only tiny missing continuity gaps, and exclude wrong elements. It must not invent
  a different scene when both visual halves are present.
- If topology_strip_2to1.jpg is attached, its abstract horizontal placement overrides any
  ambiguous interpretation of the two separate master/reverse images.
- If spatial_layout is attached, use it only to reconcile azimuth/topology while preserving
  master + reverse visual identity.
- Visual identity, style, materials, linework, color palette, lighting, and fixed fixture
  design: master + reverse images first."""
        azimuth_contract = """MASTER + REVERSE AZIMUTH CONTRACT — HARD REQUIREMENT:
- The output is a 2:1 equirectangular unwrap. Its horizontal x-axis is yaw angle.
- Use a SAFE-SEAM raw canvas layout. The raw image is intentionally yaw-shifted
  so the left/right seam lands on a low-detail side wall instead of on the
  reverse hallway / back-center features.
- The downstream 360 viewer and 360->PLY step will apply sphere yaw correction
  {SAFE_SEAM_SPHERE_YAW_DEG:.0f}° so the corrected default yaw 0° / FRONT still shows
  master.png's center.
- Therefore the RAW panorama canvas placement MUST be:
  - x=0% and x=100% / left-right seam = low-detail LEFT SIDE wall continuation
    where master left side merges with reverse screen-right side.
  - x=25% = master front center.
  - x=50% = RIGHT SIDE transition zone where master right edge merges with
    reverse screen-left edge.
  - x=75% = reverse back center.
- If topology_strip_2to1.jpg is attached, follow that topology map's horizontal order exactly:
  left-side seam/continuation -> master front center -> right-side join ->
  reverse back center -> left-side seam/continuation.
- The reverse back center is ONE physical direction around x=75%, not two
  duplicated directions at the left and right edges.
- BACK-ONLY reverse-center objects listed by the spatial contract must stay
  centered around x=75%. Do not move a back-wall desk, bookshelf, cabinet,
  window, door, or display panel into x=50%; x=50% is only the right-side join.
- FRONT-ONLY master-center objects listed by the spatial contract must stay
  centered around x=25%. Do not move front-wall fixtures into x=50% or x=75%.
- Reverse screen-left content must land in raw panorama x=50%..75%; reverse
  screen-right content must land in raw panorama x=75%..100%. This orientation
  is mandatory and must not be flipped.
- The x=0%/100% seam must be a plain continuous side wall/floor/ceiling zone.
  Do NOT put a hallway, doorway, elevator, display panel, sign, lamp, or
  unlisted unique fixture on the seam. If the spatial contract explicitly lists
  a SHARED OVERLAP anchor at the side join, render it once as a seam-adjacent
  continuous/split physical object, never as two independent copies.
- Do NOT render a complete reverse corridor / doorway / back-wall feature once
  near the left edge and again near the right edge. Keep reverse back-center
  hallway/display/sign features together around x=75%.
- Do NOT duplicate unique reverse-side objects, ads, doors, corridor openings,
  plaques, lamps, or wall panels at both outer sides. The two outer edges are
  adjacent halves of the SAME low-detail side wall.
- UNIQUE FIXTURE SIDE LOCK:
  - Around x=25% / master front center, preserve the screen-space side placement
    visible in master.png. Do not mirror unique front fixtures across the center.
  - Around x=75% / reverse back center, preserve the screen-space side placement
    visible in reverse_master.png. Do not split reverse center across the seam.
  - If a unique cabinet/panel/sign appears on one side of a doorway/elevator in
    the input references, it must remain on that same referenced side in the
    corresponding viewer direction. Do not move it to the opposite side.
  - Do not reinterpret fixture categories: an illuminated display panel / lightbox
    must remain an illuminated display panel / lightbox, a sign must remain a sign,
    a cabinet must remain a cabinet, and a call button panel must remain a call
    button panel. Never turn these unique fixtures into doorways or corridors.
  - Preserve relative fixture scale from the input view. A large wall display
    or lightbox must remain a large wall display/lightbox, not shrink into a
    small poster or side plaque. Do not add extra unreferenced panels to compensate.
- Do NOT put master center and reverse center next to each other inside the middle
  of the panorama. They are opposite directions, exactly 180° apart.
- Do NOT make a triangular/fan-shaped room where front and back are only 90° apart.
  This is one shared camera point with two opposite 180° hemispheres."""
    else:
        spatial_contract = ""
        overlap_contract = ""
        scene_block = f"""SCENE:
{scene_description}"""
        geometry_priority = """GEOMETRY / STYLE PRIORITY:
- Geometry / topology / wall layout / opening positions / fixture placement: SPATIAL LAYOUT image
  is the ground truth when attached. Scene text fills in semantic detail and naming.
- Master image ground-truths visible geometry for the FRONT HALF:
  front center + roughly half of the left side + roughly half of the right side.
- The unseen BACK HALF must come from spatial_layout + scene text, or be inferred from the
  environment contract when explicit back-side details are missing.
- Visual identity, style, materials, linework, color palette, lighting, and front/side
  fixed fixture design: master image first.
- Project style preset reinforces the master style; it must not override the master scene identity."""
        azimuth_contract = """AZIMUTH CONTRACT:
- Default 360 viewer yaw 0° / FRONT should show the master front center when a
  master image is attached.
- The panorama must still represent a full 360-degree space around one fixed camera,
  not a flat wide shot or triangular room."""
    return f"""Generate a 360-degree equirectangular panorama image in exact 2:1
aspect ratio for scene `{scene_name}`.

{reference_block}

{layer_contract}

{scene_block}

{geometry_priority}

{azimuth_contract}

{spatial_contract}

{overlap_contract}

PROJECTION REQUIREMENTS:
- Correct equirectangular spherical panorama projection.
- Output must be one continuous 2:1 panorama, suitable for a VR/360 panorama viewer.
- Camera is fixed at the center of the room at normal human eye height.
- Full 360-degree environment around the camera.
- Left and right edges must connect seamlessly with no visible seam.
- When master+reverse references are attached, the left/right seam is a safe
  low-detail side wall continuation. It must not cut or duplicate a reverse
  hallway, doorway, display panel, sign, cabinet, or other unique fixture.
  Explicit SHARED OVERLAP anchors may be seam-adjacent only if they merge into
  one physical object in a 360 viewer, not one copy on each panorama edge.
- When master+reverse references are NOT attached, the first and last columns must
  depict the same continuous surface/material and should avoid cutting a unique object.
- Horizon must be level and centered.
- Use normal VR panorama projection: no single flat wide shot, no 4-panel sheet,
  no cubemap atlas, no borders.
- In a 360 viewer, walls, doors, windows, counters, furniture/fixture groups,
  ceiling elements, and floor materials should look coherent and continuous.
- Geometry must remain stable after spherical wrapping: straight walls should
  stay straight, door/window rectangles should not melt, stretch, or duplicate.
- Avoid large close foreground objects crossing the left/right seam.
- Keep important objects away from extreme top/bottom polar distortion when possible.
- Ceiling and floor poles must be clean continuous surfaces, with no black holes,
  labels, mirrors, sliced objects, or heavy stretching.

STYLE CONTRACT:
- Match the master image style exactly when a master reference is attached:
  same linework density, mixed-media texture, color treatment, lighting mood,
  material rendering, and animated-background finish.
- Do not drift into photorealism, live-action, clean 3D render, game asset,
  or glossy architectural visualization.
- No people, no characters, no story action.
- Do not invent new readable text. Preserve existing simple numeric marks or
  abstract signage already visible in the master/reverse references.
- Signs or posters may use abstract marks inspired by the master/reverse, but do
  not rely on new readable text.

PROJECT STYLE PRESET:
{style_instructions}

STYLE AVOIDANCE:
{avoid_instructions}

NEGATIVE REQUIREMENTS:
Not a normal wide-angle illustration, not a single room painting, not a flat
one-point perspective, not a multi-panel sheet, not fisheye lens, not cubemap
faces, not VR headset screenshot, no labels, no UI, no watermark, no broken seam,
no duplicated doorway at seam, no warped horizon, no curved walls in VR viewer,
no stretched ceiling/floor poles, no mirrored left/right halves, no sliced object
at seam, no giant close foreground object, no photorealism.
"""


def clean_scene_description_for_360(scene_description: str) -> str:
    """Remove voxel/DirectorWorld control language before image panorama generation."""
    raw = str(scene_description or "").strip()
    if not raw:
        return DEFAULT_SCENE_DESCRIPTION
    blocked_markers = (
        "directorworld",
        "actor_",
        "prop_",
        "方块",
        "对象颜色",
        "颜色只代表",
        "可编辑的 directorworld",
        "beat 的草图工作台",
        "不要放 actor",
        "不要放 prop",
    )
    lines: list[str] = []
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            continue
        lowered = text.lower()
        if any(marker in lowered for marker in blocked_markers):
            continue
        lines.append(text)
    return "\n".join(lines).strip() or DEFAULT_SCENE_DESCRIPTION


def make_direction_alignment_guide(
    master_path: Path,
    reverse_path: Path,
    output_dir: Path,
) -> Path:
    """Create a direction-only guide so the image model does not mirror references."""
    panel_w, panel_h = 720, 405
    label_h = 92
    gap = 24
    canvas = Image.new("RGB", (panel_w * 2 + gap, panel_h + label_h), "white")
    draw = ImageDraw.Draw(canvas)
    title_font = font(18)
    small_font = font(14)

    panels = [
        (
            "MASTER / FRONT: viewer yaw 0 deg",
            "screen-left stays left of master front center",
            master_path,
            0,
        ),
        (
            "REVERSE / BACK: viewer yaw 180 deg",
            "keep reverse-center doors/fixtures on back, not front",
            reverse_path,
            panel_w + gap,
        ),
    ]
    for title, subtitle, path, x0 in panels:
        image = Image.open(path).convert("RGB")
        image.thumbnail((panel_w, panel_h), Image.Resampling.LANCZOS)
        px = x0 + (panel_w - image.width) // 2
        py = label_h + (panel_h - image.height) // 2
        canvas.paste(image, (px, py))
        draw.rectangle([x0, label_h, x0 + panel_w - 1, label_h + panel_h - 1], outline="black")
        center_x = x0 + panel_w // 2
        draw.line([center_x, label_h, center_x, label_h + panel_h], fill=(0, 170, 255), width=3)
        draw.text((x0 + 10, 8), title, fill="black", font=title_font)
        draw.text((x0 + 10, 34), subtitle, fill=(80, 80, 80), font=small_font)
        draw.text((x0 + 10, 60), "SCREEN LEFT", fill=(180, 20, 20), font=small_font)
        draw.text((x0 + panel_w - 112, 60), "SCREEN RIGHT", fill=(20, 90, 180), font=small_font)
        draw.text((center_x - 42, 60), "CENTER", fill=(0, 120, 180), font=small_font)

    guide_path = output_dir / "reference_3_direction_alignment_guide.jpg"
    canvas.save(guide_path, "JPEG", quality=92, optimize=True)
    return guide_path


def make_topology_strip_2to1(
    master_path: Path,
    reverse_path: Path,
    output_dir: Path,
    *,
    width: int = 2048,
    height: int = 1024,
) -> Path:
    """Build an abstract 2:1 unwrap map without photographic content."""
    quarter_w = width // 4
    half_w = width // 2
    strip = Image.new("RGB", (width, height), "#f5f1e8")
    draw = ImageDraw.Draw(strip)
    title_font = font(34)
    label_font = font(30)
    small_font = font(23)
    tiny_font = font(19)

    zones = [
        (
            0,
            quarter_w,
            "#2f5d74",
            "MASTER LEFT\nsafe seam side",
            "left side continuation -> master front",
        ),
        (
            quarter_w,
            half_w,
            "#2f5d74",
            "MASTER RIGHT\nside transition",
            "master front -> master right edge",
        ),
        (
            half_w,
            quarter_w + half_w,
            "#303642",
            "REVERSE LEFT\nside transition",
            "reverse left edge -> reverse center",
        ),
        (
            quarter_w + half_w,
            width,
            "#303642",
            "REVERSE RIGHT\nsafe seam side",
            "reverse center -> reverse right edge",
        ),
    ]
    for x0, x1, fill, label, note in zones:
        draw.rectangle((x0, 0, x1, height), fill=fill)
        cx = (x0 + x1) // 2
        draw.text((cx - 145, height // 2 - 55), label, fill="white", font=label_font)
        draw.text((cx - 205, height // 2 + 30), note, fill="#e6edf2", font=tiny_font)

    bands = [
        (0, "#ff3b30", "0% seam\nlow-detail LEFT side"),
        (quarter_w, "#00c7ff", "25%\nmaster front center"),
        (half_w, "#ffcc00", "50%\nmaster RIGHT == reverse LEFT"),
        (quarter_w + half_w, "#00c7ff", "75%\nreverse back center"),
        (width - 1, "#ff3b30", "100% seam\nsame LEFT side"),
    ]
    for x, color, label in bands:
        draw.line((x, 0, x, height), fill=color, width=8 if x not in (0, width - 1) else 16)
        box_w = 330 if x not in (quarter_w, quarter_w + half_w) else 485
        tx = max(8, min(width - box_w - 8, x + 10 if x < width // 2 else x - box_w - 10))
        draw.rectangle((tx, 16, tx + box_w, 112), fill="#111111")
        draw.text((tx + 12, 24), label, fill=color, font=small_font)

    arrow_y = height // 2 + 130
    draw.line((half_w - 140, arrow_y, half_w + 140, arrow_y), fill="#ffcc00", width=8)
    draw.polygon(
        [
            (half_w + 140, arrow_y),
            (half_w + 108, arrow_y - 18),
            (half_w + 108, arrow_y + 18),
        ],
        fill="#ffcc00",
    )
    draw.line(
        (width - 140, arrow_y, width - 1, arrow_y),
        fill="#ff3b30",
        width=8,
    )
    draw.line(
        (0, arrow_y, 140, arrow_y),
        fill="#ff3b30",
        width=8,
    )
    draw.polygon(
        [
            (0, arrow_y),
            (32, arrow_y - 18),
            (32, arrow_y + 18),
        ],
        fill="#ff3b30",
    )

    draw.rectangle((18, height - 142, width - 18, height - 18), fill="#111111")
    draw.text(
        (34, height - 126),
        "ABSTRACT TOPOLOGY MAP: safe side seam | master front | right join | reverse back | safe side seam",
        fill="white",
        font=title_font,
    )
    draw.text(
        (34, height - 76),
        "No photographic content here. Use only for x-axis placement: 0/100 seam is plain left side; 25% is master center; 75% is reverse center.",
        fill=(220, 220, 220),
        font=small_font,
    )
    draw.text(
        (34, height - 42),
        f"Viewer/PLY applies yaw {SAFE_SEAM_SPHERE_YAW_DEG:.0f}° so corrected default front still shows master.",
        fill=(220, 220, 220),
        font=tiny_font,
    )

    strip_path = output_dir / "reference_4_topology_strip_2to1.jpg"
    strip.save(strip_path, "JPEG", quality=92, optimize=True)
    return strip_path


def load_overlap_continuation_analysis(
    *,
    master_path: Path | None,
    reverse_path: Path | None,
    overlap_analysis_arg: str,
) -> tuple[Path | None, Path | None, str]:
    raw_arg = str(overlap_analysis_arg or "auto").strip()
    if raw_arg.lower() in {"none", "off", "false", "0", "no"}:
        return None, None, ""

    explicit = bool(raw_arg and raw_arg.lower() != "auto")
    if explicit:
        analysis_path = repo_path(raw_arg)
    elif master_path is not None:
        analysis_path = (
            master_path.parent / "overlap_continuation_test" / "overlap_continuation_analysis.json"
        )
    else:
        return None, None, ""

    if not analysis_path.exists():
        return None, None, ""
    if not explicit and master_path is not None and reverse_path is not None:
        latest_input_mtime = max(master_path.stat().st_mtime, reverse_path.stat().st_mtime)
        if analysis_path.stat().st_mtime < latest_input_mtime:
            return None, None, ""

    try:
        data = json.loads(analysis_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None, None, ""
    prompt_insert = str(data.get("pano_prompt_insert") or "").strip()
    front_unique = [
        str(item).strip() for item in data.get("front_unique_items") or [] if str(item).strip()
    ]
    back_unique = [
        str(item).strip() for item in data.get("back_unique_items") or [] if str(item).strip()
    ]
    unique_lines: list[str] = []
    if front_unique or back_unique:
        unique_lines.extend(
            [
                "UNIQUE FIXTURE PRESERVATION — HARD REQUIREMENT:",
                "- These fixtures are not generic wall openings. Preserve their type, side, and visual identity exactly from the reference images.",
                "- Do not convert illuminated panels, signs, cabinets, call buttons, sensors, lamps, or plaques into doors, corridors, blank walls, or different fixtures.",
            ]
        )
    if front_unique:
        unique_lines.append(
            "  MASTER FRONT UNIQUE ITEMS TO PRESERVE: " + "; ".join(front_unique) + "."
        )
    if back_unique:
        unique_lines.append(
            "  REVERSE BACK UNIQUE ITEMS TO PRESERVE: " + "; ".join(back_unique) + "."
        )
    if unique_lines and "UNIQUE FIXTURE PRESERVATION" not in prompt_insert:
        prompt_insert = "\n".join([prompt_insert, *unique_lines]).strip()
    guide_path = analysis_path.with_name("overlap_continuation_guide.jpg")
    if not guide_path.exists():
        guide_path = None
    return analysis_path, guide_path, prompt_insert


def load_scene_spatial_contract(
    *,
    master_path: Path | None,
    reverse_path: Path | None,
    spatial_contract_arg: str,
) -> tuple[Path | None, str]:
    raw_arg = str(spatial_contract_arg or "auto").strip()
    if raw_arg.lower() in {"none", "off", "false", "0", "no"}:
        return None, ""

    explicit = bool(raw_arg and raw_arg.lower() != "auto")
    if explicit:
        contract_path = repo_path(raw_arg)
    elif master_path is not None:
        contract_path = (
            master_path.parent / "scene_spatial_contract" / "scene_spatial_contract.json"
        )
    else:
        return None, ""

    if not contract_path.exists():
        return None, ""
    if not explicit and master_path is not None and reverse_path is not None:
        latest_input_mtime = max(master_path.stat().st_mtime, reverse_path.stat().st_mtime)
        if contract_path.stat().st_mtime < latest_input_mtime:
            return None, ""
    try:
        data = json.loads(contract_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None, ""
    if not explicit and data.get("schema_version") != SPATIAL_CONTRACT_SCHEMA_VERSION:
        return None, ""
    prompt_insert = str(data.get("pano_prompt_insert") or "").strip()
    return contract_path, prompt_insert


def make_contact_sheet(
    output_dir: Path,
    refs: list[tuple[str, Path]],
    result: Path,
) -> None:
    entries = [*refs, ("RESULT 2:1 360 panorama", result)]
    cell_w, cell_h = 360, 210
    label_h = 30
    sheet = Image.new("RGB", (cell_w * len(entries), cell_h + label_h), "white")
    draw = ImageDraw.Draw(sheet)
    fnt = font(15)
    for idx, (label, path) in enumerate(entries):
        img = Image.open(path).convert("RGB")
        img.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
        x0 = idx * cell_w
        draw.text((x0 + 8, 6), label, fill="black", font=fnt)
        sheet.paste(img, (x0 + (cell_w - img.width) // 2, label_h + (cell_h - img.height) // 2))
    sheet.save(output_dir / "scene_360_contact.jpg", quality=92)


def _resolve_newapi_credentials() -> tuple[str, str]:
    """Resolve newapi credentials, honoring an organization gateway injection.

    This builder runs in its own OS process (`stage_asset_tasks.run_scene_360`
    launches it), so the trusted-identity ContextVar cannot reach here. The parent
    claims the operation and resolves the organization credential, then hands the
    resolved credential over through process-local environment variables.

    `ST_ORG_EGRESS_MODE` is what makes "no credential arrived" distinguishable from
    "this is a platform task" — without it a missing credential would silently fall
    back to the platform key in settings.db, which is exactly the leak being closed.
    The credential must be passed as an explicit override: the environment fallback
    in `get_newapi_runtime_credentials` only applies when the configured gateway is
    itself environment backed, so an injected `NEWAPI_API_KEY` would be ignored in CE.
    """

    from novelvideo.config import get_newapi_runtime_credentials

    if os.environ.get("ST_ORG_EGRESS_MODE") != "1":
        return get_newapi_runtime_credentials()

    org_key = (os.environ.get("ST_ORG_GATEWAY_API_KEY") or "").strip()
    org_base_url = (os.environ.get("ST_ORG_GATEWAY_BASE_URL") or "").strip()
    if not org_key or not org_base_url:
        raise RuntimeError("ORG_CONTEXT_REQUIRED")
    return get_newapi_runtime_credentials(
        api_key_override=org_key,
        base_url_override=org_base_url,
    )


async def run(args: argparse.Namespace) -> int:
    load_env()
    args.quality = str(
        args.quality
        or os.environ.get("SCENE_360_IMAGE_QUALITY")
        or os.environ.get("HUIMENG_IMAGE_QUALITY")
        or SCENE_360_DEFAULT_QUALITY
    ).strip()
    args.image_size = str(
        args.image_size or os.environ.get("SCENE_360_IMAGE_SIZE") or SCENE_360_DEFAULT_IMAGE_SIZE
    ).strip()
    provider = str(
        args.provider
        or os.environ.get("SCENE_360_IMAGE_PROVIDER")
        or os.environ.get("SCENE_360_PROVIDER")
        or SCENE_360_IMAGE_PROVIDER
        or SCENE_360_PROVIDER
        or "huimeng"
    ).lower()
    output_dir = repo_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    master_refs: list[tuple[str, Path]] = []
    reference_images: list[tuple[str, bytes, str]] = []
    has_master_ref = False
    has_reverse_ref = False
    has_direction_guide_ref = False
    has_topology_strip_ref = False
    has_overlap_guide_ref = False
    has_spatial_layout_ref = False
    master_path_for_overlap: Path | None = None
    reverse_path_for_overlap: Path | None = None
    master_ref_path: Path | None = None
    reverse_ref_path: Path | None = None
    spatial_contract_prompt_insert = ""
    spatial_contract_path: Path | None = None
    overlap_prompt_insert = ""
    overlap_analysis_path: Path | None = None
    if not args.text_only:
        master = repo_path(args.master)
        if not master.exists():
            raise FileNotFoundError(master)
        master_path_for_overlap = master
        master_ref = make_master_reference(
            master,
            output_dir,
            filename="reference_1_master_visual_bible.jpg",
            max_side=SCENE_360_MASTER_REF_MAX_SIDE,
            quality=SCENE_360_MASTER_REF_JPEG_QUALITY,
        )
        master_refs.append(("REF 1 master visual bible (sent to model)", master_ref))
        master_ref_path = master_ref
        master_thumb = make_master_reference(
            master,
            output_dir,
            filename="reference_1_master_debug_thumb.jpg",
            max_side=SCENE_360_MASTER_THUMB_MAX_SIDE,
            quality=SCENE_360_MASTER_THUMB_JPEG_QUALITY,
        )
        master_refs.append(("REF 1 thumbnail copy (debug only)", master_thumb))
        reference_images.append(image_tuple(master_ref))
        has_master_ref = True

        reverse_master_arg = getattr(args, "reverse_master", "") or ""
        if reverse_master_arg:
            reverse_master = repo_path(reverse_master_arg)
            if not reverse_master.exists():
                raise FileNotFoundError(reverse_master)
            reverse_path_for_overlap = reverse_master
            reverse_ref = make_master_reference(
                reverse_master,
                output_dir,
                filename="reference_2_reverse_visual_bible.jpg",
                max_side=SCENE_360_MASTER_REF_MAX_SIDE,
                quality=SCENE_360_MASTER_REF_JPEG_QUALITY,
            )
            master_refs.append(("REF 2 reverse visual bible (sent to model)", reverse_ref))
            reverse_ref_path = reverse_ref
            reverse_thumb = make_master_reference(
                reverse_master,
                output_dir,
                filename="reference_2_reverse_debug_thumb.jpg",
                max_side=SCENE_360_MASTER_THUMB_MAX_SIDE,
                quality=SCENE_360_MASTER_THUMB_JPEG_QUALITY,
            )
            master_refs.append(("REF 2 reverse thumbnail copy (debug only)", reverse_thumb))
            reference_images.append(image_tuple(reverse_ref))
            has_reverse_ref = True

    if has_master_ref and has_reverse_ref:
        spatial_contract_path, spatial_contract_prompt_insert = load_scene_spatial_contract(
            master_path=master_path_for_overlap,
            reverse_path=reverse_path_for_overlap,
            spatial_contract_arg=getattr(args, "spatial_contract", "auto"),
        )
        if master_ref_path is not None and reverse_ref_path is not None:
            guide_ref = make_direction_alignment_guide(
                master_ref_path,
                reverse_ref_path,
                output_dir,
            )
            master_refs.append(("REF 3 direction-only guide (sent to model)", guide_ref))
            reference_images.append(image_tuple(guide_ref))
            has_direction_guide_ref = True
            topology_ref = make_topology_strip_2to1(
                master_ref_path,
                reverse_ref_path,
                output_dir,
            )
            master_refs.append(("REF 4 topology-only strip (sent to model)", topology_ref))
            reference_images.append(image_tuple(topology_ref))
            has_topology_strip_ref = True
        overlap_analysis_path, overlap_guide_path, overlap_prompt_insert = (
            load_overlap_continuation_analysis(
                master_path=master_path_for_overlap,
                reverse_path=reverse_path_for_overlap,
                overlap_analysis_arg=getattr(args, "overlap_analysis", "auto"),
            )
        )
        if overlap_prompt_insert and overlap_guide_path:
            overlap_ref_index = (
                1
                + int(has_master_ref)
                + int(has_reverse_ref)
                + int(has_direction_guide_ref)
                + int(has_topology_strip_ref)
            )
            overlap_copy = (
                output_dir / f"reference_{overlap_ref_index}_overlap_continuation_guide.jpg"
            )
            overlap_copy.write_bytes(overlap_guide_path.read_bytes())
            master_refs.append(
                (
                    f"REF {overlap_ref_index} overlap/continuation guide (debug only)",
                    overlap_copy,
                )
            )

    spatial_layout_arg = getattr(args, "spatial_layout", "") or ""
    if spatial_layout_arg:
        spatial_layout = repo_path(spatial_layout_arg)
        if not spatial_layout.exists():
            raise FileNotFoundError(spatial_layout)
        spatial_ref_index = (
            1
            + int(has_master_ref)
            + int(has_reverse_ref)
            + int(has_direction_guide_ref)
            + int(has_topology_strip_ref)
            + int(has_overlap_guide_ref)
        )
        layout_copy = output_dir / f"reference_{spatial_ref_index}_spatial_layout.png"
        layout_copy.write_bytes(spatial_layout.read_bytes())
        master_refs.append(
            (
                f"REF {spatial_ref_index} spatial layout (geometry truth)",
                layout_copy,
            )
        )
        reference_images.append(image_tuple(layout_copy))
        has_spatial_layout_ref = True

    if not reference_images:
        reference_images = None  # type: ignore[assignment]

    provider_trace: dict[str, str] = {}
    prompt = build_prompt(
        scene_name=args.scene_name,
        scene_description=args.scene_description,
        style=args.style,
        has_master=has_master_ref,
        has_reverse=has_reverse_ref,
        has_direction_guide=has_direction_guide_ref,
        has_topology_strip=has_topology_strip_ref,
        has_overlap_guide=has_overlap_guide_ref,
        has_spatial_layout=has_spatial_layout_ref,
        spatial_contract_prompt_insert=spatial_contract_prompt_insert,
        overlap_prompt_insert=overlap_prompt_insert,
        layer_mode=args.layer_mode,
    )
    prompt_path = output_dir / "scene_360.prompt.txt"
    result_path = output_dir / "scene_panorama_2to1.png"
    manifest_path = output_dir / "scene_360_manifest.json"
    prompt_path.write_text(prompt, encoding="utf-8")

    if provider in {"huimeng", "huimengi"}:
        api_key = os.environ.get("HUIMENGI_API_KEY")
        if not api_key:
            raise RuntimeError("HUIMENGI_API_KEY is missing")
        model = (
            args.model
            or os.environ.get("SCENE_360_HUIMENG_MODEL")
            or os.environ.get("HUIMENG_IMAGE_MODEL")
            or SCENE_360_HUIMENG_MODEL
            or HUIMENG_IMAGE_MODEL
            or "image-2"
        )
        image_bytes, _text, error = await _call_huimeng_image_api(
            api_key=api_key,
            model=model,
            prompt=prompt,
            reference_images=[item[1] for item in reference_images] if reference_images else None,
            image_config={
                "aspect_ratio": "2:1",
                "image_size": args.image_size,
                "quality": args.quality,
                "huimeng_image_quality": args.quality,
                "output_format": "png",
            },
        )
    elif provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is missing")
        model = args.model or os.environ.get("OPENAI_IMAGE_MODEL") or OPENAI_IMAGE_MODEL
        image_bytes, _text, error = await _call_openai_image_api(
            api_key=api_key,
            model=model,
            prompt=prompt,
            reference_images=reference_images,
            image_config={
                "aspect_ratio": "2:1",
                "image_size": args.image_size,
                "quality": args.quality,
                "output_format": "png",
            },
        )
    elif provider == "newapi":
        api_key, base_url = _resolve_newapi_credentials()
        if not api_key:
            raise RuntimeError("NEWAPI_API_KEY is missing")
        model = (
            args.model
            or os.environ.get("SCENE_360_IMAGE_MODEL")
            or os.environ.get("NEWAPI_IMAGE_MODEL")
            or SCENE_360_IMAGE_MODEL
            or NEWAPI_IMAGE_MODEL
        )
        image_bytes, _text, error = await _call_newapi_image_api(
            api_key=api_key,
            model=model,
            prompt=prompt,
            reference_images=reference_images,
            image_config={
                "aspect_ratio": "2:1",
                "image_size": args.image_size,
                "quality": args.quality,
                "output_format": "png",
            },
            base_url=base_url,
            trace=provider_trace,
        )
    elif provider == "openrouter":
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is missing")
        model = (
            args.model
            or os.environ.get("SCENE_360_OPENROUTER_MODEL")
            or os.environ.get("OPENROUTER_GPT_IMAGE2_MODEL")
            or OPENROUTER_GPT_IMAGE2_MODEL
        )
        image_bytes, _text, error = await _call_openrouter_image_api(
            api_key=api_key,
            model=model,
            prompt=prompt,
            reference_images=[item[1] for item in reference_images] if reference_images else None,
            image_config={
                "aspect_ratio": "2:1",
                "image_size": args.image_size,
                "quality": args.quality,
            },
        )
    else:
        raise ValueError(f"Unsupported scene 360 provider: {provider}")

    manifest_path.write_text(
        json.dumps(
            {
                "scene": args.scene_name,
                "source": "text" if args.text_only else "master",
                "master": str(repo_path(args.master)) if not args.text_only else "",
                "reverse_master": (
                    str(repo_path(getattr(args, "reverse_master", "") or ""))
                    if (not args.text_only and getattr(args, "reverse_master", ""))
                    else ""
                ),
                "spatial_layout": (
                    str(repo_path(spatial_layout_arg)) if spatial_layout_arg else ""
                ),
                "overlap_analysis": str(overlap_analysis_path) if overlap_analysis_path else "",
                "spatial_contract": str(spatial_contract_path) if spatial_contract_path else "",
                "topology_strip": (
                    "reference_4_topology_strip_2to1.jpg" if has_topology_strip_ref else ""
                ),
                "provider": provider,
                "model": model,
                "quality": args.quality,
                "image_size": args.image_size,
                "style": args.style,
                "layer_mode": args.layer_mode,
                "request_id": provider_trace.get("request_id", ""),
                "response_id": provider_trace.get("response_id", ""),
                "result": str(result_path),
                "size_note": ("scene 360 defaults to image-2 2K medium; aspect_ratio=2:1"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    if not image_bytes:
        raise RuntimeError(error or "image generation returned no image")
    result_path.write_bytes(image_bytes)

    make_contact_sheet(output_dir, master_refs, result_path)

    print(f"output_dir={output_dir}")
    print(f"panorama={result_path}")
    print(f"prompt={prompt_path}")
    print(f"manifest={manifest_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene-name", default=SCENE_NAME)
    parser.add_argument("--master", default=str(DEFAULT_MASTER))
    parser.add_argument("--reverse-master", default="", dest="reverse_master")
    parser.add_argument("--spatial-layout", default="", dest="spatial_layout")
    parser.add_argument(
        "--spatial-contract",
        default="auto",
        dest="spatial_contract",
        help="Path to scene_spatial_contract.json; use 'auto' to load scene default, 'none' to disable.",
    )
    parser.add_argument(
        "--overlap-analysis",
        default="auto",
        dest="overlap_analysis",
        help="Path to overlap_continuation_analysis.json; use 'auto' to load scene default, 'none' to disable.",
    )
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--provider", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--scene-description", default=DEFAULT_SCENE_DESCRIPTION)
    parser.add_argument("--text-only", action="store_true")
    parser.add_argument("--quality", default="")
    parser.add_argument("--image-size", default="")
    parser.add_argument("--style", default="spider_verse_mixed_media")
    parser.add_argument("--layer-mode", default="full", choices=("full", "shell_only"))
    args = parser.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
