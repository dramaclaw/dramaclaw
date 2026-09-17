// SPDX-License-Identifier: Elastic-2.0
import { animalFrameAt, type AnimalPlacement, type AnimalClip } from './courtyard-animals';
import type { PikoPoint } from './navigation-geometry';

// Original four-frame side walk, with its original order, anchors and scale.
export const DOG_SIDE_STEPS = [
  ['dog-side-original', 0], ['dog-side-original', 1],
  ['dog-side-original', 2], ['dog-side-original', 3],
] as const;
// At 23 units/s this restores the original 0.18 seconds per frame.
const DOG_SIDE_STRIDE_DISTANCE = 23 * 0.18 * 4;
export const CAT_ROUTE = [
  { x: 610, y: 145 }, { x: 690, y: 200 }, { x: 690, y: 300 },
  { x: 690, y: 200 }, { x: 610, y: 145 }, { x: 555, y: 108 },
] as const;
const DOG_STRIDE_DISTANCE = 32;
/** Explicit visible stops; route corners behind roofs/trees are transit only. */
export const DOG_REST_STOPS = [
  { x: 450, y: 780, name: '西侧钟楼旁开阔步道' },
  { x: 1650, y: 1050, name: '东南侧开阔步道' },
  { x: 1185, y: 684, name: '喷泉东南侧步道' },
] as const;

/** Directional animation and resting transitions share one clock; blocked steps never advance routes. */
export function createPetMotion(placement: AnimalPlacement, random: () => number,
  canMove: (point: PikoPoint) => boolean,
  canRest: (point: PikoPoint) => boolean = () => true,
  options: { restStops?: readonly PikoPoint[]; once?: boolean; restSeconds?: readonly [number, number] } = {}) {
  const dog = placement.kind === 'dog';
  const route = placement.route ?? CAT_ROUTE;
  const state = { position: { ...placement.position }, facing: placement.facing ?? 1,
    clip: (dog ? 'dogWalk' : 'catIdle') as AnimalClip, frame: 0, lift: 0,
    atlas: dog ? 'dog-side-original' : 'cat-rest-v2', pose: dog ? 0 : 7,
    phase: dog ? 'walk' : 'rest' };
  let elapsed = 0, index = 0, walked = 0;
  let atEnd = false;
  let rest = dog ? 35 : 80;
  let gaitDistance = 0;
  let barkCooldown = 45 + random() * 30;
  let afterBark = "walk";
  function transition(phase: string) { state.phase = phase; elapsed = 0; }
  function tick(delta: number) {
    elapsed += delta;
    barkCooldown -= delta;
    if (state.phase === 'done') return;
    if (state.phase === 'bark') {
      state.clip = 'dogBark';
      state.frame = animalFrameAt('dogBark', Math.min(elapsed, 1.239));
      state.atlas = 'dog-bark'; state.pose = state.frame;
      if (elapsed >= 1.24) { barkCooldown = 45 + random() * 30; transition(afterBark); }
      return;
    }
    if (state.phase === 'walk') {
      if (atEnd) { transition('done'); return; }
      const target = route[index];
      const dx = target.x - state.position.x, dy = target.y - state.position.y;
      const distance = Math.hypot(dx, dy);
      const speed = (dog ? 23 : 10) * Math.min(1, Math.max(0.3, distance / 18));
      const step = Math.min(distance, speed * delta);
      const next = distance ? { x: state.position.x + dx / distance * step, y: state.position.y + dy / distance * step } : target;
      if (!canMove(next)) return;
      state.position = { ...next };
      walked += delta;
      gaitDistance += step;
      if (Math.abs(dy) > Math.abs(dx) * 1.3) {
        state.facing = 1;
        state.atlas = dog ? 'dog-actions-v2' : 'cat-actions-v2';
        state.pose = (dog ? (dy < 0 ? 0 : 4) : (dy < 0 ? 4 : 8)) + Math.floor((dog ? gaitDistance / DOG_STRIDE_DISTANCE : elapsed / 0.8) * 4) % 4;
      } else {
        if (Math.abs(dx) > 0.01) state.facing = dx > 0 ? 1 : -1;
        state.atlas = dog ? 'dog-side-original' : 'cat-side-v3';
        if (dog) {
          const frame = DOG_SIDE_STEPS[Math.floor(gaitDistance / DOG_SIDE_STRIDE_DISTANCE * DOG_SIDE_STEPS.length) % DOG_SIDE_STEPS.length];
          state.atlas = frame[0]; state.pose = frame[1];
        } else state.pose = Math.floor(elapsed / 0.16) % 8;
      }
      if (distance <= step + 0.01) {
        atEnd = Boolean(options.once && index === route.length - 1);
        index = (index + 1) % route.length;
        // Dog rests at open lawn/path nodes, never at every corner or at the east exit.
        const restNode = !dog || (options.restStops ?? DOG_REST_STOPS).some(p => p.x === target.x && p.y === target.y);
        if (restNode && canRest(state.position) && walked > (dog ? 25 : 2)) {
          rest = options.restSeconds ? options.restSeconds[0] + random() * (options.restSeconds[1] - options.restSeconds[0])
            : dog ? 60 + random() * 30 : 80 + random() * 20;
          walked = 0;
          if (dog && barkCooldown <= 0) { afterBark = 'lie'; transition('bark'); }
          else transition('lie');
        }
      }
    } else {
      state.atlas = dog ? 'dog-actions-v2' : 'cat-rest-v2';
      const count = dog ? 4 : 8;
      const duration = dog ? 0.9 : 1.3;
      if (state.phase === 'lie') {
        state.pose = (dog ? 8 : 0) + Math.min(count - 1, Math.floor(elapsed / duration * count));
        if (elapsed >= duration) transition('rest');
      } else if (state.phase === 'rest') {
        state.pose = dog ? 14 + Math.floor(elapsed / 2.5) % 2 : 7;
        if (elapsed >= rest) transition('rise');
      } else {
        state.pose = (dog ? 8 : 0) + Math.max(0, count - 1 - Math.floor(elapsed / duration * count));
        if (elapsed >= duration) transition('walk');
      }
    }
    // Existing proximity audio remains silent during locomotion and settling.
    state.clip = dog ? 'dogWalk' : 'catIdle';
    state.frame = !dog && state.phase === 'rest' && elapsed % 12 < 2 ? 0 : 2;
  }
  return { state, update(delta: number) {
    // Substeps prevent crossing narrow obstacles after delayed frames.
    let left = Math.max(0, Math.min(delta, 1));
    while (left > 0) { const step = Math.min(left, 0.05); tick(step); left -= step; }
  } };
}
