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
