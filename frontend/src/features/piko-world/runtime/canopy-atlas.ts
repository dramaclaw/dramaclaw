// SPDX-License-Identifier: Elastic-2.0
import { Texture } from "pixi.js";
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";

export const CANOPY_PLACEMENT = { x: 1381, y: 245, width: 280, height: 212 };
export const CANOPY_FRAME_COUNT = 8;
// Correct generated sheet registration, keeping the rightward excursion below ~2 map pixels.
export const CANOPY_REGISTRATION = [
  { x: 0, y: 0 }, { x: -3, y: 0 }, { x: -8, y: 0 }, { x: -4, y: 0 },
  { x: 2, y: 3 }, { x: 2, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 },
] as const;

/** Exclude the chroma matte before creating transparent runtime frames. */
export function canopyPixelVisible(pixels: ArrayLike<number>, offset: number) {
  const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
  return pixels[offset + 3] >= 128 && !(r > g && b > g);
}

export function canopyFrameGeometry(pixels: ArrayLike<number>, trunk: PikoPoint[], offset: PikoPoint = { x: 0, y: 0 }) {
  const { x: left, y: top, width, height } = CANOPY_PLACEMENT;
  const runs: number[][] = [], leftEdge: PikoPoint[] = [], rightEdge: PikoPoint[] = [];
  const bottom = Math.ceil(Math.max(...trunk.map(point => point.y)));
  for (let y = 0; y < Math.max(height, bottom - top); y++) {
    let run = -1, first = width, last = -1;
    for (let x = 0; x <= width; x++) {
      const sampleX = x - offset.x, sampleY = y - offset.y;
      const crown = x < width && sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height
        && canopyPixelVisible(pixels, (sampleY * width + sampleX) * 4);
      if (crown && run < 0) run = x;
      if (!crown && run >= 0) { runs.push([left + run, top + y, x - run]); run = -1; }
      if (x < width && (crown || pointInPolygon({ x: left + x + 0.5, y: top + y + 0.5 }, trunk))) {
        first = Math.min(first, x); last = x;
      }
    }
    if (last >= 0) {
      leftEdge.push({ x: left + first, y: top + y }, { x: left + first, y: top + y + 1 });
      rightEdge.push({ x: left + last + 1, y: top + y }, { x: left + last + 1, y: top + y + 1 });
    }
  }
  const contour = [...leftEdge, ...rightEdge.reverse()];
  // Remove collinear scanline points while retaining one-pixel silhouette steps.
  const outline = contour.filter((point, index) => {
    const previous = contour[(index + contour.length - 1) % contour.length];
    const next = contour[(index + 1) % contour.length];
    return (point.x - previous.x) * (next.y - point.y) !== (point.y - previous.y) * (next.x - point.x);
  });
  return { runs, outline };
}

/** Decode once into map-resolution RGBA frames: rendering and geometry share exact pixels. */
export function readCanopyAtlas(atlas: Texture, trunk: PikoPoint[]) {
  const textures: Texture[] = [], canvases: HTMLCanvasElement[] = [];
  try {
    return Array.from({ length: CANOPY_FRAME_COUNT }, (_, index) => {
      const canvas = document.createElement("canvas");
      canvases.push(canvas);
      canvas.width = CANOPY_PLACEMENT.width; canvas.height = CANOPY_PLACEMENT.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Cannot read tree canopy atlas");
      context.imageSmoothingEnabled = false;
      context.drawImage(atlas.source.resource as CanvasImageSource,
        index % 4 * atlas.width / 4, Math.floor(index / 4) * atlas.height / 2,
        atlas.width / 4, atlas.height / 2, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let offset = 0; offset < image.data.length; offset += 4) {
        if (!canopyPixelVisible(image.data, offset)) image.data.fill(0, offset, offset + 4);
      }
      context.putImageData(image, 0, 0);
      const geometry = canopyFrameGeometry(image.data, trunk, CANOPY_REGISTRATION[index]);
      const texture = Texture.from(canvas);
      textures.push(texture);
      texture.source.scaleMode = "nearest";
      return { ...geometry, texture };
    });
  } catch (error) {
    textures.forEach(texture => texture.destroy(true));
    canvases.forEach(canvas => { canvas.width = canvas.height = 0; });
    throw error;
  }
}
