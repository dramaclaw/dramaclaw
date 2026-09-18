#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Build the approved male player's four-direction idle/walk atlas."""

from pathlib import Path
import json

from PIL import Image

from build_piko_player_masters import QUADRANTS, SOURCE as TURNAROUND_SOURCE, normalize
from build_piko_player_walk_keys import EIGHT_PHASE_KEYS, extract


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "piko-world/art/source"
REVIEW = ROOT / "piko-world/art/review/player-male-motion-v1"
OUTPUT = ROOT / "piko-world/art/archive/2026-09-17/player-male-motion-v1.png"
DIRECTIONS = ("south", "west", "east", "north")
FRAME_SIZE = 64
COLUMNS = 11


def main() -> None:
    turnaround = Image.open(TURNAROUND_SOURCE).convert("RGBA")
    if turnaround.size != (2048, 2048):
        raise ValueError(f"Unexpected player turnaround size: {turnaround.size}")
    atlas = Image.new("RGBA", (COLUMNS * FRAME_SIZE, len(DIRECTIONS) * FRAME_SIZE))
    sources = {}
    for row, direction in enumerate(DIRECTIONS):
        master, _ = normalize(turnaround, QUADRANTS[direction])
        source = SOURCE_DIR / f"player-male-{direction}-walk-keys-v1.png"
        walk_sheet = Image.open(source).convert("RGBA")
        keys = [extract(walk_sheet, index // 3, index % 3)[0] for index in range(6)]
        frames = [master] * 3 + [keys[index] for index in EIGHT_PHASE_KEYS]
        for column, frame in enumerate(frames):
            alpha = frame.getchannel("A")
            if frame.size != (FRAME_SIZE, FRAME_SIZE) or set(alpha.getdata()) - {0, 255}:
                raise ValueError(f"Invalid {direction} frame {column}: size or alpha")
            if alpha.getbbox() is None or alpha.getbbox()[3] != 58:
                raise ValueError(f"Invalid {direction} frame {column}: foot baseline")
            atlas.alpha_composite(frame, (column * FRAME_SIZE, row * FRAME_SIZE))
        sources[direction] = str(source.relative_to(ROOT))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    REVIEW.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT)
    atlas.resize((atlas.width * 4, atlas.height * 4), Image.Resampling.NEAREST).save(REVIEW / "player-male-motion-v1-inspection.png")
    (REVIEW / "player-male-motion-v1.json").write_text(json.dumps({
        "sourceTurnaround": str(TURNAROUND_SOURCE.relative_to(ROOT)),
        "sourceWalkKeys": sources,
        "atlas": str(OUTPUT.relative_to(ROOT)),
        "frameSize": FRAME_SIZE,
        "columns": COLUMNS,
        "rows": DIRECTIONS,
        "pivot": {"x": 32, "y": 57},
        "idleColumns": [0, 1, 2],
        "walkColumns": list(range(3, 11)),
        "eightPhaseKeyOrder": EIGHT_PHASE_KEYS,
        "cycleDistanceSourcePixels": 40,
        "wardrobeContract": "Future body/outfit/accessory atlases use the same frame grid, pivot and phase order.",
    }, indent=2) + "\n")
    print("Built 44 male player frames with four directions and a shared foot pivot")


if __name__ == "__main__":
    main()
