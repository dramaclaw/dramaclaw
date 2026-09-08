// SPDX-License-Identifier: Elastic-2.0
import type { PikoNavigation } from "./map-package-schema";
export type Point = { x: number; y: number };
export type Facing = "south" | "west" | "east" | "north";
export const FACINGS: Facing[] = ["south", "west", "east", "north"];

export function inside(point: Point, polygon: Point[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x) hit = !hit;
  }
  return hit;
}
function edgeDistance(p: Point, a: Point, b: Point) {
  const dx = b.x-a.x, dy = b.y-a.y;
  const t = Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy || 1)));
  return Math.hypot(p.x-a.x-t*dx, p.y-a.y-t*dy);
}
export function canStand(p: Point, navigation: PikoNavigation, radius = 8) {
  const samples = [p, ...Array.from({length:8}, (_,i) => ({x:p.x+radius*Math.cos(i*Math.PI/4),y:p.y+radius*Math.sin(i*Math.PI/4)}))];
  if (!samples.every(s => navigation.walkableAreas.some(area => inside(s, area.points)))) return false;
  return !navigation.colliders.some(c => inside(p,c.points) || c.points.some((a,i) => edgeDistance(p,a,c.points[(i+1)%c.points.length]) <= radius));
}
export function moveCharacter(position: Point, input: Point, deltaMs: number, navigation: PikoNavigation) {
  const length = Math.hypot(input.x,input.y);
  // Pixi ObservablePoint exposes x/y through accessors, not enumerable fields.
  if (!length || !Number.isFinite(deltaMs)) return {x:position.x,y:position.y};
  const distance = 150 * Math.max(0,Math.min(deltaMs,50)) / 1000;
  const dx = input.x/length*distance, dy = input.y/length*distance;
  const result = {x:position.x,y:position.y};
  // Small swept steps avoid tunnelling; axis separation allows sliding along obstacles.
  const steps = Math.max(1,Math.ceil(distance/3));
  for(let i=0;i<steps;i++) {
    if(canStand({x:result.x+dx/steps,y:result.y},navigation)) result.x += dx/steps;
    if(canStand({x:result.x,y:result.y+dy/steps},navigation)) result.y += dy/steps;
  }
  return result;
}
export function facingFor(input: Point): Facing {
  return Math.abs(input.x)>Math.abs(input.y) ? (input.x<0?"west":"east") : (input.y<0?"north":"south");
}
export function canTalkTo(position: Point, npc: Point, navigation: PikoNavigation) {
  const distance = Math.hypot(position.x-npc.x,position.y-npc.y);
  if(distance>100) return false;
  const steps=Math.max(1,Math.ceil(distance/4));
  return Array.from({length:steps+1},(_,i)=>({x:position.x+(npc.x-position.x)*i/steps,y:position.y+(npc.y-position.y)*i/steps}))
    .every(p=>canStand(p,navigation,0));
}
