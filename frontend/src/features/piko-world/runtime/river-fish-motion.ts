// SPDX-License-Identifier: Elastic-2.0
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";

export type RiverFish = PikoPoint & { heading: number; speed: number; target: PikoPoint; retargetIn: number; restFor: number; hasTarget: boolean };
export type RiverWaterRegion = { id: string; points: PikoPoint[] };
const STARTS = [{ x: 1970, y: 610 }, { x: 2005, y: 660 }, { x: 1953, y: 705 }, { x: 2006, y: 800 }];
export type RiverFishRoute = {
  start: PikoPoint;
  surfaceId?: string;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  flowAxis?: "x" | "y";
  downstreamChance?: number;
};
const COURTYARD_ROUTES: readonly RiverFishRoute[] = STARTS.map(start => ({
  start, bounds: { minX: 1940, maxX: 2023, minY: 595, maxY: 820 },
}));
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

/** Independent steering inside each fish's water surface, with body clearance. */
export function createRiverFishMotion(regions: readonly RiverWaterRegion[], random: () => number = Math.random,
  routes: readonly RiverFishRoute[] = COURTYARD_ROUTES) {
  const surfaces = new Map(regions.map(region => [region.id, region.points]));
  for (const route of routes) {
    if (route.surfaceId !== undefined && !surfaces.has(route.surfaceId)) {
      throw new Error(`Missing river fish surface: ${route.surfaceId}`);
    }
  }
  const inside = (point: PikoPoint, route: RiverFishRoute) => route.surfaceId === undefined
    ? regions.some(region => pointInPolygon(point, region.points))
    : pointInPolygon(point, surfaces.get(route.surfaceId)!);
  const probe = { x: 0, y: 0 };
  const safe = (point: PikoPoint, route: RiverFishRoute) => {
    if (!inside(point, route)) return false;
    for (const offset of CLEARANCE_OFFSETS) {
      probe.x = point.x + offset.x; probe.y = point.y + offset.y;
      if (!inside(probe, route)) return false;
    }
    return true;
  };
  const fish: RiverFish[] = routes.map((route, index) => ({ ...route.start, heading: index * 1.5,
    speed: MIN_SPEED + random() * SPEED_RANGE, target: { ...route.start }, retargetIn: 0, restFor: 0, hasTarget: false }));
  const targetFor = (actor: RiverFish, route: RiverFishRoute) => {
    let fallback: PikoPoint | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      // The river moves downward; shallows drift along the shore toward the right.
      // Occasional reverse targets keep the shoal from looking scripted.
      const downstream = random() < (route.downstreamChance ?? DOWNSTREAM_CHANCE);
      const { minX, maxX, minY, maxY } = route.bounds;
      const alongX = route.flowAxis === "x";
      const origin = alongX ? actor.x : actor.y;
      const lower = downstream ? origin - 10 : origin - 100;
      const upper = downstream ? origin + 105 : origin + 25;
      const min = Math.max(alongX ? minX : minY, lower);
      const max = Math.min(alongX ? maxX : maxY, upper);
      const point = alongX
        ? { x: min + random() * Math.max(0, max - min), y: minY + random() * (maxY - minY) }
        : { x: minX + random() * (maxX - minX), y: min + random() * Math.max(0, max - min) };
      if (!safe(point, route) || Math.hypot(point.x - actor.x, point.y - actor.y) < 30) continue;
      // Avoid asking a fish to cut across a bank on its way to a distant target.
      let clearPath = true;
      for (let index = 1; index <= 12; index++) {
        const t = index / 12;
        if (!safe({ x: actor.x + (point.x - actor.x) * t, y: actor.y + (point.y - actor.y) * t }, route)) {
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
    for (const [index, actor] of fish.entries()) {
      const route = routes[index];
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
        const target = targetFor(actor, route);
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
      if (!safe(lookAhead, route)) {
        dx = actor.target.x - actor.x; dy = actor.target.y - actor.y;
      }
      const turn = angleDifference(Math.atan2(dy, dx), actor.heading);
      actor.heading += Math.max(-1.8 * dt, Math.min(1.8 * dt, turn));
      const next = { x: actor.x + Math.cos(actor.heading) * actor.speed * dt,
        y: actor.y + Math.sin(actor.heading) * actor.speed * dt };
      if (safe(next, route) && fish.every(other => other === actor || Math.hypot(next.x - other.x, next.y - other.y) >= MIN_SEPARATION)) {
        actor.x = next.x; actor.y = next.y;
      } else {
        actor.retargetIn = Math.min(actor.retargetIn, 0.3);
      }
    }
  };
  return { fish, step };
}
