#!/usr/bin/env python3
"""Analyze overlap vs continuation between master and reverse scene references."""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
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
DEFAULT_SCENE_NAME = "兰州拉面馆"
DEFAULT_SCENE_DIR = PROJECT_DIR / "assets/scenes" / DEFAULT_SCENE_NAME
DEFAULT_MASTER = DEFAULT_SCENE_DIR / "master.png"
DEFAULT_REVERSE = DEFAULT_SCENE_DIR / "reverse_master.png"
DEFAULT_OUTPUT_DIR = DEFAULT_SCENE_DIR / "overlap_continuation_test"
DEFAULT_MODEL = "gemini-3.5-flash"


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
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _fit(
    image: Image.Image, box: tuple[int, int], fill: str = "#111111"
) -> Image.Image:
    target_w, target_h = box
    fitted = Image.new("RGB", (target_w, target_h), fill)
    src = image.convert("RGB")
    scale = min(target_w / src.width, target_h / src.height)
    size = (max(1, round(src.width * scale)), max(1, round(src.height * scale)))
    resized = src.resize(size, Image.Resampling.LANCZOS)
    x = (target_w - resized.width) // 2
    y = (target_h - resized.height) // 2
    fitted.paste(resized, (x, y))
    return fitted


def _crop_edge(image: Image.Image, side: str, ratio: float) -> Image.Image:
    width, height = image.size
    crop_w = max(1, int(width * ratio))
    if side == "left":
        box = (0, 0, crop_w, height)
    elif side == "right":
        box = (width - crop_w, 0, width, height)
    else:
        raise ValueError(f"unsupported side: {side}")
    return image.crop(box)


def make_crop_sheet(
    master_path: Path,
    reverse_path: Path,
    output_dir: Path,
    *,
    edge_ratio: float,
) -> tuple[Path, dict[str, Path]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    master = Image.open(master_path).convert("RGB")
    reverse = Image.open(reverse_path).convert("RGB")

    crops = {
        "master_left": _crop_edge(master, "left", edge_ratio),
        "master_right": _crop_edge(master, "right", edge_ratio),
        "reverse_left": _crop_edge(reverse, "left", edge_ratio),
        "reverse_right": _crop_edge(reverse, "right", edge_ratio),
    }

    crop_paths: dict[str, Path] = {}
    for name, image in crops.items():
        path = output_dir / f"{name}.jpg"
        image.save(path, "JPEG", quality=92, optimize=True)
        crop_paths[name] = path

    canvas = Image.new("RGB", (1800, 1620), "#0e0f11")
    draw = ImageDraw.Draw(canvas)
    title_font = _font(32)
    label_font = _font(24)
    note_font = _font(20)
    draw.text(
        (30, 24),
        "Scene overlap / continuation analysis sheet",
        fill="#ffffff",
        font=title_font,
    )
    draw.text(
        (30, 66),
        "MASTER is front 180. REVERSE is back 180 from same camera position. Compare side joins.",
        fill="#cfd3dc",
        font=note_font,
    )

    panels = [
        ("FULL MASTER", master, (30, 115), (840, 470), "#5ac8fa"),
        ("FULL REVERSE", reverse, (930, 115), (840, 470), "#ffcc00"),
        (
            "PAIR A / LEFT SIDE JOIN: MASTER LEFT",
            crops["master_left"],
            (30, 685),
            (840, 360),
            "#5ac8fa",
        ),
        (
            "PAIR A / LEFT SIDE JOIN: REVERSE RIGHT",
            crops["reverse_right"],
            (930, 685),
            (840, 360),
            "#ffcc00",
        ),
        (
            "PAIR B / RIGHT SIDE JOIN: MASTER RIGHT",
            crops["master_right"],
            (30, 1165),
            (840, 360),
            "#5ac8fa",
        ),
        (
            "PAIR B / RIGHT SIDE JOIN: REVERSE LEFT",
            crops["reverse_left"],
            (930, 1165),
            (840, 360),
            "#ffcc00",
        ),
    ]
    for label, image, origin, size, color in panels:
        x, y = origin
        w, h = size
        draw.rounded_rectangle(
            (x - 4, y - 42, x + w + 4, y + h + 4), radius=10, fill="#1a1d22"
        )
        draw.text((x, y - 34), label, fill=color, font=label_font)
        canvas.paste(_fit(image, size), origin)

    sheet_path = output_dir / "overlap_continuation_sheet.jpg"
    canvas.save(sheet_path, "JPEG", quality=90, optimize=True)
    return sheet_path, crop_paths


def build_prompt(scene_name: str) -> str:
    return f"""
You are analyzing two opposite 180-degree visual references for one fixed 3D scene: {scene_name}.
This is NOT an image-generation task. Return JSON only.

Coordinate contract:
- MASTER is the front-facing 180-degree half from the camera position.
- REVERSE is the back-facing 180-degree half from the same camera position, yaw turned 180 degrees.
- MASTER LEFT and REVERSE RIGHT belong to the same physical left-side join.
- MASTER RIGHT and REVERSE LEFT belong to the same physical right-side join.
- A side join can contain BOTH overlap and continuation.

Definitions:
- overlap: the two crops show the same physical region, fixture, wall section, object, sign, table, window, door, cabinet, or architectural anchor. It must be merged once in the panorama, not duplicated.
- continuation: the two crops show adjacent/continued parts of the same side wall, aisle, ceiling line, floor line, counter run, window run, table row, or doorway sequence. They should connect smoothly but should not be treated as the exact same object.
- conflict: the two crops disagree in a way that cannot both be true.

Analyze the sheet labels and produce strict JSON with this schema:
{{
  "scene_name": "...",
  "scene_summary": "...",
  "pairs": [
    {{
      "id": "left_side_join",
      "physical_side": "camera_left_side",
      "crop_a": "MASTER_LEFT",
      "crop_b": "REVERSE_RIGHT",
      "relationship": "overlap_only|continuation_only|mixed_overlap_and_continuation|conflict_or_unrelated",
      "overlap_items": [
        {{"name": "...", "where_in_master": "...", "where_in_reverse": "...", "merge_instruction": "..."}}
      ],
      "continuation_items": [
        {{"name": "...", "from_master": "...", "to_reverse": "...", "stitch_instruction": "..."}}
      ],
      "conflicts": [],
      "generation_instruction": "...",
      "confidence": 0.0
    }},
    {{
      "id": "right_side_join",
      "physical_side": "camera_right_side",
      "crop_a": "MASTER_RIGHT",
      "crop_b": "REVERSE_LEFT",
      "relationship": "overlap_only|continuation_only|mixed_overlap_and_continuation|conflict_or_unrelated",
      "overlap_items": [],
      "continuation_items": [],
      "conflicts": [],
      "generation_instruction": "...",
      "confidence": 0.0
    }}
  ],
  "front_unique_items": ["items visible mainly in MASTER front center"],
  "back_unique_items": ["items visible mainly in REVERSE back center"],
  "do_not_duplicate": ["specific shared objects/regions that should appear once"],
  "pano_prompt_insert": "Short instruction block to insert into a 360-generation prompt."
}}

Be concrete. Mention visual anchors by appearance and location. If uncertain, say so in confidence,
but still classify the join.
""".strip()


async def ask_openrouter(
    *, image_path: Path, prompt: str, api_key: str, model: str
) -> str:
    image_bytes = image_path.read_bytes()
    data_url = "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_tokens": 2200,
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
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://supertale.local/scene-overlap",
        "X-Title": "SuperTale Scene Overlap Analyzer",
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


def render_annotation(
    sheet_path: Path, analysis: dict[str, Any], output_dir: Path
) -> Path:
    sheet = Image.open(sheet_path).convert("RGB")
    side_w = 640
    canvas = Image.new("RGB", (sheet.width + side_w, sheet.height), "#101216")
    canvas.paste(sheet, (0, 0))
    draw = ImageDraw.Draw(canvas)
    title_font = _font(28)
    body_font = _font(20)
    small_font = _font(17)

    x = sheet.width + 30
    y = 32
    draw.text((x, y), "AI join analysis", fill="#ffffff", font=title_font)
    y += 55
    summary = str(analysis.get("scene_summary") or "")[:220]
    for line in _wrap(summary, 48):
        draw.text((x, y), line, fill="#cfd3dc", font=small_font)
        y += 24
    y += 20

    for pair in analysis.get("pairs") or []:
        pair_id = str(pair.get("id") or "pair")
        rel = str(pair.get("relationship") or "unknown")
        conf = pair.get("confidence")
        draw.text((x, y), f"{pair_id}: {rel} ({conf})", fill="#ffcc00", font=body_font)
        y += 32
        instruction = str(pair.get("generation_instruction") or "")[:280]
        for line in _wrap(instruction, 52):
            draw.text((x + 8, y), line, fill="#e8e8e8", font=small_font)
            y += 23
        overlap = pair.get("overlap_items") or []
        continuation = pair.get("continuation_items") or []
        draw.text(
            (x + 8, y),
            f"overlap: {len(overlap)}    continuation: {len(continuation)}",
            fill="#8fd694",
            font=small_font,
        )
        y += 38

    insert = str(analysis.get("pano_prompt_insert") or "")[:700]
    draw.text((x, y), "Prompt insert", fill="#5ac8fa", font=body_font)
    y += 32
    for line in _wrap(insert, 54):
        if y > canvas.height - 32:
            break
        draw.text((x + 8, y), line, fill="#d7e8ff", font=small_font)
        y += 23

    output_path = output_dir / "overlap_continuation_guide.jpg"
    canvas.save(output_path, "JPEG", quality=90, optimize=True)
    return output_path


def synthesize_pano_prompt_insert(analysis: dict[str, Any]) -> str:
    lines = [
        "MASTER/REVERSE SIDE-JOIN STITCHING CONTRACT:",
        "- Treat master.png and reverse_master.png as two opposite 180-degree halves from one fixed camera point.",
        "- The side joins may contain BOTH shared overlap anchors and adjacent continuation zones; handle them separately.",
        "- Overlap anchors must be merged once in the panorama, never duplicated on both sides of a join.",
        "- Continuation zones should extend smoothly across the join but keep adjacent objects as adjacent, not cloned.",
    ]
    for pair in analysis.get("pairs") or []:
        pair_id = str(pair.get("id") or "side_join")
        crop_a = str(pair.get("crop_a") or "")
        crop_b = str(pair.get("crop_b") or "")
        relationship = str(pair.get("relationship") or "unknown")
        lines.append(
            f"- {pair_id}: {crop_a} connects to {crop_b}; relationship={relationship}."
        )
        overlap_names = [
            str(item.get("name") or "").strip()
            for item in (pair.get("overlap_items") or [])
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        ]
        continuation_names = [
            str(item.get("name") or "").strip()
            for item in (pair.get("continuation_items") or [])
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        ]
        if overlap_names:
            lines.append(
                "  OVERLAP / MERGE ONCE: "
                + "; ".join(overlap_names)
                + ". These are the same physical anchors visible from both references."
            )
        if continuation_names:
            lines.append(
                "  CONTINUATION / STITCH SMOOTHLY: "
                + "; ".join(continuation_names)
                + ". These should continue across the side wall/floor/ceiling, not repeat as separate copies."
            )
        instruction = str(pair.get("generation_instruction") or "").strip()
        if instruction:
            lines.append(f"  JOIN INSTRUCTION: {instruction}")

    do_not_duplicate = [
        str(item).strip()
        for item in (analysis.get("do_not_duplicate") or [])
        if str(item).strip()
    ]
    if do_not_duplicate:
        lines.append(
            "DO NOT DUPLICATE ACROSS JOINS: " + "; ".join(do_not_duplicate) + "."
        )

    front_unique = [
        str(item).strip()
        for item in (analysis.get("front_unique_items") or [])
        if str(item).strip()
    ]
    back_unique = [
        str(item).strip()
        for item in (analysis.get("back_unique_items") or [])
        if str(item).strip()
    ]
    if front_unique or back_unique:
        lines.extend(
            [
                "UNIQUE FIXTURE PRESERVATION — HARD REQUIREMENT:",
                "- These fixtures are not generic wall openings. Preserve their type, side, and visual identity exactly from the reference images.",
                "- Do not convert illuminated panels, signs, cabinets, call buttons, sensors, lamps, or plaques into doors, corridors, blank walls, or different fixtures.",
            ]
        )
    if front_unique:
        lines.append(
            "  MASTER FRONT UNIQUE ITEMS TO PRESERVE: " + "; ".join(front_unique) + "."
        )
    if back_unique:
        lines.append(
            "  REVERSE BACK UNIQUE ITEMS TO PRESERVE: " + "; ".join(back_unique) + "."
        )
    return "\n".join(lines)


def _wrap(text: str, width: int) -> list[str]:
    words = text.replace("\n", " ").split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines or [""]


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

    sheet_path, crop_paths = make_crop_sheet(
        master,
        reverse,
        output_dir,
        edge_ratio=args.edge_ratio,
    )
    prompt = build_prompt(args.scene_name)
    (output_dir / "overlap_continuation_prompt.txt").write_text(
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
    )
    (output_dir / "overlap_continuation_raw_response.txt").write_text(
        raw_text, encoding="utf-8"
    )
    analysis = parse_json(raw_text)
    ai_insert = analysis.get("pano_prompt_insert")
    analysis["ai_pano_prompt_insert"] = ai_insert
    analysis["pano_prompt_insert"] = synthesize_pano_prompt_insert(analysis)
    analysis["inputs"] = {
        "master": str(master),
        "reverse": str(reverse),
        "sheet": str(sheet_path),
        "crops": {key: str(value) for key, value in crop_paths.items()},
        "model": args.model,
    }
    analysis_path = output_dir / "overlap_continuation_analysis.json"
    analysis_path.write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    guide_path = render_annotation(sheet_path, analysis, output_dir)

    print(
        json.dumps(
            {"analysis": str(analysis_path), "guide": str(guide_path)},
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
        "--model", default=os.environ.get("OPENROUTER_VISION_MODEL", DEFAULT_MODEL)
    )
    parser.add_argument("--api-key", default="")
    parser.add_argument("--edge-ratio", type=float, default=0.36)
    return parser.parse_args()


def main() -> None:
    asyncio.run(run(parse_args()))


if __name__ == "__main__":
    main()
