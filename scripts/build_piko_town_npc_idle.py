#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Pack HD town NPC idle poses directly from the transparent generated sources."""
import argparse
import json
from pathlib import Path

from PIL import Image

from build_piko_player_three_frame_motion import extract_row, head_width, normalize

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "frontend/public/piko/world/characters/town-npcs-hd-v1"
SOURCES = ROOT / "piko-world/art/source/town-npcs-hd-v1"
RESIDENTS = ("m01", "f01", "m02", "f02")


def build(resident: str) -> Image.Image:
    with Image.open(SOURCES / f"{resident}.png") as source:
        poses = extract_row(source, 3)
    widths = [head_width(pose) for pose in poses]
    if max(widths) / min(widths) > 1.04:
        raise ValueError(f"{resident}: inconsistent head widths: {widths}")
    ratio = 224 / max(pose.height for pose in poses)
    frames = [normalize(pose, 128, ratio) for pose in poses]
    atlas = Image.new("RGBA", (768, 256))
    for column, frame in enumerate(frames):
        atlas.paste(frame, (column * 256, 0))
    return atlas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    atlases = {resident: build(resident) for resident in RESIDENTS}
    for resident, atlas in atlases.items():
        path = ART / f"{resident}-idle.png"
        if args.check:
            with Image.open(path) as saved:
                if saved.mode != atlas.mode or saved.size != atlas.size or saved.tobytes() != atlas.tobytes():
                    raise SystemExit(f"Stale NPC atlas: {path}")
        else:
            atlas.save(path)
        print(f"{resident}: {atlas.size}, three HD idle poses")
    manifest = {
        "residents": list(RESIDENTS), "frameSize": 256, "logicalFrameSize": 64,
        "columns": 3, "bodyHeight": 224, "footBottom": 232, "pivot": [128, 228],
    }
    manifest_path = ART / "manifest.json"
    if args.check:
        if json.loads(manifest_path.read_text()) != manifest:
            raise SystemExit("Stale NPC manifest")
    else:
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
