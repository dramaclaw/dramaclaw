// SPDX-License-Identifier: Elastic-2.0
import type { createDogWorld } from "./dog-world";
import { isPetRestVisible } from "./pet-rest-visibility";
import petAtlases from "./pet-atlases.json";
import { createPetMotion } from "./pet-motion";
import { acquireSharedTexture } from "./shared-texture";
import { createContactShadow } from "./character-shadow";
import { createCharacterName } from "./character-presentation";
import { Container, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import type { PikoNavigation, PikoOccluder } from "./map-package-schema";
import { createBakedActorOcclusion } from "./map-occlusion";
import { CAT_HEART_FRAME, CAT_HEART_SRC, isAnimalPositionNavigable, ANIMAL_SHEETS, COURTYARD_ANIMALS, ARTISAN_MARKET_ANIMALS, createAnimalMotion, type AnimalClip } from "./courtyard-animals";

export function animalAtlasFrames(atlas: Texture) {
  if (atlas.width !== 2048 || atlas.height !== 2048) {
    throw new Error("Courtyard animal atlas must contain four 1024-square cells in a 2048-square sheet");
  }
  return Array.from({ length: 4 }, (_, index) => new Texture({
    source: atlas.source,
    frame: new Rectangle(index % 2 * 1024, Math.floor(index / 2) * 1024, 1024, 1024),
  }));
}

/** Shared sheets, one ticker, and world-depth containers for all courtyard animals. */
export async function createCourtyardAnimalRuntime({ ticker, navigation, bakedOccluders, size,
  resolveAssetUrl, isDisposed, random = Math.random, worldDog, mapId = "welcome-courtyard" }: {
  ticker: Ticker;
  navigation: PikoNavigation;
  bakedOccluders: PikoOccluder[];
  size: { width: number; height: number };
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
  random?: () => number;
  worldDog?: ReturnType<typeof createDogWorld>;
  mapId?: string;
}) {
  const placements = mapId === "artisan-market"
    ? [...ARTISAN_MARKET_ANIMALS, ...COURTYARD_ANIMALS.filter(p => p.kind === "dog")]
    : COURTYARD_ANIMALS.filter(p => mapId === "welcome-courtyard" || p.kind === "dog");
  const kinds = new Set<string>(placements.map(p => p.kind));
  const requiredClip = (clip: string) => kinds.has(clip.match(/^[a-z]+/)?.[0] ?? "");
  const replacedClips: ReadonlySet<AnimalClip> = new Set(["dogWalk", "dogBark", "catIdle"]);
  const entries: { clip: AnimalClip | keyof typeof petAtlases | null; url: string }[] = (Object.keys(ANIMAL_SHEETS) as AnimalClip[])
    .filter(clip => !replacedClips.has(clip) && requiredClip(clip))
    .map(clip => ({ clip, url: resolveAssetUrl(ANIMAL_SHEETS[clip].src) }));
  for (const [clip, sheet] of Object.entries(petAtlases)) {
    if (requiredClip(clip)) entries.push({ clip: clip as keyof typeof petAtlases, url: resolveAssetUrl(sheet.src) });
  }
  if (kinds.has("cat")) entries.push({ clip: null, url: resolveAssetUrl(CAT_HEART_SRC) });
  const releases: (() => void)[] = [];
  const results = await Promise.allSettled(entries.map(async ({ url }) => {
    const lease = await acquireSharedTexture(url);
    releases.push(lease.release);
    return lease.texture;
  }));
  const unload = () => releases.splice(0).forEach(release => release());
  const failure = results.find(result => result.status === "rejected");
  if (failure || isDisposed()) {
    unload();
    if (failure && !isDisposed()) throw failure.reason;
    return null;
  }
  const clips = new Map<string, Texture[]>();
  let heartTexture: Texture | undefined;
  let shadowTexture: Texture;
  try {
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      result.value.source.scaleMode = "nearest";
      const clip = entries[index].clip;
      if (clip === null) heartTexture = result.value;
      else if (clip in petAtlases) {
        const sheet = petAtlases[clip as keyof typeof petAtlases];
        clips.set(clip, sheet.frames.map(({ rect }) => new Texture({ source: result.value.source,
          frame: new Rectangle(rect[0], rect[1], rect[2], rect[3]) })));
      } else clips.set(clip, animalAtlasFrames(result.value));
    });
    shadowTexture = createContactShadow({ width: 24, height: 8 });
  } catch (error) {
    clips.forEach(frames => frames.forEach(frame => frame.destroy(false)));
    unload();
    throw error;
  }
  const actors = placements.map(placement => {
    const container = new Container({ label: placement.id, eventMode: "none" });
    const shadow = new Sprite({ texture: shadowTexture, label: "animal-contact-shadow", eventMode: "none", roundPixels: true });
    shadow.anchor.set(0.5);
    const flying = placement.kind === "butterfly";
    const width = flying ? 3 : placement.scale * 220;
    shadow.width = width * 2;
    shadow.height = (flying ? 1.3 : width * 0.28) * 2;
    shadow.alpha = flying ? 0.45 : 1;
    const body = new Sprite({ label: "animal-body", eventMode: "none" });
    container.addChild(shadow, body);
    const heart = placement.kind === "cat" ? new Sprite({ texture: heartTexture, label: "cat-heart", eventMode: "none" }) : null;
    if (heart) {
      heart.anchor.set(0.5, 1);
      heart.width = placement.scale * 340;
      heart.height = heart.width;
      heart.position.set(placement.scale * 190 * (placement.facing ?? 1), -placement.scale * 540);
      heart.visible = false;
      container.addChild(heart);
    }
    const name = placement.name ? createCharacterName(placement.name, -placement.scale * 900 - 4) : null;
    if (name) container.addChild(name);
    const externallyDriven = placement.kind === "dog" ? worldDog : undefined;
    const motion = externallyDriven ?? (placement.kind === "dog" || placement.kind === "cat" ? createPetMotion : createAnimalMotion)(
      placement, random, point => isAnimalPositionNavigable(point, navigation),
      point => isPetRestVisible(point, bakedOccluders));
    let previousClip: AnimalClip | undefined, previousFrame = -1;
    const render = () => {
      const state = motion.state as typeof motion.state & Partial<Pick<ReturnType<typeof createPetMotion>["state"], "atlas" | "pose">>;
      container.visible = !externallyDriven || worldDog!.mapId === mapId;
      container.position.set(state.position.x, state.position.y);
      container.zIndex = state.position.y;
      if (heart) {
        heart.visible = state.clip === "catIdle" && state.frame === CAT_HEART_FRAME;
        heart.x = placement.scale * 190 * state.facing;
      }
      body.y = -state.lift;
      body.scale.set(placement.scale * state.facing, placement.scale);
      if (state.atlas !== undefined && state.pose !== undefined) {
        const sheet = petAtlases[state.atlas as keyof typeof petAtlases];
        const frame = sheet.frames[state.pose];
        body.texture = clips.get(state.atlas)![state.pose];
        body.anchor.set(frame.anchor[0] / frame.rect[2], frame.anchor[1] / frame.rect[3]);
        body.scale.set(placement.scale * frame.scale * state.facing, placement.scale * frame.scale);
      } else if (state.clip !== previousClip || state.frame !== previousFrame) {
        body.texture = clips.get(state.clip)![state.frame];
        const anchor = ANIMAL_SHEETS[state.clip].anchors[state.frame];
        body.anchor.set(anchor[0] / 1024, anchor[1] / 1024);
        previousClip = state.clip;
        previousFrame = state.frame;
      }
    };
    if (!externallyDriven) motion.update(0);
    render();
    const occlusion = createBakedActorOcclusion(container, bakedOccluders, size);
    return { container, body, heart, name, shadow, placement, motion, occlusion, render, externallyDriven };
  });
  let attached = false, destroyed = false;
  const update = (clock: Ticker) => {
    const delta = Math.max(0, Math.min(clock.deltaMS, 100)) / 1000;
    actors.forEach(actor => {
      if (!actor.externallyDriven) actor.motion.update(delta);
      actor.render();
      actor.occlusion.update();
    });
  };
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => {
    const active = !destroyed && !media.matches && !document.hidden;
    if (active && !attached) { ticker.add(update); attached = true; }
    if (!active && attached) { ticker.remove(update); attached = false; }
  };
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return {
    actors,
    objects: actors.flatMap(actor => [actor.container, actor.occlusion.mask]),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (attached) ticker.remove(update);
      attached = false;
      media.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      actors.forEach(actor => {
        actor.occlusion.destroy();
        actor.container.destroy({ children: true });
      });
      shadowTexture.destroy(true);
      clips.forEach(frames => frames.forEach(frame => frame.destroy(false)));
      unload();
    },
  };
}
