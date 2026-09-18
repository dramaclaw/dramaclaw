#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Normalize the approved player turnaround to the shared 64 px character grid."""

from pathlib import Path
import json

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "piko-world/art/source/player-male-directions-v1.png"
REVIEW = ROOT / "piko-world/art/review/player-male-motion-v1"
QUADRANTS = {
    "south": (0, 0, 1024, 1024),
    "west": (1024, 0, 2048, 1024),
    "east": (0, 1024, 1024, 2048),
    "north": (1024, 1024, 2048, 2048),
}
FRAME_SIZE = 64
BODY_HEIGHT = 56
FOOT_Y = 57


def normalize(source: Image.Image, bounds: tuple[int, int, int, int]) -> tuple[Image.Image, dict]:
    quadrant = source.crop(bounds).convert("RGBA")
    alpha = quadrant.getchannel("A")
    box = alpha.point(lambda value: 255 if value >= 32 else 0).getbbox()
    if box is None:
        raise ValueError(f"Empty player quadrant: {bounds}")
    figure = quadrant.crop(box)
    width = round(figure.width * BODY_HEIGHT / figure.height)
    figure = figure.resize((width, BODY_HEIGHT), Image.Resampling.NEAREST)
    figure.putalpha(figure.getchannel("A").point(lambda value: 255 if value >= 128 else 0))
    frame = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE))
    frame.alpha_composite(figure, ((FRAME_SIZE - width) // 2, FOOT_Y + 1 - BODY_HEIGHT))
    if frame.getchannel("A").getbbox()[3] != FOOT_Y + 1:
        raise ValueError("Player foot baseline drifted during normalization")
    return frame, {"sourceBoundsInQuadrant": box, "normalizedWidth": width}


def main() -> None:
    source = Image.open(SOURCE)
    if source.size != (2048, 2048):
        raise ValueError(f"Expected 2048x2048 turnaround, got {source.size}")
    REVIEW.mkdir(parents=True, exist_ok=True)
    strip = Image.new("RGBA", (4 * FRAME_SIZE, FRAME_SIZE))
    details = {}
    for index, (direction, bounds) in enumerate(QUADRANTS.items()):
        frame, detail = normalize(source, bounds)
        frame.save(REVIEW / f"{direction}-64.png")
        strip.alpha_composite(frame, (index * FRAME_SIZE, 0))
        details[direction] = detail
    strip.save(REVIEW / "player-male-masters.png")
    strip.resize((2048, 512), Image.Resampling.NEAREST).save(REVIEW / "player-male-masters-inspection.png")
    (REVIEW / "masters.json").write_text(json.dumps({
        "source": str(SOURCE.relative_to(ROOT)),
        "frameSize": FRAME_SIZE,
        "pivot": {"x": 32, "y": FOOT_Y},
        "directions": list(QUADRANTS),
        "details": details,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
