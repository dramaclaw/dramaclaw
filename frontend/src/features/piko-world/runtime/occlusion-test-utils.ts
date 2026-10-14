// SPDX-License-Identifier: Elastic-2.0
import { Container, earcut } from 'pixi.js';
import { expect } from 'vitest';
import type { PikoOccluder } from './map-package-schema';
import { createBakedActorOcclusion } from './map-occlusion';
import { pointInPolygon } from './navigation-geometry';

type Point = { x: number; y: number };

/** Compare the rendered mask with the authored silhouettes above a foot depth. */
export function expectCombinedOcclusion(occluders: PikoOccluder[], depth: number) {
  const actor = new Container(); actor.y = depth;
  const mask = createBakedActorOcclusion(actor, occluders, { width: 2048, height: 1152 });
  const active = occluders.filter(o => depth < o.depthY);
  try {
    for (let y = Math.max(1, depth - 130) + 0.37; y < depth; y += 11) for (let x = 8.19; x < 2040; x += 11) {
      const hidden = active.some(o => pointInPolygon({ x: x - o.position.x, y: y - o.position.y }, o.outline!));
      expect(!actor.mask || mask.mask.containsPoint({ x, y }), `${x},${y} at depth ${depth}`).toBe(!hidden);
    }
  } finally { mask.destroy(); actor.destroy(); }
}

const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const area = (p: Point[]) => Math.abs(p.reduce((s, a, i) => {
  const b = p[(i + 1) % p.length];
  return s + a.x * b.y - b.x * a.y;
}, 0)) / 2;

// Shared edges are allowed; positive-area overlap invalidates baked mask holes.
function intersection(subject: Point[], triangle: Point[]): Point[] {
  let output = subject;
  const sign = Math.sign(cross(triangle[0], triangle[1], triangle[2]));
  for (let j = 0; j < 3; j++) {
    const a = triangle[j], b = triangle[(j + 1) % 3], input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i], q = input[(i + 1) % input.length];
      const d = cross(a, b, p) * sign, e = cross(a, b, q) * sign;
      if (d >= 0) output.push(p);
      if ((d >= 0) !== (e >= 0)) {
        const t = d / (d - e);
        output.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
  }
  return output;
}

export function occlusionOverlaps(occluders: readonly PikoOccluder[]): string[] {
  const overlaps: string[] = [];
  const polygons = occluders.map(o => {
    const p = o.outline!.map(q => ({ x: q.x + o.position.x, y: q.y + o.position.y }));
    const indices = earcut(p.flatMap(q => [q.x, q.y]));
    return {
      id: o.id,
      box: [Math.min(...p.map(q => q.x)), Math.min(...p.map(q => q.y)), Math.max(...p.map(q => q.x)), Math.max(...p.map(q => q.y))],
      triangles: Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3).map(k => p[k])),
    };
  });
  for (let i = 0; i < polygons.length; i++) for (let j = i + 1; j < polygons.length; j++) {
    const a = polygons[i], b = polygons[j];
    if (a.box[0] >= b.box[2] || b.box[0] >= a.box[2] || a.box[1] >= b.box[3] || b.box[1] >= a.box[3]) continue;
    let overlap = 0;
    for (const ta of a.triangles) for (const tb of b.triangles) overlap += area(intersection(ta, tb));
    if (overlap >= 0.01) overlaps.push(`${a.id} / ${b.id}: ${overlap.toFixed(2)}`);
  }
  return overlaps;
}
