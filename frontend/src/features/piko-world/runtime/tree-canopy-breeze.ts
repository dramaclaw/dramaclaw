// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, GraphicsContext, Sprite, type Texture, type Ticker } from "pixi.js";
import type { PikoOccluder } from "./map-package-schema";
import type { PikoPoint } from "./navigation-geometry";
import { CANOPY_PLACEMENT, CANOPY_REGISTRATION, readCanopyAtlas } from "./canopy-atlas";
import { createFallingLeaves } from "./falling-leaves";

// Retain the original branch junction and lower foliage beneath the moving crown.
// Cutting at 435 removed this overlap and exposed the clean plate between crown and trunk.
export const TREE_CANOPY_ANCHOR_Y = 405;

/** Split the original outline without changing its union at rest. */
export function clipTreeOutline(points: PikoPoint[], upper: boolean, boundary = TREE_CANOPY_ANCHOR_Y) {
  const result: PikoPoint[] = [];
  const inside = (point: PikoPoint) => upper ? point.y <= boundary : point.y >= boundary;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    if (inside(a)) result.push({ ...a });
    if (inside(a) !== inside(b)) {
      const t = (boundary - a.y) / (b.y - a.y);
      result.push({ x: a.x + (b.x - a.x) * t, y: boundary });
    }
  }
  return result;
}

// Skip the far-right pose (atlas index 2), retaining the eight-second cycle.
export const TREE_CANOPY_SEQUENCE = [0, 1, 3, 4, 5, 6, 7] as const;
export const TREE_CANOPY_FPS = TREE_CANOPY_SEQUENCE.length / 8;

/** Replace the baked crown with authored frames; retain the original trunk and silhouette. */
export function createTreeCanopyBreeze(source: Texture, cleanPlate: Texture, atlas: Texture, definition: PikoOccluder,
  ticker: Ticker, size: { width: number; height: number }) {
  const originalOutline = definition.outline!;
  const outline = originalOutline.map(point => ({ x: point.x + definition.position.x, y: point.y + definition.position.y }));
  const lower = clipTreeOutline(outline, false);
  const geometry = readCanopyAtlas(atlas, lower);
  const background = new Container({ label: "east-tree-clean-background", eventMode: "none", zIndex: -2 });
  const plate = new Sprite(cleanPlate);
  plate.width = size.width; plate.height = size.height;
  const mask = new Graphics({ eventMode: "none" });
  mask.poly(outline.flatMap(point => [point.x, point.y])).fill(0xffffff);
  plate.mask = mask;
  background.addChild(plate, mask);

  const container = new Container({ label: "east-tree-canopy-breeze", eventMode: "none", zIndex: definition.depthY });
  const trunk = new Graphics({ label: "original-tree-trunk", eventMode: "none" });
  trunk.poly(lower.flatMap(point => [point.x, point.y])).fill({ texture: source, textureSpace: "global" });
  const frames = geometry.map(item => item.texture);
  const canopy = new Sprite(frames[0]);
  canopy.position.set(CANOPY_PLACEMENT.x, CANOPY_PLACEMENT.y);
  canopy.width = CANOPY_PLACEMENT.width; canopy.height = CANOPY_PLACEMENT.height;
  const masks = geometry.map(item => {
    const context = new GraphicsContext();
    item.runs.forEach(([x, y, width]) => context.rect(x, y, width, 1));
    return context.fill(0xffffff);
  });
  const outlines = geometry.map(item => item.outline.map(point => ({
    x: point.x - definition.position.x, y: point.y - definition.position.y,
  })));
  const canopyMask = new Graphics({ context: masks[0], eventMode: "none" });
  canopy.mask = canopyMask;
  const leaves = createFallingLeaves();
  container.addChild(trunk, canopy, canopyMask, leaves.container);
  let frame = 0;
  definition.outline = outlines[0];
  const apply = (next: number) => {
    if (next === frame) return;
    frame = next;
    canopy.texture = frames[frame];
    canopy.position.set(CANOPY_PLACEMENT.x + CANOPY_REGISTRATION[frame].x,
      CANOPY_PLACEMENT.y + CANOPY_REGISTRATION[frame].y);
    canopyMask.context = masks[frame];
    definition.outline = outlines[frame];
  };
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let elapsed = 0, attached = false;
  const update = (clock: Ticker) => {
    const delta = Math.min(clock.deltaMS, 100) / 1000;
    elapsed += delta;
    apply(TREE_CANOPY_SEQUENCE[Math.floor((elapsed + 1e-8) * TREE_CANOPY_FPS) % TREE_CANOPY_SEQUENCE.length]);
    leaves.update(delta);
  };
  const sync = () => {
    const active = !media.matches && !document.hidden;
    if (active && !attached) { ticker.add(update); attached = true; }
    if (!active && attached) { ticker.remove(update); attached = false; }
    if (media.matches) { elapsed = 0; apply(0); leaves.reset(); }
  };
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return { background, container, canopy, trunk, leaves: leaves.container, destroy() {
    if (attached) ticker.remove(update);
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    definition.outline = originalOutline;
    leaves.destroy();
    canopy.mask = null;
    canopyMask.destroy({ context: false });
    masks.forEach(context => context.destroy());
    background.destroy({ children: true });
    container.destroy({ children: true });
    frames.forEach(texture => {
      const canvas = texture.source.resource as HTMLCanvasElement;
      texture.destroy(true);
      canvas.width = canvas.height = 0;
    });
  } };
}
