// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Container } from "pixi.js";
import { PikoNavigationSchema } from "./map-package-schema";
import { canStand, facingFor, moveCharacter } from "./character-movement";
const nav=PikoNavigationSchema.parse(JSON.parse(readFileSync("public/piko/world/maps/welcome-courtyard/data/navigation.json","utf8")));
it("preserves real Pixi ObservablePoint coordinates while idle and moving",()=>{
  const actor=new Container();
  actor.position.set(1190,485);
  expect(moveCharacter(actor.position,{x:0,y:0},16,nav)).toEqual({x:1190,y:485});
  expect(moveCharacter(actor.position,{x:1,y:0},NaN,nav)).toEqual({x:1190,y:485});
  const moved=moveCharacter(actor.position,{x:1,y:0},16,nav);
  expect(moved.x).toBeGreaterThan(1190);
  expect(moved.y).toBe(485);
  actor.position.set(moved.x,moved.y);
  for(let i=0;i<100;i++){
    const idle=moveCharacter(actor.position,{x:0,y:0},16,nav);
    actor.position.set(idle.x,idle.y);
  }
  expect(Number.isFinite(actor.x)&&Number.isFinite(actor.y)).toBe(true);
  actor.destroy();
});
it("uses actual map collision regions and permits the initial resident position",()=>{
  expect(canStand({x:1190,y:485},nav)).toBe(true);
  for(const point of [{x:1060,y:300},{x:1060,y:560},{x:2020,y:700},{x:-20,y:500}]) expect(canStand(point,nav)).toBe(false);
});
it("normalizes diagonal speed and bounds long frames",()=>{
  const start={x:1300,y:650};
  const straight=moveCharacter(start,{x:1,y:0},16,nav);
  const diagonal=moveCharacter(start,{x:1,y:1},16,nav);
  expect(Math.hypot(diagonal.x-start.x,diagonal.y-start.y)).toBeCloseTo(straight.x-start.x);
  expect(moveCharacter(start,{x:1,y:0},10000,nav).x-start.x).toBeLessThanOrEqual(7.5);
});
it("does not walk through the fountain and stops safely",()=>{
  let point={x:1250,y:550};
  for(let i=0;i<200;i++)point=moveCharacter(point,{x:-1,y:0},16,nav);
  expect(point.x).toBeGreaterThan(1060);
  expect(canStand({x:point.x-3,y:point.y},nav)).toBe(false);
  expect(canStand(point,nav)).toBe(true);
  expect(moveCharacter(point,{x:0,y:0},16,nav)).toEqual(point);
});
it("resolves all four facings",()=>{
  expect([{x:0,y:1},{x:-1,y:0},{x:1,y:0},{x:0,y:-1}].map(facingFor)).toEqual(["south","west","east","north"]);
});
