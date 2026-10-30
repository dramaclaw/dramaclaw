// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import { createRiverFishMotion, type RiverFishRoute, type RiverWaterRegion } from "./river-fish-motion";
import { acquireSharedTexture } from "./shared-texture";

export const RIVER_FISH_SOURCES = ["effects/river-fish-gray-v1.png", "effects/river-fish-gold-v1.png"] as const;
// Bounds measured from the user-supplied transparent 2172 × 724 strips.
// Match nose and body center across frames; preserve one scale for each species.
const CROPS = [
  [[33,208,482,267], [580,208,477,267], [1099,208,478,267], [1649,209,463,266]],
  [[53,239,434,217], [597,239,437,217], [1138,239,437,217], [1684,239,434,217]],
] as const;
const FISH_SIZE_MULTIPLIER = 1.02;
const WATER_VEIL_ALPHA = 0.05;
type FishAppearance = { species: 0 | 1; length: number; phase: number; alpha: number; tailFps: number };
export type RiverFishPlacement = FishAppearance & { route: RiverFishRoute };
const COURTYARD_FISH: readonly FishAppearance[] = [
  { species: 0, length: 26, phase: 0, alpha: 0.86, tailFps: 2.7 },
  { species: 0, length: 24, phase: 0.9, alpha: 0.82, tailFps: 2.5 },
  { species: 0, length: 25, phase: 1.7, alpha: 0.84, tailFps: 2.8 },
  { species: 1, length: 28, phase: 2.5, alpha: 0.88, tailFps: 2.3 },
] as const;

/** Two fish above the bridge, three in the deeper downstream channel, two small gray fish in the shallows. */
export const LANTERN_CANAL_FISH: readonly RiverFishPlacement[] = [
  { species: 0, length: 24, phase: 0.4, alpha: 0.8, tailFps: 2.5,
    route: { start: { x: 1050, y: 145 }, surfaceId: "canal-upper-river-water",
      bounds: { minX: 980, maxX: 1125, minY: 60, maxY: 220 } } },
  { species: 0, length: 24, phase: 1.8, alpha: 0.81, tailFps: 2.7,
    route: { start: { x: 1100, y: 325 }, surfaceId: "canal-upper-river-water",
      bounds: { minX: 1030, maxX: 1180, minY: 230, maxY: 385 } } },
  { species: 0, length: 24, phase: 0.9, alpha: 0.82, tailFps: 2.6,
    route: { start: { x: 1080, y: 705 }, surfaceId: "canal-lower-river-water",
      bounds: { minX: 950, maxX: 1190, minY: 670, maxY: 850 } } },
  { species: 0, length: 23, phase: 2.1, alpha: 0.8, tailFps: 2.8,
    route: { start: { x: 1050, y: 870 }, surfaceId: "canal-lower-river-water",
      bounds: { minX: 850, maxX: 1170, minY: 820, maxY: 1010 } } },
  { species: 1, length: 26, phase: 3, alpha: 0.84, tailFps: 2.3,
    route: { start: { x: 850, y: 1050 }, surfaceId: "canal-lower-river-water",
      bounds: { minX: 760, maxX: 1070, minY: 960, maxY: 1125 } } },
  { species: 0, length: 22, phase: 0.7, alpha: 0.78, tailFps: 2.6,
    route: { start: { x: 1830, y: 1090 }, surfaceId: "canal-southeast-shallows-water", flowAxis: "x", downstreamChance: 0.5,
      bounds: { minX: 1700, maxX: 1900, minY: 1060, maxY: 1130 } } },
  { species: 0, length: 23, phase: 2.4, alpha: 0.8, tailFps: 2.5,
    route: { start: { x: 1970, y: 1050 }, surfaceId: "canal-southeast-shallows-water", flowAxis: "x", downstreamChance: 0.5,
      bounds: { minX: 1870, maxX: 2020, minY: 1020, maxY: 1120 } } },
];

export async function createMapRiverFish({ ticker, surfaces, resolveAssetUrl, isDisposed, placements }: {
  ticker: Ticker;
  surfaces: (RiverWaterRegion & { sprite: Sprite })[];
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
  placements?: readonly RiverFishPlacement[];
}) {
  const fish = placements ?? COURTYARD_FISH;
  if (!surfaces.length) return null;
  const movement = createRiverFishMotion(surfaces, Math.random,
    placements?.map(placement => placement.route));
  const releases: (() => void)[] = [];
  const frames: Texture[][] = [];
  const container = new Container({ label: "map-river-fish", eventMode: "none", zIndex: -0.9 });
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
      const spec = fish[index];
      const position = movement.fish[index];
      // A resting fish is still while the water veil continues to pass over it.
      const frame = media.matches || position.restFor > 0 ? 0 : Math.floor(elapsed * spec.tailFps + spec.phase) % 4;
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
    fish.forEach(spec => {
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
