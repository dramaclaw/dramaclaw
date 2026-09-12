// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Texture, TextureSource, Ticker } from "pixi.js";
import {
  AERIAL_BODY_Z_INDEX,
  AERIAL_LANES,
  AERIAL_LANE_DEPTH,
  AERIAL_SHADOW_Z_INDEX,
  aerialCycleState,
  BIRD_ROUTES,
  birdAtlasFrames,
  CLOUD_ROUTES,
  COURTYARD_BIRD_ATLAS_SRC,
  COURTYARD_CLOUD_SRC,
  createBirdEvent,
  createCloudEvent,
  createCourtyardAerialRuntime,
  createLaneShuffle,
  MAX_BIRD_COUNT,
  MAX_CLOUD_COUNT,
} from "./courtyard-aerial-runtime";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps each aerial transit bounded and fades only at its edges", () => {
  expect(aerialCycleState(0, 10, 30)).toEqual({ visible: true, progress: 0, fade: 0 });
  expect(aerialCycleState(5, 10, 30)).toEqual({ visible: true, progress: 0.5, fade: 1 });
  expect(aerialCycleState(10, 10, 30)).toEqual({ visible: false, progress: 1, fade: 0 });
  expect(aerialCycleState(35, 10, 30).progress).toBe(0.5);
});

it("reads the four registered square bird frames", () => {
  const atlas = new Texture({ source: new TextureSource({ width: 2048, height: 512 }) });
  const frames = birdAtlasFrames(atlas);
  expect(frames.map(texture => texture.frame.x)).toEqual([0, 512, 1024, 1536]);
  expect(frames.every(texture => texture.width === 512 && texture.height === 512)).toBe(true);
  frames.forEach(texture => texture.destroy(false));
  atlas.destroy(true);
});

it("keeps the aerial source assets in their registered RGBA dimensions", () => {
  const readPngContract = (src: string) => {
    const png = readFileSync(`public/piko/world/maps/welcome-courtyard/${src}`);
    return [png.readUInt32BE(16), png.readUInt32BE(20), png[25]];
  };
  expect(readPngContract(COURTYARD_BIRD_ATLAS_SRC)).toEqual([2048, 512, 6]);
  expect(readPngContract(COURTYARD_CLOUD_SRC)).toEqual([1856, 528, 6]);
});

it("shuffles every aerial lane before repeating and avoids boundary duplicates", () => {
  const next = createLaneShuffle(() => 0, "middle");
  const lanes = Array.from({ length: 6 }, next);
  expect(new Set(lanes.slice(0, 3))).toEqual(new Set(AERIAL_LANES));
  expect(new Set(lanes.slice(3, 6))).toEqual(new Set(AERIAL_LANES));
  expect(lanes[2]).not.toBe(lanes[3]);
});

it("separates upper and lower routes with perspective-scaled depth", () => {
  expect(BIRD_ROUTES.upper.to.y).toBeLessThan(300);
  expect(CLOUD_ROUTES.upper.to.y).toBeLessThan(300);
  expect(BIRD_ROUTES.lower.from.y).toBeGreaterThanOrEqual(750);
  expect(BIRD_ROUTES.lower.to.y).toBeGreaterThanOrEqual(1000);
  expect(CLOUD_ROUTES.lower.from.y).toBeGreaterThanOrEqual(700);
  expect(CLOUD_ROUTES.lower.to.y).toBeGreaterThanOrEqual(900);
  expect(AERIAL_LANE_DEPTH.upper.scale).toBeLessThan(AERIAL_LANE_DEPTH.middle.scale);
  expect(AERIAL_LANE_DEPTH.middle.scale).toBeLessThan(AERIAL_LANE_DEPTH.lower.scale);
  expect(AERIAL_LANE_DEPTH.upper.duration).toBeGreaterThan(AERIAL_LANE_DEPTH.lower.duration);
});

it("bounds the randomized distant flock and cloud-group presets", () => {
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    const birds = createBirdEvent("upper", random);
    expect(birds.count).toBeGreaterThanOrEqual(2);
    expect(birds.count).toBeLessThanOrEqual(4);
    expect(birds.birds.every(item => item.scale >= 0.086 && item.scale <= 0.13)).toBe(true);
    const clouds = createCloudEvent("lower", random);
    expect(clouds.count).toBeGreaterThanOrEqual(1);
    expect(clouds.count).toBeLessThanOrEqual(3);
    expect(clouds.clouds.every(item => item.width >= 320 && item.width <= 520)).toBe(true);
    expect(clouds.clouds.every(item => item.shadowAlpha < item.alpha)).toBe(true);
  }
});

it("pairs visible bodies with projected shadows and pauses for reduced motion", async () => {
  let reduced = false, change = () => {};
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, fn: () => void) => { change = fn; }, removeEventListener: remove }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const birdAtlas = new Texture({ source: new TextureSource({ width: 2048, height: 512 }) });
  const cloudTexture = new Texture({ source: new TextureSource({ width: 1856, height: 528 }) });
  const load = vi.spyOn((await import("pixi.js")).Assets, "load")
    .mockResolvedValueOnce(birdAtlas as never).mockResolvedValueOnce(cloudTexture as never);
  const unload = vi.spyOn((await import("pixi.js")).Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker(); ticker.autoStart = false;
  const runtime = await createCourtyardAerialRuntime({ ticker, resolveAssetUrl: src => `/map/${src}`,
    isDisposed: () => false, random: () => 0 });
  expect(runtime).not.toBeNull();
  expect(runtime!.objects.map(object => object.zIndex)).toEqual([AERIAL_SHADOW_Z_INDEX, AERIAL_BODY_Z_INDEX]);
  expect(runtime!.birds).toHaveLength(MAX_BIRD_COUNT);
  expect(runtime!.birdShadows).toHaveLength(MAX_BIRD_COUNT);
  expect(runtime!.birds.filter(sprite => sprite.visible)).toHaveLength(2);
  expect(runtime!.clouds).toHaveLength(MAX_CLOUD_COUNT);
  expect(runtime!.cloudShadows).toHaveLength(MAX_CLOUD_COUNT);
  ticker.update(1000); ticker.update(1100);
  expect(runtime!.clouds[0].alpha).toBeGreaterThan(0);
  expect(runtime!.cloudShadows[0].alpha).toBeLessThan(runtime!.clouds[0].alpha);
  expect(Math.abs(runtime!.clouds[0].width)).toBe(320);
  expect(ticker.count).toBe(1);
  reduced = true; change();
  expect(ticker.count).toBe(0);
  expect(runtime!.bodyLayer.visible).toBe(false);
  reduced = false; change();
  expect(ticker.count).toBe(1);
  runtime!.destroy();
  expect(ticker.count).toBe(0);
  expect(remove).toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(2));
  ticker.destroy();
});

it("releases both aerial assets when the bird atlas is malformed", async () => {
  const { Assets } = await import("pixi.js");
  const malformed = new Texture({ source: new TextureSource({ width: 100, height: 100 }) });
  const cloud = new Texture({ source: new TextureSource({ width: 1856, height: 528 }) });
  vi.spyOn(Assets, "load").mockResolvedValueOnce(malformed as never).mockResolvedValueOnce(cloud as never);
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker();
  await expect(createCourtyardAerialRuntime({ ticker, resolveAssetUrl: src => src,
    isDisposed: () => false })).rejects.toThrow("four square horizontal frames");
  await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(2));
  expect(ticker.count).toBe(0);
  ticker.destroy(); malformed.destroy(true); cloud.destroy(true);
});

it("releases partial aerial loads and treats a cancelled map load as cancellation", async () => {
  const { Assets } = await import("pixi.js");
  const cloud = new Texture({ source: new TextureSource({ width: 1856, height: 528 }) });
  const load = vi.spyOn(Assets, "load");
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker();
  for (const disposed of [false, true]) {
    load.mockRejectedValueOnce(new Error("missing birds")).mockResolvedValueOnce(cloud as never);
    const result = createCourtyardAerialRuntime({ ticker, resolveAssetUrl: src => src, isDisposed: () => disposed });
    if (disposed) expect(await result).toBeNull();
    else await expect(result).rejects.toThrow("missing birds");
  }
  await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(2));
  expect(ticker.count).toBe(0);
  ticker.destroy(); cloud.destroy(true);
});
