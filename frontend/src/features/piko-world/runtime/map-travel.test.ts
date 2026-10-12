// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it, vi, afterEach } from "vitest";
import { PikoNavigationSchema, PikoOcclusionSchema } from "./map-package-schema";
import { canStand } from "./character-movement";
import { findClickPath } from "./click-path";
import { canActivateTransport, createExitGate, enabledMapExits, prepareMapTravel } from "./map-travel";
import { pointInPolygon } from "./navigation-geometry";
import { MAP_EXIT_MARKERS } from "../piko-map-connections";

const read = (map: string, file: string) => JSON.parse(readFileSync(`public/piko/world/maps/${map}/${file}`, "utf8"));
const courtyard = PikoNavigationSchema.parse(read("welcome-courtyard", "data/navigation.json"));
const market = PikoNavigationSchema.parse(read("artisan-market", "data/navigation.json"));
afterEach(() => vi.unstubAllGlobals());
it("keeps both arrivals outside triggers, with walkable routes to their exits and map centres", () => {
  for (const [navigation, centre] of [[courtyard, {x:1190,y:485}], [market, {x:1130,y:650}]] as const) {
    const exit = enabledMapExits(navigation)[0];
    const marker = MAP_EXIT_MARKERS[navigation.mapId as keyof typeof MAP_EXIT_MARKERS]![0];
    const arrival = navigation.spawnPoints.find(p => p.id === (navigation === market ? "welcome-courtyard-arrival" : "artisan-market-arrival"))!;
    expect(canStand(arrival.position, navigation), `${navigation.mapId} arrival`).toBe(true);
    expect(canStand(marker.position, navigation), `${navigation.mapId} marker`).toBe(true);
    expect(pointInPolygon(arrival.position, exit.trigger.points)).toBe(false);
    expect(pointInPolygon(marker.position, exit.trigger.points)).toBe(true);
    expect(findClickPath(arrival.position, marker.position, navigation).length, `${navigation.mapId} exit route`).toBeGreaterThan(0);
    expect(findClickPath(arrival.position, centre, navigation).length, `${navigation.mapId} centre route`).toBeGreaterThan(0);
    PikoOcclusionSchema.parse(read(navigation.mapId, "data/occlusion.json"));
  }
});
it("does not repeat a request while standing in a trigger or while blocked", () => {
  const exit = enabledMapExits(courtyard)[0];
  const gate = createExitGate([exit]);
  expect(gate({x:65,y:270}, false)).toBeUndefined();
  expect(gate({x:65,y:270}, true)).toBe(exit);
  expect(gate({x:65,y:270}, true)).toBeUndefined();
  gate({x:190,y:275}, true);
  expect(gate({x:65,y:270}, true)).toBe(exit);
});
it("prepares reciprocal arrivals and rejects an unfinished connection", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => {
    const [, map, file] = url.match(/\/maps\/([^/]+)\/(.*)/)!;
    return read(map, file);
  } })));
  const prepared = await prepareMapTravel("welcome-courtyard", enabledMapExits(courtyard)[0], new AbortController().signal);
  expect(prepared.destination).toEqual({mapId:"artisan-market",spawnId:"welcome-courtyard-arrival"});
  expect(prepared.fallback).toEqual({mapId:"welcome-courtyard",spawnId:"artisan-market-arrival"});
  const reverse = await prepareMapTravel("artisan-market", enabledMapExits(market)[0], new AbortController().signal);
  expect(reverse.destination).toEqual(prepared.fallback);
  expect(reverse.fallback).toEqual(prepared.destination);
  await expect(prepareMapTravel("welcome-courtyard", { ...courtyard.exits[0], targetMapId: "boundless-sea" }, new AbortController().signal)).rejects.toThrow("not open");
});

it("requires deliberate nearby activation for sea, sky and hall transfers", () => {
  let actions = 0;
  for (const [map, markers] of Object.entries(MAP_EXIT_MARKERS)) {
    const navigation = PikoNavigationSchema.parse(read(map, "data/navigation.json"));
    const gate = createExitGate(enabledMapExits(navigation));
    for (const marker of markers.filter(marker => marker.action)) {
      actions++;
      expect(gate(marker.position, true)).toBeUndefined();
      expect(canActivateTransport(marker, marker.position, false)).toBe(false);
      expect(canActivateTransport(marker, { x: marker.position.x + 141, y: marker.position.y }, true)).toBe(false);
      expect(canActivateTransport(marker, marker.position, true)).toBe(true);
    }
  }
  expect(actions).toBe(5);
});
it("rejects a missing target spawn without switching maps", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => {
    const [, map, file] = url.match(/\/maps\/([^/]+)\/(.*)/)!;
    const data = read(map, file);
    if (file.endsWith("navigation.json")) data.spawnPoints = [];
    return data;
  } })));
  await expect(prepareMapTravel("welcome-courtyard", enabledMapExits(courtyard)[0], new AbortController().signal)).rejects.toThrow("safe arrival");
});
