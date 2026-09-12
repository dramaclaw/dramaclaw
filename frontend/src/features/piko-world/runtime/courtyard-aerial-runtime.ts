// SPDX-License-Identifier: Elastic-2.0
import { Assets, Container, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";

export const COURTYARD_BIRD_ATLAS_SRC = "effects/flying-bird-atlas-v1.png";
export const COURTYARD_CLOUD_SRC = "effects/thin-cloud-v1.png";
export const BIRD_FRAME_COUNT = 4;
export const MAX_BIRD_COUNT = 4;
export const MAX_CLOUD_COUNT = 3;
export const AERIAL_SHADOW_Z_INDEX = 9000;
export const AERIAL_BODY_Z_INDEX = 10000;
export const AERIAL_LANES = ["upper", "middle", "lower"] as const;
export const AERIAL_LANE_DEPTH = {
  upper: { scale: 0.82, alpha: 0.78, shadowAlpha: 0.68, duration: 1.18 },
  middle: { scale: 1, alpha: 0.92, shadowAlpha: 0.88, duration: 1 },
  lower: { scale: 1.08, alpha: 1, shadowAlpha: 1, duration: 0.88 },
} as const;

export type AerialLane = typeof AERIAL_LANES[number];
type Random = () => number;
type Point = { x: number; y: number };
type Route = { from: Point; to: Point; arc: number };
type CycleState = { visible: boolean; progress: number; fade: number };

export type BirdEvent = {
  lane: AerialLane;
  count: number;
  duration: number;
  gap: number;
  shadowOffset: Point;
  birds: { x: number; y: number; scale: number; alpha: number }[];
};

export type CloudEvent = {
  lane: AerialLane;
  count: number;
  duration: number;
  gap: number;
  clouds: { x: number; y: number; width: number; alpha: number; shadowAlpha: number;
    shadowOffset: Point; flipped: boolean; drift: number }[];
};

export const BIRD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -180, y: 110 }, to: { x: 2240, y: 250 }, arc: 16 },
  middle: { from: { x: -190, y: 245 }, to: { x: 2250, y: 610 }, arc: 26 },
  lower: { from: { x: -180, y: 760 }, to: { x: 2240, y: 1010 }, arc: 18 },
};

export const CLOUD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -520, y: 135 }, to: { x: 2568, y: 275 }, arc: 10 },
  middle: { from: { x: -520, y: 250 }, to: { x: 2568, y: 455 }, arc: 14 },
  lower: { from: { x: -520, y: 700 }, to: { x: 2568, y: 910 }, arc: 12 },
};

const BIRD_FORMATION = [{ x: 0, y: 0 }, { x: -52, y: -26 }, { x: -92, y: 18 }, { x: -128, y: -44 }];
const randomBetween = (random: Random, min: number, max: number) => min + random() * (max - min);
const eventTransitSeconds = (event: { lane: AerialLane; duration: number }) =>
  event.duration * AERIAL_LANE_DEPTH[event.lane].duration;

/** Traverse each lane once before reshuffling, without repeating at the bag boundary. */
export function createLaneShuffle(random: Random = Math.random, initialLast?: AerialLane) {
  let bag: AerialLane[] = [];
  let last = initialLast;
  return () => {
    if (bag.length === 0) {
      bag = [...AERIAL_LANES];
      for (let index = bag.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [bag[index], bag[swap]] = [bag[swap], bag[index]];
      }
      if (bag[0] === last) {
        const swap = bag.findIndex(lane => lane !== last);
        [bag[0], bag[swap]] = [bag[swap], bag[0]];
      }
    }
    last = bag.shift()!;
    return last;
  };
}

/** A bounded transit with a quiet gap and soft entry/exit. */
export function aerialCycleState(elapsed: number, transitSeconds: number, cycleSeconds: number): CycleState {
  const phase = ((elapsed % cycleSeconds) + cycleSeconds) % cycleSeconds;
  if (phase >= transitSeconds) return { visible: false, progress: 1, fade: 0 };
  const progress = phase / transitSeconds;
  return { visible: true, progress, fade: Math.min(1, progress / 0.08, (1 - progress) / 0.08) };
}

export function birdAtlasFrames(atlas: Texture) {
  const frameWidth = atlas.width / BIRD_FRAME_COUNT;
  if (!Number.isInteger(frameWidth) || atlas.height !== frameWidth) {
    throw new Error("Courtyard bird atlas must contain four square horizontal frames");
  }
  return Array.from({ length: BIRD_FRAME_COUNT }, (_, index) => new Texture({
    source: atlas.source,
    frame: new Rectangle(index * frameWidth, 0, frameWidth, atlas.height),
  }));
}

export function createBirdEvent(lane: AerialLane, random: Random = Math.random): BirdEvent {
  const count = 2 + Math.floor(random() * 3);
  const baseScale = randomBetween(random, 0.105, 0.13);
  return {
    lane,
    count,
    duration: randomBetween(random, 8, 12),
    gap: randomBetween(random, 18, 35),
    shadowOffset: { x: randomBetween(random, 42, 64), y: randomBetween(random, 34, 52) },
    birds: BIRD_FORMATION.map(item => ({
      x: item.x + randomBetween(random, -6, 6),
      y: item.y + randomBetween(random, -5, 5),
      scale: baseScale * randomBetween(random, 0.82, 1),
      alpha: randomBetween(random, 0.88, 0.98),
    })),
  };
}

export function createCloudEvent(lane: AerialLane, random: Random = Math.random): CloudEvent {
  const countRoll = random();
  const count = countRoll < 0.45 ? 1 : countRoll < 0.85 ? 2 : 3;
  const offsets = [
    { x: 0, y: 0 },
    { x: randomBetween(random, -290, -190), y: randomBetween(random, 65, 125) },
    { x: randomBetween(random, 210, 330), y: randomBetween(random, -120, -55) },
  ];
  return {
    lane,
    count,
    duration: randomBetween(random, 32, 48),
    gap: randomBetween(random, 15, 30),
    clouds: offsets.map(offset => ({
      ...offset,
      width: randomBetween(random, 320, 520),
      alpha: randomBetween(random, 0.24, 0.34),
      shadowAlpha: randomBetween(random, 0.08, 0.14),
      shadowOffset: { x: randomBetween(random, 58, 96), y: randomBetween(random, 42, 72) },
      flipped: random() >= 0.5,
      drift: randomBetween(random, -18, 18),
    })),
  };
}

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const pointOnRoute = (route: Route, progress: number) => ({
  x: lerp(route.from.x, route.to.x, progress),
  y: lerp(route.from.y, route.to.y, progress) + Math.sin(progress * Math.PI) * route.arc,
});

/** Own the courtyard's sparse high-altitude bodies and their projected shadows. */
export async function createCourtyardAerialRuntime({ ticker, resolveAssetUrl, isDisposed,
  random = Math.random }: {
  ticker: Ticker;
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
  random?: Random;
}) {
  const sources = [COURTYARD_BIRD_ATLAS_SRC, COURTYARD_CLOUD_SRC] as const;
  const entries = sources.map(src => ({ src, url: resolveAssetUrl(src) }));
  const settled = await Promise.allSettled(entries.map(({ url }) => Assets.load<Texture>(url)));
  const loaded = new Map<string, Texture>();
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    result.value.source.scaleMode = "nearest";
    loaded.set(entries[index].src, result.value);
  });
  const unload = () => entries.forEach(({ src, url }) => {
    if (loaded.has(src)) void Assets.unload(url);
  });
  const failed = settled.find(result => result.status === "rejected");
  if (failed || isDisposed()) {
    unload();
    if (failed && !isDisposed()) throw failed.reason;
    return null;
  }

  const birdAtlas = loaded.get(COURTYARD_BIRD_ATLAS_SRC)!;
  const cloudTexture = loaded.get(COURTYARD_CLOUD_SRC)!;
  let frames: Texture[];
  try { frames = birdAtlasFrames(birdAtlas); }
  catch (error) { unload(); throw error; }
  const shadowLayer = new Container({ label: "courtyard-aerial-shadows", eventMode: "none",
    zIndex: AERIAL_SHADOW_Z_INDEX });
  const bodyLayer = new Container({ label: "courtyard-aerial-bodies", eventMode: "none",
    zIndex: AERIAL_BODY_Z_INDEX });
  const birdShadowFlock = new Container({ label: "courtyard-bird-shadow-flock", eventMode: "none" });
  const birdFlock = new Container({ label: "courtyard-bird-flock", eventMode: "none" });

  const cloudShadows = Array.from({ length: MAX_CLOUD_COUNT }, () => {
    const sprite = new Sprite({ texture: cloudTexture, anchor: 0.5, tint: 0x213040, alpha: 0 });
    sprite.blendMode = "multiply";
    shadowLayer.addChild(sprite);
    return sprite;
  });
  const clouds = Array.from({ length: MAX_CLOUD_COUNT }, () => {
    const sprite = new Sprite({ texture: cloudTexture, anchor: 0.5, alpha: 0 });
    bodyLayer.addChild(sprite);
    return sprite;
  });
  shadowLayer.addChild(birdShadowFlock);
  bodyLayer.addChild(birdFlock);

  const birdShadows = Array.from({ length: MAX_BIRD_COUNT }, () => {
    const sprite = new Sprite({ texture: frames[0], anchor: 0.5, tint: 0x16202b, alpha: 0 });
    sprite.blendMode = "multiply";
    birdShadowFlock.addChild(sprite);
    return sprite;
  });
  const birds = Array.from({ length: MAX_BIRD_COUNT }, () => {
    const sprite = new Sprite({ texture: frames[0], anchor: 0.5, alpha: 0 });
    birdFlock.addChild(sprite);
    return sprite;
  });

  const nextBirdLane = createLaneShuffle(random, "middle");
  const nextCloudLane = createLaneShuffle(random, "middle");
  let birdEvent = { ...createBirdEvent("middle", random), duration: 12 };
  let cloudEvent = createCloudEvent("middle", random);
  let birdElapsed = 0;
  let cloudElapsed = 0;

  const applyBirdEvent = () => {
    const depth = AERIAL_LANE_DEPTH[birdEvent.lane];
    birdEvent.birds.forEach((item, index) => {
      const body = birds[index], shadow = birdShadows[index];
      body.position.set(item.x * depth.scale, item.y * depth.scale);
      body.scale.set(item.scale * depth.scale);
      shadow.position.set((item.x + birdEvent.shadowOffset.x) * depth.scale,
        (item.y + birdEvent.shadowOffset.y) * depth.scale);
      shadow.scale.set(item.scale * depth.scale * 1.04, item.scale * depth.scale * 0.62);
    });
  };
  const applyCloudEvent = () => {
    const depth = AERIAL_LANE_DEPTH[cloudEvent.lane];
    cloudEvent.clouds.forEach((item, index) => {
      const body = clouds[index], shadow = cloudShadows[index];
      const scale = item.width * depth.scale / cloudTexture.width;
      body.scale.set((item.flipped ? -1 : 1) * scale, scale);
      shadow.scale.set((item.flipped ? -1 : 1) * scale * 1.06, scale * 0.76);
    });
  };
  applyBirdEvent();
  applyCloudEvent();

  const step = (deltaMS: number) => {
    const delta = Math.max(0, Math.min(deltaMS, 100)) / 1000;
    birdElapsed += delta;
    cloudElapsed += delta;
    const birdTransit = eventTransitSeconds(birdEvent);
    const cloudTransit = eventTransitSeconds(cloudEvent);
    if (birdElapsed >= birdTransit + birdEvent.gap) {
      birdElapsed %= birdTransit + birdEvent.gap;
      birdEvent = createBirdEvent(nextBirdLane(), random);
      applyBirdEvent();
    }
    if (cloudElapsed >= cloudTransit + cloudEvent.gap) {
      cloudElapsed %= cloudTransit + cloudEvent.gap;
      cloudEvent = createCloudEvent(nextCloudLane(), random);
      applyCloudEvent();
    }

    const cloudDepth = AERIAL_LANE_DEPTH[cloudEvent.lane];
    const activeCloudTransit = eventTransitSeconds(cloudEvent);
    const cloudState = aerialCycleState(cloudElapsed, activeCloudTransit, activeCloudTransit + cloudEvent.gap);
    const cloudPoint = pointOnRoute(CLOUD_ROUTES[cloudEvent.lane], cloudState.progress);
    cloudEvent.clouds.forEach((item, index) => {
      const enabled = index < cloudEvent.count && cloudState.visible;
      const drift = Math.sin(cloudState.progress * Math.PI * 2 + index) * item.drift * cloudDepth.scale;
      const x = cloudPoint.x + item.x * cloudDepth.scale;
      const y = cloudPoint.y + item.y * cloudDepth.scale + drift;
      clouds[index].position.set(x, y);
      cloudShadows[index].position.set(x + item.shadowOffset.x * cloudDepth.scale,
        y + item.shadowOffset.y * cloudDepth.scale);
      clouds[index].alpha = item.alpha * cloudDepth.alpha * cloudState.fade;
      cloudShadows[index].alpha = item.shadowAlpha * cloudDepth.shadowAlpha * cloudState.fade;
      clouds[index].visible = cloudShadows[index].visible = enabled;
    });

    const birdDepth = AERIAL_LANE_DEPTH[birdEvent.lane];
    const activeBirdTransit = eventTransitSeconds(birdEvent);
    const birdState = aerialCycleState(birdElapsed, activeBirdTransit, activeBirdTransit + birdEvent.gap);
    const birdPoint = pointOnRoute(BIRD_ROUTES[birdEvent.lane], birdState.progress);
    const frame = Math.floor((birdElapsed + 0.15) * 5.5) % frames.length;
    birds.forEach((sprite, index) => {
      sprite.texture = frames[frame];
      sprite.alpha = birdEvent.birds[index].alpha * birdDepth.alpha * birdState.fade;
      sprite.visible = index < birdEvent.count && birdState.visible;
    });
    birdShadows.forEach((sprite, index) => {
      sprite.texture = frames[frame];
      sprite.alpha = 0.13 * birdDepth.shadowAlpha * birdState.fade;
      sprite.visible = index < birdEvent.count && birdState.visible;
    });
    birdFlock.position.set(birdPoint.x, birdPoint.y);
    birdShadowFlock.position.set(birdPoint.x, birdPoint.y);
  };
  const update = (clock: Ticker) => step(clock.deltaMS);

  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let attached = false, destroyed = false;
  const sync = () => {
    const active = !destroyed && !media.matches && !document.hidden;
    bodyLayer.visible = shadowLayer.visible = !media.matches;
    if (active && !attached) { ticker.add(update); attached = true; }
    if (!active && attached) { ticker.remove(update); attached = false; }
  };
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  step(0);
  sync();

  return { objects: [shadowLayer, bodyLayer], shadowLayer, bodyLayer, clouds, cloudShadows, birds, birdShadows, destroy() {
    if (destroyed) return;
    destroyed = true;
    if (attached) ticker.remove(update);
    attached = false;
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    shadowLayer.destroy({ children: true });
    bodyLayer.destroy({ children: true });
    frames.forEach(texture => texture.destroy(false));
    unload();
  } };
}
