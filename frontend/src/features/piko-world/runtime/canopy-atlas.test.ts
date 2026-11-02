// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CANOPY_ATLAS_COLUMNS,
  CANOPY_ATLAS_ROWS,
  CANOPY_ATLAS_SRC,
  CANOPY_FRAME_COUNT,
  CANOPY_PLACEMENT,
  CANOPY_REGISTRATION,
  canopyFrameGeometry,
  canopyPixelVisible,
  readCanopyAtlas,
} from "./canopy-atlas";
import { Texture, TextureSource } from "pixi.js";
import { pointInPolygon } from "./navigation-geometry";

it("keeps the v5 atlas contract internally consistent", () => {
  expect(CANOPY_ATLAS_SRC).toBe("effects/east-tree-canopy-atlas-v5.png");
  const png = readFileSync(`public/piko/world/maps/welcome-courtyard/${CANOPY_ATLAS_SRC}`);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1983);
  expect(png.readUInt32BE(20)).toBe(793);
  expect(png[25]).toBe(6); // PNG color type 6: RGBA.
  expect(CANOPY_FRAME_COUNT).toBe(CANOPY_ATLAS_COLUMNS * CANOPY_ATLAS_ROWS);
  expect(CANOPY_REGISTRATION).toHaveLength(CANOPY_FRAME_COUNT);
});

it("derives the occlusion silhouette exclusively from authored alpha", () => {
  expect(canopyPixelVisible([255, 0, 255, 255], 0)).toBe(true);
  expect(canopyPixelVisible([20, 48, 36, 128], 0)).toBe(true);
  expect(canopyPixelVisible([190, 200, 45, 127], 0)).toBe(false);
  expect(canopyPixelVisible([10, 80, 20, 0], 0)).toBe(false);
});
it("builds frame masks and an occlusion contour from foliage plus fixed trunk", () => {
  const { x, y, width, height } = CANOPY_PLACEMENT;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 10; row < 100; row++) for (let col = 20; col < 150; col++) {
    pixels.set([40, 100, 50, 255], (row * width + col) * 4);
  }
  const trunk = [{ x: x + 70, y: y + 90 }, { x: x + 100, y: y + 90 },
    { x: x + 100, y: y + 250 }, { x: x + 70, y: y + 250 }];
  const geometry = canopyFrameGeometry(pixels, trunk);
  expect(geometry.runs).toHaveLength(90);
  expect(pointInPolygon({ x: x + 40, y: y + 40 }, geometry.outline)).toBe(true);
  expect(pointInPolygon({ x: x + 80, y: y + 220 }, geometry.outline)).toBe(true);
  expect(pointInPolygon({ x: x + 5, y: y + 40 }, geometry.outline)).toBe(false);
  expect(pointInPolygon({ x: x + 40, y: y + 220 }, geometry.outline)).toBe(false);
});


afterEach(() => vi.restoreAllMocks());
it("releases earlier frame textures and all canvases if decoding fails midway", () => {
  const canvases: HTMLCanvasElement[] = [], textures: Texture[] = [];
  const originalCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const element = originalCreate(tag);
    if (tag === "canvas") canvases.push(element as HTMLCanvasElement);
    return element;
  }) as typeof document.createElement);
  let reads = 0;
  const context = { drawImage() {}, putImageData() {}, getImageData() {
    if (++reads === 2) throw new Error("decode failed");
    return { data: new Uint8ClampedArray(280 * 212 * 4) };
  } };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(Texture, "from").mockImplementation(() => {
    const texture = new Texture({ source: new TextureSource({ width: 280, height: 212 }) });
    textures.push(texture); return texture;
  });
  const atlas = new Texture({ source: new TextureSource({ width: 1983, height: 793 }) });
  expect(() => readCanopyAtlas(atlas, [{ x: 1500, y: 405 }, { x: 1540, y: 405 }, { x: 1520, y: 500 }])).toThrow("decode failed");
  expect(textures).toHaveLength(1);
  expect(textures[0].destroyed).toBe(true);
  expect(canvases).toHaveLength(2);
  expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  expect(atlas.source.destroyed).toBe(false);
  atlas.destroy(true);
});
