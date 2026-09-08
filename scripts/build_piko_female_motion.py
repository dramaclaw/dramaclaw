#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Compile F01 direction art into the shared 64px, four-direction gait contract."""
from collections import deque
from pathlib import Path
import json
from PIL import Image, ImageDraw
from piko_leg_rig import paint_walk

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / 'piko-world/art/review/resident-f01-directions-v1'
RUNTIME = ROOT / 'frontend/public/piko/world/characters/resident-f01-idle-v1'
DIRECTIONS = ('south', 'west', 'east', 'north')


def direction_source(image):
    image = image.convert('RGBA')
    pixels = image.load()
    queue = deque([(x, y) for x in range(image.width) for y in (0, image.height-1)]
                  + [(x, y) for y in range(image.height) for x in (0, image.width-1)])
    seen = set()
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < image.width and 0 <= y < image.height):
            continue
        seen.add((x, y))
        r, g, b, a = pixels[x, y]
        if a and (min(r, g, b) < 215 or max(r, g, b)-min(r, g, b) > 20):
            continue
        pixels[x, y] = (0, 0, 0, 0)
        queue.extend(((x-1, y), (x+1, y), (x, y-1), (x, y+1)))
    box = image.getchannel('A').getbbox()
    if not box:
        raise ValueError('Empty direction')
    image = image.crop(box)
    return image.resize((round(image.width*56/image.height), 56), Image.Resampling.NEAREST)


def masters():
    image = Image.open(REVIEW / 'directions-candidate-v2.png')
    # The source has uneven empty margins. Boundaries fall in the clear gaps.
    bounds = (0, 433, 765, 1097, image.width)
    crops = [direction_source(image.crop((bounds[i], 0, bounds[i+1], image.height))) for i in range(4)]
    palette_source = Image.new('RGB', (160, 56), (40, 30, 20))
    for i, crop in enumerate(crops):
        palette_source.paste(crop, (i*40, 0), crop.getchannel('A'))
    palette = palette_source.quantize(colors=24, dither=Image.Dither.NONE)
    result = []
    for crop in crops:
        reduced = crop.convert('RGB').quantize(palette=palette, dither=Image.Dither.NONE).convert('RGBA')
        reduced.putalpha(crop.getchannel('A').point(lambda a: 255 if a >= 200 else 0))
        master = Image.new('RGBA', (64, 64))
        master.paste(reduced, (32-reduced.width//2, 2))
        result.append(master)
    return result


def main():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    atlas = Image.new('RGBA', (704, 256))
    for row, (direction, master) in enumerate(zip(DIRECTIONS, masters())):
        master.save(REVIEW / f'{direction}-64.png')
        raised = Image.new('RGBA', (64, 64))
        raised.paste(master.crop((0, 0, 64, 39)), (0, -1))
        raised.paste(master.crop((0, 38, 64, 64)), (0, 38))
        frames = [master, raised, master.copy()]
        frames += [paint_walk(master, direction, phase, character='f01') for phase in range(8)]
        for col, frame in enumerate(frames):
            assert frame.getchannel('A').getbbox()[3] == 58
            assert set(frame.getchannel('A').tobytes()) <= {0, 255}
            atlas.paste(frame, (col*64, row*64))
    atlas.save(RUNTIME / 'resident-f01-motion-v2.png')
    atlas.save(REVIEW / 'resident-f01-motion-v1.png')
    atlas.resize((2816, 1024), Image.Resampling.NEAREST).save(REVIEW / 'motion-inspection.png')
    (REVIEW / 'motion.json').write_text(json.dumps({'frameSize':64,'columns':11,'rows':DIRECTIONS,
        'pivot':{'x':32,'y':57},'idleColumns':[0,1,2],'walkColumns':list(range(3,11)),
        'rig':'shared-eight-pose-gait-f01','cycleDistanceSourcePixels':40},indent=2)+'\n')
    print('F01: 44 frames compiled; four directions, breathing idle and eight-phase walking')

if __name__ == '__main__':
    main()
