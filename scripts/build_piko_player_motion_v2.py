#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Build the male player's revised idle and walking atlas from approved cutouts."""

import json
from pathlib import Path

from PIL import Image

from build_piko_player_walk_keys import EIGHT_PHASE_KEYS, extract, shirt_center


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "piko-world/art/source"
REVIEW = ROOT / "piko-world/art/review/player-male-motion-v2"
OUTPUT = ROOT / "frontend/public/piko/world/characters/player-male-motion-v2.png"
DIRECTIONS = ("south", "west", "east", "north")
FRAME_SIZE = 64
BODY_HEIGHT = 56
FOOT_Y = 57
COLUMNS = 11


def occupied_bands(image: Image.Image, axis: str, expected: int) -> list[tuple[int, int]]:
    """Find figure bands by transparent gutters; generated rows are not evenly spaced."""
    alpha = image.getchannel("A").point(lambda value: 255 if value >= 128 else 0)
    length = image.width if axis == "x" else image.height
    occupied = [bool(alpha.crop((i, 0, i + 1, image.height) if axis == "x"
                                else (0, i, image.width, i + 1)).getbbox()) for i in range(length)]
    bands = []
    start = None
    for index, has_pixels in enumerate(occupied + [False]):
        if has_pixels and start is None:
            start = index
        elif not has_pixels and start is not None:
            bands.append((start, index))
            start = None
    if len(bands) != expected:
        raise ValueError(f"Expected {expected} {axis} bands, got {bands}")
    return bands


def normalize_idle(cell: Image.Image, horizontal_scale: float) -> Image.Image:
    box = cell.getchannel("A").point(lambda value: 255 if value >= 128 else 0).getbbox()
    if box is None:
        raise ValueError("Empty idle cell")
    figure = cell.crop(box)
    center = shirt_center(figure)
    width = round(figure.width * BODY_HEIGHT / figure.height * horizontal_scale)
    if width > FRAME_SIZE:
        raise ValueError(f"Idle pose wider than frame: {width}")
    center *= BODY_HEIGHT / figure.height * horizontal_scale
    figure = figure.resize((width, BODY_HEIGHT), Image.Resampling.NEAREST)
    figure.putalpha(figure.getchannel("A").point(lambda value: 255 if value >= 128 else 0))
    frame = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE))
    offset_x = round(FRAME_SIZE / 2 - center)
    if offset_x < 0 or offset_x + width > FRAME_SIZE:
        raise ValueError(f"Idle pose clipped horizontally: {offset_x}, {width}")
    frame.alpha_composite(figure, (offset_x, FOOT_Y + 1 - BODY_HEIGHT))
    return frame


def validate(frame: Image.Image, direction: str, column: int) -> None:
    alpha = frame.getchannel("A")
    if frame.size != (FRAME_SIZE, FRAME_SIZE) or set(alpha.getdata()) - {0, 255}:
        raise ValueError(f"Invalid {direction} frame {column}: size or alpha")
    if alpha.getbbox() is None or alpha.getbbox()[3] != FOOT_Y + 1:
        raise ValueError(f"Invalid {direction} frame {column}: foot baseline")


def main() -> None:
    idle_source = SOURCE_DIR / "player-male-idle-keys-v2.png"
    idle_sheet = Image.open(idle_source).convert("RGBA")
    x_bands = occupied_bands(idle_sheet, "x", 3)
    y_bands = occupied_bands(idle_sheet, "y", 4)
    atlas = Image.new("RGBA", (COLUMNS * FRAME_SIZE, len(DIRECTIONS) * FRAME_SIZE))
    walk_sources = {}
    idle_horizontal_scales = {}
    for row, direction in enumerate(DIRECTIONS):
        version = "v1" if direction == "north" else "v2"
        walk_source = SOURCE_DIR / f"player-male-{direction}-walk-keys-{version}.png"
        walk_sheet = Image.open(walk_source).convert("RGBA")
        walk_frames = [extract(walk_sheet, index // 3, index % 3)[0] for index in range(6)]
        idle_cells = [idle_sheet.crop((x0, y_bands[row][0], x1, y_bands[row][1])) for x0, x1 in x_bands]
        neutral = idle_cells[0].getchannel("A").point(lambda value: 255 if value >= 128 else 0).getbbox()
        if neutral is None:
            raise ValueError(f"Empty {direction} neutral idle pose")
        neutral_width = round((neutral[2] - neutral[0]) * BODY_HEIGHT / (neutral[3] - neutral[1]))
        # The generated idle figures are wider than the authored walk figures despite equal height.
        # Apply one direction-wide width ratio so all three idle poses keep their relative motion.
        horizontal_scale = 21 / neutral_width
        neutral_frame, action_frame = [normalize_idle(cell, horizontal_scale) for cell in idle_cells[:2]]
        # Keep the 11-column atlas contract; column 2 repeats neutral and is not played.
        idle_frames = [neutral_frame, action_frame, neutral_frame]
        idle_horizontal_scales[direction] = round(horizontal_scale, 4)
        frames = idle_frames + [walk_frames[index] for index in EIGHT_PHASE_KEYS]
        for column, frame in enumerate(frames):
            validate(frame, direction, column)
            atlas.alpha_composite(frame, (column * FRAME_SIZE, row * FRAME_SIZE))
        walk_sources[direction] = str(walk_source.relative_to(ROOT))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    REVIEW.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT)
    atlas.resize((atlas.width * 4, atlas.height * 4), Image.Resampling.NEAREST).save(REVIEW / "player-male-motion-v2-inspection.png")
    (REVIEW / "player-male-motion-v2.json").write_text(json.dumps({
        "sourceIdle": str(idle_source.relative_to(ROOT)),
        "sourceWalkKeys": walk_sources,
        "atlas": str(OUTPUT.relative_to(ROOT)),
        "frameSize": FRAME_SIZE,
        "columns": COLUMNS,
        "rows": DIRECTIONS,
        "pivot": {"x": 32, "y": FOOT_Y},
        "idleColumns": [0, 1, 2],
        "idleSequence": [0, 1, 0, 1, 0],
        "walkColumns": list(range(3, 11)),
        "eightPhaseKeyOrder": EIGHT_PHASE_KEYS,
        "idleHorizontalScales": idle_horizontal_scales,
        "cycleDistanceSourcePixels": 48,
    }, indent=2) + "\n")
    print("Built 44 male player frames with revised idle and walking poses")


if __name__ == "__main__":
    main()
