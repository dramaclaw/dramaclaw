// SPDX-License-Identifier: Elastic-2.0
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";

export type RiverFish = PikoPoint & { heading: number; speed: number; target: PikoPoint; retargetIn: number; restFor: number; hasTarget: boolean };
const STARTS = [{ x: 1970, y: 610 }, { x: 2005, y: 660 }, { x: 1953, y: 705 }, { x: 2006, y: 800 }];
const BODY_CLEARANCE = 15;
const MIN_SEPARATION = 28;
const MIN_SPEED = 16;
const SPEED_RANGE = 8;
const DOWNSTREAM_CHANCE = 0.72;
const REST_CHANCE = 0.42;
const MIN_REST_SECONDS = 2;
const REST_RANGE_SECONDS = 3;
const CLEARANCE_OFFSETS = Array.from({ length: 12 }, (_, index) => ({
  x: Math.cos(index * Math.PI / 6) * BODY_CLEARANCE,
  y: Math.sin(index * Math.PI / 6) * BODY_CLEARANCE,
}));
const angleDifference = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** Independent steering within the connected bridge/downstream water, with body clearance. */
export function createRiverFishMotion(regions: PikoPoint[][], random: () => number = Math.random) {
  const inside = (point: PikoPoint) => regions.some(region => pointInPolygon(point, region));
  const probe = { x: 0, y: 0 };
  const safe = (point: PikoPoint) => {
    if (!inside(point)) return false;
    for (const offset of CLEARANCE_OFFSETS) {
      probe.x = point.x + offset.x; probe.y = point.y + offset.y;
      if (!inside(probe)) return false;
    }
    return true;
  };
  const fish: RiverFish[] = STARTS.map((point, index) => ({ ...point, heading: index * 1.5,
    speed: MIN_SPEED + random() * SPEED_RANGE, target: { ...point }, retargetIn: 0, restFor: 0, hasTarget: false }));
  const targetFor = (actor: RiverFish) => {
    let fallback: PikoPoint | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      // The river moves toward increasing y. Most routes drift downstream, with
      // enough upstream exploration to keep the shoal from looking scripted.
      const downstream = random() < DOWNSTREAM_CHANCE;
      const minY = downstream ? Math.max(595, actor.y - 10) : Math.max(595, actor.y - 100);
      const maxY = downstream ? Math.min(820, actor.y + 105) : Math.min(820, actor.y + 25);
      const point = { x: 1940 + random() * 83, y: minY + random() * Math.max(0, maxY - minY) };
      if (!safe(point) || Math.hypot(point.x - actor.x, point.y - actor.y) < 30) continue;
      // Avoid asking a fish to cut across a bank on its way to a distant target.
      let clearPath = true;
      for (let index = 1; index <= 12; index++) {
        const t = index / 12;
        if (!safe({ x: actor.x + (point.x - actor.x) * t, y: actor.y + (point.y - actor.y) * t })) {
          clearPath = false; break;
        }
      }
      if (!clearPath) continue;
      fallback = point;
      if (fish.some(other => other !== actor && other.hasTarget && Math.hypot(point.x - other.target.x, point.y - other.target.y) < 38)) continue;
      return point;
    }
    return fallback;
  };
  const step = (deltaSeconds: number) => {
    const dt = Number.isFinite(deltaSeconds) ? Math.min(0.05, Math.max(0, deltaSeconds)) : 0;
    if (!dt) return;
    for (const actor of fish) {
      if (actor.restFor > 0) {
        actor.restFor = Math.max(0, actor.restFor - dt);
        continue;
      }
      actor.retargetIn -= dt;
      const reached = actor.hasTarget && Math.hypot(actor.target.x - actor.x, actor.target.y - actor.y) < 18;
      if (reached && random() < REST_CHANCE) {
        actor.hasTarget = false;
        actor.retargetIn = 0;
        actor.restFor = MIN_REST_SECONDS + random() * REST_RANGE_SECONDS;
        continue;
      }
      if (actor.retargetIn <= 0 || reached) {
        const target = targetFor(actor);
        actor.hasTarget = target !== null;
        actor.retargetIn = target ? 5.5 + random() * 4.5 : 0.75;
        if (target) { actor.target = target; actor.speed = MIN_SPEED + random() * SPEED_RANGE; }
      }
      if (!actor.hasTarget) continue;
      let dx = actor.target.x - actor.x, dy = actor.target.y - actor.y;
      const distance = Math.hypot(dx, dy) || 1;
      dx /= distance; dy /= distance;
      for (const other of fish) {
        if (other === actor) continue;
        const gap = Math.hypot(actor.x - other.x, actor.y - other.y);
        if (gap > 0 && gap < 45) {
          const repulsion = (45 - gap) / 18;
          dx += (actor.x - other.x) / gap * repulsion;
          dy += (actor.y - other.y) / gap * repulsion;
        }
      }
      // Steer back toward safe water before reaching the shore.
      const lookAhead = { x: actor.x + Math.cos(actor.heading) * 22, y: actor.y + Math.sin(actor.heading) * 22 };
      if (!safe(lookAhead)) {
        dx = actor.target.x - actor.x; dy = actor.target.y - actor.y;
      }
      const turn = angleDifference(Math.atan2(dy, dx), actor.heading);
      actor.heading += Math.max(-1.8 * dt, Math.min(1.8 * dt, turn));
      const next = { x: actor.x + Math.cos(actor.heading) * actor.speed * dt,
        y: actor.y + Math.sin(actor.heading) * actor.speed * dt };
      if (safe(next) && fish.every(other => other === actor || Math.hypot(next.x - other.x, next.y - other.y) >= MIN_SEPARATION)) {
        actor.x = next.x; actor.y = next.y;
      } else {
        actor.retargetIn = Math.min(actor.retargetIn, 0.3);
      }
    }
  };
  return { fish, step };
}
