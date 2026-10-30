// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from 'node:fs';
import { Container } from 'pixi.js';
import { expect, it } from 'vitest';
import { canStand } from './character-movement';
import { createBakedActorOcclusion } from './map-occlusion';
import { PikoNavigationSchema, PikoOcclusionSchema } from './map-package-schema';
import { expectCombinedOcclusion, occlusionOverlaps } from './occlusion-test-utils';

const read = (name: string) => JSON.parse(readFileSync(`public/piko/world/maps/artisan-market/data/${name}.json`, 'utf8'));
const nav = PikoNavigationSchema.parse(read('navigation'));
const occluders = PikoOcclusionSchema.parse(read('occlusion')).occluders;
it('keeps all baked silhouettes free of positive-area overlaps', () => {
  expect(occlusionOverlaps(occluders)).toEqual([]);
});

it.each([
  { name: 'west', root: { x: 310, y: 765 }, behind: { x: 310, y: 725 }, crown: { x: 310, y: 690 }, front: 785, sides: [270, 345], sideY: 775 },
  { name: 'east', root: { x: 1778, y: 640 }, behind: { x: 1778, y: 600 }, crown: { x: 1778, y: 575 }, front: 665, sides: [1735, 1815], sideY: 650 },
])('blocks the $name roadside pine root, allows passage and sorts its canopy', ({ root, behind, crown, front, sides, sideY }) => {
  expect(canStand(root, nav)).toBe(false);
  expect(canStand(behind, nav)).toBe(true);
  for (const x of sides) expect(canStand({ x, y: sideY }, nav)).toBe(true);
  const actor = new Container(); actor.position.set(behind.x, behind.y);
  const mask = createBakedActorOcclusion(actor, occluders, { width: 2048, height: 1152 });
  try {
    expect(mask.mask.containsPoint(crown)).toBe(false);
    actor.y = front; mask.update();
    expect(mask.mask.containsPoint(crown)).toBe(true);
  } finally { mask.destroy(); actor.destroy(); }
});

it('blocks the east bench and separate furniture while preserving the visible gaps', () => {
  for (const p of [{ x: 1330, y: 720 }, { x: 1038, y: 540 }, { x: 1140, y: 500 }]) expect(canStand(p, nav)).toBe(false);
  for (const p of [{ x: 1330, y: 680 }, { x: 1000, y: 546 }, { x: 1910, y: 460 }, { x: 150, y: 460 }]) expect(canStand(p, nav)).toBe(true);
  const actor = new Container(); actor.y = 500;
  const mask = createBakedActorOcclusion(actor, occluders, { width: 2048, height: 1152 });
  try {
    expect(mask.mask.containsPoint({ x: 950, y: 510 })).toBe(true);
    expect(mask.mask.containsPoint({ x: 918, y: 515 })).toBe(false);
    actor.y = 720; mask.update();
    expect(mask.mask.containsPoint({ x: 1330, y: 725 })).toBe(true);
    expect(mask.mask.containsPoint({ x: 1285, y: 725 })).toBe(false);
  } finally { mask.destroy(); actor.destroy(); }
});

it.each([150, 300, 400, 500, 630, 720, 755, 800, 950, 1100])('matches the combined silhouettes across the map at foot depth %s', depth => {
  expectCombinedOcclusion(occluders, depth);
});
