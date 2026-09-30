// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Sprite, Texture, TextureSource } from "pixi.js";
import { PikoMapPackageSchema } from "./map-package-schema";
import { canStand } from "./character-movement";
import { clearWalkSegment, findClickPath } from "./click-path";
import { pikoSeatAction } from "./seat-actions";
import { TOWN_HALL_NOTICES } from "./town-hall-interactions";
import { createTownHallAmbience } from "./town-hall-ambience";
import { mapPerspectiveScale } from "./map-perspective";
import { createExitGate, enabledMapExits } from "./map-travel";
import { MAP_EXIT_MARKERS } from "../piko-map-connections";
import { navigationIssues } from "./navigation-editor";
import { TOWN_HALL_BUTTERFLIES, createAnimalMotion } from "./courtyard-animals";
import { pointInPolygon } from "./navigation-geometry";
const read = (name: string, map = "town-hall-interior") => JSON.parse(readFileSync(`public/piko/world/maps/${map}/${name}`, "utf8"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps the full butterfly flight envelopes clear of furniture masks", () => {
  const { occluders } = PikoMapPackageSchema.shape.occlusion.parse(read("data/occlusion.json"));
  for (const placement of TOWN_HALL_BUTTERFLIES) {
    const motion = createAnimalMotion(placement, () => 0.5);
    for (let step = 0; step < 1800; step++) {
      motion.update(0.1);
      const { position, lift } = motion.state;
      // Include a conservative full 24px wing envelope, not just its centre.
      for (const dx of [-12, 0, 12]) for (const dy of [-12, 0, 12]) {
        expect(occluders.some(o => position.y < o.depthY && pointInPolygon({
          x: position.x + dx - o.position.x, y: position.y - lift + dy - o.position.y,
        }, o.outline!))).toBe(false);
      }
    }
  }
});
it("keeps every hall interaction reachable and both seat exits outside furniture", () => {
  const pack = PikoMapPackageSchema.parse({ manifest: read("manifest.json"), navigation: read("data/navigation.json"),
    interactions: read("data/interactions.json"), occlusion: read("data/occlusion.json"), environment: read("data/environment.json") });
  const nav = pack.navigation, start = nav.spawnPoints[0].position;
  expect(navigationIssues(nav)).toEqual([]);
  expect(navigationIssues({ ...nav, walkableAreas: pack.occlusion.occluders.map(item => ({
    id: item.id, points: item.outline!.map(point => ({ x: point.x + item.position.x, y: point.y + item.position.y })),
  })), colliders: [] })).toEqual([]);
  const targets = Object.values(TOWN_HALL_NOTICES).map(item => item.approach);
  for (const item of pack.interactions.interactions.filter(item => item.kind === "seat")) {
    const seat = pikoSeatAction(item.actionId)!;
    expect(seat).toBeDefined(); expect(canStand(seat.approach, nav)).toBe(true);
    expect(canStand(seat.seat, nav)).toBe(false);
    targets.push(seat.approach);
    const foot = seat.seat.y + 22 * (82 / 48 * 1.15) * 1.05 * mapPerspectiveScale(nav.mapId, seat.seat.y);
    expect(foot).toBeLessThan(seat.approach.y);
    expect(seat.depthY).toBeGreaterThanOrEqual(761);
  }
  for (const target of targets) for (const [a,b] of [[start,target],[target,start]]) {
    expect(canStand(b,nav)).toBe(true); const path=findClickPath(a,b,nav); expect(path.length).toBeGreaterThan(0);
    let previous=a; for(const step of path){expect(clearWalkSegment(previous,step,nav)).toBe(true);previous=step;}
  }
  expect(canStand({x:1200,y:375},nav)).toBe(false);
  expect(canStand({x:400,y:1070},nav)).toBe(false);
});
it("requires a deliberate hall entry rather than triggering beside the mayor", () => {
  const nav=read("data/navigation.json","welcome-courtyard");
  const marker=MAP_EXIT_MARKERS["welcome-courtyard"].find(item=>item.targetMapId==='town-hall-interior')!;
  expect(marker.action).toBe('enterHall');
  expect(createExitGate(enabledMapExits(nav))(marker.position,true)).toBeUndefined();
});
it("pauses indoor effects while hidden or reduced and removes all ticker work on disposal", () => {
  let reduced=false, change=()=>{};
  const remove=vi.fn();
  vi.stubGlobal('matchMedia',()=>({get matches(){return reduced;},addEventListener:(_:string,cb:()=>void)=>{change=cb;},removeEventListener:remove}));
  vi.spyOn(document,'hasFocus').mockReturnValue(true);
  const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
  const ticker={add:vi.fn(),remove:vi.fn()};
  const clean=new Texture({source:new TextureSource({width:1672,height:941})});
  const atlas=new Texture({source:new TextureSource({width:2172,height:724})});
  const runtime=createTownHallAmbience(ticker as never,clean,atlas);
  expect(ticker.add).toHaveBeenCalledTimes(1);
  const fire = runtime.container.getChildByLabel("hearth-fire", true) as Sprite;
  const firstFrame = fire.texture;
  const tick = ticker.add.mock.calls[0][0];
  for (let i = 0; i < 4; i++) tick({ deltaMS: 100 });
  expect(fire.texture).not.toBe(firstFrame);
  expect(fire.alpha).toBe(1);
  expect(fire.parent!.children.filter(child => child.label === "hearth-fire")).toHaveLength(1);
  hidden.mockReturnValue(true);document.dispatchEvent(new Event('visibilitychange'));
  expect(ticker.remove).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);document.dispatchEvent(new Event('visibilitychange'));
  expect(ticker.add).toHaveBeenCalledTimes(2);
  reduced=true;change();expect(ticker.remove).toHaveBeenCalledTimes(2);
  expect(fire.texture).toBe(firstFrame); expect(fire.alpha).toBe(1);
  reduced=false;change();expect(ticker.add).toHaveBeenCalledTimes(3);
  runtime.destroy();runtime.destroy();expect(ticker.remove).toHaveBeenCalledTimes(3);expect(remove).toHaveBeenCalledOnce();
  clean.destroy(true);atlas.destroy(true);
});
