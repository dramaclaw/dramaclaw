// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { Ticker, Texture, TextureSource } from "pixi.js";
import { clipTreeOutline, createTreeCanopyBreeze, TREE_CANOPY_FPS } from "./tree-canopy-breeze";
import { pointInPolygon } from "./navigation-geometry";
import occlusion from "../../../../public/piko/world/maps/welcome-courtyard/data/occlusion.json";

vi.mock("./canopy-atlas", async importOriginal => {
  const actual = await importOriginal<typeof import("./canopy-atlas")>();
  return { ...actual, readCanopyAtlas: () => Array.from({ length: 8 }, (_, i) => ({
    texture: new Texture({ source: new TextureSource({ width: 280, height: 212,
      resource: document.createElement("canvas") }) }),
    runs: [[1390 + i, 260, 250]],
    outline: [{ x: 1390 + i, y: 260 }, { x: 1640 + i, y: 260 }, { x: 1530, y: 500 }, { x: 1490, y: 500 }],
  })) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const definition = () => structuredClone(occlusion.occluders.find(item => item.id === "east-canopy-tree")!);
it("splits the original tree without losing or adding pixels at rest", () => {
  const tree = definition();
  const points = tree.outline.map(p => ({ x: p.x + tree.position.x, y: p.y + tree.position.y }));
  const upper = clipTreeOutline(points, true), lower = clipTreeOutline(points, false);
  // Preserve branch attachment behind the new crown, not only the bare trunk below 435.
  for (const point of [{ x: 1515, y: 412 }, { x: 1530, y: 427 }, { x: 1520, y: 440 }]) {
    expect(pointInPolygon(point, lower)).toBe(true);
  }
  for (let y = 250.5; y < 505; y += 2) for (let x = 1380.5; x < 1650; x += 2) {
    const point = { x, y };
    expect(pointInPolygon(point, upper) || pointInPolygon(point, lower)).toBe(pointInPolygon(point, points));
  }
});
it("plays matching frame masks and outlines, pauses particles and releases resources", () => {
  let reduced = false;
  let change = () => {};
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, fn: () => void) => { change = fn; }, removeEventListener: remove }));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const source = new TextureSource({ width: 2048, height: 1152 });
  const texture = new Texture({ source });
  const plateSource = new TextureSource({ width: 1672, height: 941 });
  const plate = new Texture({ source: plateSource });
  const atlasSource = new TextureSource({ width: 1327, height: 1185 });
  const atlas = new Texture({ source: atlasSource });
  const ticker = new Ticker(); ticker.autoStart = false;
  const tree = definition(), original = structuredClone(tree.outline);
  const effect = createTreeCanopyBreeze(texture, plate, atlas, tree, ticker, { width: 2048, height: 1152 });
  expect(effect.background.zIndex).toBeLessThan(0);
  expect(effect.container.zIndex).toBe(500);
  expect(effect.canopy.alpha).toBe(1);
  const firstTexture = effect.canopy.texture;
  const played = new Set([firstTexture]);
  const firstOutline = tree.outline;
  const firstMask = effect.canopy.mask;
  const initialX = effect.canopy.x, initialY = effect.canopy.y;
  expect(firstTexture.source).not.toBe(atlasSource);
  const decodedSource = firstTexture.source;
  for (let time = 100; time <= 500; time += 100) ticker.update(time);
  expect(effect.canopy.texture).toBe(firstTexture);
  for (let time = 600; time <= 2200; time += 100) ticker.update(time);
  expect(effect.canopy.texture).not.toBe(firstTexture);
  expect(Math.abs(effect.canopy.x - initialX)).toBeLessThanOrEqual(8);
  expect(Math.abs(effect.canopy.y - initialY)).toBeLessThanOrEqual(3);
  expect(effect.canopy.skew.x).toBe(0); expect(effect.canopy.rotation).toBe(0);
  expect(tree.outline).not.toBe(firstOutline);
  expect(effect.canopy.mask).toBe(firstMask);
  expect(effect.canopy.height).toBe(212);
  // Exactly one full authored sequence returns to frame zero.
  played.add(effect.canopy.texture);
  for (let time = 2300; time <= 8200; time += 100) {
    ticker.update(time); played.add(effect.canopy.texture);
  }
  expect(played.size).toBe(7);
  expect(effect.canopy.texture).toBe(firstTexture);
  expect(TREE_CANOPY_FPS).toBe(7 / 8);
  expect(tree.outline).toBe(firstOutline);
  expect(effect.trunk.position.x).toBe(0); expect(effect.trunk.position.y).toBe(0);
  reduced = true; change();
  expect(ticker.count).toBe(0); expect(effect.container.visible).toBe(true);
  expect(tree.outline).toBe(firstOutline);
  expect(effect.leaves.children).toHaveLength(0);
  expect(effect.canopy.texture).toBe(firstTexture);
  reduced = false; change();
  hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(0);
  hidden.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(1);
  effect.destroy(); expect(ticker.count).toBe(0); expect(remove).toHaveBeenCalled();
  expect(tree.outline).toEqual(original);
  expect(source.destroyed).toBe(false); expect(plateSource.destroyed).toBe(false);
  expect(atlasSource.destroyed).toBe(false);
  expect(firstTexture.destroyed).toBe(true);
  expect(decodedSource.destroyed).toBe(true);
  ticker.destroy(); texture.destroy(true); plate.destroy(true); atlas.destroy(true);
});
