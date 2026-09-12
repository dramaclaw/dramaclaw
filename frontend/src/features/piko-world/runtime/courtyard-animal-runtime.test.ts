// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Texture, TextureSource, Ticker } from "pixi.js";
import { animalAtlasFrames, createCourtyardAnimalRuntime } from "./courtyard-animal-runtime";
import { ANIMAL_SHEETS } from "./courtyard-animals";
import { PikoNavigationSchema } from "./map-package-schema";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const navigation = PikoNavigationSchema.parse(JSON.parse(readFileSync(
  "public/piko/world/maps/welcome-courtyard/data/navigation.json", "utf8")));
const options = (ticker: Ticker) => ({ ticker, navigation, bakedOccluders: [], size: { width: 2048, height: 1152 },
  resolveAssetUrl: (src: string) => `/map/${src}`, isDisposed: () => false, random: () => 0.5 });
const atlas = () => new Texture({ source: new TextureSource({ width: 2048, height: 2048 }) });

it("uses shared original sheet pixels in top-left, top-right, bottom-left, bottom-right order", () => {
  const sheet = atlas();
  const frames = animalAtlasFrames(sheet);
  expect(frames.map(frame => [frame.frame.x, frame.frame.y])).toEqual([[0, 0], [1024, 0], [0, 1024], [1024, 1024]]);
  expect(frames.every(frame => frame.source === sheet.source)).toBe(true);
  frames.forEach(frame => frame.destroy(false));
  expect(sheet.source.destroyed).toBe(false);
  sheet.destroy(true);
});

it("shares ten sheets and a heart across nineteen depth-sorted animals and pauses all animation when hidden or reduced", async () => {
  let reduced = false, change = () => {};
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, listener: () => void) => { change = listener; }, removeEventListener: remove }));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const sheets = Array.from({ length: 11 }, atlas);
  let index = 0;
  const load = vi.spyOn(Assets, "load").mockImplementation(async () => sheets[index++] as never);
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker(); ticker.autoStart = false;
  const runtime = (await createCourtyardAnimalRuntime(options(ticker)))!;
  expect(load).toHaveBeenCalledTimes(11);
  expect(runtime.actors).toHaveLength(19);
  expect(ticker.count).toBe(1);
  const cat = runtime.actors.find(actor => actor.placement.kind === "cat")!;
  cat.motion.state.frame = 0; cat.render();
  expect(cat.heart?.visible).toBe(true);
  expect(cat.heart?.width).toBeCloseTo(22.032);
  cat.motion.state.frame = 2; cat.render();
  expect(cat.heart?.visible).toBe(false);
  const dog = runtime.actors.find(actor => actor.container.label === "fountain-path-dog")!;
  const start = dog.container.x;
  for (let time = 100; time <= 15000; time += 100) ticker.update(time);
  expect(dog.container.x).not.toBe(start);
  runtime.actors.forEach(actor => {
    expect(actor.container.zIndex).toBe(actor.container.y);
    const { clip, frame } = actor.motion.state;
    expect(actor.body.anchor.x).toBe(ANIMAL_SHEETS[clip].anchors[frame][0] / 1024);
  });
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(0);
  const frozen = dog.container.x;
  ticker.update(20000);
  expect(dog.container.x).toBe(frozen);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(1);
  reduced = true; change();
  expect(ticker.count).toBe(0);
  expect(runtime.actors.every(actor => actor.container.visible)).toBe(true);
  reduced = false; change();
  expect(ticker.count).toBe(1);
  runtime.destroy(); runtime.destroy();
  expect(ticker.count).toBe(0);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(unload).toHaveBeenCalledTimes(11);
  expect(runtime.objects.every(object => object.destroyed)).toBe(true);
  ticker.destroy();
  sheets.forEach(sheet => sheet.destroy(true));
});

it("releases successfully loaded sheets when another sheet fails or the map unmounts while loading", async () => {
  const sheet = atlas();
  const load = vi.spyOn(Assets, "load").mockResolvedValue(sheet as never);
  load.mockRejectedValueOnce(new Error("missing animal sheet"));
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker(); ticker.autoStart = false;
  await expect(createCourtyardAnimalRuntime(options(ticker))).rejects.toThrow("missing animal sheet");
  expect(unload).toHaveBeenCalledTimes(10);
  unload.mockClear();
  expect(await createCourtyardAnimalRuntime({ ...options(ticker), isDisposed: () => true })).toBeNull();
  expect(unload).toHaveBeenCalledTimes(11);
  expect(ticker.count).toBe(0);
  ticker.destroy(); sheet.destroy(true);
});

it("rejects malformed layouts and releases the source assets before attaching a ticker", async () => {
  const sheet = new Texture({ source: new TextureSource({ width: 1024, height: 2048 }) });
  vi.spyOn(Assets, "load").mockResolvedValue(sheet as never);
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker(); ticker.autoStart = false;
  await expect(createCourtyardAnimalRuntime(options(ticker))).rejects.toThrow("four 1024-square cells");
  expect(unload).toHaveBeenCalledTimes(11);
  expect(ticker.count).toBe(0);
  ticker.destroy(); sheet.destroy(true);
});
