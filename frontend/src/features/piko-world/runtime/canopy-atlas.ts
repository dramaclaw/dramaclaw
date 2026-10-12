// SPDX-License-Identifier: Elastic-2.0
import { Texture } from "pixi.js";
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";

export const CANOPY_PLACEMENT = { x: 1381, y: 245, width: 280, height: 212 };
export const CANOPY_ATLAS_SRC = "effects/east-tree-canopy-atlas-v5.png";
export const CANOPY_ATLAS_COLUMNS = 4;
export const CANOPY_ATLAS_ROWS = 2;
export const CANOPY_FRAME_COUNT = CANOPY_ATLAS_COLUMNS * CANOPY_ATLAS_ROWS;
// Keep the authored lower crown fixed while preserving the breeze at the outer leaf clusters.
export const CANOPY_REGISTRATION = [
  { x: 0, y: 0 }, { x: -8, y: 0 }, { x: -8, y: -1 }, { x: -4, y: 0 },
  { x: -2, y: 8 }, { x: -3, y: 7 }, { x: -3, y: 7 }, { x: -1, y: 6 },
] as const;

/** Use the authored alpha channel for the runtime occlusion silhouette. */
export function canopyPixelVisible(pixels: ArrayLike<number>, offset: number) {
  return pixels[offset + 3] >= 128;
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
        index % CANOPY_ATLAS_COLUMNS * atlas.width / CANOPY_ATLAS_COLUMNS,
        Math.floor(index / CANOPY_ATLAS_COLUMNS) * atlas.height / CANOPY_ATLAS_ROWS,
        atlas.width / CANOPY_ATLAS_COLUMNS, atlas.height / CANOPY_ATLAS_ROWS,
        0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
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
