// SPDX-License-Identifier: Elastic-2.0
import { COURTYARD_ANIMALS, isAnimalPositionNavigable } from './courtyard-animals';
import { createPetMotion } from './pet-motion';
import { findClickPath } from './click-path';
import { isPetRestVisible } from './pet-rest-visibility';
import { DOG_MAPS, DOG_MAP_STOPS, DOG_CORRIDORS, type DogMap } from './dog-world-routes';
import type { PikoNavigation, PikoOccluder } from './map-package-schema';
import type { PikoPoint } from './navigation-geometry';
const GREETING = { radius: 120, leaveRadius: 180, dwellMs: 1000, cooldownMs: 90000, bubbleMs: 2500 } as const;
export type DogWorldData = Record<DogMap, { navigation: PikoNavigation; occluders: PikoOccluder[] }>;
const placement = COURTYARD_ANIMALS.find(p => p.kind === 'dog')!;

export function planDogPath(start: PikoPoint, guides: readonly PikoPoint[], navigation: PikoNavigation) {
  const route: PikoPoint[] = [];
  let anchor = start;
  for (const target of guides) {
    if (Math.hypot(target.x-anchor.x,target.y-anchor.y)<1) continue;
    const path = findClickPath(anchor, target, navigation);
    if (!path.length) throw new Error(`Unreachable dog waypoint in ${navigation.mapId}: ${target.x},${target.y}`);
    route.push(...path); anchor = target;
  }
  return route;
}
/** One simulation for the entire visit. Renderers never own or advance this clock. */
export function createDogWorld(data: DogWorldData, random: () => number = Math.random) {
  let mapId: DogMap = 'welcome-courtyard';
  let itinerary: DogMap[] = [];
  let destination: DogMap | undefined;
  let failure: string | null = null;
  const transitions: { from: DogMap; to: DogMap; position: PikoPoint }[] = [];
  let retry = 0;
  let greetingUntil = 0, cooldownUntil = 0, nearbySince: number | null = null, armed = true;
  let nextWest = random() < .5;
  let motion = createPetMotion({ ...placement, route: [placement.position] }, random, () => true);
  function chooseTrip() {
    // Alternate west/east trips, with a courtyard return and rest between them.
    itinerary = nextWest
      ? ['artisan-market','wind-garden-gate','whispering-meadow','wind-garden-gate','artisan-market','welcome-courtyard']
      : ['lantern-canal-street','starlight-dock','lantern-canal-street','welcome-courtyard'];
    nextWest = !nextWest;
  }
  function begin(start: PikoPoint, home = false) {
    destination = home ? undefined : itinerary.shift();
    const { navigation, occluders } = data[mapId];
    let guides: PikoPoint[];
    if (home) guides = [ {x:1500,y:640},{x:1650,y:730},{x:1690,y:900},{x:1650,y:1050},{x:1060,y:1060},{x:700,y:1060},{x:450,y:1035},{x:450,y:780},{x:420,y:550},{x:680,y:490},{x:800,y:640},{x:1185,y:684} ];
    else {
      const corridor = [...DOG_CORRIDORS[mapId]];
      const westward = destination ? DOG_MAPS.indexOf(destination) < DOG_MAPS.indexOf(mapId) : false;
      // End maps walk out to both rest spots before returning to their sole connecting exit.
      if (mapId === 'whispering-meadow') guides = [...corridor].reverse().concat(corridor.slice(1));
      else if (mapId === 'starlight-dock') guides = corridor.concat([...corridor].reverse().slice(1));
      else {
        if (westward) corridor.reverse();
        // Start at the nearest corridor node, then follow the scenic corridor to the exit.
        let nearest=0;
        corridor.forEach((p,i)=>{if(Math.hypot(p.x-start.x,p.y-start.y)<Math.hypot(corridor[nearest].x-start.x,corridor[nearest].y-start.y))nearest=i;});
        guides = corridor.slice(nearest);
      }
      if (destination) {
        const exit = navigation.exits.find(e => e.targetMapId === destination);
        if (!exit) throw new Error(`Missing dog exit: ${mapId} → ${destination}`);
        const points = exit.trigger.points;
        guides.push({x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length});
      }
    }
    const route = planDogPath(start, guides, navigation);
    motion = createPetMotion({ ...placement, position:start, route:route.length ? route : [start] },random,
      p=>isAnimalPositionNavigable(p,navigation),p=>isPetRestVisible(p,occluders),
      { once:true, restStops:DOG_MAP_STOPS[mapId],restSeconds:mapId==='whispering-meadow'||home?[90,140]:[60,90] });
  }
  // Complete the courtyard circuit before consuming the first cross-map destination.
  chooseTrip(); begin(placement.position, true);
  return {
    get mapId() { return mapId; },
    get state() { return motion.state; },
    get error() { return failure; },
    get greetingUntil() { return greetingUntil; },
    pauseGreeting() { nearbySince = null; },
    greetNearby(viewMap: string, player: PikoPoint, now: number, ready: () => boolean) {
      const distance = viewMap === mapId ? Math.hypot(player.x-motion.state.position.x, player.y-motion.state.position.y) : Infinity;
      if (distance > GREETING.leaveRadius) { armed = true; nearbySince = null; return; }
      if (distance > GREETING.radius || !armed || now < cooldownUntil || motion.state.phase !== 'walk' || failure
        || !isPetRestVisible(motion.state.position, data[mapId].occluders)) { nearbySince = null; return; }
      nearbySince ??= now;
      if (now-nearbySince < GREETING.dwellMs || !ready() || !motion.greet()) return;
      armed = false; nearbySince = null;
      cooldownUntil = now + GREETING.cooldownMs; greetingUntil = now + GREETING.bubbleMs;
    },
    get transitions() { return transitions.map(t => ({...t,position:{...t.position}})); },
    update(delta: number) {
      if (failure) return;
      const before = motion.state.position;
      motion.update(delta);
      if (motion.state.phase==='walk' && before===motion.state.position) retry+=delta; else retry=0;
      // A changed collider stops movement; do not skip a blocked edge or teleport.
      if (retry>5) { failure=`Dog route blocked in ${mapId}`; return; }
      if (motion.state.phase!=='done') return;
      try {
        if (destination) {
          const exit=data[mapId].navigation.exits.find(e=>e.targetMapId===destination)!;
          const spawn=data[destination].navigation.spawnPoints.find(p=>p.id===exit.targetSpawnId);
          if (!spawn) throw new Error('Missing dog arrival');
          transitions.push({from:mapId,to:destination,position:{...motion.state.position}});
          if(transitions.length>20)transitions.shift();
          mapId=destination;
          if (mapId==='welcome-courtyard' && !itinerary.length) { chooseTrip();begin(spawn.position,true); }
          else begin(spawn.position);
        } else begin(motion.state.position);
      } catch (error) { failure=String(error); }
    },
  };
}
