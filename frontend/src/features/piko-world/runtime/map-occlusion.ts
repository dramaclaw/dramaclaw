// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, earcut, type Texture } from "pixi.js";
import type { PikoOccluder, PikoOcclusion } from "./map-package-schema";
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";

/** Reuse source pixels at their original scale. A silhouette leaves the arch opening clear. */
export function createMapOccluder(source: Texture, definition: PikoOccluder) {
  const frame = definition.frame;
  if (frame && (frame.x + frame.width > source.width || frame.y + frame.height > source.height)) {
    throw new Error(`Occluder crop exceeds source texture: ${definition.id}`);
  }
  const container = new Container({ label: definition.id, eventMode: "none" });
  container.position.set(definition.position.x - (frame?.x ?? 0), definition.position.y - (frame?.y ?? 0));
  container.zIndex = definition.depthY;
  // Map the silhouette directly into the original texture's pixel coordinates.
  const shape = new Graphics();
  if (definition.outline) {
    shape.poly(definition.outline.flatMap(point => [point.x + (frame?.x ?? 0), point.y + (frame?.y ?? 0)]));
  } else {
    shape.rect(frame?.x ?? 0, frame?.y ?? 0, frame?.width ?? source.width, frame?.height ?? source.height);
  }
  shape.fill({ texture: source, textureSpace: "global" });
  container.addChild(shape);
  return {
    container,
    destroy() {
      container.destroy({ children: true, context: true });
      // The base map owns the shared texture/source; never destroy it here.
    },
  };
}

/** Static pixels already in the ground only need to cut the rear actor's silhouette.
 * This avoids repainting the ground and Canvas2D's fractional-scale sampling seams.
 * Use a normal mask with holes, supported by both WebGL and Canvas (not an inverse mask).
 */
export function createBakedActorOcclusion(actor: Container, definitions: PikoOccluder[], size: { width: number; height: number }) {
  const mask = new Graphics({ label: "baked-scenery-mask", eventMode: "none" });
  let previousY: number | undefined;
  let previous = "";
  const update = () => {
    if (actor.y === previousY) return;
    previousY = actor.y;
    const active = definitions.filter(item => actor.y < item.depthY && item.outline);
    const key = active.map(item => item.id).join("|");
    if (key === previous) return;
    previous = key;
    if (!active.length) { actor.mask = null; mask.clear(); return; }
    const vertices = [0, 0, size.width, 0, size.width, size.height, 0, size.height];
    const holes: number[] = [];
    for (const item of active) {
      holes.push(vertices.length / 2);
      vertices.push(...item.outline!.flatMap(point => [point.x + item.position.x, point.y + item.position.y]));
    }
    const triangles = earcut(vertices, holes, 2);
    mask.clear();
    // Explicit triangles also work in Canvas masks, whose clip path does not read Graphics.cut().
    for (let index = 0; index < triangles.length; index += 3) {
      mask.poly(triangles.slice(index, index + 3).flatMap(vertex => vertices.slice(vertex * 2, vertex * 2 + 2)));
    }
    mask.fill(0xffffff);
    actor.mask = mask;
  };
  update();
  return { mask, update, destroy() { actor.mask = null; mask.destroy(); } };
}

export function isBakedOccluder(item: PikoOccluder, baseSource: string) {
  return item.src === baseSource && Boolean(item.outline && item.frame
    && item.position.x === item.frame.x && item.position.y === item.frame.y);
}

/** The DOM speech bubble must not float above scenery hiding the speaker's head. */
export function isResidentHeadOccluded(position: PikoPoint, occlusion: PikoOcclusion, scale: number) {
  return occlusion.occluders.some(occluder => {
    if (position.y >= occluder.depthY || !occluder.outline) return false;
    return [-8, 0, 8].some(offset => pointInPolygon({
      x: position.x + offset * scale - occluder.position.x,
      y: position.y - 42 * scale - occluder.position.y,
    }, occluder.outline!));
  });
}
