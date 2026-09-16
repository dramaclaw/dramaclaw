// SPDX-License-Identifier: Elastic-2.0
import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { MAP_EXIT_MARKERS } from "../piko-map-connections";
import { PIKO_MAP_TRANSITIONS, type PikoMapId } from "../piko-map-transitions";
import { PikoMapPackageSchema } from "./map-package-schema";
import { canStand } from "./character-movement";
import { clearWalkSegment, findClickPath } from "./click-path";
import { pointInPolygon } from "./navigation-geometry";
import { createExitGate, enabledMapExits, prepareMapTravel } from "./map-travel";

const read = (map: string, file: string) => JSON.parse(readFileSync(`public/piko/world/maps/${map}/${file}`, "utf8"));
const maps = Object.keys(MAP_EXIT_MARKERS) as PikoMapId[];
const previewMaps = maps.filter(map => map !== "welcome-courtyard");
const packages = new Map(maps.map(map => [map, PikoMapPackageSchema.parse({
  manifest: read(map, "manifest.json"), navigation: read(map, "data/navigation.json"),
  occlusion: read(map, "data/occlusion.json"), environment: read(map, "data/environment.json"),
  interactions: read(map, "data/interactions.json"),
})]));
const centres: Partial<Record<PikoMapId, { x: number; y: number }>> = {
  "welcome-courtyard": { x: 1190, y: 485 }, "artisan-market": { x: 1130, y: 650 },
  "wind-garden-gate": { x: 1180, y: 725 }, "lantern-canal-street": { x: 1070, y: 540 },
  "starlight-dock": { x: 900, y: 550 },
  "whispering-meadow": { x: 1080, y: 625 }, "whispering-forest": { x: 990, y: 515 },
  "cloudtop-slope": { x: 1000, y: 600 }, "frostmoon-tundra": { x: 1050, y: 750 },
  "amber-wilds": { x: 1100, y: 510 }, "crimson-canyon": { x: 1030, y: 625 },
  "starfall-tidal-wetland": { x: 1100, y: 210 }, "startrace-coast": { x: 920, y: 405 },
  "changfeng-sea": { x: 1100, y: 650 }, "boundless-sea": { x: 1100, y: 650 }, "whalesong-skyport": { x: 1040, y: 580 },
};
afterEach(() => vi.unstubAllGlobals());

for (const map of maps) {
  it(`${map}: every arrival can reach every open exit and the central path`, () => {
    const { navigation, manifest, occlusion } = packages.get(map)!;
    const markers = MAP_EXIT_MARKERS[map]!;
    expect(enabledMapExits(navigation)).toHaveLength(markers.length);
    expect(new Set(markers.map(marker => marker.exitId)).size).toBe(markers.length);
    for (const src of [manifest.baseTexture.src, ...Object.values(manifest.data), ...occlusion.occluders.map(item => item.src)]) {
      expect(existsSync(`public/piko/world/maps/${map}/${src}`), src).toBe(true);
    }
    for (const marker of markers) {
      expect(canStand(marker.position, navigation), `${map} ${marker.exitId} marker`).toBe(true);
      const exit = navigation.exits.find(exit => exit.id === marker.exitId)!;
      expect(pointInPolygon(marker.position, exit.trigger.points)).toBe(true);
      const destination = packages.get(marker.targetMapId)!;
      const arrival = destination.navigation.spawnPoints.find(spawn => spawn.id === exit.targetSpawnId)!;
      expect(arrival, `${map} target spawn`).toBeDefined();
      expect(canStand(arrival.position, destination.navigation), `${map} target safe`).toBe(true);
      expect(destination.navigation.exits.some(exit => pointInPolygon(arrival.position, exit.trigger.points))).toBe(false);
      for (const target of [...MAP_EXIT_MARKERS[marker.targetMapId]!.map(marker => marker.position), centres[marker.targetMapId]!]) {
        const path = findClickPath(arrival.position, target, destination.navigation);
        expect(path.length, `${map} → ${marker.targetMapId}: ${JSON.stringify(target)}`).toBeGreaterThan(0);
        let previous = arrival.position;
        for (const step of path) {
          expect(clearWalkSegment(previous, step, destination.navigation)).toBe(true);
          previous = step;
        }
      }
    }
  });
}

it("prepares all thirty-two directions with the correct source fallback in maps with multiple exits", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => {
    const [, map, file] = url.match(/\/maps\/([^/]+)\/(.*)/)!;
    return read(map, file);
  } })));
  let directions = 0;
  for (const map of maps) for (const exit of enabledMapExits(packages.get(map)!.navigation)) {
    const result = await prepareMapTravel(map, exit, new AbortController().signal);
    expect(result.destination).toEqual({ mapId: exit.targetMapId, spawnId: exit.targetSpawnId });
    expect(result.fallback.mapId).toBe(map);
    const back = enabledMapExits(packages.get(exit.targetMapId as PikoMapId)!.navigation).find(exit => exit.targetMapId === map)!;
    expect(result.fallback.spawnId).toBe(back.targetSpawnId);
    expect(canStand(packages.get(map)!.navigation.spawnPoints.find(spawn => spawn.id === result.fallback.spawnId)!.position,
      packages.get(map)!.navigation)).toBe(true);
    directions++;
  }
  expect(directions).toBe(32);
});

it("arms each courtyard exit independently", () => {
  const navigation = packages.get("welcome-courtyard")!.navigation;
  const gate = createExitGate(enabledMapExits(navigation));
  for (const marker of MAP_EXIT_MARKERS["welcome-courtyard"]!) {
    expect(gate(marker.position, false)).toBeUndefined();
    expect(gate(marker.position, true)?.id).toBe(marker.exitId);
    expect(gate(marker.position, true)).toBeUndefined();
    gate(centres["welcome-courtyard"]!, true);
    expect(gate(marker.position, true)?.id).toBe(marker.exitId);
  }
});

it("allows pure-map previews without stale collision or occlusion regions", () => {
  for (const map of previewMaps) {
    const { navigation, occlusion, manifest } = packages.get(map)!;
    expect(navigation.colliders).toEqual([]);
    expect(occlusion.occluders).toEqual([]);
    for (const point of [{ x: 10, y: 10 }, { x: manifest.size.width - 10, y: manifest.size.height - 10 },
      { x: manifest.size.width / 2, y: manifest.size.height / 2 }]) {
      expect(canStand(point, navigation), map).toBe(true);
    }
  }
});

it("connects all sixteen regions to the courtyard and closes the southern loop", () => {
  expect([...maps].sort()).toEqual(Object.keys(PIKO_MAP_TRANSITIONS).sort());
  const seen = new Set<PikoMapId>();
  const visit = (map: PikoMapId) => {
    if (seen.has(map)) return;
    seen.add(map);
    MAP_EXIT_MARKERS[map]!.forEach(exit => visit(exit.targetMapId));
  };
  visit("welcome-courtyard");
  expect(seen.size).toBe(16);
  const loop: PikoMapId[] = ["welcome-courtyard", "amber-wilds", "crimson-canyon", "startrace-coast",
    "starfall-tidal-wetland", "starlight-dock", "lantern-canal-street", "welcome-courtyard"];
  loop.slice(0, -1).forEach((map, index) => {
    expect(MAP_EXIT_MARKERS[map]!.some(exit => exit.targetMapId === loop[index + 1])).toBe(true);
  });
});
