import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DOG_MAPS, DOG_MAP_STOPS } from './dog-world-routes';
import { createDogWorld, type DogWorldData } from './dog-world';
import { PikoNavigationSchema } from './map-package-schema';
import { isAnimalPositionNavigable } from './courtyard-animals';
import { pointInPolygon } from './navigation-geometry';
import { isPetRestVisible } from './pet-rest-visibility';
const data=Object.fromEntries(DOG_MAPS.map(id=>[id,{
 navigation:PikoNavigationSchema.parse(JSON.parse(readFileSync(`public/piko/world/maps/${id}/data/navigation.json`,'utf8'))),
 occluders:JSON.parse(readFileSync(`public/piko/world/maps/${id}/data/occlusion.json`,'utf8')).occluders,
}])) as DogWorldData;
it('greets after a dwell and requires cooldown plus a new approach',()=>{
 const dog=createDogWorld(data,()=>0), near=()=>({...dog.state.position});
 dog.greetNearby(dog.mapId,near(),0,()=>true);
 dog.greetNearby(dog.mapId,near(),999,()=>true);
 expect(dog.state.phase).toBe('walk');
 dog.greetNearby(dog.mapId,near(),1000,()=>true);
 expect(dog.state.phase).toBe('bark');
 expect(dog.greetingUntil).toBe(3500);
 const position=near(); dog.update(1); dog.update(1);
 expect(dog.state.phase).toBe('walk');
 expect(dog.state.position).not.toEqual(position);
 dog.greetNearby(dog.mapId,near(),100000,()=>true);
 dog.greetNearby(dog.mapId,near(),101000,()=>true);
 expect(dog.greetingUntil).toBe(3500);
 dog.greetNearby('other-map',near(),102000,()=>true);
 dog.greetNearby(dog.mapId,near(),103000,()=>true);
 dog.greetNearby(dog.mapId,near(),104000,()=>true);
 expect(dog.greetingUntil).toBe(106500);
 dog.update(1);dog.update(1);
 dog.greetNearby('other-map',near(),105000,()=>true);
 dog.greetNearby(dog.mapId,near(),106000,()=>true);
 dog.greetNearby(dog.mapId,near(),107000,()=>true);
 expect(dog.greetingUntil).toBe(106500);
});
it('cancels interrupted dwell and never interrupts rest',()=>{
 const dog=createDogWorld(data,()=>0);
 dog.greetNearby(dog.mapId,dog.state.position,0,()=>true);
 dog.pauseGreeting();
 dog.greetNearby(dog.mapId,dog.state.position,2000,()=>true);
 expect(dog.greetingUntil).toBe(0);
 for(let i=0;i<4000&&dog.state.phase!=='rest';i++)dog.update(.5);
 expect(dog.state.phase).toBe('rest');
 dog.greetNearby(dog.mapId,dog.state.position,3000,()=>true);
 dog.greetNearby(dog.mapId,dog.state.position,5000,()=>true);
 expect(dog.state.phase).toBe('rest');
 expect(dog.greetingUntil).toBe(0);
});
it('uses visible navigable resting sites on all six maps',()=>{
 for(const id of DOG_MAPS)for(const p of DOG_MAP_STOPS[id]){
  expect(isAnimalPositionNavigable(p,data[id].navigation),`${id} ${JSON.stringify(p)}`).toBe(true);
  expect(isPetRestVisible(p,data[id].occluders),`${id} ${JSON.stringify(p)}`).toBe(true);
 }
});
it('visits all six maps and rests without crossing collision geometry',()=>{
 const dog=createDogWorld(data,()=>0);
 const maps=new Set<string>(),rests=new Set<string>();
 for(let i=0;i<36000;i++){
  const previousMap=dog.mapId, previousPosition={...dog.state.position};
  dog.update(.5);maps.add(dog.mapId);
  if(previousMap!==dog.mapId){
    const exit=data[previousMap].navigation.exits.find(e=>e.targetMapId===dog.mapId)!;
    expect(pointInPolygon(previousPosition,exit.trigger.points)).toBe(true);
    const spawn=data[dog.mapId].navigation.spawnPoints.find(p=>p.id===exit.targetSpawnId)!;
    expect(dog.state.position).toEqual(spawn.position);
  }
  expect(dog.error).toBeNull();
  expect(isAnimalPositionNavigable(dog.state.position,data[dog.mapId].navigation),`${dog.mapId} ${JSON.stringify(dog.state.position)}`).toBe(true);
  if(dog.state.phase==='rest')rests.add(dog.mapId);
  if(maps.size===6&&rests.size===6)break;
 }
 expect([...maps].sort()).toEqual([...DOG_MAPS].sort());
 expect([...rests].sort()).toEqual([...DOG_MAPS].sort());
},60000);
it('starts a real market excursion and preserves its state while the player changes views',()=>{
 const dog=createDogWorld(data,()=>0);
 for(let i=0;i<10000&&dog.mapId==='welcome-courtyard';i++)dog.update(.5);
 expect(dog.mapId).toBe('artisan-market');
 expect(dog.transitions[dog.transitions.length - 1]).toMatchObject({from:'welcome-courtyard',to:'artisan-market'});
 const position={...dog.state.position};
 // Scene reads do not advance or reset the simulation.
 for(let i=0;i<20;i++){void dog.state;void dog.mapId;}
 expect(dog.state.position).toEqual(position);
 for(let i=0;i<60;i++)dog.update(.5);
 expect(dog.mapId).toBe('artisan-market');
 expect(dog.error).toBeNull();
});
it.each([0, 0.9])('completes the courtyard circuit before either excursion (%s)', random=>{
 const dog=createDogWorld(data,()=>random);
 const visited=new Set<string>();
 for(let i=0;i<10000&&dog.mapId==='welcome-courtyard';i++){
  const p=dog.state.position;
  if(Math.hypot(p.x-1690,p.y-900)<20)visited.add('east');
  if(Math.hypot(p.x-1060,p.y-1060)<20)visited.add('south');
  if(Math.hypot(p.x-450,p.y-780)<20)visited.add('west');
  if(visited.size===3&&Math.hypot(p.x-1185,p.y-684)<20)visited.add('return');
  dog.update(.5);
  expect(dog.error).toBeNull();
 }
 expect(visited).toEqual(new Set(['east','south','west','return']));
 expect(dog.mapId).toBe(random===0?'artisan-market':'lantern-canal-street');
});
