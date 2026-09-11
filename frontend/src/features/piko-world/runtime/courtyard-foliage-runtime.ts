// SPDX-License-Identifier: Elastic-2.0
import { Assets, type Container, type Texture, type Ticker } from "pixi.js";
import { CANOPY_ATLAS_SRC } from "./canopy-atlas";
import type { PikoOccluder, PikoOcclusion } from "./map-package-schema";
import { createTreeCanopyBreeze } from "./tree-canopy-breeze";
import {
  createEastWillowCanopyBreeze,
  createWestGardenCanopyBreeze,
  WEST_GARDEN_CANOPY_ATLAS_SRC,
  WEST_GARDEN_CANOPY_CLEAN_PLATE_SRC,
} from "./west-garden-canopy-breeze";
import {
  createWestGroveRearPineBreeze,
  WEST_GROVE_REAR_PINE_ATLAS_SRC,
  WEST_GROVE_REAR_PINE_CLEAN_PATCH_SRC,
} from "./west-grove-rear-pine-breeze";
import {
  createWestHallPineBreeze,
  WEST_HALL_PINE_ATLAS_SRC,
  WEST_HALL_PINE_CLEAN_PLATE_SRC,
} from "./west-hall-pine-breeze";

const EAST_TREE_CLEAN_PLATE_SRC = "effects/east-tree-clean-plate-v1.png";
type Destroyable = { destroy(): void };

export function courtyardFoliageOccluders(occlusion: PikoOcclusion) {
  const find = (id: string) => occlusion.occluders.find(item => item.id === id);
  const animatedTree = find("east-canopy-tree");
  const westGardenCanopy = find("west-garden-canopy");
  const eastWillowCanopy = find("east-willow-canopy");
  const westHallPine = find("west-hall-pine");
  const westGroveRearPine = find("west-grove-rear-pine");
  const westGroveFrontPine = find("west-grove-front-pine");
  return {
    animatedTree,
    westGardenCanopy,
    eastWillowCanopy,
    westHallPine,
    westGroveRearPine,
    westGroveFrontPine,
    bakedActorOcclusionExclusions: new Set([animatedTree, westGroveRearPine].filter(Boolean) as PikoOccluder[]),
    occluderRenderExclusions: new Set([eastWillowCanopy, westHallPine].filter(Boolean) as PikoOccluder[]),
  };
}

/** Own the courtyard's authored foliage replacements and their shared texture lifecycle. */
export async function createCourtyardFoliageRuntime({ occlusion, baseTexture, ticker, size,
  resolveAssetUrl, isDisposed }: {
  occlusion: PikoOcclusion;
  baseTexture: Texture;
  ticker: Ticker;
  size: { width: number; height: number };
  resolveAssetUrl: (src: string) => string;
  isDisposed: () => boolean;
}) {
  const foliage = courtyardFoliageOccluders(occlusion);
  const sources = new Set<string>();
  if (foliage.animatedTree) sources.add(EAST_TREE_CLEAN_PLATE_SRC).add(CANOPY_ATLAS_SRC);
  if (foliage.westGardenCanopy) sources.add(WEST_GARDEN_CANOPY_CLEAN_PLATE_SRC).add(WEST_GARDEN_CANOPY_ATLAS_SRC);
  if (foliage.westHallPine) sources.add(WEST_HALL_PINE_CLEAN_PLATE_SRC).add(WEST_HALL_PINE_ATLAS_SRC);
  if (foliage.westGroveRearPine) sources.add(WEST_GROVE_REAR_PINE_CLEAN_PATCH_SRC).add(WEST_GROVE_REAR_PINE_ATLAS_SRC);

  const entries = [...sources].map(src => ({ src, url: resolveAssetUrl(src) }));
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
    if (failed) throw failed.reason;
    return null;
  }

  const objects: Container[] = [];
  const effects: Destroyable[] = [];
  const texture = (src: string) => {
    const value = loaded.get(src);
    if (!value) throw new Error(`Missing courtyard foliage texture: ${src}`);
    return value;
  };
  try {
    if (foliage.animatedTree) {
      const effect = createTreeCanopyBreeze(baseTexture, texture(EAST_TREE_CLEAN_PLATE_SRC),
        texture(CANOPY_ATLAS_SRC), foliage.animatedTree, ticker, size);
      effects.push(effect);
      objects.push(effect.background, effect.container);
    }
    if (foliage.westGardenCanopy) {
      const effect = createWestGardenCanopyBreeze(texture(WEST_GARDEN_CANOPY_ATLAS_SRC),
        texture(WEST_GARDEN_CANOPY_CLEAN_PLATE_SRC), foliage.westGardenCanopy, ticker, size);
      effects.push(effect);
      objects.push(effect.background, effect.container, effect.mask);
      if (foliage.eastWillowCanopy) {
        const copy = createEastWillowCanopyBreeze(texture(WEST_GARDEN_CANOPY_ATLAS_SRC),
          foliage.eastWillowCanopy, ticker);
        effects.push(copy);
        objects.push(copy.container, copy.mask);
      }
    }
    if (foliage.westHallPine) {
      const effect = createWestHallPineBreeze(texture(WEST_HALL_PINE_ATLAS_SRC),
        texture(WEST_HALL_PINE_CLEAN_PLATE_SRC), foliage.westHallPine, ticker, size);
      effects.push(effect);
      objects.push(effect.background, effect.container, effect.mask);
    }
    if (foliage.westGroveRearPine) {
      const effect = createWestGroveRearPineBreeze(texture(WEST_GROVE_REAR_PINE_ATLAS_SRC),
        texture(WEST_GROVE_REAR_PINE_CLEAN_PATCH_SRC), foliage.westGroveRearPine,
        foliage.westGroveFrontPine, ticker);
      effects.push(effect);
      objects.push(effect.background, effect.container, effect.mask);
    }
  } catch (error) {
    effects.reverse().forEach(effect => effect.destroy());
    unload();
    throw error;
  }

  let destroyed = false;
  return { ...foliage, objects, destroy() {
    if (destroyed) return;
    destroyed = true;
    effects.reverse().forEach(effect => effect.destroy());
    objects.length = 0;
    unload();
  } };
}
