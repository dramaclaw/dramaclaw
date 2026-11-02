// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from 'node:fs';
import { Container } from 'pixi.js';
import { expect, it } from 'vitest';
import { PikoNavigationSchema, PikoOcclusionSchema } from './map-package-schema';
import { canStand } from './character-movement';
import { pointInPolygon } from './navigation-geometry';
import { createBakedActorOcclusion } from './map-occlusion';

const read = (name: string) => JSON.parse(readFileSync(`public/piko/world/maps/artisan-market/data/${name}.json`, 'utf8'));
const nav = PikoNavigationSchema.parse(read('navigation'));
const occluders = PikoOcclusionSchema.parse(read('occlusion')).occluders;
const west = occluders.filter(o => o.id.startsWith('market-west-'));

it('blocks the full bench, tree root and rocks while allowing passage behind them', () => {
  for (const p of [{ x: 580, y: 750 }, { x: 480, y: 735 }, { x: 390, y: 740 }, { x: 700, y: 625 }])
    expect(canStand(p, nav), JSON.stringify(p)).toBe(false);
  for (const p of [{ x: 580, y: 705 }, { x: 705, y: 590 }, { x: 630, y: 745 }, { x: 440, y: 700 }])
    expect(canStand(p, nav), JSON.stringify(p)).toBe(true);
});

it('keeps the gap under the bench visible and restores actors in front of the bench', () => {
  const actor = new Container(); actor.position.set(560, 740);
  const mask = createBakedActorOcclusion(actor, occluders, { width: 2048, height: 1152 });
  try {
    expect(mask.mask.containsPoint({ x: 560, y: 737 })).toBe(false);
    expect(mask.mask.containsPoint({ x: 560, y: 760 })).toBe(true);
    expect(mask.mask.containsPoint({ x: 508, y: 761 })).toBe(false);
    actor.y = 780; mask.update();
    expect(mask.mask.containsPoint({ x: 560, y: 737 })).toBe(true);
  } finally { mask.destroy(); actor.destroy(); }
});

it.each([630, 720, 755, 800])('keeps the combined west-side mask consistent at foot depth %s', depth => {
  const actor = new Container(); actor.y = depth;
  const mask = createBakedActorOcclusion(actor, occluders, { width: 2048, height: 1152 });
  try {
    for (let y = 420.31; y < 780; y += 7) for (let x = 310.17; x < 745; x += 7) {
      const covers = occluders.filter(o => depth < o.depthY && o.outline && pointInPolygon(
        { x: x - o.position.x, y: y - o.position.y }, o.outline));
      if (covers.some(o => west.includes(o))) expect(covers).toHaveLength(1);
      expect(mask.mask.containsPoint({ x, y }), `${x},${y}`).toBe(covers.length === 0);
    }
  } finally { mask.destroy(); actor.destroy(); }
});
