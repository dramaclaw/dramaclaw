#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Rebuild or check head anchors for the runtime player atlases."""

import argparse
import json
from pathlib import Path

from PIL import Image
from build_piko_player_three_frame_motion import OUTPUTS as ATLASES

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend/src/features/piko-world/runtime/player-head-anchors.json"


def build() -> dict[str, list[list[float | int]]]:
    result = {}
    for gender, filename in ATLASES.items():
        with Image.open(ROOT / "frontend/public/piko/world/characters" / filename) as image:
            if image.size != (1536, 1024):
                raise ValueError(f"Unexpected atlas size: {filename}: {image.size}")
            frames = []
            for index in range(24):
                x, y = index % 6 * 256, index // 6 * 256
                alpha = image.crop((x, y, x + 256, y + 256)).getchannel("A")
                alpha = alpha.point(lambda value: 255 if value > 64 else 0)
                bounds = alpha.getbbox()
                if bounds is None:
                    raise ValueError(f"Empty frame: {filename}:{index}")
                head = alpha.crop((0, bounds[1], 256, bounds[1] + 48)).getbbox()
                frames.append([round((head[0] + head[2]) / 8 - 32, 1), bounds[1] / 4 - 57])
            result[gender] = frames
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if committed anchors differ from the atlases")
    args = parser.parse_args()
    data = build()
    if args.check:
        if json.loads(OUTPUT.read_text()) != data:
            raise SystemExit("Stale player head anchors; rebuild with this script")
        print("Verified 48 player head anchors")
    else:
        OUTPUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        print(f"Wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
