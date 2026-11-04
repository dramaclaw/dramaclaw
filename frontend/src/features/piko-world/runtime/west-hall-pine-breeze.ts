// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { createEnvironmentSprite } from "./environment-sprite";
import type { PikoOccluder } from "./map-package-schema";
import { courtyardWindStepAt } from "./courtyard-wind";
import { createFoliageCleanBackground } from "./foliage-clean-background";

export const WEST_HALL_PINE_ATLAS_SRC = "effects/west-hall-pine-atlas-v1.png";
export const WEST_HALL_PINE_CLEAN_PLATE_SRC = "effects/west-hall-pine-clean-plate-v1.png";
export const WEST_HALL_PINE_ATLAS_COLUMNS = 3;
export const WEST_HALL_PINE_FRAME_COUNT = 2;
export const WEST_HALL_PINE_SEQUENCE = [0, 1, 1, 0] as const;
export const WEST_HALL_PINE_LOOP_SECONDS = 4.4;
export const WEST_HALL_PINE_PHASE_SECONDS = -0.12;
export const WEST_HALL_PINE_FPS = WEST_HALL_PINE_SEQUENCE.length / WEST_HALL_PINE_LOOP_SECONDS;

export const westHallPineWindStepAt = (timeMS: number) =>
  courtyardWindStepAt(timeMS, WEST_HALL_PINE_LOOP_SECONDS, WEST_HALL_PINE_PHASE_SECONDS);
export const WEST_HALL_PINE_PLACEMENT = { x: 499, y: 186, width: 150, height: 256 };
export const WEST_HALL_PINE_CLEAN_PLATE_OUTLINE = [
  { x: 571, y: 102 }, { x: 594, y: 131 }, { x: 598, y: 157 }, { x: 614, y: 182 },
  { x: 610, y: 206 }, { x: 631, y: 238 }, { x: 625, y: 267 }, { x: 641, y: 296 },
  { x: 628, y: 325 }, { x: 633, y: 357 }, { x: 616, y: 387 }, { x: 606, y: 410 },
  { x: 569, y: 410 }, { x: 555, y: 390 }, { x: 546, y: 360 }, { x: 527, y: 331 },
  { x: 535, y: 300 }, { x: 522, y: 270 }, { x: 530, y: 240 }, { x: 522, y: 210 },
  { x: 534, y: 180 }, { x: 537, y: 151 }, { x: 551, y: 130 },
] as const;

/** Replace the complete baked pine silhouette, then loop the two restrained poses. */
export function createWestHallPineBreeze(atlas: Texture, cleanPlate: Texture, definition: PikoOccluder,
  ticker: Ticker, size: { width: number; height: number }) {
  const { x, y, width, height } = WEST_HALL_PINE_PLACEMENT;
  const cleanBackground = createFoliageCleanBackground(cleanPlate, { x: 0, y: 0, ...size },
    WEST_HALL_PINE_CLEAN_PLATE_OUTLINE, "west-hall-pine-clean-background");

  const effect = createEnvironmentSprite(atlas, [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ], { columns: WEST_HALL_PINE_ATLAS_COLUMNS, rows: 1, frames: WEST_HALL_PINE_FRAME_COUNT, fps: WEST_HALL_PINE_FPS,
    inset: 0, sequence: WEST_HALL_PINE_SEQUENCE, stepAt: westHallPineWindStepAt }, ticker);
  effect.container.label = "west-hall-pine-breeze";
  effect.container.zIndex = definition.depthY;
  return { ...effect, background: cleanBackground.container, destroy() {
    effect.destroy();
    cleanBackground.destroy();
  } };
}
