#!/usr/bin/env python3
"""Build a structured spatial contract from master/reverse scene references."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageDraw, ImageFont

from novelvideo.config import OUTPUT_DIR

# Demo defaults for standalone/manual runs. In production stage_asset_tasks
# always passes absolute --master/--reverse/--output-dir, so these are never used.
PROJECT_DIR = Path(OUTPUT_DIR) / "admin/xuanchuanpian"
DEFAULT_SCENE_NAME = "公寓楼电梯间"
DEFAULT_SCENE_DIR = PROJECT_DIR / "assets/scenes" / DEFAULT_SCENE_NAME
DEFAULT_MASTER = DEFAULT_SCENE_DIR / "master.png"
DEFAULT_REVERSE = DEFAULT_SCENE_DIR / "reverse_master.png"
DEFAULT_OUTPUT_DIR = DEFAULT_SCENE_DIR / "scene_spatial_contract"
DEFAULT_MODEL = "openai/gpt-5.5"
SPATIAL_CONTRACT_SCHEMA_VERSION = "scene_spatial_contract_v8_topology_only_locks"


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


def _font(size: int) -> ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _fit(
    image: Image.Image, size: tuple[int, int], fill: str = "#111111"
) -> Image.Image:
    target_w, target_h = size
    src = image.convert("RGB")
    canvas = Image.new("RGB", size, fill)
    scale = min(target_w / src.width, target_h / src.height)
    resized = src.resize(
        (max(1, round(src.width * scale)), max(1, round(src.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas.paste(
        resized, ((target_w - resized.width) // 2, (target_h - resized.height) // 2)
    )
    return canvas


def _crop(image: Image.Image, x0: float, x1: float) -> Image.Image:
    width, height = image.size
    return image.crop((round(width * x0), 0, round(width * x1), height))


def make_contract_sheet(
    master_path: Path, reverse_path: Path, output_dir: Path
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    master = Image.open(master_path).convert("RGB")
    reverse = Image.open(reverse_path).convert("RGB")
    panels: list[tuple[str, Image.Image, str]] = [
        ("FULL MASTER / front-facing reference", master, "#5ac8fa"),
        ("FULL REVERSE / back-facing reference / seam center", reverse, "#ffcc00"),
        (
            "MASTER LEFT SIDE -> pano x=0..25 / seam side",
            _crop(master, 0.0, 0.38),
            "#5ac8fa",
        ),
        ("MASTER CENTER / front wall", _crop(master, 0.31, 0.69), "#5ac8fa"),
        ("MASTER RIGHT SIDE -> pano x=25..50", _crop(master, 0.62, 1.0), "#5ac8fa"),
        ("REVERSE SCREEN-LEFT -> pano x=50..75", _crop(reverse, 0.0, 0.38), "#ffcc00"),
        ("REVERSE CENTER / back wall", _crop(reverse, 0.31, 0.69), "#ffcc00"),
        (
            "REVERSE SCREEN-RIGHT -> pano x=75..100 / seam side",
            _crop(reverse, 0.62, 1.0),
            "#ffcc00",
        ),
    ]

    cell_w, cell_h = 620, 350
    label_h = 54
    gap = 18
    cols = 2
    rows = 4
    canvas = Image.new(
        "RGB",
        (
            cols * cell_w + (cols + 1) * gap,
            rows * (cell_h + label_h) + (rows + 1) * gap,
        ),
        "#0e0f11",
    )
    draw = ImageDraw.Draw(canvas)
    title_font = _font(24)
    label_font = _font(18)
    for idx, (label, image, color) in enumerate(panels):
        col = idx % cols
        row = idx // cols
        x = gap + col * (cell_w + gap)
        y = gap + row * (cell_h + label_h + gap)
        draw.rounded_rectangle(
            (x - 3, y - 3, x + cell_w + 3, y + cell_h + label_h + 3),
            radius=8,
            fill="#1a1d22",
        )
        draw.text(
            (x + 10, y + 12),
            label,
            fill=color,
            font=title_font if idx < 2 else label_font,
        )
        canvas.paste(_fit(image, (cell_w, cell_h)), (x, y + label_h))

    sheet_path = output_dir / "scene_spatial_contract_sheet.jpg"
    canvas.save(sheet_path, "JPEG", quality=90, optimize=True)
    return sheet_path


def _list_overlap_prompt_lines(overlap_analysis: dict[str, Any] | None) -> list[str]:
    if not isinstance(overlap_analysis, dict):
        return []
    lines = [
        "PRECOMPUTED SIDE-JOIN OVERLAP ANALYSIS:",
        "- This analysis is authoritative for deciding whether side-edge objects are shared overlap anchors.",
        "- If a named overlap anchor appears in both MASTER and REVERSE, list it under the relevant side join's merge_once/shared_overlap, not as two independent front/back fixtures.",
        "- GLOBAL DO NOT DUPLICATE entries are duplicate warnings, not automatic side-join anchors. Do not move center/back/front objects into a side join unless they are listed in that pair's overlap anchors.",
    ]
    for pair in overlap_analysis.get("pairs") or []:
        if not isinstance(pair, dict):
            continue
        pair_id = str(pair.get("id") or "").strip()
        rel = str(pair.get("relationship") or "").strip()
        lines.append(f"- {pair_id}: relationship={rel}")
        overlap_names = _names(pair.get("overlap_items"), include_scale=False)
        continuation_names = _names(pair.get("continuation_items"), include_scale=False)
        if overlap_names:
            lines.append(f"  overlap anchors / MERGE ONCE: {'; '.join(overlap_names)}.")
        if continuation_names:
            lines.append(f"  continuation zones: {'; '.join(continuation_names)}.")
    do_not_duplicate = _names(
        overlap_analysis.get("do_not_duplicate"), include_scale=False
    )
    if do_not_duplicate:
        lines.append(
            f"- GLOBAL DO NOT DUPLICATE / WARNINGS ONLY: {'; '.join(do_not_duplicate)}."
        )
    return lines


def build_prompt(
    scene_name: str, overlap_analysis: dict[str, Any] | None = None
) -> str:
    overlap_block = "\n".join(_list_overlap_prompt_lines(overlap_analysis))
    return f"""
You are a spatial set-continuity analyst for a 360 panorama pipeline.
Scene: {scene_name}

This is NOT image generation. Analyze the attached reference sheet and return strict JSON only.

{overlap_block}

Coordinate assumptions:
- MASTER is the front-facing reference from one fixed camera point.
- REVERSE is the back-facing reference from the same camera point, yaw-rotated 180 degrees.
- The panorama uses a SAFE-SEAM raw canvas layout. This avoids cutting doors,
  hallways, display panels, or other high-semantic objects at the left/right seam.
- The raw final panorama x-axis contract is:
  x=0% and x=100% = low-detail LEFT SIDE seam, where MASTER left side meets
  REVERSE screen-right side. The seam should be plain continuous wall/floor/ceiling,
  not a door, hallway, display panel, or cabinet.
  x=25% = MASTER front center.
  x=50% = RIGHT SIDE join, where MASTER right side meets REVERSE screen-left side.
  x=75% = REVERSE back center.
- Non-negotiable reverse orientation in this safe-seam layout:
  REVERSE screen-left content maps to panorama x=50%..75%.
  REVERSE screen-right content maps to panorama x=75%..100%.
  REVERSE center content maps around x=75%, not across the x=0%/100% seam.
- The two images may be ordinary wide-angle references, not perfect 180-degree wall elevations.
  Identify directly visible facts and inferred/gap areas separately.

Return JSON with this schema:
{{
  "schema_version": "{SPATIAL_CONTRACT_SCHEMA_VERSION}",
  "scene_name": "...",
  "coverage_assessment": {{
    "master_coverage": "strict_180|wide_angle_partial|unclear",
    "reverse_coverage": "strict_180|wide_angle_partial|unclear",
    "coverage_gaps": [
      {{"area": "left_side_transition|right_side_transition|back_seam|front_side", "description": "...", "inference_rule": "..."}}
    ]
  }},
  "walls": {{
    "front": {{
      "panorama_position": "x=25%",
      "source": "master center",
      "must_preserve": [
        {{
          "name": "...",
          "type": "door|opening|display_panel|cabinet|sign|light|wall_surface|fixture|furniture|other",
          "count": 1,
          "source_view": "master|reverse|both|inferred",
          "source_side": "screen-left|center|screen-right|full-width|unclear",
          "panorama_zone": "x=...",
          "placement": "...",
          "size_lock": "tiny|small|medium|large|full_height|full_width|wall_dominant|unknown",
          "visual_identity": "...",
          "must_not_become": ["..."]
        }}
      ],
      "inferred_fill": ["..."]
    }},
    "back": {{
      "panorama_position": "x=75%",
      "source": "reverse center",
      "must_preserve": [],
      "seam_split_rule": "...",
      "inferred_fill": []
    }},
    "left": {{
      "panorama_position": "around x=0%/100% seam",
      "source": "master left + reverse right",
      "must_preserve": [],
      "shared_overlap": [],
      "inferred_fill": []
    }},
    "right": {{
      "panorama_position": "around x=50%",
      "source": "master right + reverse left",
      "must_preserve": [],
      "shared_overlap": [],
      "inferred_fill": []
    }}
  }},
  "joins": [
    {{"id": "left_side_join", "panorama_position": "x=0%/100% seam", "source_pair": "MASTER_LEFT + REVERSE_RIGHT", "merge_once": ["..."], "continue_smoothly": ["..."], "do_not_duplicate": ["..."]}},
    {{"id": "right_side_join", "panorama_position": "x=50%", "source_pair": "MASTER_RIGHT + REVERSE_LEFT", "merge_once": ["..."], "continue_smoothly": ["..."], "do_not_duplicate": ["..."]}}
  ],
  "must_not_transform": [
    {{"source_object": "...", "forbidden_transform": "...", "reason": "..."}}
  ],
  "direction_exclusion_locks": [
    {{"name": "...", "required_direction": "front|back", "required_panorama_zone": "x=25%|x=75%", "must_not_appear_in": "...", "reason": "..."}}
  ],
  "pano_prompt_insert": "Concise hard constraints for a 360 image-generation prompt."
}}

Be concrete and conservative. If a fixture is clearly visible in MASTER or REVERSE,
lock it as must_preserve with approximate count, source_view, source_side, panorama_zone,
and size_lock. Do not output bbox or original-image coordinates.
The downstream topology guide is coordinate-free.
Use the full MASTER/FULL REVERSE panels to judge object scale; side crops are only
helpers for edge continuity and should not make a large fixture look smaller.
For REVERSE objects, compute panorama_zone using the non-negotiable safe-seam
orientation above. Do not put REVERSE center objects at the x=0%/100% seam.
Direction locks are critical: large or wall-dominant front-center objects belong
around x=25% only; large or wall-dominant reverse-center/back objects belong
around x=75% only. Do not use back-center furniture or wall fixtures to fill
the x=50% right-side join.
Keep the JSON compact: preserve the important visible fixtures and wall surfaces,
not every tiny scratch. Prefer at most 8 must_preserve items per wall.
If an area is not visible enough, put it in coverage_gaps and inferred_fill instead
of inventing a confident wall.
""".strip()


async def ask_openrouter(
    *,
    image_path: Path,
    prompt: str,
    api_key: str,
    model: str,
    max_tokens: int,
) -> str:
    data_url = "data:image/jpeg;base64," + base64.b64encode(
        image_path.read_bytes()
    ).decode("ascii")
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    if model.lower().startswith("openai/"):
        payload["response_format"] = {"type": "json_object"}
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://supertale.local/scene-spatial-contract",
        "X-Title": "SuperTale Scene Spatial Contract",
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    choices = data.get("choices") or []
    if not choices:
        return ""
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(
            str(part.get("text") or "") for part in content if isinstance(part, dict)
        ).strip()
    return ""


def parse_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def load_overlap_analysis(
    *,
    master_path: Path,
    reverse_path: Path,
    overlap_analysis_arg: str,
) -> tuple[Path | None, dict[str, Any] | None]:
    raw_arg = str(overlap_analysis_arg or "auto").strip()
    if raw_arg.lower() in {"none", "off", "false", "0", "no"}:
        return None, None
    explicit = bool(raw_arg and raw_arg.lower() != "auto")
    if explicit:
        analysis_path = repo_path(raw_arg)
    else:
        analysis_path = (
            master_path.parent
            / "overlap_continuation_test"
            / "overlap_continuation_analysis.json"
        )
    if not analysis_path.exists():
        return None, None
    if not explicit:
        latest_input_mtime = max(
            master_path.stat().st_mtime, reverse_path.stat().st_mtime
        )
        if analysis_path.stat().st_mtime < latest_input_mtime:
            return None, None
    try:
        data = json.loads(analysis_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None
    return analysis_path, data if isinstance(data, dict) else None


_TOKEN_STOPWORDS = {
    "a",
    "an",
    "and",
    "art",
    "fixture",
    "fixtures",
    "frame",
    "framed",
    "large",
    "small",
    "the",
    "wall",
}
_UNIQUE_ANCHOR_TOKENS = {
    "ad",
    "ads",
    "board",
    "cabinet",
    "counter",
    "curtain",
    "display",
    "door",
    "drapery",
    "extinguisher",
    "frame",
    "lightbox",
    "menu",
    "panel",
    "painting",
    "poster",
    "shelf",
    "shelves",
    "sign",
    "sofa",
    "couch",
    "bookshelf",
    "bookcase",
    "desk",
    "window",
}
_SIDE_JOIN_SURFACE_TOKENS = {
    "ceiling",
    "floor",
    "flooring",
    "light",
    "lighting",
    "rug",
    "wall",
}
_SIDE_JOIN_CENTER_OBJECT_MARKERS = (
    "area rug",
    "coffee table",
    "center table",
    "central table",
    "茶几",
    "地毯",
)
_SIDE_JOIN_SURFACE_MARKERS = (
    "carpet",
    "ceiling",
    "floor",
    "plain wall",
    "rug",
    "wall area",
    "wall behind",
    "wall section",
    "wall surface",
)
_SIDE_JOIN_SURFACE_UNIQUE_MARKERS = (
    "cabinet",
    "display",
    "door",
    "drapery",
    "curtain",
    "extinguisher",
    "lightbox",
    "menu",
    "panel",
    "poster",
    "sign",
    "window",
)
_DIRECTION_LOCK_TYPES = {
    "cabinet",
    "display_panel",
    "door",
    "fixture",
    "furniture",
    "light",
    "opening",
    "sign",
}
_DIRECTION_LOCK_SIZE_LOCKS = {"large", "full_height", "full_width", "wall_dominant"}
_DIRECTION_LOCK_NAME_TOKENS = {
    "bookcase",
    "bookshelf",
    "cabinet",
    "desk",
    "display",
    "door",
    "elevator",
    "panel",
    "screen",
    "shelf",
    "sofa",
    "tv",
    "window",
}


def _tokenize_name(value: Any) -> set[str]:
    text = str(value or "").lower()
    raw_tokens = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", text)
    return {
        token
        for token in raw_tokens
        if len(token) > 1 and token not in _TOKEN_STOPWORDS
    }


def _is_name_match(candidate: str, target: str) -> bool:
    candidate_tokens = _tokenize_name(candidate)
    target_tokens = _tokenize_name(target)
    if not candidate_tokens or not target_tokens:
        return False
    overlap = candidate_tokens & target_tokens
    return bool(overlap) and (
        overlap == target_tokens
        or overlap == candidate_tokens
        or len(overlap) >= min(2, len(target_tokens))
    )


def _is_unique_overlap_anchor(name: str) -> bool:
    tokens = _tokenize_name(name)
    if not tokens:
        return False
    if tokens & _UNIQUE_ANCHOR_TOKENS:
        return True
    lowered = str(name or "").lower()
    return any(
        marker in lowered
        for marker in (
            "消防",
            "柜",
            "门",
            "窗",
            "屏",
            "牌",
            "招牌",
            "菜单",
            "椅",
            "画",
            "沙发",
            "书架",
            "书柜",
        )
    )


def _is_side_merge_lock_anchor(name: str) -> bool:
    lowered = str(name or "").lower()
    if not lowered.strip():
        return False
    if any(marker in lowered for marker in _SIDE_JOIN_CENTER_OBJECT_MARKERS):
        return False
    if any(marker in lowered for marker in _SIDE_JOIN_SURFACE_MARKERS) and not any(
        marker in lowered for marker in _SIDE_JOIN_SURFACE_UNIQUE_MARKERS
    ):
        return False
    tokens = _tokenize_name(lowered)
    if tokens & _SIDE_JOIN_SURFACE_TOKENS and not (tokens & _UNIQUE_ANCHOR_TOKENS):
        return False
    return _is_unique_overlap_anchor(name)


def _unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean = str(value or "").strip()
        key = " ".join(sorted(_tokenize_name(clean))) or clean.lower()
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def _extract_pair_names(items: Any) -> list[str]:
    values: list[str] = []
    if not isinstance(items, list):
        return values
    for item in items:
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
        else:
            name = str(item or "").strip()
        if name:
            values.append(name)
    return _unique_strings(values)


def _find_representative_and_remove(
    walls: dict[str, Any],
    *,
    overlap_name: str,
    remove_from_wall_ids: tuple[str, ...],
) -> dict[str, Any] | None:
    representative: dict[str, Any] | None = None
    if not _is_unique_overlap_anchor(overlap_name):
        return None
    for wall_id in remove_from_wall_ids:
        wall = walls.get(wall_id)
        if not isinstance(wall, dict):
            continue
        preserved = wall.get("must_preserve")
        if not isinstance(preserved, list):
            continue
        remaining: list[Any] = []
        for item in preserved:
            item_name = (
                str(item.get("name") or "") if isinstance(item, dict) else str(item)
            )
            if _is_name_match(item_name, overlap_name):
                if representative is None and isinstance(item, dict):
                    representative = dict(item)
                continue
            remaining.append(item)
        wall["must_preserve"] = remaining
    return representative


def _append_shared_overlap(
    wall: dict[str, Any],
    *,
    name: str,
    representative: dict[str, Any] | None,
    pair_id: str,
) -> None:
    shared = wall.setdefault("shared_overlap", [])
    if not isinstance(shared, list):
        shared = []
        wall["shared_overlap"] = shared
    if any(
        _is_name_match(str(item.get("name") if isinstance(item, dict) else item), name)
        for item in shared
    ):
        return
    payload: dict[str, Any] = {
        "name": name,
        "type": str((representative or {}).get("type") or "fixture"),
        "count": 1,
        "source_view": "both",
        "source_side": "side-overlap",
        "panorama_zone": str(wall.get("panorama_position") or ""),
        "placement": f"{pair_id} shared overlap anchor",
        "size_lock": str((representative or {}).get("size_lock") or "unknown"),
        "visual_identity": str(
            (representative or {}).get("visual_identity")
            or "same physical side-edge anchor visible in both master and reverse"
        ),
        "must_not_become": ["two separate copies", "duplicated fixture"],
    }
    shared.append(payload)


def _clean_shared_overlap(
    wall: dict[str, Any],
    *,
    allowed_names: list[str],
) -> None:
    shared = wall.get("shared_overlap")
    if not isinstance(shared, list):
        return
    kept: list[Any] = []
    removed_names: list[str] = []
    for item in shared:
        name = (
            str(item.get("name") or "") if isinstance(item, dict) else str(item or "")
        )
        if any(_is_name_match(name, allowed) for allowed in allowed_names):
            kept.append(item)
        elif name:
            removed_names.append(name)
    wall["shared_overlap"] = kept
    if removed_names:
        inferred = wall.setdefault("inferred_fill", [])
        if isinstance(inferred, list):
            inferred.append(
                "Continue non-anchor overlap surfaces/materials smoothly; do not treat these as "
                f"unique duplicated side anchors: {'; '.join(_unique_strings(removed_names))}."
            )


def _merge_join_values(join: dict[str, Any], key: str, values: list[str]) -> None:
    existing = _names(join.get(key), include_scale=False)
    join[key] = _unique_strings([*existing, *values])


def apply_overlap_analysis(
    contract: dict[str, Any],
    overlap_analysis: dict[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(overlap_analysis, dict):
        return contract
    walls = contract.setdefault("walls", {})
    if not isinstance(walls, dict):
        walls = {}
        contract["walls"] = walls
    joins = contract.setdefault("joins", [])
    if not isinstance(joins, list):
        joins = []
        contract["joins"] = joins
    join_by_id = {
        str(join.get("id") or ""): join for join in joins if isinstance(join, dict)
    }

    pair_to_wall = {
        "left_side_join": ("left", ("front", "back")),
        "right_side_join": ("right", ("front", "back")),
    }
    pair_overlap_lock_names: list[str] = []
    for pair in overlap_analysis.get("pairs") or []:
        if not isinstance(pair, dict):
            continue
        pair_id = str(pair.get("id") or "").strip()
        side_wall_id, remove_from = pair_to_wall.get(pair_id, ("", ()))
        if not side_wall_id:
            continue
        join = join_by_id.get(pair_id)
        if join is None:
            join = {
                "id": pair_id,
                "panorama_position": (
                    "x=0%/100% seam" if pair_id == "left_side_join" else "x=50%"
                ),
                "source_pair": (
                    "MASTER_LEFT + REVERSE_RIGHT"
                    if pair_id == "left_side_join"
                    else "MASTER_RIGHT + REVERSE_LEFT"
                ),
                "merge_once": [],
                "continue_smoothly": [],
                "do_not_duplicate": [],
            }
            joins.append(join)
            join_by_id[pair_id] = join

        overlap_names = _extract_pair_names(pair.get("overlap_items"))
        merge_anchor_names = [
            name for name in overlap_names if _is_side_merge_lock_anchor(name)
        ]
        non_anchor_overlap_names = [
            name for name in overlap_names if not _is_side_merge_lock_anchor(name)
        ]
        continuation_names = _extract_pair_names(pair.get("continuation_items"))
        existing_continuation = _names(
            join.get("continue_smoothly"), include_scale=False
        )
        join["merge_once"] = _unique_strings(merge_anchor_names)
        join["do_not_duplicate"] = _unique_strings(merge_anchor_names)
        join["continue_smoothly"] = _unique_strings(
            [*existing_continuation, *continuation_names, *non_anchor_overlap_names]
        )
        pair_overlap_lock_names.extend(merge_anchor_names)

        side_wall = walls.setdefault(side_wall_id, {})
        if not isinstance(side_wall, dict):
            side_wall = {}
            walls[side_wall_id] = side_wall
        _clean_shared_overlap(side_wall, allowed_names=merge_anchor_names)
        for overlap_name in merge_anchor_names:
            representative = _find_representative_and_remove(
                walls,
                overlap_name=overlap_name,
                remove_from_wall_ids=remove_from,
            )
            _append_shared_overlap(
                side_wall,
                name=overlap_name,
                representative=representative,
                pair_id=pair_id,
            )

    do_not_duplicate = _extract_pair_names(overlap_analysis.get("do_not_duplicate"))
    contract["overlap_duplicate_warnings"] = [
        {
            "name": name,
            "rule": "Do not create duplicate copies if this is visibly the same object, but do not move it between directions unless a side join explicitly lists it under merge_once.",
        }
        for name in do_not_duplicate
    ]
    pair_overlap_lock_names = _unique_strings(pair_overlap_lock_names)
    contract["overlap_merge_locks"] = [
        {
            "name": name,
            "rule": "If this appears in both master and reverse side crops, render it once as a shared physical anchor, never as separate front/back copies.",
        }
        for name in pair_overlap_lock_names
    ]
    transforms = contract.setdefault("must_not_transform", [])
    if isinstance(transforms, list):
        for name in pair_overlap_lock_names:
            if any(
                isinstance(item, dict)
                and _is_name_match(str(item.get("source_object") or ""), name)
                and "duplicate" in str(item.get("forbidden_transform") or "").lower()
                for item in transforms
            ):
                continue
            transforms.append(
                {
                    "source_object": name,
                    "forbidden_transform": "duplicate as separate master-side and reverse-side copies",
                    "reason": "overlap analyzer classified this as the same physical side-edge anchor.",
                }
            )
    return contract


def _is_direction_lock_candidate(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    name = str(item.get("name") or "").strip()
    if not name:
        return False
    item_type = str(item.get("type") or "").strip().lower()
    size_lock = str(item.get("size_lock") or "").strip().lower()
    source_view = str(item.get("source_view") or "").strip().lower()
    if source_view in {"both", "inferred"}:
        return False
    if item_type == "wall_surface" and size_lock not in _DIRECTION_LOCK_SIZE_LOCKS:
        return False
    tokens = _tokenize_name(name)
    return (
        item_type in _DIRECTION_LOCK_TYPES
        or size_lock in _DIRECTION_LOCK_SIZE_LOCKS
        or bool(tokens & _DIRECTION_LOCK_NAME_TOKENS)
    )


def add_direction_exclusion_locks(contract: dict[str, Any]) -> None:
    walls = contract.get("walls")
    if not isinstance(walls, dict):
        return

    specs = {
        "front": {
            "required_direction": "front",
            "required_panorama_zone": "raw x=25% / corrected viewer yaw 0°",
            "must_not_appear_in": (
                "raw x=50% right-side join, raw x=75% reverse back center, "
                "or raw x=0%/100% safe seam"
            ),
            "reason": "This is visible in master front center and must not migrate to side/back zones.",
        },
        "back": {
            "required_direction": "back",
            "required_panorama_zone": "raw x=75% / corrected viewer yaw 180°",
            "must_not_appear_in": (
                "raw x=25% master front center, raw x=50% right-side join, "
                "or raw x=0%/100% safe seam"
            ),
            "reason": "This is visible in reverse back center and must not be used to fill a side join or front wall.",
        },
    }

    locks = contract.setdefault("direction_exclusion_locks", [])
    if not isinstance(locks, list):
        locks = []
        contract["direction_exclusion_locks"] = locks
    existing = {
        (
            str(item.get("name") or "").lower(),
            str(item.get("required_direction") or "").lower(),
        )
        for item in locks
        if isinstance(item, dict)
    }

    for wall_id, spec in specs.items():
        wall = walls.get(wall_id)
        if not isinstance(wall, dict):
            continue
        preserved = wall.get("must_preserve")
        if not isinstance(preserved, list):
            continue
        for item in preserved:
            if not _is_direction_lock_candidate(item):
                continue
            name = str(item.get("name") or "").strip()
            key = (name.lower(), str(spec["required_direction"]).lower())
            if key in existing:
                continue
            locks.append(
                {
                    "name": name,
                    "required_direction": spec["required_direction"],
                    "required_panorama_zone": spec["required_panorama_zone"],
                    "must_not_appear_in": spec["must_not_appear_in"],
                    "reason": spec["reason"],
                }
            )
            existing.add(key)


def _names(items: Any, *, include_scale: bool = True) -> list[str]:
    if not isinstance(items, list):
        return []
    values: list[str] = []
    for item in items:
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("source_object") or "").strip()
            placement = str(item.get("placement") or "").strip()
            pieces: list[str] = []
            source_view = str(item.get("source_view") or "").strip()
            source_side = str(item.get("source_side") or "").strip()
            panorama_zone = str(item.get("panorama_zone") or "").strip()
            if source_view:
                pieces.append(f"source={source_view}")
            if source_side:
                pieces.append(f"source_side={source_side}")
            if panorama_zone:
                pieces.append(f"pano_zone={panorama_zone}")
            if placement:
                pieces.append(placement)
            if include_scale:
                count = item.get("count")
                if isinstance(count, (int, float)):
                    pieces.append(f"count={int(count)}")
                size_lock = str(item.get("size_lock") or "").strip()
                if size_lock:
                    pieces.append(f"size={size_lock}")
                identity = str(item.get("visual_identity") or "").strip()
                if identity:
                    pieces.append(f"identity={identity}")
            value = f"{name} ({'; '.join(pieces)})" if pieces else name
        else:
            value = str(item).strip()
        if value:
            values.append(value)
    return values


def synthesize_prompt_insert(contract: dict[str, Any]) -> str:
    lines = [
        "SCENE SPATIAL CONTRACT — HARD REQUIREMENT:",
        "- Use this contract as the primary structure for the 360 panorama. Master/reverse images provide visual identity and exact fixture appearance.",
        "- Do not invent a different wall layout when this contract names visible wall fixtures, openings, signs, panels, or cabinets.",
        "- Preserve listed fixture COUNT and SCALE. Do not shrink a large fixture into a small one, and do not enlarge a small fixture into a dominant wall feature.",
        "- Do not add extra doors, corridors, display panels, signs, cabinets, lamps, or wall fixtures that are not listed in the contract.",
        "- In inferred-fill / coverage-gap areas, generate plain continuation of wall/floor/ceiling materials unless a fixture is explicitly listed.",
        "- SAFE-SEAM ORIENTATION LOCK: raw panorama x=0%/100% is a low-detail LEFT SIDE seam; master front center is x=25%; right side join is x=50%; reverse back center is x=75%. Do not put reverse center at the seam.",
        "- FRONT/BACK DIRECTION LOCK: front-only objects stay at x=25%; back-only reverse-center objects stay at x=75%. The x=50% right-side join is not the back wall.",
        "- LEFT/RIGHT SEAM CONTENT LOCK: the x=0%/100% seam should be continuous side wall/floor/ceiling. If an explicitly listed SHARED OVERLAP anchor is seam-adjacent, render it as one split/continuous physical object, never as two copies.",
        "- SHARED OVERLAP LOCK: items under SHARED OVERLAP, MERGE ONCE, or DO NOT DUPLICATE are the same physical anchors visible from both master/reverse side crops. They override front/back duplicate detections.",
    ]
    merge_locks = contract.get("overlap_merge_locks") or []
    if merge_locks:
        lines.append("GLOBAL OVERLAP MERGE LOCKS:")
        for item in merge_locks:
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip()
                rule = str(item.get("rule") or "").strip()
                if name:
                    lines.append(f"- {name}: {rule or 'render once, never duplicate.'}")
    direction_locks = contract.get("direction_exclusion_locks") or []
    if direction_locks:
        lines.append("DIRECTION EXCLUSION LOCKS:")
        for item in direction_locks:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            required = str(item.get("required_direction") or "").strip()
            zone = str(item.get("required_panorama_zone") or "").strip()
            forbidden = str(item.get("must_not_appear_in") or "").strip()
            reason = str(item.get("reason") or "").strip()
            if name:
                lines.append(
                    f"- {name}: required {required} at {zone}; must not appear in {forbidden}. {reason}"
                )
    coverage = contract.get("coverage_assessment") or {}
    gaps = coverage.get("coverage_gaps") or []
    if gaps:
        lines.append("COVERAGE GAPS / INFERENCE AREAS:")
        for gap in gaps:
            if isinstance(gap, dict):
                area = str(gap.get("area") or "").strip()
                desc = str(gap.get("description") or "").strip()
                rule = str(gap.get("inference_rule") or "").strip()
                lines.append(f"- {area}: {desc} Inference rule: {rule}")
    walls = contract.get("walls") or {}
    for wall_id in ("front", "back", "left", "right"):
        wall = walls.get(wall_id) or {}
        pos = str(wall.get("panorama_position") or "").strip()
        source = str(wall.get("source") or "").strip()
        lines.append(f"{wall_id.upper()} WALL / DIRECTION ({pos}, source: {source}):")
        preserved = _names(wall.get("must_preserve"))
        if preserved:
            lines.append("- MUST PRESERVE: " + "; ".join(preserved) + ".")
            lines.append(
                "- COUNT/SCALE LOCK: preserve the listed count and size_lock; do not resize wall-dominant fixtures into small details."
            )
        lines.append(
            "- NO EXTRA FIXTURES: do not add unlisted doors, corridors, panels, signs, cabinets, or lights on this wall."
        )
        shared = _names(wall.get("shared_overlap"))
        if shared:
            lines.append("- SHARED OVERLAP / MERGE ONCE: " + "; ".join(shared) + ".")
        inferred = _names(wall.get("inferred_fill"))
        if inferred:
            lines.append("- INFERRED FILL ONLY: " + "; ".join(inferred) + ".")
        seam_rule = str(wall.get("seam_split_rule") or "").strip()
        if seam_rule:
            lines.append(f"- SEAM SPLIT RULE: {seam_rule}")
    joins = contract.get("joins") or []
    if joins:
        lines.append("SIDE JOIN RULES:")
        for join in joins:
            if not isinstance(join, dict):
                continue
            join_id = str(join.get("id") or "").strip()
            pos = str(join.get("panorama_position") or "").strip()
            source_pair = str(join.get("source_pair") or "").strip()
            lines.append(f"- {join_id} at {pos} from {source_pair}:")
            for key, label in (
                ("merge_once", "MERGE ONCE"),
                ("continue_smoothly", "CONTINUE SMOOTHLY"),
                ("do_not_duplicate", "DO NOT DUPLICATE"),
            ):
                values = _names(join.get(key))
                if values:
                    lines.append(f"  {label}: " + "; ".join(values) + ".")
    transforms = contract.get("must_not_transform") or []
    if transforms:
        lines.append("FORBIDDEN FIXTURE TRANSFORMS:")
        for item in transforms:
            if isinstance(item, dict):
                source = str(item.get("source_object") or "").strip()
                forbidden = str(item.get("forbidden_transform") or "").strip()
                reason = str(item.get("reason") or "").strip()
                lines.append(f"- {source}: must not become {forbidden}. {reason}")
    return "\n".join(lines)


async def run(args: argparse.Namespace, *, egress_context=None) -> None:
    from novelvideo.task_backend.subprocesses import require_direct_model_egress_allowed

    require_direct_model_egress_allowed(egress_context)
    load_env()
    master = repo_path(args.master)
    reverse = repo_path(args.reverse)
    output_dir = repo_path(args.output_dir)
    if not master.exists():
        raise FileNotFoundError(master)
    if not reverse.exists():
        raise FileNotFoundError(reverse)

    overlap_analysis_path, overlap_analysis = load_overlap_analysis(
        master_path=master,
        reverse_path=reverse,
        overlap_analysis_arg=args.overlap_analysis,
    )

    sheet_path = make_contract_sheet(master, reverse, output_dir)
    prompt = build_prompt(args.scene_name, overlap_analysis=overlap_analysis)
    (output_dir / "scene_spatial_contract.prompt.txt").write_text(
        prompt, encoding="utf-8"
    )

    api_key = args.api_key or os.environ.get("OPENROUTER_API_KEY") or ""
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is missing")
    raw_text = await ask_openrouter(
        image_path=sheet_path,
        prompt=prompt,
        api_key=api_key,
        model=args.model,
        max_tokens=max(4000, int(args.max_tokens)),
    )
    (output_dir / "scene_spatial_contract.raw_response.txt").write_text(
        raw_text, encoding="utf-8"
    )
    contract = parse_json(raw_text)
    contract["schema_version"] = SPATIAL_CONTRACT_SCHEMA_VERSION
    contract = apply_overlap_analysis(contract, overlap_analysis)
    add_direction_exclusion_locks(contract)
    contract["pano_prompt_insert"] = synthesize_prompt_insert(contract)
    contract["inputs"] = {
        "master": str(master),
        "reverse": str(reverse),
        "sheet": str(sheet_path),
        "overlap_analysis": str(overlap_analysis_path) if overlap_analysis_path else "",
        "provider": "openrouter",
        "model": args.model,
    }
    contract_path = output_dir / "scene_spatial_contract.json"
    contract_path.write_text(
        json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {"contract": str(contract_path), "sheet": str(sheet_path)},
            ensure_ascii=False,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene-name", default=DEFAULT_SCENE_NAME)
    parser.add_argument("--master", default=str(DEFAULT_MASTER))
    parser.add_argument("--reverse", default=str(DEFAULT_REVERSE))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument(
        "--overlap-analysis",
        default="auto",
        dest="overlap_analysis",
        help="Path to overlap_continuation_analysis.json; use 'auto' to load scene default.",
    )
    parser.add_argument(
        "--model",
        default=(
            os.environ.get("SCENE_SPATIAL_CONTRACT_MODEL")
            or os.environ.get("OPENROUTER_VISION_MODEL")
            or DEFAULT_MODEL
        ),
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=int(os.environ.get("SCENE_SPATIAL_CONTRACT_MAX_TOKENS") or "16000"),
    )
    parser.add_argument("--api-key", default="")
    return parser.parse_args()


def main() -> None:
    asyncio.run(run(parse_args()))


if __name__ == "__main__":
    main()
