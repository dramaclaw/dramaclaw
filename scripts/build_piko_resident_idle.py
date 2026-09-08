#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Deterministic resident pixel production; no model-generated animation frames."""
from collections import deque
from pathlib import Path
import json
import hashlib
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "piko-world/art/review/resident-m01-idle-v1"
SOURCE = OUTPUT / "master-candidate-v1.png"


def make_master():
    image = Image.open(SOURCE).convert("RGBA")
    pixels = image.load()
    # Remove only edge-connected near-white checkerboard, preserving eye glints.
    queue = deque([(x, y) for x in range(image.width) for y in (0, image.height - 1)]
                  + [(x, y) for y in range(image.height) for x in (0, image.width - 1)])
    seen = set()
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < image.width and 0 <= y < image.height):
            continue
        seen.add((x, y))
        r, g, b, a = pixels[x, y]
        if min(r, g, b) < 215 or max(r, g, b) - min(r, g, b) > 20:
            continue
        pixels[x, y] = (0, 0, 0, 0)
        queue.extend(((x-1, y), (x+1, y), (x, y-1), (x, y+1)))
    crop = image.crop(image.getchannel("A").getbbox())
    reduced = crop.resize((round(crop.width * 56 / crop.height), 56), Image.Resampling.NEAREST)
    alpha = reduced.getchannel("A")
    reduced = reduced.convert("RGB").quantize(colors=24, dither=Image.Dither.NONE).convert("RGBA")
    reduced.putalpha(alpha)
    master = Image.new("RGBA", (64, 64))
    master.paste(reduced, (32 - reduced.width // 2, 2))
    draw = ImageDraw.Draw(master)
    for x in (27, 34):
        draw.rectangle((x, 20, x + 1, 22), fill=(17, 21, 46, 255))
        draw.point((x, 20), fill=(255, 253, 245, 255))
    return master


def main():
    master = make_master()
    master.save(OUTPUT / "resident-m01-south-master-64.png")
    master.resize((512, 512), Image.Resampling.NEAREST).save(OUTPUT / "master-preview-8x.png")
    raised = Image.new("RGBA", (64, 64))
    raised.paste(master.crop((0, 0, 64, 40)), (0, -1))
    raised.paste(master.crop((0, 39, 64, 64)), (0, 39))
    blink = master.copy()
    draw = ImageDraw.Draw(blink)
    for x in (27, 34):
        draw.rectangle((x, 20, x + 1, 22), fill=master.getpixel((x + 2, 23)))
        draw.line((x, 22, x + 1, 22), fill=(17, 21, 46, 255))
    frames = [master, raised, blink]
    timeline = [(0, 1100), (1, 450), (0, 900), (2, 120), (0, 1100), (1, 450), (0, 680)]
    sheet = Image.new("RGBA", (192, 64))
    for index, frame in enumerate(frames):
        assert frame.getchannel("A").getbbox()[3] == 58
        assert set(frame.getchannel("A").tobytes()) <= {0, 255}
        assert frame.crop((0, 40, 64, 64)).tobytes() == master.crop((0, 40, 64, 64)).tobytes()
        frame.save(OUTPUT / f"frame-{index:02}.png")
        sheet.paste(frame, (64 * index, 0))
    assert len({f.tobytes() for f in frames}) == 3
    sheet.save(OUTPUT / "resident-m01-idle-sheet.png")
    metadata = {"frameSize": 64, "frameCount": 3, "pivot": {"x": 32, "y": 57},
                "direction": "SOUTH", "shadow": {"width": 24, "height": 8},
                "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                "timeline": [{"frame": f, "durationMs": ms} for f, ms in timeline]}
    (OUTPUT / "resident-m01-idle.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Validated: 3 distinct 64x64 RGBA frames, fixed feet, 4800 ms loop")


if __name__ == "__main__":
    main()
