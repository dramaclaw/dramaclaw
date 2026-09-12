// SPDX-License-Identifier: Elastic-2.0
import { Container, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import { acquireSharedTexture } from "./shared-texture";
import type { PikoExitMarkerDefinition } from "../piko-map-connections";

const ATLAS_SRC = "/piko/world/ui/map-exits/golden-arrows-v1.png";
const ROTATION = { west: 0, north: Math.PI / 2, east: Math.PI, south: -Math.PI / 2 };

/** Ground decal below scenery and people, above the map base. */
export async function createMapExitMarker(ticker: Ticker, definition: PikoExitMarkerDefinition,
  isDisposed: () => boolean, isVisible: () => boolean) {
  const lease = await acquireSharedTexture(ATLAS_SRC);
  const atlas = lease.texture;
  if (isDisposed()) { lease.release(); return null; }
  if (atlas.width !== 2048 || atlas.height !== 1024) {
    lease.release();
    throw new Error("Exit marker requires a 4x2 atlas of 512px frames");
  }
  atlas.source.scaleMode = "nearest";
  const frames = Array.from({ length: 8 }, (_, index) => new Texture({ source: atlas.source,
    frame: new Rectangle(index % 4 * 512, Math.floor(index / 4) * 512, 512, 512) }));
  const container = new Container({ label: "map-exit-ground-marker", eventMode: "none", zIndex: -1 });
  container.position.set(definition.position.x, definition.position.y);
  container.scale.y = 0.72;
  const sprite = new Sprite({ texture: frames[0], eventMode: "none" });
  sprite.anchor.set(0.5);
  sprite.scale.set(120 / 512);
  sprite.rotation = ROTATION[definition.direction];
  container.addChild(sprite);
  container.visible = isVisible();
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let elapsed = 0;
  const update = (clock: Ticker) => {
    container.visible = isVisible();
    if (document.hidden || !container.visible) return;
    if (!motion?.matches) elapsed = (elapsed + Math.max(0, Math.min(clock.deltaMS, 100))) % 2400;
    sprite.texture = frames[motion?.matches ? 1 : Math.floor(elapsed / 300)];
  };
  ticker.add(update);
  return { container, destroy() {
    ticker.remove(update);
    container.destroy({ children: true });
    frames.forEach(frame => frame.destroy(false));
    lease.release();
  } };
}
