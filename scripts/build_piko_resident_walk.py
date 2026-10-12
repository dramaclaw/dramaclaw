#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Build direction/step frames deterministically; preserve approved south idle."""
from pathlib import Path
import json
from PIL import Image
from piko_leg_rig import paint_walk

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "piko-world/art/review/resident-m01-directions-v1"
IDLE = ROOT / "piko-world/art/review/resident-m01-idle-v1"
DIRECTIONS = ("south", "west", "east", "north")


def normalize(image, palette):
    image = image.convert("RGBA")
    alpha = image.getchannel("A").point(lambda a: 255 if a >= 200 else 0)
    image.putalpha(alpha)
    box = alpha.getbbox()
    if not box:
        raise ValueError("Empty direction source")
    image = image.crop(box)
    image = image.resize((round(image.width * 56 / image.height), 56), Image.Resampling.NEAREST)
    frame = Image.new("RGBA", (64, 64))
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = image.getpixel((x, y))
            if a:
                color = min(palette, key=lambda c: sum((v-w)**2 for v, w in zip(c[:3], (r,g,b))))
                frame.putpixel((32-image.width//2+x, 2+y), color)
    return frame


def step(master, direction, phase):
    return paint_walk(master, direction, phase)


def main():
    south = Image.open(IDLE / "resident-m01-south-master-64.png").convert("RGBA")
    palette = sorted({p for p in south.getdata() if p[3]})
    source = Image.open(REVIEW / "directions-candidate-v1.png")
    masters = [south] + [normalize(source.crop((i*512, 0, (i+1)*512, 1024)), palette) for i in range(3)]
    atlas = Image.new("RGBA", (704, 256))
    for row, (direction, master) in enumerate(zip(DIRECTIONS, masters)):
        master.save(REVIEW / f"{direction}-64.png")
        frames = [master, master.copy(), master.copy()]
        if row == 0:
            frames = [Image.open(IDLE / f"frame-{i:02}.png").convert("RGBA") for i in range(3)]
        else:
            frames[1] = Image.new("RGBA", (64,64))
            frames[1].paste(master.crop((0,0,64,40)), (0,-1))
            frames[1].paste(master.crop((0,39,64,64)), (0,39))
        frames += [step(master, direction, phase) for phase in range(8)]
        for col, frame in enumerate(frames):
            assert frame.size == (64,64)
            assert set(frame.getchannel("A").tobytes()) <= {0,255}
            assert frame.getchannel("A").getbbox()[3] == 58
            atlas.paste(frame, (col*64,row*64))
    atlas.save(REVIEW / "resident-m01-motion-v8.png")
    atlas.save(ROOT / "frontend/public/piko/world/characters/resident-m01-idle-v1/resident-m01-motion-v8.png")
    atlas.resize((2816,1024),Image.Resampling.NEAREST).save(REVIEW / "motion-v8-inspection.png")
    metadata = {"frameSize":64,"columns":11,"rows":list(DIRECTIONS),"pivot":{"x":32,"y":57},
                "idleColumns":[0,1,2],"walkColumns":list(range(3,11)),"cycleDistanceSourcePixels":40}
    metadata["rig"] = "unified-eight-pose-gait-v8"
    (REVIEW / "motion-v8.json").write_text(json.dumps(metadata,indent=2)+"\n")
    print("Validated 44 RGBA frames; south idle preserved; contact plane 57")


if __name__ == "__main__":
    main()
