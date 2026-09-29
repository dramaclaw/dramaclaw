// SPDX-License-Identifier: Elastic-2.0
import { acquireSharedTexture } from "./shared-texture";
import { Container, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";

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
  fadeFraction?: number;
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
  upper: { from: { x: -360, y: 135 }, to: { x: 2408, y: 275 }, arc: 10 },
  middle: { from: { x: -360, y: 250 }, to: { x: 2408, y: 455 }, arc: 14 },
  lower: { from: { x: -360, y: 700 }, to: { x: 2408, y: 910 }, arc: 12 },
};

export const MARKET_BIRD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -180, y: 95 }, to: { x: 2240, y: 210 }, arc: 14 },
  middle: { from: { x: -190, y: 355 }, to: { x: 2250, y: 540 }, arc: 22 },
  lower: { from: { x: -180, y: 740 }, to: { x: 2240, y: 890 }, arc: 16 },
};

export const MARKET_CLOUD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -360, y: 65 }, to: { x: 2408, y: 225 }, arc: 10 },
  middle: { from: { x: -360, y: 255 }, to: { x: 2408, y: 500 }, arc: 14 },
  lower: { from: { x: -360, y: 675 }, to: { x: 2408, y: 875 }, arc: 12 },
};

export const CANAL_BIRD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -180, y: 105 }, to: { x: 2240, y: 190 }, arc: 14 },
  middle: { from: { x: -190, y: 360 }, to: { x: 2250, y: 475 }, arc: 20 },
  lower: { from: { x: -180, y: 795 }, to: { x: 2240, y: 915 }, arc: 16 },
};

export const CANAL_CLOUD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -360, y: 95 }, to: { x: 2408, y: 230 }, arc: 10 },
  middle: { from: { x: -360, y: 285 }, to: { x: 2408, y: 480 }, arc: 14 },
  lower: { from: { x: -360, y: 705 }, to: { x: 2408, y: 905 }, arc: 12 },
};

export const CLOUDTOP_BIRD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -180, y: 75 }, to: { x: 2240, y: 185 }, arc: 14 },
  middle: { from: { x: -190, y: 285 }, to: { x: 2250, y: 465 }, arc: 20 },
  lower: { from: { x: -180, y: 675 }, to: { x: 2240, y: 865 }, arc: 16 },
};
export const CLOUDTOP_CLOUD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -650, y: 80 }, to: { x: 2700, y: 80 }, arc: 0 },
  middle: { from: { x: -500, y: 520 }, to: { x: 2548, y: 520 }, arc: 0 },
  lower: { from: { x: -500, y: 900 }, to: { x: 2548, y: 900 }, arc: 0 },
};
export const AMBER_BIRD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -180, y: 65 }, to: { x: 2240, y: 155 }, arc: 12 },
  middle: { from: { x: -190, y: 175 }, to: { x: 2250, y: 310 }, arc: 18 },
  lower: { from: { x: -180, y: 325 }, to: { x: 2240, y: 475 }, arc: 14 },
};
export const AMBER_CLOUD_ROUTES: Record<AerialLane, Route> = {
  upper: { from: { x: -360, y: 30 }, to: { x: 2408, y: 115 }, arc: 8 },
  middle: { from: { x: -360, y: 125 }, to: { x: 2408, y: 280 }, arc: 10 },
  lower: { from: { x: -360, y: 255 }, to: { x: 2408, y: 430 }, arc: 12 },
};

export type AerialMapId = "welcome-courtyard" | "artisan-market" | "lantern-canal-street"
  | "cloudtop-slope" | "amber-wilds";
const AERIAL_ROUTES: Record<AerialMapId, { birds: Record<AerialLane, Route>; clouds: Record<AerialLane, Route>;
  cloudOpacity?: number; cloudGap?: readonly [number, number] }> = {
  "welcome-courtyard": { birds: BIRD_ROUTES, clouds: CLOUD_ROUTES, cloudGap: [8, 12] },
  "artisan-market": { birds: MARKET_BIRD_ROUTES, clouds: MARKET_CLOUD_ROUTES },
  "lantern-canal-street": { birds: CANAL_BIRD_ROUTES, clouds: CANAL_CLOUD_ROUTES },
  "cloudtop-slope": { birds: CLOUDTOP_BIRD_ROUTES, clouds: CLOUDTOP_CLOUD_ROUTES, cloudOpacity: 0.8 },
  "amber-wilds": { birds: AMBER_BIRD_ROUTES, clouds: AMBER_CLOUD_ROUTES, cloudOpacity: 0.55 },
};

export function isAerialMap(mapId: string): mapId is AerialMapId {
  return Object.prototype.hasOwnProperty.call(AERIAL_ROUTES, mapId);
}

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
export function aerialCycleState(elapsed: number, transitSeconds: number, cycleSeconds: number, fadeFraction = 0.08): CycleState {
  const phase = ((elapsed % cycleSeconds) + cycleSeconds) % cycleSeconds;
  if (phase >= transitSeconds) return { visible: false, progress: 1, fade: 0 };
  const progress = phase / transitSeconds;
  return { visible: true, progress, fade: Math.min(1, progress / fadeFraction, (1 - progress) / fadeFraction) };
}

export function birdAtlasFrames(atlas: Texture) {
  const frameWidth = atlas.width / BIRD_FRAME_COUNT;
  if (!Number.isInteger(frameWidth) || atlas.height !== frameWidth) {
    throw new Error("Aerial bird atlas must contain four square horizontal frames");
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
      shadowAlpha: randomBetween(random, 0.12, 0.2),
      shadowOffset: { x: randomBetween(random, 58, 96), y: randomBetween(random, 42, 72) },
      flipped: random() >= 0.5,
      drift: randomBetween(random, -18, 18),
    })),
  };
}

/** Independent horizontal passes cover the ridge, central slope and lower foreground. */
export function createCloudtopCloudEvent(lane: AerialLane, random: Random = Math.random): CloudEvent {
  const event = createCloudEvent(lane, random);
  return {
    ...event,
    count: 1,
    // Longer mid/lower routes take 64–96 seconds, independent of lane depth.
    duration: lane === "upper" ? event.duration / 0.7 : event.duration * 2 / AERIAL_LANE_DEPTH[lane].duration,
    fadeFraction: 0.14,
    gap: lane === "upper" ? randomBetween(random, 12, 20) : randomBetween(random, 3, 6),
    clouds: [{ ...event.clouds[0], x: 0, y: 0, drift: event.clouds[0].drift * 0.12, width: event.clouds[0].width * 1.75,
      alpha: event.clouds[0].alpha * 0.72, shadowAlpha: event.clouds[0].shadowAlpha * 0.28 }],
  };
}

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const pointOnRoute = (route: Route, progress: number) => ({
  x: lerp(route.from.x, route.to.x, progress),
  y: lerp(route.from.y, route.to.y, progress) + Math.sin(progress * Math.PI) * route.arc,
});

/** Own sparse high-altitude bodies and projected shadows for one map. */
export async function createMapAerialRuntime({ mapId, ticker, resolveAssetUrl, isDisposed,
  random = Math.random }: {
  mapId: AerialMapId;
  ticker: Ticker;
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
  random?: Random;
}) {
  const routes = AERIAL_ROUTES[mapId];
  const sources = [COURTYARD_BIRD_ATLAS_SRC, COURTYARD_CLOUD_SRC] as const;
  const entries = sources.map(src => ({ src, url: resolveAssetUrl(src) }));
  const releases: (() => void)[] = [];
  const settled = await Promise.allSettled(entries.map(async ({ url }) => {
    const lease = await acquireSharedTexture(url);
    releases.push(lease.release);
    return lease.texture;
  }));
  const loaded = new Map<string, Texture>();
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    result.value.source.scaleMode = "nearest";
    loaded.set(entries[index].src, result.value);
  });
  const unload = () => releases.splice(0).forEach(release => release());
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
  const shadowLayer = new Container({ label: `${mapId}-aerial-shadows`, eventMode: "none",
    zIndex: AERIAL_SHADOW_Z_INDEX });
  const bodyLayer = new Container({ label: `${mapId}-aerial-bodies`, eventMode: "none",
    zIndex: AERIAL_BODY_Z_INDEX });
  const birdShadowFlock = new Container({ label: `${mapId}-bird-shadow-flock`, eventMode: "none" });
  const birdFlock = new Container({ label: `${mapId}-bird-flock`, eventMode: "none" });

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
  const nextCloudLane = createLaneShuffle(random, "upper");
  let birdEvent = { ...createBirdEvent("middle", random), duration: 12 };
  let birdElapsed = 0;
  const createTransitCloud = (lane: AerialLane): CloudEvent => {
    const event = createCloudEvent(lane, random);
    const [minGap, maxGap] = routes.cloudGap ?? [6, 10];
    return { ...event, count: 1, gap: randomBetween(random, minGap, maxGap),
      clouds: [{ ...event.clouds[0], x: 0, y: 0 }] };
  };
  // Each sprite owns its cycle; one cloud can enter while another leaves.
  const cloudTracks = mapId === "cloudtop-slope"
    ? (["middle", "lower", "upper"] as const).map((lane, offset) => {
      const event = createCloudtopCloudEvent(lane, random);
      return { event, offset,
        elapsed: eventTransitSeconds(event) * [0.4, 0.62, 0.18][offset],
        next: () => createCloudtopCloudEvent(lane, random) };
    })
    : (["middle", "upper"] as const).map((lane, offset) => {
      const event = createTransitCloud(lane);
      return { event, offset, elapsed: eventTransitSeconds(event) * (offset === 0 ? 0.28 : 0.68),
        next: () => createTransitCloud(nextCloudLane()) };
    });
  clouds.forEach(sprite => { sprite.visible = false; });
  cloudShadows.forEach(sprite => { sprite.visible = false; });

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
  const applyCloudEvent = ({ event, offset }: typeof cloudTracks[number]) => {
    const depth = AERIAL_LANE_DEPTH[event.lane];
    event.clouds.forEach((item, index) => {
      const body = clouds[offset + index], shadow = cloudShadows[offset + index];
      const scale = item.width * depth.scale / cloudTexture.width;
      body.scale.set((item.flipped ? -1 : 1) * scale, scale);
      shadow.scale.set((item.flipped ? -1 : 1) * scale * 1.06, scale * 0.76);
    });
  };
  applyBirdEvent();
  cloudTracks.forEach(applyCloudEvent);

  const step = (deltaMS: number) => {
    const delta = Math.max(0, Math.min(deltaMS, 100)) / 1000;
    birdElapsed += delta;
    const birdTransit = eventTransitSeconds(birdEvent);
    if (birdElapsed >= birdTransit + birdEvent.gap) {
      birdElapsed %= birdTransit + birdEvent.gap;
      birdEvent = createBirdEvent(nextBirdLane(), random);
      applyBirdEvent();
    }
    cloudTracks.forEach(track => {
      track.elapsed += delta;
      const cycle = eventTransitSeconds(track.event) + track.event.gap;
      if (track.elapsed >= cycle) {
        track.elapsed %= cycle;
        track.event = track.next();
        applyCloudEvent(track);
      }
      const { event, elapsed, offset } = track;
      const depth = AERIAL_LANE_DEPTH[event.lane];
      const transit = eventTransitSeconds(event);
      const state = elapsed < 0 ? { visible: false, progress: 0, fade: 0 }
        : aerialCycleState(elapsed, transit, transit + event.gap, event.fadeFraction);
      const point = pointOnRoute(routes.clouds[event.lane], state.progress);
      event.clouds.forEach((item, index) => {
        const body = clouds[offset + index], shadow = cloudShadows[offset + index];
        const drift = Math.sin(state.progress * Math.PI * 2 + index) * item.drift * depth.scale;
        const x = point.x + item.x * depth.scale;
        const y = point.y + item.y * depth.scale + drift;
        body.position.set(x, y);
        shadow.position.set(x + item.shadowOffset.x * depth.scale, y + item.shadowOffset.y * depth.scale);
        body.alpha = item.alpha * depth.alpha * state.fade * (routes.cloudOpacity ?? 1);
        shadow.alpha = item.shadowAlpha * depth.shadowAlpha * state.fade * (routes.cloudOpacity ?? 1);
        body.visible = shadow.visible = index < event.count && state.visible;
      });
    });

    const birdDepth = AERIAL_LANE_DEPTH[birdEvent.lane];
    const activeBirdTransit = eventTransitSeconds(birdEvent);
    const birdState = aerialCycleState(birdElapsed, activeBirdTransit, activeBirdTransit + birdEvent.gap);
    const birdPoint = pointOnRoute(routes.birds[birdEvent.lane], birdState.progress);
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
