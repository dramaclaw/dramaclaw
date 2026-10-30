// SPDX-License-Identifier: Elastic-2.0
import { createDogWorld, type DogWorldData } from './dog-world';
import { DOG_MAPS } from './dog-world-routes';
import { loadPikoMapNavigation, loadPikoMapOcclusion } from './map-package-loader';
let session: ReturnType<typeof createSession> | undefined;
function createSession() {
  const abort=new AbortController();
  let dog: ReturnType<typeof createDogWorld> | undefined;
  const ready=Promise.all(DOG_MAPS.map(async id=> {
    const [navigation,occlusion]=await Promise.all([
      loadPikoMapNavigation(id,'data/navigation.json',abort.signal),
      loadPikoMapOcclusion(id,'data/occlusion.json',abort.signal),
    ]);
    return [id,{navigation,occluders:occlusion.occluders}] as const;
  })).then(entries=>{
    if(abort.signal.aborted)throw new Error('Dog session disposed');
    dog=createDogWorld(Object.fromEntries(entries) as DogWorldData);
    return dog;
  });
  // Canvas awaits and reports load errors; avoid unhandled rejections during navigation/unmount.
  void ready.catch(()=>{});
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  let previous=performance.now();
  const timer=window.setInterval(()=>{
    const now=performance.now(),delta=Math.min((now-previous)/1000,.25);previous=now;
    if(!document.hidden&&!media.matches)dog?.update(delta);
  },50);
  return {ready,destroy(){abort.abort();window.clearInterval(timer);}};
}
export function getWorldDog() { session ??= createSession(); return session.ready; }
/** Called once by the shell, not by individual map renderers. */
export function retainDogWorldSession() {
  session ??= createSession();const current=session;
  return ()=>{if(session===current){current.destroy();session=undefined;}};
}
