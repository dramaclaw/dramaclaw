// SPDX-License-Identifier: Elastic-2.0
import { canStand, type Point } from "./character-movement";
import type { PikoNavigation } from "./map-package-schema";

export function clearWalkSegment(a: Point, b: Point, navigation: PikoNavigation) {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let i = 1; i <= steps; i++) {
    if (!canStand({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, navigation)) return false;
  }
  return true;
}

/** Bounded A* on a local grid; every edge uses the player's collision radius. */
export function findClickPath(start: Point, target: Point, navigation: PikoNavigation): Point[] {
  if (!canStand(target, navigation)) return [];
  if (clearWalkSegment(start, target, navigation)) return [target];
  const step = 16;
  type Node = { x: number; y: number; cost: number; score: number; parent?: Node };
  const point = (node: Node): Point => ({ x: start.x + node.x * step, y: start.y + node.y * step });
  const heuristic = (p: Point) => Math.hypot(target.x - p.x, target.y - p.y);
  const open: Node[] = [{ x: 0, y: 0, cost: 0, score: heuristic(start) }];
  const costs = new Map<string, number>([["0,0", 0]]);
  const closed = new Set<string>();
  const walkable = new Map<string, boolean>();
  for (let count = 0; open.length && count < 12000; count++) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i].score < open[best].score) best = i;
    const current = open.splice(best, 1)[0];
    const currentKey = `${current.x},${current.y}`;
    if (closed.has(currentKey) || current.cost !== costs.get(currentKey)) continue;
    closed.add(currentKey);
    const here = point(current);
    if (heuristic(here) <= step * 2 && clearWalkSegment(here, target, navigation)) {
      const path: Point[] = [target];
      for (let node: Node | undefined = current; node?.parent; node = node.parent) path.unshift(point(node));
      // Remove intermediate grid corners only when the swept route stays clear.
      const smooth: Point[] = [];
      let anchor = start;
      for (let index = 0; index < path.length;) {
        let next = path.length - 1;
        while (next > index && !clearWalkSegment(anchor, path[next], navigation)) next--;
        anchor = path[next];
        smooth.push(anchor);
        index = next + 1;
      }
      return smooth;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = current.x + dx, y = current.y + dy;
      const key = `${x},${y}`, cost = current.cost + Math.hypot(dx, dy) * step;
      if (closed.has(key)) continue;
      if (cost >= (costs.get(key) ?? Infinity)) continue;
      const next = { x: start.x + x * step, y: start.y + y * step };
      let valid = walkable.get(key);
      if (valid === undefined) {
        valid = canStand(next, navigation);
        walkable.set(key, valid);
      }
      if (!valid || !clearWalkSegment(here, next, navigation)) continue;
      costs.set(key, cost);
      open.push({ x, y, cost, score: cost + heuristic(next), parent: current });
    }
  }
  return [];
}
