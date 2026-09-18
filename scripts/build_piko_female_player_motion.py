#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Build the female player's directional motion atlas from approved cutouts."""

import json
from pathlib import Path
from statistics import median

from PIL import Image

from build_piko_player_motion_v2 import (
    BODY_HEIGHT,
    COLUMNS,
    DIRECTIONS,
    FOOT_Y,
    FRAME_SIZE,
    occupied_bands,
    validate,
)
from build_piko_player_walk_keys import EIGHT_PHASE_KEYS, extract, shirt_center


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "piko-world/art/source"
REVIEW = ROOT / "piko-world/art/review/player-female-motion-v3"
OUTPUT = ROOT / "frontend/public/piko/world/characters/player-female-motion-v3.png"
# Side sources repeat the same arm sweep in both rows. Use one complete sweep
# per gait cycle, with the approved v1 passing poses between opposite contacts.
SIDE_PHASES = (("v2", 0), ("v2", 1), ("v1", 2), ("v2", 2),
               ("v2", 5), ("v2", 4), ("v1", 5), ("v2", 3))


def normalize_idle(cell: Image.Image) -> Image.Image:
    """Scale both axes equally to preserve the approved figure's proportions."""
    box = cell.getchannel("A").point(lambda value: 255 if value >= 128 else 0).getbbox()
    if box is None:
        raise ValueError("Empty female idle cell")
    figure = cell.crop(box)
    ratio = BODY_HEIGHT / figure.height
    center = shirt_center(figure) * ratio
    width = round(figure.width * ratio)
    if width > FRAME_SIZE:
        raise ValueError(f"Female idle pose wider than frame: {width}")
    figure = figure.resize((width, BODY_HEIGHT), Image.Resampling.NEAREST)
    figure.putalpha(figure.getchannel("A").point(lambda value: 255 if value >= 128 else 0))
    offset_x = round(FRAME_SIZE / 2 - center)
    if offset_x < 0 or offset_x + width > FRAME_SIZE:
        raise ValueError(f"Female idle pose clipped: x={offset_x}, width={width}")
    frame = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE))
    frame.alpha_composite(figure, (offset_x, FOOT_Y + 1 - BODY_HEIGHT))
    return frame


def main() -> None:
    atlas = Image.new("RGBA", (COLUMNS * FRAME_SIZE, len(DIRECTIONS) * FRAME_SIZE))
    metrics = {}
    for row, direction in enumerate(DIRECTIONS):
        walk_version = "v2" if direction in ("west", "east") else "v1"
        idle_version = "v3" if direction in ("west", "east") else "v2" if direction == "south" else "v1"
        walk_path = SOURCE / f"player-female-{direction}-walk-keys-{walk_version}.png"
        idle_path = SOURCE / f"player-female-{direction}-idle-keys-{idle_version}.png"
        walk_sheet = Image.open(walk_path).convert("RGBA")
        idle_sheet = Image.open(idle_path).convert("RGBA")
        walk_frames = [extract(walk_sheet, index // 3, index % 3)[0]
                       for index in range(6)]
        if direction in ("west", "east"):
            original = Image.open(SOURCE / f"player-female-{direction}-walk-keys-v1.png").convert("RGBA")
            walk_cycle = [extract(original if version == "v1" else walk_sheet, index // 3, index % 3)[0]
                          for version, index in SIDE_PHASES]
        else:
            walk_cycle = [walk_frames[index] for index in EIGHT_PHASE_KEYS]
        idle_bands = occupied_bands(idle_sheet, "x", 2)
        idle_frames = [normalize_idle(idle_sheet.crop((x0, 0, x1, idle_sheet.height)))
                       for x0, x1 in idle_bands]
        frames = [idle_frames[0], idle_frames[1], idle_frames[0]]
        frames.extend(walk_cycle)
        for column, frame in enumerate(frames):
            validate(frame, direction, column)
            atlas.alpha_composite(frame, (column * FRAME_SIZE, row * FRAME_SIZE))
        def head_width(frame: Image.Image) -> int:
            box = frame.getchannel("A").crop((0, 0, FRAME_SIZE, 24)).getbbox()
            return box[2] - box[0]
        idle_heads = [head_width(frame) for frame in idle_frames]
        walk_heads = [head_width(frame) for frame in walk_cycle]
        if direction in ("west", "east") and any(abs(w - median(walk_heads)) > 2 for w in idle_heads):
            raise ValueError(f"{direction} idle/walk head proportions differ: {idle_heads}, {walk_heads}")
        metrics[direction] = {
            "idleHeadWidths": idle_heads,
            "walkHeadWidths": walk_heads,
            "idleWidths": [frame.getchannel("A").getbbox()[2] - frame.getchannel("A").getbbox()[0]
                           for frame in idle_frames],
            "walkWidths": [frame.getchannel("A").getbbox()[2] - frame.getchannel("A").getbbox()[0]
                           for frame in walk_frames],
            "sourceIdle": str(idle_path.relative_to(ROOT)),
            "sourceWalk": str(walk_path.relative_to(ROOT)),
            "phaseSources": SIDE_PHASES if direction in ("west", "east") else [("v1", i) for i in EIGHT_PHASE_KEYS],
        }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    REVIEW.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT)
    atlas.resize((atlas.width * 4, atlas.height * 4), Image.Resampling.NEAREST).save(
        REVIEW / "player-female-motion-v3-inspection.png"
    )
    (REVIEW / "player-female-motion-v3.json").write_text(json.dumps({
        "atlas": str(OUTPUT.relative_to(ROOT)),
        "rows": DIRECTIONS,
        "frameSize": FRAME_SIZE,
        "columns": COLUMNS,
        "pivot": {"x": 32, "y": FOOT_Y},
        "idleSequence": [0, 1, 0, 1, 0],
        "sampling": "nearest",
        "eightPhaseKeyOrder": EIGHT_PHASE_KEYS,
        "sourceMaster": "piko-world/art/source/player-female-directions-v1.png",
        "metrics": metrics,
    }, indent=2) + "\n")
    print("Built 44 female player frames with uniform height and foot baseline")


if __name__ == "__main__":
    main()
