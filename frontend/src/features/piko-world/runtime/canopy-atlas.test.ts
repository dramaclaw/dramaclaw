// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { CANOPY_PLACEMENT, canopyFrameGeometry, canopyPixelVisible, readCanopyAtlas } from "./canopy-atlas";
import { Texture, TextureSource } from "pixi.js";
import { pointInPolygon } from "./navigation-geometry";

it("excludes the matte and its pink fringe while retaining dark and sunlit foliage", () => {
  for (const color of [[255, 0, 255, 255], [150, 65, 145, 255], [76, 65, 79, 255], [10, 80, 20, 0]]) {
    expect(canopyPixelVisible(color, 0)).toBe(false);
  }
  for (const color of [[20, 48, 36, 255], [190, 200, 45, 255]]) expect(canopyPixelVisible(color, 0)).toBe(true);
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
