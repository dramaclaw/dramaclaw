// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { alphaSilhouetteRuns, createResidentOcclusionSilhouette } from "./resident-occlusion-silhouette";

afterEach(() => vi.restoreAllMocks());

it("fills adjacent opaque pixels as one silhouette run", () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  expect(alphaSilhouetteRuns(pixels, 2, 1)).toEqual([[0, 0, 2]]);
});

it("ignores transparent padding and preserves holes between limbs", () => {
  const pixels = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < 9; i++) pixels[i * 4 + 3] = i === 4 ? 0 : 255;
  expect(alphaSilhouetteRuns(pixels, 3, 3)).toEqual([[0, 0, 3], [0, 1, 1], [2, 1, 1], [0, 2, 3]]);
  expect(alphaSilhouetteRuns(new Uint8ClampedArray(16), 2, 2)).toEqual([]);
});

it.each([1, 4])("clips a %ix texture in logical coordinates and reuses its cached silhouette", (resolution) => {
  const readPixels = vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }));
  const context = {
    drawImage: vi.fn(), getImageData: readPixels,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  const actor = new Container();
  actor.position.set(11, 20);
  const texture = new Texture({ source: Texture.WHITE.source, frame: new Rectangle(0, 0, resolution, resolution), orig: new Rectangle(0, 0, 1, 1) });
  const body = new Sprite(texture);
  const locator = createResidentOcclusionSilhouette(actor, body, [{
    id: "wall", src: "wall.png", depthY: 15, position: { x: 10, y: 10 },
    outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
  }]);
  expect(locator.container.visible).toBe(false);
  expect(readPixels).not.toHaveBeenCalled();
  const shape = locator.container.children[0] as Graphics;
  const emptyContext = shape.context;
  actor.y = 11;
  locator.update();
  expect(locator.container.visible).toBe(true);
  expect(locator.mask.containsPoint({ x: 11, y: 11 })).toBe(true);
  expect(locator.mask.containsPoint({ x: 9, y: 11 })).toBe(false);
  const cachedContext = shape.context;
  actor.y = 20;
  locator.update();
  expect(locator.container.visible).toBe(false);
  actor.y = 11;
  locator.update();
  expect(locator.container.visible).toBe(true);
  expect(shape.context).toBe(cachedContext);
  expect(readPixels).toHaveBeenCalledTimes(1);
  expect(readPixels).toHaveBeenCalledWith(0, 0, 1, 1);
  expect(context.drawImage).toHaveBeenCalledWith(Texture.WHITE.source.resource, 0, 0, resolution, resolution, 0, 0, 1, 1);
  locator.destroy();
  expect(emptyContext.destroyed).toBe(true);
  expect(cachedContext.destroyed).toBe(true);
  expect(locator.mask.destroyed).toBe(true);
  expect(Texture.WHITE.source.destroyed).toBe(false);
  body.destroy();
  texture.destroy(false);
  actor.destroy();
});

it("updates a moving canopy mask even while the player stands still", () => {
  const context = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  const actor = new Container(); actor.position.set(11, 11);
  const texture = new Texture({ source: Texture.WHITE.source, frame: new Rectangle(0, 0, 1, 1) });
  const body = new Sprite(texture);
  const tree = { id: "tree", src: "base.png", depthY: 15, position: { x: 10, y: 10 },
    outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }] };
  let depth = actor.y;
  const locator = createResidentOcclusionSilhouette(actor, body, [tree], new Set(["tree"]), () => depth);
  expect(locator.mask.containsPoint({ x: 14, y: 11 })).toBe(true);
  tree.outline = tree.outline.map(p => ({ x: p.x - 2, y: p.y }));
  locator.update();
  expect(locator.container.visible).toBe(true);
  expect(locator.mask.containsPoint({ x: 14, y: 11 })).toBe(false);
  expect(locator.mask.containsPoint({ x: 9, y: 11 })).toBe(true);
  // Hips can be behind the tree's depth boundary while seated feet are in front.
  depth = 20;
  locator.update();
  expect(locator.container.visible).toBe(false);
  depth = actor.y;
  locator.update();
  expect(locator.container.visible).toBe(true);
  locator.destroy(); body.destroy(); texture.destroy(false); actor.destroy();
});
