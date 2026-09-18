// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { createCharacterActor } from "./character-actor";
import type { PikoNavigation } from "./map-package-schema";
import { CHARACTER_SPEED, FACINGS, facingFor, moveCharacter, type Facing, type Point } from "./character-movement";
import { advanceGait, gaitColumn, crossesFootContact } from "./character-gait";
import { createGrassFootsteps } from "./footstep-audio";
import { findClickPath } from "./click-path";
export const RESIDENT_MOTION_SRC = "/piko/world/characters/resident-m01-idle-v1/resident-m01-motion-v8.png";
export const RESIDENT_IDLE_SRC = "/piko/world/characters/resident-m01-idle-v1/resident-m01-idle-sheet.png";
// Resident display tuning; shared actor applies it to body and contact shadow.
export const RESIDENT_WORLD_SCALE = (82 / 48) * 1.15;
export const RESIDENT_TIMELINE = [
  { frame: 0, durationMs: 1100 }, { frame: 1, durationMs: 450 },
  { frame: 0, durationMs: 900 }, { frame: 2, durationMs: 120 },
  { frame: 0, durationMs: 1100 }, { frame: 1, durationMs: 450 },
  { frame: 0, durationMs: 680 },
] as const;
export function residentFrameAt(elapsedMs: number) {
  let remaining = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) % 4800 : 0;
  for (const step of RESIDENT_TIMELINE) {
    if (remaining < step.durationMs) return step.frame;
    remaining -= step.durationMs;
  }
  return 0;
}
export function createResidentActor(sheet: Texture, ticker: Ticker, isActive: () => boolean,
  controls: {
    host: HTMLElement; navigation: PikoNavigation;
    label?: string; position?: Point; facing?: Facing;
    simulatedInput?: () => Point;
    footsteps?: boolean;
    idleFrameAt?: (elapsedMs: number) => number;
    idleCycleMs?: number;
    onPose?: (facing: Facing, column: number) => void;
    speed?: number;
    gaitCycleSourcePixels?: number;
  }) {
  const idleCycleMs = controls.idleCycleMs ?? 4800;
  const actor = createCharacterActor(sheet, ticker, isActive, {
    label: controls.label ?? "piko-player", frameSize: 64, frameCount: 44, columns: 11, manual: true, pivot: { x: 32, y: 57 },
    position: controls.position ?? { x: 1190, y: 485 }, scale: RESIDENT_WORLD_SCALE,
    shadow: { width: 24, height: 8 }, durationMs: idleCycleMs, frameAt: residentFrameAt,
  });
  const keyboardControlled = !controls.simulatedInput;
  let facing: Facing = controls.facing ?? "south";
  actor.setFrame(FACINGS.indexOf(facing) * 11);
  const footsteps = keyboardControlled && controls.footsteps !== false ? createGrassFootsteps() : { unlock() {}, step() {}, stop() {}, destroy() {} };
  let elapsed = 0, wasMoving = false;
  let gaitDistance = 0;
  const cycleDistance = (controls.gaitCycleSourcePixels ?? 40) * RESIDENT_WORLD_SCALE;
  const speed = controls.speed ?? CHARACTER_SPEED;
  const keys = new Set<string>();
  let path: Point[] = [];
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const clear = () => { keys.clear(); path = []; elapsed = 0; wasMoving = false; gaitDistance = 0; footsteps.stop(); };
  const keyDown = (event: KeyboardEvent) => {
    if(!isActive() || document.activeElement !== controls.host || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if(!["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code)) return;
    path = [];
    footsteps.unlock();
    event.preventDefault(); keys.add(event.code);
  };
  const keyUp = (event: KeyboardEvent) => { keys.delete(event.code); };
  const focus = () => controls.host.focus({preventScroll:true});
  const tick = (time: Ticker) => {
    if(!isActive() || document.hidden || (keyboardControlled && document.activeElement !== controls.host)) clear();
    const canMove = isActive() && !document.hidden;
    const input = controls.simulatedInput ? (canMove ? controls.simulatedInput() : { x: 0, y: 0 }) : {x:Number(keys.has("KeyD")||keys.has("ArrowRight"))-Number(keys.has("KeyA")||keys.has("ArrowLeft")),
      y:Number(keys.has("KeyS")||keys.has("ArrowDown"))-Number(keys.has("KeyW")||keys.has("ArrowUp"))};
    const destination = path[0];
    let deltaMs = time.deltaMS;
    if (destination && canMove && !input.x && !input.y) {
      input.x = destination.x - actor.container.position.x;
      input.y = destination.y - actor.container.position.y;
      deltaMs = Math.min(deltaMs, Math.hypot(input.x, input.y) / speed * 1000);
    }
    if(input.x||input.y) facing = facingFor(input);
    const before = actor.container.position;
    const next = moveCharacter(before,input,deltaMs,controls.navigation,speed);
    const travelled = Math.hypot(next.x-before.x,next.y-before.y);
    const moving = travelled>0.01;
    actor.container.position.set(next.x,next.y);
    if (destination) {
      if (Math.hypot(next.x - destination.x, next.y - destination.y) < 0.1) path.shift();
      else if (time.deltaMS > 0 && !moving) path = [];
    }
    actor.container.zIndex = next.y;
    if(moving!==wasMoving) elapsed=0;
    if (keyboardControlled && crossesFootContact(gaitDistance, travelled, cycleDistance, wasMoving)) footsteps.step();
    if (!moving && wasMoving) footsteps.stop();
    wasMoving=moving;
    gaitDistance = moving ? advanceGait(gaitDistance, travelled, cycleDistance) : 0;
    if(!document.hidden && isActive()) elapsed=(elapsed+Math.min(time.deltaMS,50))%idleCycleMs;
    const column = motion?.matches ? 0 : moving ? gaitColumn(gaitDistance, cycleDistance) : (controls.idleFrameAt ?? residentFrameAt)(elapsed);
    actor.setFrame(FACINGS.indexOf(facing)*11+column);
    controls.onPose?.(facing, column);
  };
  if (keyboardControlled) {
  window.addEventListener("keydown",keyDown);
  window.addEventListener("keyup",keyUp);
  window.addEventListener("blur",clear);
  document.addEventListener("visibilitychange",clear);
  controls.host.addEventListener("pointerdown",focus);
  }
  ticker.add(tick);
  return { ...actor, stop: clear, walkTo(target: Point) {
    if (!keyboardControlled || !isActive() || document.hidden) return false;
    focus();
    keys.clear();
    footsteps.unlock();
    path = findClickPath({ x: actor.container.position.x, y: actor.container.position.y }, target, controls.navigation);
    return path.length > 0;
  }, destroy() {
    footsteps.destroy();
    ticker.remove(tick);
    window.removeEventListener("keydown",keyDown); window.removeEventListener("keyup",keyUp);
    window.removeEventListener("blur",clear); document.removeEventListener("visibilitychange",clear);
    controls.host.removeEventListener("pointerdown",focus); actor.destroy();
  }};
}
