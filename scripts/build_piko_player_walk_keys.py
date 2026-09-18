#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Extract approved six-pose player walk sources without inventing in-between art."""

import argparse
from pathlib import Path
import json

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path("piko-world/art/source/player-male-west-walk-keys-v2.png")
DEFAULT_REVIEW = Path("piko-world/art/review/player-walk-keys")
FRAME_SIZE = 64
BODY_HEIGHT = 56
FOOT_Y = 57
EIGHT_PHASE_KEYS = (0, 1, 2, 2, 3, 4, 5, 5)


def shirt_center(figure: Image.Image) -> float:
    """Anchor the torso, so stride width cannot move the actor across cells."""
    xs = []
    for y in range(round(figure.height * 0.36), round(figure.height * 0.65)):
        for x in range(figure.width):
            r, g, b, a = figure.getpixel((x, y))
            if a >= 200 and r >= 220 and g >= 215 and b >= 205:
                xs.append(x)
    if not xs:
        raise ValueError("No shirt pixels found for torso alignment")
    return (min(xs) + max(xs)) / 2


def extract(source: Image.Image, row: int, column: int,
            resampling: Image.Resampling = Image.Resampling.NEAREST) -> tuple[Image.Image, dict]:
    x0 = round(column * source.width / 3)
    x1 = round((column + 1) * source.width / 3)
    y0, y1 = row * source.height // 2, (row + 1) * source.height // 2
    cell = source.crop((x0, y0, x1, y1)).convert("RGBA")
    box = cell.getchannel("A").point(lambda value: 255 if value >= 32 else 0).getbbox()
    if box is None:
        raise ValueError(f"Empty walk cell ({row}, {column})")
    figure = cell.crop(box)
    center = shirt_center(figure)
    width = round(figure.width * BODY_HEIGHT / figure.height)
    center = center * BODY_HEIGHT / figure.height
    figure = figure.resize((width, BODY_HEIGHT), resampling)
    figure.putalpha(figure.getchannel("A").point(lambda value: 255 if value >= 128 else 0))
    frame = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE))
    offset_x = round(FRAME_SIZE / 2 - center)
    frame.alpha_composite(figure, (offset_x, FOOT_Y + 1 - BODY_HEIGHT))
    if frame.getchannel("A").getbbox()[3] != FOOT_Y + 1:
        raise ValueError(f"Foot baseline drift in ({row}, {column})")
    return frame, {"sourceBoundsInCell": box, "torsoX": round(center, 2), "frameOffsetX": offset_x}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--review", type=Path, default=DEFAULT_REVIEW)
    parser.add_argument("--direction", choices=("south", "west", "east", "north"), default="west")
    args = parser.parse_args()
    source_path = ROOT / args.source
    review = ROOT / args.review
    source = Image.open(source_path)
    if source.width < 600 or source.height < 400:
        raise ValueError(f"Walk source too small for six cells: {source.size}")
    review.mkdir(parents=True, exist_ok=True)
    strip = Image.new("RGBA", (6 * FRAME_SIZE, FRAME_SIZE))
    details = []
    frames = []
    for phase in range(6):
        frame, detail = extract(source, phase // 3, phase % 3)
        frame.save(review / f"{args.direction}-walk-key-{phase:02}.png")
        strip.alpha_composite(frame, (phase * FRAME_SIZE, 0))
        frames.append(frame)
        details.append(detail)
    strip.save(review / f"{args.direction}-walk-keys.png")
    strip.resize((6 * FRAME_SIZE * 8, FRAME_SIZE * 8), Image.Resampling.NEAREST).save(review / f"{args.direction}-walk-keys-inspection.png")
    cycle = Image.new("RGBA", (8 * FRAME_SIZE, FRAME_SIZE))
    for phase, key in enumerate(EIGHT_PHASE_KEYS):
        cycle.alpha_composite(frames[key], (phase * FRAME_SIZE, 0))
    cycle.save(review / f"{args.direction}-walk-cycle.png")
    cycle.resize((8 * FRAME_SIZE * 8, FRAME_SIZE * 8), Image.Resampling.NEAREST).save(review / f"{args.direction}-walk-cycle-inspection.png")
    (review / f"{args.direction}-walk-keys.json").write_text(json.dumps({
        "source": str(args.source),
        "direction": args.direction,
        "frameSize": FRAME_SIZE,
        "pivot": {"x": 32, "y": FOOT_Y},
        "phaseCount": 6,
        "eightPhaseKeyOrder": EIGHT_PHASE_KEYS,
        "details": details,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
