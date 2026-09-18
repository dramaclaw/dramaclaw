// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import { createRiverFishMotion } from "./river-fish-motion";
import { acquireSharedTexture } from "./shared-texture";
import type { PikoPoint } from "./navigation-geometry";

export const RIVER_FISH_SOURCES = ["effects/river-fish-gray-v1.png", "effects/river-fish-gold-v1.png"] as const;
// Bounds measured from the user-supplied transparent 2172 × 724 strips.
// Match nose and body center across frames; preserve one scale for each species.
const CROPS = [
  [[33,208,482,267], [580,208,477,267], [1099,208,478,267], [1649,209,463,266]],
  [[53,239,434,217], [597,239,437,217], [1138,239,437,217], [1684,239,434,217]],
] as const;
const FISH_SIZE_MULTIPLIER = 1.02;
const WATER_VEIL_ALPHA = 0.05;
const FISH = [
  { species: 0, length: 26, phase: 0, alpha: 0.86 },
  { species: 0, length: 24, phase: 0.9, alpha: 0.82 },
  { species: 0, length: 25, phase: 1.7, alpha: 0.84 },
  { species: 1, length: 28, phase: 2.5, alpha: 0.88 },
] as const;

export async function createCourtyardFish({ ticker, surfaces, resolveAssetUrl, isDisposed }: {
  ticker: Ticker;
  surfaces: { points: PikoPoint[]; sprite: Sprite }[];
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
}) {
  const movement = createRiverFishMotion(surfaces.map(surface => surface.points));
  const releases: (() => void)[] = [];
  const frames: Texture[][] = [];
  const container = new Container({ label: "courtyard-river-fish", eventMode: "none", zIndex: -0.9 });
  const mask = new Graphics({ eventMode: "none" });
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let elapsed = 0, destroyed = false, attached = false;
  const surfaceMasks: Graphics[] = [];
  const actors: Sprite[] = [];
  const overlays: { source: Sprite; sprite: Sprite }[] = [];
  const tick = (clock: Ticker) => {
    if (document.hidden || media.matches) return;
    const dt = Math.min(clock.deltaMS, 50) / 1000;
    elapsed += dt;
    movement.step(dt);
    draw();
  };
  const draw = () => {
    actors.forEach((sprite, index) => {
      const spec = FISH[index];
      const position = movement.fish[index];
      const frame = media.matches ? 0 : Math.floor(elapsed * (index === 3 ? 2.6 : 3.2) + spec.phase) % 4;
      sprite.texture = frames[spec.species][frame];
      // Anchor by nose; frame width variation comes only from the moving tail.
      sprite.anchor.set(1, 0.5);
      sprite.position.set(position.x + Math.cos(position.heading) * spec.length * FISH_SIZE_MULTIPLIER / 2,
        position.y + Math.sin(position.heading) * spec.length * FISH_SIZE_MULTIPLIER / 2);
      sprite.rotation = position.heading;
      sprite.alpha = spec.alpha * (0.96 + 0.04 * Math.sin(elapsed * 0.24 + spec.phase));
    });
    overlays.forEach(({ source, sprite }) => { sprite.texture = source.texture; });
  };
  const sync = () => {
    const active = !document.hidden && !media.matches;
    if (active && !attached) { ticker.add(tick); attached = true; }
    if (!active && attached) { ticker.remove(tick); attached = false; }
    draw();
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (attached) ticker.remove(tick);
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    container.mask = null;
    overlays.forEach(({ sprite }) => { sprite.mask = null; });
    container.destroy({ children: true });
    mask.destroy();
    surfaceMasks.forEach(item => item.destroy());
    frames.flat().forEach(frame => frame.destroy(false));
    releases.splice(0).forEach(release => release());
  };
  try {
    if (!surfaces.length) { destroy(); return null; }
    for (let species = 0; species < RIVER_FISH_SOURCES.length; species++) {
      const lease = await acquireSharedTexture(resolveAssetUrl(RIVER_FISH_SOURCES[species]));
      releases.push(lease.release);
      if (isDisposed()) { destroy(); return null; }
      lease.texture.source.scaleMode = "nearest";
      frames.push(CROPS[species].map(([x,y,width,height]) => new Texture({ source: lease.texture.source,
        frame: new Rectangle(x,y,width,height) })));
    }
    surfaces.forEach(({ points }) => mask.poly(points.flatMap(point => [point.x, point.y])).fill(0xffffff));
    container.mask = mask;
    FISH.forEach(spec => {
      const sprite = new Sprite(frames[spec.species][0]);
      sprite.scale.set(spec.length * FISH_SIZE_MULTIPLIER / CROPS[spec.species][0][2]);
      sprite.tint = spec.species === 0 ? 0xc0e4e9 : 0xf0ead4;
      sprite.eventMode = "none";
      actors.push(sprite); container.addChild(sprite);
    });
    // Reuse the already-playing river textures as a thin water veil above the fish.
    surfaces.forEach(({ points, sprite: source }) => {
      const sprite = new Sprite(source.texture);
      sprite.position.copyFrom(source.position); sprite.scale.copyFrom(source.scale);
      sprite.alpha = WATER_VEIL_ALPHA; sprite.eventMode = "none";
      const surfaceMask = new Graphics({ eventMode: "none" });
      surfaceMask.poly(points.flatMap(point => [point.x, point.y])).fill(0xffffff);
      surfaceMasks.push(surfaceMask); sprite.mask = surfaceMask;
      overlays.push({ source, sprite }); container.addChild(sprite);
    });
    media.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return { objects: [container, mask, ...surfaceMasks], destroy };
  } catch (error) { destroy(); throw error; }
}
