// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from 'node:fs';
import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { canStand } from './character-movement';
import { clearWalkSegment, findClickPath } from './click-path';
import { createBakedActorOcclusion } from './map-occlusion';
import { PikoNavigationSchema, PikoOcclusionSchema } from './map-package-schema';
import { navigationIssues } from './navigation-editor';
import { expectCombinedOcclusion, occlusionOverlaps } from './occlusion-test-utils';

const cases = [
  {
    map: 'lantern-canal-street',
    blocked: [[1900, 1080], [1000, 300], [1000, 850], [1505, 820], [1730, 859]],
    clear: [[1070, 540], [1000, 560], [165, 430], [1790, 810], [1450, 650]],
    routes: [[[750, 560], [1370, 600]], [[1790, 750], [1790, 820]]],
    sorting: { behind: [650, 375], front: [650, 455], pixel: [640, 325] },
  },
  {
    map: 'cloudtop-slope',
    blocked: [[30, 500], [2000, 500], [492, 438], [1159, 1050], [1450, 980]],
    clear: [[1000, 600], [1000, 1050], [1200, 310], [1190, 350], [1090, 70]],
    routes: [[[1000, 600], [1200, 310]], [[1000, 600], [1000, 1100]]],
    sorting: { behind: [492, 418], front: [492, 460], pixel: [492, 400] },
  },
  {
    map: 'amber-wilds',
    blocked: [[2000, 100], [1900, 1100], [1080, 583], [1385, 991], [675, 545]],
    clear: [[718, 485], [718, 530], [950, 700], [1100, 510], [1400, 1100]],
    routes: [[[718, 570], [718, 475]], [[1100, 510], [1400, 1100]]],
    sorting: { behind: [718, 485], front: [718, 590], pixel: [720, 410] },
  },
];
const point = ([x, y]: number[]) => ({ x, y });

for (const spec of cases) describe(spec.map, () => {
  const read = (name: string) => JSON.parse(readFileSync(`public/piko/world/maps/${spec.map}/data/${name}.json`, 'utf8'));
  const nav = PikoNavigationSchema.parse(read('navigation'));
  const occluders = PikoOcclusionSchema.parse(read('occlusion')).occluders;

  it('uses simple silhouettes with no overlapping mask holes', () => {
    const issues = occluders.flatMap(o => navigationIssues({ ...nav, walkableAreas: [], colliders: [{
      id: o.id, kind: 'prop', points: o.outline!.map(p => ({ x: p.x + o.position.x, y: p.y + o.position.y })),
    }] }));
    expect(issues).toEqual([]);
    expect(occlusionOverlaps(occluders)).toEqual([]);
  });

  it('blocks object footprints, water or cliffs without blocking the main passages', () => {
    for (const p of spec.blocked) expect(canStand(point(p), nav), `blocked ${p}`).toBe(false);
    for (const p of spec.clear) expect(canStand(point(p), nav), `clear ${p}`).toBe(true);
    for (const [start, end] of spec.routes) {
      let previous = point(start);
      const path = findClickPath(previous, point(end), nav);
      expect(path.length, `${start} → ${end}`).toBeGreaterThan(0);
      for (const step of path) {
        expect(clearWalkSegment(previous, step, nav)).toBe(true);
        previous = step;
      }
    }
  });

  it('occludes behind the prop and restores the character in front', () => {
    const actor = new Container(); actor.position.copyFrom(point(spec.sorting.behind));
    const mask = createBakedActorOcclusion(actor, occluders, { width: 2048, height: 1152 });
    try {
      expect(canStand(point(spec.sorting.behind), nav)).toBe(true);
      expect(canStand(point(spec.sorting.front), nav)).toBe(true);
      expect(mask.mask.containsPoint(point(spec.sorting.pixel))).toBe(false);
      actor.position.copyFrom(point(spec.sorting.front)); mask.update();
      expect(mask.mask.containsPoint(point(spec.sorting.pixel))).toBe(true);
    } finally { mask.destroy(); actor.destroy(); }
  });

  it.each([150, 300, 400, 500, 630, 720, 755, 800, 950, 1100])('combines silhouettes correctly at depth %s', depth => {
    expectCombinedOcclusion(occluders, depth);
  });
});
