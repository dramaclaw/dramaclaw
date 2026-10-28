#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Pack three idle poses and three walking poses per player direction."""
import argparse
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "frontend/public/piko/world/characters"
SOURCE_ROOT = ROOT / "piko-world/art/source"
SOURCES = SOURCE_ROOT / "walk-three-source-v1"
REGENERATED = SOURCE_ROOT / "motion-source-v2"
DIRECTIONS = ("south", "west", "east", "north")
# Preserve the approved horizontal alignment without depending on obsolete atlases.
HEAD_ANCHOR_X = {"male": (128.5, 133.0, 127.5, 128.5), "female": (128.0, 134.0, 120.0, 128.0)}
OUTPUTS = {"male": "player-male-motion-v5.png", "female": "player-female-motion-v6.png"}
SIZE = 256
HEIGHT = 224
FOOT_BOTTOM = 232
# Atlas-space crop boundaries at the neck/collar, reviewed for all eight facings.
HEAD_BOTTOMS = {"male": (90, 88, 90, 94), "female": (90, 88, 88, 90)}


def opaque(image: Image.Image) -> Image.Image:
    return image.getchannel("A").point(lambda value: 255 if value >= 32 else 0)


def head_center(image: Image.Image) -> float:
    alpha = opaque(image)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("Empty figure")
    head = alpha.crop((0, bounds[1], image.width, bounds[1] + round((bounds[3] - bounds[1]) * .32))).getbbox()
    return (head[0] + head[2]) / 2


def extract_poses(source: Image.Image) -> list[Image.Image]:
    if source.mode != "RGBA" or source.width < 600 or source.height < 600:
        raise ValueError("Expected high-resolution RGBA source")
    alpha = opaque(source)
    # Generated sheets can have unequal row margins. Find the empty gutter.
    candidates = range(round(source.height * .45), round(source.height * .57))
    gaps = [y for y in candidates if not alpha.crop((0, y, source.width, y + 1)).getbbox()]
    if not gaps:
        raise ValueError("No transparent row gutter; inspect source before packing")
    split_y = min(gaps, key=lambda y: abs(y - source.height / 2))
    split_x = source.width // 2
    if alpha.crop((split_x, split_y, source.width, source.height)).getbbox():
        raise ValueError("Fourth cell must be empty")
    cells = [(0, 0, split_x, split_y), (split_x, 0, source.width, split_y), (0, split_y, split_x, source.height)]
    result = []
    for cell in cells:
        figure = source.crop(cell)
        bounds = opaque(figure).getbbox()
        if bounds is None or bounds[3] - bounds[1] < HEIGHT:
            raise ValueError("Missing or low-resolution pose")
        result.append(figure.crop(bounds))
    return result


def normalize(figure: Image.Image, anchor_x: float, ratio: float | None = None) -> Image.Image:
    ratio = HEIGHT / figure.height if ratio is None else ratio
    center = head_center(figure) * ratio
    resized = figure.resize((round(figure.width * ratio), round(figure.height * ratio)), Image.Resampling.LANCZOS)
    x = round(anchor_x - center)
    if x < 0 or x + resized.width > SIZE:
        raise ValueError("Pose would be clipped")
    frame = Image.new("RGBA", (SIZE, SIZE))
    frame.alpha_composite(resized, (x, FOOT_BOTTOM - resized.height))
    return frame


def extract_row(source: Image.Image, count: int) -> list[Image.Image]:
    """Split transparent horizontal sheets, without rescaling individual poses."""
    if source.mode != "RGBA" or min(source.size) < 256:
        raise ValueError("Expected high-resolution transparent RGBA sheet")
    result = []
    alpha = opaque(source)
    spans = []
    start = None
    for x in range(source.width + 1):
        occupied = x < source.width and alpha.crop((x, 0, x + 1, source.height)).getbbox() is not None
        if occupied and start is None:
            start = x
        elif not occupied and start is not None:
            if x - start > 32:
                spans.append((start, x))
            start = None
    if len(spans) != count:
        raise ValueError(f"Expected {count} separated figures, found {len(spans)}")
    for left, right in spans:
        if left == 0 or right == source.width:
            raise ValueError("Opaque background or clipped figure")
        cell = source.crop((left, 0, right, source.height))
        bounds = opaque(cell).getbbox()
        if bounds is None:
            raise ValueError("Missing pose")
        result.append(cell.crop(bounds))
    return result


def head_width(figure: Image.Image) -> int:
    bounds = opaque(figure).crop((0, 0, figure.width, round(figure.height * .30))).getbbox()
    if bounds is None:
        raise ValueError("Missing head")
    return bounds[2] - bounds[0]


def regenerated_frames(direction: str, anchor_x: float) -> list[Image.Image]:
    poses = extract_row(Image.open(REGENERATED / f"male-{direction}.png"), 3)
    widths = [head_width(pose) for pose in poses]
    if max(widths) / min(widths) > 1.04:
        raise ValueError(f"{direction}: head width varies by more than 4%: {widths}")
    # One camera scale per sheet: never compensate a stride by enlarging its head.
    ratio = HEIGHT / max(pose.height for pose in poses)
    frames = [normalize(pose, anchor_x, ratio) for pose in poses]
    print(f"male {direction}: head widths {widths}, shared scale {ratio:.5f}")
    return frames


def idle_poses(gender: str) -> list[list[Image.Image]]:
    source = Image.open(REGENERATED / f"{gender}-idle-body.png")
    alpha = opaque(source)
    spans = []
    start = None
    for y in range(source.height + 1):
        occupied = y < source.height and alpha.crop((0, y, source.width, y + 1)).getbbox() is not None
        if occupied and start is None:
            start = y
        elif not occupied and start is not None:
            if y - start > HEIGHT:
                spans.append((start, y))
            start = None
    if len(spans) != 3:
        raise ValueError(f"{gender}: expected three separated idle rows, found {len(spans)}")
    rows = [extract_row(source.crop((0, max(0, top - 1), source.width, min(source.height, bottom + 1))), 4)
            for top, bottom in spans]
    return [[row[direction] for row in rows] for direction in range(4)]


def pack_idle(poses: list[Image.Image], neutral: Image.Image, label: str) -> list[Image.Image]:
    widths = [head_width(pose) for pose in poses]
    if max(widths) / min(widths) > 1.04:
        raise ValueError(f"{label}: idle head widths differ by more than 4%: {widths}")
    bounds = opaque(neutral).getbbox()
    ratio = (bounds[3] - bounds[1]) / max(pose.height for pose in poses)
    frames = [normalize(pose, head_center(neutral), ratio) for pose in poses]
    neutral_width = head_width(neutral.crop(bounds))
    for frame in frames:
        frame_bounds = opaque(frame).getbbox()
        width = head_width(frame.crop(frame_bounds))
        if abs(width - neutral_width) > max(2, neutral_width * .04):
            raise ValueError(f"{label}: idle/walk head size mismatch: {width} vs {neutral_width}")
        if abs(frame_bounds[1] - bounds[1]) > 3:
            raise ValueError(f"{label}: idle head height drifts from standing baseline")
    if frames[0].tobytes() == frames[1].tobytes():
        raise ValueError(f"{label}: body idle must differ from neutral")
    print(f"{label} idle: head widths {widths}; shared scale {ratio:.5f}")
    return frames


def stabilize_walking_heads(frames: list[Image.Image], gender: str, row: int) -> list[Image.Image]:
    """Pack one shared neutral head above each original walking body.

    Exact crop reuse keeps facial detail and the accessory anchor stationary.
    No individual scaling, interpolation, or changes below the collar.
    """
    bottom = HEAD_BOTTOMS[gender][row]
    head = frames[1].crop((0, 0, SIZE, bottom))
    result = []
    for frame in frames:
        packed = frame.copy()
        # Replace the region, including transparency, so the old outline cannot remain.
        packed.paste(head, (0, 0))
        result.append(packed)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check compiled pixels without replacing assets")
    args = parser.parse_args()
    # Build both in memory first; invalid/missing sources never replace live assets.
    atlases = {}
    for gender in OUTPUTS:
        atlas = Image.new("RGBA", (6 * SIZE, 4 * SIZE))
        new_idle = idle_poses(gender)
        for row, direction in enumerate(DIRECTIONS):
            anchor_x = HEAD_ANCHOR_X[gender][row]
            if gender == "male":
                walk = regenerated_frames(direction, anchor_x)
            else:
                poses = extract_poses(Image.open(SOURCES / f"{gender}-{direction}.png"))
                walk = [normalize(pose, anchor_x) for pose in poses]
            frames = pack_idle(new_idle[row], walk[1], f"{gender} {direction}") + stabilize_walking_heads(walk, gender, row)
            for col, frame in enumerate(frames):
                atlas.alpha_composite(frame, (col * SIZE, row * SIZE))
        atlases[gender] = atlas
    manifest = {
        "outputs": OUTPUTS, "frameSize": SIZE, "logicalFrameSize": 64,
        "columns": 6, "directions": DIRECTIONS, "idleColumns": [0, 1, 2],
        "walkColumns": [3, 4, 5, 4], "pivot": [128, 228],
        "maleSources": "../motion-source-v2/male-{direction}.png",
        "maleScaling": "one scale per direction; maximum body height 224",
        "idleSources": "../motion-source-v2/{male,female}-idle-body.png",
        "sharedWalkingHeadColumn": 4, "headBottoms": HEAD_BOTTOMS,
    }
    if args.check:
        for gender, atlas in atlases.items():
            with Image.open(ART / OUTPUTS[gender]) as saved:
                if saved.mode != atlas.mode or saved.size != atlas.size or saved.tobytes() != atlas.tobytes():
                    raise SystemExit(f"Stale player atlas: {OUTPUTS[gender]}")
        if json.loads((SOURCES / "manifest.json").read_text()) != json.loads(json.dumps(manifest)):
            raise SystemExit("Stale player motion manifest")
        print("Verified both player atlases and shared walking heads")
        return
    for gender, atlas in atlases.items():
        atlas.save(ART / OUTPUTS[gender])
    (SOURCES / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Built two player atlases: 3 idle + 3 walk poses per direction")


if __name__ == "__main__":
    main()
