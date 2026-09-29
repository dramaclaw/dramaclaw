// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { Texture, TextureSource, type Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { PIKO_TOWN_NPCS, townNpcIdleSrc, townNpcsForMap } from "../piko-town-npcs";
import { canStand } from "./character-movement";
import { findClickPath } from "./click-path";
import { isResidentHeadOccluded } from "./map-occlusion";
import { PikoNavigationSchema, PikoOcclusionSchema } from "./map-package-schema";
import { RESIDENT_WORLD_SCALE } from "./resident-actor";
import { createTownNpcActor } from "./town-npc-actor";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(PIKO_TOWN_NPCS)("renders $residentId in front of a reachable doorway", npc => {
  const read = (name: string) => JSON.parse(readFileSync(`public/piko/world/maps/${npc.mapId}/data/${name}.json`, "utf8"));
  const nav = PikoNavigationSchema.parse(read("navigation"));
  const occlusion = PikoOcclusionSchema.parse(read("occlusion"));
  expect(canStand(npc.position, nav)).toBe(true);
  expect(isResidentHeadOccluded(npc.position, occlusion, RESIDENT_WORLD_SCALE * (npc.scale ?? 1))).toBe(false);
  for (const spawn of nav.spawnPoints) {
    const path = findClickPath(spawn.position, npc.position, nav);
    expect(path[path.length - 1], spawn.id).toEqual(npc.position);
  }
  const png = readFileSync(`public${townNpcIdleSrc(npc)}`);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([768, 256]);
});

it("moves the courtyard resident to the market without duplicates", () => {
  expect(townNpcsForMap("welcome-courtyard")).toEqual([]);
  expect(PIKO_TOWN_NPCS.filter(npc => npc.residentId === "f01")).toHaveLength(1);
});

it("samples HD frames directly and resets for reduced motion without destroying the shared atlas", () => {
  const motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => motion);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn() } as never);
  const shadow = new Texture({ source: new TextureSource({ width: 24, height: 8 }) });
  vi.spyOn(Texture, "from").mockReturnValue(shadow);
  const sheet = new Texture({ source: new TextureSource({ width: 768, height: 256 }) });
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const actor = createTownNpcActor(sheet, ticker as unknown as Ticker, () => true, PIKO_TOWN_NPCS[0]);
  const tick = ticker.add.mock.calls[0][0];
  expect(actor.body.texture.frame.width).toBe(256);
  expect(actor.body.texture.orig.width).toBe(64);
  expect(sheet.source.scaleMode).toBe("linear");
  tick({ deltaMS: 1850 });
  expect(actor.body.texture.frame.x).toBe(512);
  motion.matches = true;
  tick({ deltaMS: 100 });
  expect(actor.body.texture.frame.x).toBe(0);
  actor.destroy();
  expect(ticker.remove).toHaveBeenCalledWith(tick);
  expect(sheet.source.destroyed).toBe(false);
  sheet.destroy(true);
});
