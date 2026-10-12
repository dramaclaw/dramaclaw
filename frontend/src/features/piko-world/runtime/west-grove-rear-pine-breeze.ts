// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { courtyardWindStepAt } from "./courtyard-wind";
import { createEnvironmentSprite } from "./environment-sprite";
import { createFoliageCleanBackground, createFoliageMask } from "./foliage-clean-background";
import type { PikoOccluder } from "./map-package-schema";

export const WEST_GROVE_REAR_PINE_ATLAS_SRC = "effects/west-grove-rear-pine-atlas-v1.png";
export const WEST_GROVE_REAR_PINE_CLEAN_PATCH_SRC = "effects/west-grove-rear-clean-patch-v1.png";
export const WEST_GROVE_REAR_PINE_FRAME_COUNT = 2;
export const WEST_GROVE_REAR_PINE_SEQUENCE = [0, 1, 1, 0] as const;
export const WEST_GROVE_REAR_PINE_LOOP_SECONDS = 4.1;
export const WEST_GROVE_REAR_PINE_PHASE_SECONDS = 0.06;
export const WEST_GROVE_REAR_PINE_FPS = WEST_GROVE_REAR_PINE_SEQUENCE.length
  / WEST_GROVE_REAR_PINE_LOOP_SECONDS;
export const WEST_GROVE_REAR_PINE_PLACEMENT = { x: 119, y: 428, width: 173, height: 273 };
export const WEST_GROVE_REAR_CLEAN_PATCH_PLACEMENT = { x: 64, y: 420, width: 320, height: 320 };
export const WEST_GROVE_REAR_CLEAN_INSET = 0.78;

export const westGroveRearPineWindStepAt = (timeMS: number) =>
  courtyardWindStepAt(timeMS, WEST_GROVE_REAR_PINE_LOOP_SECONDS, WEST_GROVE_REAR_PINE_PHASE_SECONDS);

/** Replace the baked rear-grove tree while retaining its map-authored root and occlusion geometry. */
export function createWestGroveRearPineBreeze(atlas: Texture, cleanPatch: Texture, definition: PikoOccluder,
  foreground: PikoOccluder | undefined, ticker: Ticker) {
  const cleanOutline = definition.outline!.map(point => ({
    x: point.x + definition.position.x, y: point.y + definition.position.y,
  }));
  const foregroundOutline = foreground?.outline?.map(point => ({
    x: point.x + foreground.position.x, y: point.y + foreground.position.y,
  }));
  const center = cleanOutline.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 });
  center.x /= cleanOutline.length;
  center.y /= cleanOutline.length;
  const insetCleanOutline = cleanOutline.map(point => ({
    x: center.x + (point.x - center.x) * WEST_GROVE_REAR_CLEAN_INSET,
    y: center.y + (point.y - center.y) * WEST_GROVE_REAR_CLEAN_INSET,
  }));
  const exclusions = foregroundOutline ? [foregroundOutline] : [];
  const cleanBackground = createFoliageCleanBackground(cleanPatch, WEST_GROVE_REAR_CLEAN_PATCH_PLACEMENT,
    insetCleanOutline, "west-grove-rear-pine-clean-background", exclusions);
  const { x, y, width, height } = WEST_GROVE_REAR_PINE_PLACEMENT;
  const effect = createEnvironmentSprite(atlas, [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ], {
    columns: 2,
    rows: 1,
    frames: WEST_GROVE_REAR_PINE_FRAME_COUNT,
    fps: WEST_GROVE_REAR_PINE_FPS,
    inset: 0,
    sequence: WEST_GROVE_REAR_PINE_SEQUENCE,
    stepAt: westGroveRearPineWindStepAt,
  }, ticker);
  effect.container.label = "west-grove-rear-pine-breeze";
  effect.container.zIndex = definition.depthY;
  const dynamicOutline = [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ];
  const dynamicMask = createFoliageMask(WEST_GROVE_REAR_CLEAN_PATCH_PLACEMENT, dynamicOutline, exclusions);
  effect.sprite.mask = dynamicMask.mask;
  effect.container.addChild(dynamicMask.mask);
  return { ...effect, background: cleanBackground.container, destroy() {
    effect.destroy();
    dynamicMask.release();
    cleanBackground.destroy();
  } };
}
