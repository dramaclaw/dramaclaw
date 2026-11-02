// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { PikoPoint } from "./navigation-geometry";

export type FoliagePlacement = { x: number; y: number; width: number; height: number };

/** Build a raster difference mask when foreground foliage must remain untouched. */
export function createFoliageMask(placement: FoliagePlacement, outline: readonly PikoPoint[],
  exclusions: readonly (readonly PikoPoint[])[] = []) {
  if (!exclusions.length) {
    return { mask: new Graphics({ eventMode: "none" })
      .poly(outline.flatMap(point => [point.x, point.y])).fill(0xffffff), release() {} };
  }
  const canvas = document.createElement("canvas");
  canvas.width = placement.width;
  canvas.height = placement.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot create exclusive foliage mask");
  const draw = (points: readonly PikoPoint[]) => {
    context.beginPath();
    points.forEach((point, index) => {
      const x = point.x - placement.x, y = point.y - placement.y;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
    context.fill();
  };
  context.fillStyle = "white";
  draw(outline);
  context.globalCompositeOperation = "destination-out";
  exclusions.forEach(draw);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = "nearest";
  const mask = new Sprite(texture);
  mask.position.set(placement.x, placement.y);
  mask.width = placement.width;
  mask.height = placement.height;
  return { mask, release() {
    texture.destroy(true);
    canvas.width = canvas.height = 0;
  } };
}

/** Place a clean map patch beneath animated foliage and clip it to the baked silhouette. */
export function createFoliageCleanBackground(texture: Texture, placement: FoliagePlacement,
  outline: readonly PikoPoint[], label: string, exclusions: readonly (readonly PikoPoint[])[] = []) {
  const container = new Container({ label, eventMode: "none", zIndex: -2 });
  const plate = new Sprite(texture);
  plate.position.set(placement.x, placement.y);
  plate.width = placement.width;
  plate.height = placement.height;
  const maskResource = createFoliageMask(placement, outline, exclusions);
  const { mask } = maskResource;
  plate.mask = mask;
  container.addChild(plate, mask);
  return { container, plate, mask, destroy() {
    plate.mask = null;
    container.destroy({ children: true });
    maskResource.release();
  } };
}
