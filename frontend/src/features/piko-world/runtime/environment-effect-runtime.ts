// SPDX-License-Identifier: Elastic-2.0
import { acquireSharedTexture } from "./shared-texture";
import { type Container, type Sprite, type Texture, type Ticker } from "pixi.js";
import { createEnvironmentSprite } from "./environment-sprite";
import type { EnvironmentSpriteAnimation } from "./environment-sprite";
import { createMapOccluder } from "./map-occlusion";
import type { PikoEnvironment } from "./map-package-schema";
import { courtyardWindStepAt } from "./courtyard-wind";
import type { RiverWaterRegion } from "./river-fish-motion";

type EnvironmentDefinition = PikoEnvironment["effects"][number];
type Destroyable = { destroy(): void };

export const environmentLayerZIndex = (layer: EnvironmentDefinition["layer"]) =>
  layer === "front-scenery" ? -0.25 : layer === "behind-scenery" ? -0.75 : -1;

export function environmentSpriteAnimation(animation: NonNullable<EnvironmentDefinition["animation"]>) {
  const { clock, loopSeconds, phaseSeconds, ...spriteAnimation } = animation;
  if (clock !== "courtyard-wind") return spriteAnimation as EnvironmentSpriteAnimation;
  return {
    ...spriteAnimation,
    stepAt: (timeMS: number) => courtyardWindStepAt(timeMS, loopSeconds, phaseSeconds),
  } satisfies EnvironmentSpriteAnimation;
}

/**
 * Own all data-authored environment effects as one lifecycle. Texture URLs are
 * loaded once even when many placements share one atlas (for example grass).
 */
export async function createEnvironmentEffectRuntime({ definitions, baseTexture, baseTextureSrc, ticker,
  resolveAssetUrl, isDisposed }: {
  definitions: PikoEnvironment["effects"];
  baseTexture: Texture;
  baseTextureSrc: string;
  ticker: Ticker;
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
}) {
  const objects: Container[] = [];
  const waterSurfaces: (RiverWaterRegion & { sprite: Sprite })[] = [];
  const mounted: Destroyable[] = [];
  const textures = new Map<string, Texture>();
  const releases: (() => void)[] = [];

  const destroy = () => {
    mounted.splice(0).reverse().forEach(effect => effect.destroy());
    releases.splice(0).forEach(release => release());
    textures.clear();
    objects.length = 0;
    waterSurfaces.length = 0;
  };

  const loadTexture = async (src: string) => {
    const url = resolveAssetUrl(src);
    const cached = textures.get(url);
    if (cached) return cached;
    const lease = await acquireSharedTexture(url);
    const texture = lease.texture;
    if (isDisposed()) {
      lease.release();
      return null;
    }
    releases.push(lease.release);
    texture.source.scaleMode = "nearest";
    textures.set(url, texture);
    return texture;
  };

  try {
    for (const definition of definitions) {
      if (isDisposed()) { destroy(); return null; }
      if (definition.kind !== "sprite" || !definition.region || !definition.src) continue;

      if (!definition.animation && definition.src === baseTextureSrc) {
        const points = definition.region.points;
        const x = Math.min(...points.map(point => point.x));
        const y = Math.min(...points.map(point => point.y));
        const foreground = createMapOccluder(baseTexture, {
          id: definition.id,
          src: definition.src,
          position: { x, y },
          depthY: -0.5,
          frame: {
            x, y,
            width: Math.max(...points.map(point => point.x)) - x,
            height: Math.max(...points.map(point => point.y)) - y,
          },
          outline: points.map(point => ({ x: point.x - x, y: point.y - y })),
        });
        foreground.container.alpha = definition.opacity ?? 1;
        objects.push(foreground.container);
        mounted.push(foreground);
        continue;
      }

      if (!definition.animation) continue;
      const atlas = await loadTexture(definition.src);
      if (!atlas) { destroy(); return null; }
      const effect = createEnvironmentSprite(atlas, definition.region.points,
        environmentSpriteAnimation(definition.animation), ticker);
      effect.container.label = definition.id;
      effect.container.zIndex = environmentLayerZIndex(definition.layer);
      effect.container.alpha = definition.opacity ?? 1;
      objects.push(effect.container, effect.mask);
      mounted.push(effect);
      if (definition.layer === "water") {
        waterSurfaces.push({ id: definition.id, points: definition.region.points, sprite: effect.sprite });
      }
    }
    return { objects, waterSurfaces, destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}
