import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPetMotion } from './pet-motion';
import { COURTYARD_ANIMALS, isAnimalPositionNavigable } from './courtyard-animals';
import { PikoNavigationSchema } from './map-package-schema';
const navigation = PikoNavigationSchema.parse(JSON.parse(readFileSync('public/piko/world/maps/welcome-courtyard/data/navigation.json', 'utf8')));
it('settles, rests, rises and resumes without moving during a rest transition', () => {
  for (const kind of ['dog', 'cat']) {
    const placement = COURTYARD_ANIMALS.find(p => p.kind === kind)!;
    const motion = createPetMotion(placement, () => 0.5, p => isAnimalPositionNavigable(p, navigation));
    const phases = new Set<string>();
    const atlases = new Set<string>();
    for (let i = 0; i < 12000; i++) {
      const before = { ...motion.state.position }, phase = motion.state.phase;
      motion.update(0.1);
      phases.add(motion.state.phase); atlases.add(motion.state.atlas);
      expect(isAnimalPositionNavigable(motion.state.position, navigation)).toBe(true);
      if (phase !== 'walk' && motion.state.phase !== 'walk') expect(motion.state.position).toEqual(before);
    }
    expect(phases).toEqual(new Set(kind === 'dog' ? ['walk', 'lie', 'rest', 'rise', 'bark'] : ['walk', 'lie', 'rest', 'rise']));
    expect(atlases.has(kind === 'dog' ? 'dog-side-original' : 'cat-side-v3')).toBe(true);
  }
});
it('uses front/back poses and cannot tunnel through blocked terrain', () => {
  const p = { id: 'dog', kind: 'dog' as const, scale: 1, position: { x: 0, y: 0 }, route: [{ x: 0, y: 100 }] };
  const motion = createPetMotion(p, () => 0.5, point => point.y < 5);
  motion.update(1);
  expect(motion.state.position.y).toBeLessThan(5);
  expect(motion.state.atlas).toBe('dog-actions-v2');
  const before = { ...motion.state.position };
  motion.update(1);
  expect(motion.state.position).toEqual(before);
});
it('rests for 80 seconds on arrival and 80–100 seconds after moving', () => {
  for (const value of [0, 0.5, 1]) {
    const placement = COURTYARD_ANIMALS.find(p => p.kind === 'cat')!;
    const motion = createPetMotion(placement, () => value, () => true);
    for (let i = 0; i < 799; i++) motion.update(0.1);
    expect(motion.state.phase).toBe('rest');
    motion.update(0.2);
    expect(motion.state.phase).toBe('rise');
    for (let i = 0; i < 1000 && motion.state.phase !== 'rest'; i++) motion.update(0.1);
    expect(motion.state.phase).toBe('rest');
    let duration = 0;
    while (motion.state.phase === 'rest' && duration < 102) { motion.update(0.1); duration += 0.1; }
    expect(duration).toBeCloseTo(80 + value * 20, 0);
  }
});
it('freezes the gait at obstacles and advances it by distance, independent of frame timing', () => {
  const p = { id: 'dog', kind: 'dog' as const, scale: 1, position: { x: 0, y: 0 }, route: [{ x: 1000, y: 0 }] };
  let blocked = false;
  const a = createPetMotion(p, () => .5, () => !blocked);
  const b = createPetMotion(p, () => .5, () => true);
  for (let i = 0; i < 10; i++) a.update(.1);
  b.update(1);
  expect(a.state.pose).toBe(b.state.pose);
  blocked = true;
  const pose = a.state.pose;
  a.update(1);
  expect(a.state.pose).toBe(pose);
  expect(a.state.position.x).toBeCloseTo(b.state.position.x);
});

it('only rests at explicit visible stops, never behind the north roof', async () => {
  const { DOG_REST_STOPS } = await import('./pet-motion');
  const { isPetRestVisible } = await import('./pet-rest-visibility');
  const { occluders } = JSON.parse(readFileSync('public/piko/world/maps/welcome-courtyard/data/occlusion.json', 'utf8'));
  for (const p of DOG_REST_STOPS) {
    expect(isAnimalPositionNavigable(p, navigation), p.name).toBe(true);
    expect(isPetRestVisible(p, occluders), p.name).toBe(true);
  }
  expect(isPetRestVisible({ x: 1100, y: 95 }, occluders)).toBe(false);
  const placement = COURTYARD_ANIMALS.find(p => p.kind === 'dog')!;
  const motion = createPetMotion(placement, () => .5, () => true, () => false);
  for (let i = 0; i < 10000; i++) {
    motion.update(.1);
    expect(motion.state.phase).toBe('walk');
  }
});
it('keeps the expanded cat route navigable and actually plays both vertical directions', async () => {
  const { CAT_ROUTE } = await import('./pet-motion');
  const cat = COURTYARD_ANIMALS.find(p => p.kind === 'cat')!;
  const points = [cat.position, ...CAT_ROUTE];
  for (let i = 1; i < points.length; i++) {
    for (let t = 0; t <= 1; t += .01) {
      const p = { x: points[i-1].x + (points[i].x-points[i-1].x)*t, y: points[i-1].y + (points[i].y-points[i-1].y)*t };
      expect(isAnimalPositionNavigable(p, navigation), JSON.stringify(p)).toBe(true);
    }
  }
  const motion = createPetMotion(cat, () => 0, p => isAnimalPositionNavigable(p, navigation));
  const directions = new Set<number>();
  for (let i = 0; i < 10000; i++) {
    motion.update(.1);
    if (motion.state.atlas === 'cat-actions-v2') directions.add(Math.floor(motion.state.pose/4));
  }
  expect(directions).toEqual(new Set([1, 2]));
});
it('barks once before eligible rests, holds position and exposes the bark clip for audio', () => {
 const dog=COURTYARD_ANIMALS.find(p=>p.kind==='dog')!;
 const m=createPetMotion(dog,()=>0,()=>true);
 let previous=m.state.phase,count=0,duration=0;
 for(let i=0;i<14000;i++){
  const p={...m.state.position};m.update(.1);
  if(m.state.phase==='bark'){
   if(previous==='bark')expect(m.state.position).toEqual(p);
   if(previous==='bark'){expect(m.state.clip).toBe('dogBark');expect(m.state.atlas).toBe('dog-bark');}
   if(previous!=='bark')count++;
   duration+=.1;
  }
  previous=m.state.phase;
 }
 expect(count).toBeGreaterThan(0);
 expect(duration/count).toBeGreaterThan(1);
 expect(duration/count).toBeLessThan(1.5);
});

it('plays the original side walk in order at the original cruising cadence', () => {
 const m=createPetMotion({id:'dog',kind:'dog',scale:1,position:{x:0,y:0},route:[{x:1000,y:0}]},()=>.5,()=>true);
 const frames: number[]=[];
 for(let i=0;i<8;i++){
  m.update(.09);
  expect(m.state.atlas).toBe('dog-side-original');
  frames.push(m.state.pose);
 }
 expect(frames.filter((p,i)=>i===0||p!==frames[i-1]).slice(0,4)).toEqual([0,1,2,3]);
});
