// SPDX-License-Identifier: Elastic-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sprite, Texture, TextureSource, type Ticker } from "pixi.js";
import environment from "../../../../public/piko/world/maps/welcome-courtyard/data/environment.json";
import canalEnvironment from "../../../../public/piko/world/maps/lantern-canal-street/data/environment.json";
import { createMapRiverFish, LANTERN_CANAL_FISH } from "./map-river-fish";
import { createRiverFishMotion } from "./river-fish-motion";
import { pointInPolygon } from "./navigation-geometry";
const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./shared-texture", () => ({ acquireSharedTexture: mocks.acquire }));
const regions = environment.effects.filter(effect => effect.id.startsWith("river-water-")).map(effect => ({ id: effect.id, points: effect.region.points }));
const canalRegions = canalEnvironment.effects.filter(effect => effect.layer === "water").map(effect => ({ id: effect.id, points: effect.region.points }));
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each([17, 42, 123, 2026])("keeps random routes safe and moving (seed %s)", (initialSeed) => {
  let seed = initialSeed;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const motion = createRiverFishMotion(regions, random);
  const travel = [0, 0, 0, 0];
  for (let step = 0; step < 12000; step++) {
    const before = motion.fish.map(fish => ({ ...fish }));
    motion.step(0.05);
    motion.fish.forEach((fish, index) => {
      expect(regions.some(region => pointInPolygon(fish, region.points))).toBe(true);
      const distance = Math.hypot(fish.x - before[index].x, fish.y - before[index].y);
      expect(distance).toBeLessThanOrEqual(1.501);
      expect(Math.abs(fish.heading - before[index].heading)).toBeLessThanOrEqual(0.121);
      travel[index] += distance;
      motion.fish.slice(index + 1).forEach(other => expect(Math.hypot(fish.x - other.x, fish.y - other.y)).toBeGreaterThanOrEqual(27.999));
    });
  }
  // Fish may rest at a target, but each one must continue to tour the river.
  travel.forEach(distance => expect(distance / 600).toBeGreaterThan(5));
});

it.each([42, 2026])("keeps canal fish in their assigned water and moving (seed %s)", (initialSeed) => {
  let seed = initialSeed;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const motion = createRiverFishMotion(canalRegions, random, LANTERN_CANAL_FISH.map(item => item.route));
  expect(motion.fish).toHaveLength(7);
  expect(LANTERN_CANAL_FISH.map(item => item.route.surfaceId)).toEqual([canalRegions[0].id, canalRegions[0].id, canalRegions[1].id, canalRegions[1].id, canalRegions[1].id, canalRegions[2].id, canalRegions[2].id]);
  expect(LANTERN_CANAL_FISH.filter(item => item.species === 1)).toHaveLength(1);
  const travel = motion.fish.map(() => 0);
  for (let step = 0; step < 4800; step++) {
    const before = motion.fish.map(actor => ({ x: actor.x, y: actor.y }));
    motion.step(0.05);
    motion.fish.forEach((actor, index) => {
      expect(pointInPolygon(actor, canalRegions.find(region => region.id === LANTERN_CANAL_FISH[index].route.surfaceId)!.points)).toBe(true);
      const distance = Math.hypot(actor.x - before[index].x, actor.y - before[index].y);
      expect(distance).toBeLessThanOrEqual(1.501);
      travel[index] += distance;
      motion.fish.slice(index + 1).forEach(other =>
        expect(Math.hypot(actor.x - other.x, actor.y - other.y)).toBeGreaterThanOrEqual(27.999));
    });
  }
  travel.forEach(distance => expect(distance / 240).toBeGreaterThan(4));
});

it("shares the two fish atlases across seven canal fish and releases all three water masks", async () => {
  const atlas = new Texture({ source: new TextureSource({ width: 2172, height: 724 }) });
  const release = vi.fn(); mocks.acquire.mockResolvedValue({ texture: atlas, release });
  const water = new Sprite(Texture.WHITE);
  const runtime = await createMapRiverFish({ ticker: { add: vi.fn(), remove: vi.fn() } as unknown as Ticker,
    surfaces: canalRegions.map(region => ({ ...region, sprite: water })),
    placements: LANTERN_CANAL_FISH, resolveAssetUrl: src => src, isDisposed: () => false });
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect(runtime!.objects).toHaveLength(5);
  expect(runtime!.objects[0].children).toHaveLength(10);
  runtime!.destroy();
  expect(release).toHaveBeenCalledTimes(2);
  water.destroy(); atlas.destroy(true);
});

it("keeps fish routes unchanged when water effects are reordered", () => {
  const routes = LANTERN_CANAL_FISH.map(item => item.route);
  const forward = createRiverFishMotion(canalRegions, () => 0.37, routes);
  const reversed = createRiverFishMotion([...canalRegions].reverse(), () => 0.37, routes);
  for (let step = 0; step < 400; step++) {
    forward.step(0.05);
    reversed.step(0.05);
  }
  expect(reversed.fish).toEqual(forward.fish);
  expect(() => createRiverFishMotion(canalRegions.slice(1), () => 0.37, routes))
    .toThrow("Missing river fish surface: canal-upper-river-water");
});
it("shares two atlases, layers water above fish, and releases resources", async () => {
  const atlas = new Texture({ source: new TextureSource({ width: 2172, height: 724 }) });
  const release = vi.fn(); mocks.acquire.mockResolvedValue({ texture: atlas, release });
  const water = new Sprite(Texture.WHITE);
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const runtime = await createMapRiverFish({ ticker: ticker as unknown as Ticker,
    surfaces: regions.map(region => ({ ...region, sprite: water })), resolveAssetUrl: src => src, isDisposed: () => false });
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  const container = runtime!.objects[0];
  expect(container.children).toHaveLength(7); expect(container.mask).toBeTruthy();
  ticker.add.mock.calls[0][0]({ deltaMS: 16 });
  runtime!.destroy(); runtime!.destroy();
  expect(release).toHaveBeenCalledTimes(2); expect(ticker.remove).toHaveBeenCalledWith(ticker.add.mock.calls[0][0]);
  expect(atlas.destroyed).toBe(false);
  water.destroy(); atlas.destroy(true);
});
it("releases a late texture after the map has been left", async () => {
  const atlas = new Texture({ source: new TextureSource({ width: 2172, height: 724 }) });
  const release = vi.fn(); mocks.acquire.mockResolvedValue({ texture: atlas, release });
  const water = new Sprite(Texture.WHITE);
  const runtime = await createMapRiverFish({ ticker: { remove: vi.fn() } as unknown as Ticker,
    surfaces: [{ ...regions[0], sprite: water }], resolveAssetUrl: src => src, isDisposed: () => true });
  expect(runtime).toBeNull(); expect(release).toHaveBeenCalledOnce(); expect(mocks.acquire).toHaveBeenCalledOnce();
  water.destroy(); atlas.destroy(true);
});

it("backs off after unsuccessful target searches instead of retrying every frame", () => {
  const random = vi.fn(() => 0.5);
  const motion = createRiverFishMotion([], random);
  motion.step(0.05);
  const calls = random.mock.calls.length;
  for (let index = 0; index < 10; index++) motion.step(0.05);
  expect(random).toHaveBeenCalledTimes(calls);
  const positions = motion.fish.map(fish => ({ x: fish.x, y: fish.y }));
  motion.step(NaN); motion.step(Infinity); motion.step(-1);
  expect(motion.fish.map(fish => ({ x: fish.x, y: fish.y }))).toEqual(positions);
});

it("searches for its next route immediately after resting instead of waiting out the old route timer", () => {
  const random = vi.fn(() => 0.2);
  const motion = createRiverFishMotion(regions, random);
  const fish = motion.fish[0];
  fish.hasTarget = true; fish.target = { x: fish.x, y: fish.y }; fish.retargetIn = 9;
  motion.step(0.05);
  expect(fish.restFor).toBeGreaterThan(0);
  const position = { x: fish.x, y: fish.y };
  while (fish.restFor > 0) motion.step(0.05);
  expect({ x: fish.x, y: fish.y }).toEqual(position);
  // Isolate its search from the other actors' random choices.
  motion.fish.slice(1).forEach(other => { other.restFor = 10; });
  random.mockClear();
  motion.step(0.05);
  expect(random).toHaveBeenCalled();
});

it("detaches animation callbacks while hidden or reduced motion is enabled", async () => {
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const atlas = new Texture({ source: new TextureSource({ width: 2172, height: 724 }) });
  mocks.acquire.mockResolvedValue({ texture: atlas, release: vi.fn() });
  const water = new Sprite(Texture.WHITE);
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const runtime = await createMapRiverFish({ ticker: ticker as unknown as Ticker,
    surfaces: regions.map(region => ({ ...region, sprite: water })), resolveAssetUrl: src => src, isDisposed: () => false });
  const tick = ticker.add.mock.calls[0][0];
  hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.remove).toHaveBeenCalledWith(tick);
  hidden.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.add).toHaveBeenCalledTimes(2);
  media.matches = true; media.addEventListener.mock.calls[0][1]();
  expect(ticker.remove).toHaveBeenCalledTimes(2);
  runtime!.destroy();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", media.addEventListener.mock.calls[0][1]);
  hidden.mockRestore(); water.destroy(); atlas.destroy(true);
});
