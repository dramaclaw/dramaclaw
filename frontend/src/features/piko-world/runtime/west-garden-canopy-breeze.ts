// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { createEnvironmentSprite } from "./environment-sprite";
import type { PikoOccluder } from "./map-package-schema";
import { courtyardWindStepAt } from "./courtyard-wind";
import { createFoliageCleanBackground } from "./foliage-clean-background";

export const WEST_GARDEN_CANOPY_ATLAS_SRC = "effects/west-garden-canopy-atlas-v1.png";
export const WEST_GARDEN_CANOPY_CLEAN_PLATE_SRC = "effects/west-garden-clean-plate-v1.png";
export const WEST_GARDEN_CANOPY_ATLAS_COLUMNS = 3;
export const WEST_GARDEN_CANOPY_ATLAS_ROWS = 1;
export const WEST_GARDEN_CANOPY_FRAME_COUNT = 2;
export const WEST_GARDEN_CANOPY_SEQUENCE = [0, 1, 1, 0] as const;
export const WEST_GARDEN_CANOPY_LOOP_SECONDS = 3.8;
export const WEST_GARDEN_CANOPY_PHASE_SECONDS = 0.18;
export const WEST_GARDEN_CANOPY_FPS = WEST_GARDEN_CANOPY_SEQUENCE.length / WEST_GARDEN_CANOPY_LOOP_SECONDS;

export const westGardenCanopyWindStepAt = (timeMS: number) =>
  courtyardWindStepAt(timeMS, WEST_GARDEN_CANOPY_LOOP_SECONDS, WEST_GARDEN_CANOPY_PHASE_SECONDS);

// The transparent source keeps generous registration margins. These bounds
// align its authored foliage with the baked 160x119 west-garden silhouette.
export const WEST_GARDEN_CANOPY_PLACEMENT = { x: 478, y: 523, width: 188, height: 149 };
export const EAST_WILLOW_CANOPY_PLACEMENT = { x: 1759, y: 685, width: 152, height: 121 };
export const EAST_WILLOW_CANOPY_LOOP_SECONDS = 4.9;
export const EAST_WILLOW_CANOPY_PHASE_SECONDS = 0.08;

export const eastWillowCanopyWindStepAt = (timeMS: number) =>
  courtyardWindStepAt(timeMS, EAST_WILLOW_CANOPY_LOOP_SECONDS, EAST_WILLOW_CANOPY_PHASE_SECONDS);

function createCanopySprite(atlas: Texture, placement: typeof WEST_GARDEN_CANOPY_PLACEMENT,
  loopSeconds: number, stepAt: (timeMS: number) => number, ticker: Ticker) {
  const { x, y, width, height } = placement;
  return createEnvironmentSprite(atlas, [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ], {
    columns: WEST_GARDEN_CANOPY_ATLAS_COLUMNS,
    rows: WEST_GARDEN_CANOPY_ATLAS_ROWS,
    frames: WEST_GARDEN_CANOPY_FRAME_COUNT,
    fps: WEST_GARDEN_CANOPY_SEQUENCE.length / loopSeconds,
    inset: 0,
    sequence: WEST_GARDEN_CANOPY_SEQUENCE,
    stepAt,
  }, ticker);
}

/** Reuse the authored shrub without another clean plate because the destination ground is already clear. */
export function createEastWillowCanopyBreeze(atlas: Texture, definition: PikoOccluder, ticker: Ticker) {
  const effect = createCanopySprite(atlas, EAST_WILLOW_CANOPY_PLACEMENT,
    EAST_WILLOW_CANOPY_LOOP_SECONDS, eastWillowCanopyWindStepAt, ticker);
  effect.container.label = "east-willow-canopy-breeze";
  effect.container.zIndex = definition.depthY;
  return effect;
}

/** Replace the baked foliage with a clean plate, then overlay a restrained breeze. */
export function createWestGardenCanopyBreeze(atlas: Texture, cleanPlate: Texture, definition: PikoOccluder,
  ticker: Ticker, size: { width: number; height: number }) {
  const cleanBackground = createFoliageCleanBackground(cleanPlate, { x: 0, y: 0, ...size },
    definition.outline!.map(point => ({
      x: point.x + definition.position.x, y: point.y + definition.position.y,
    })), "west-garden-clean-background");

  const effect = createCanopySprite(atlas, WEST_GARDEN_CANOPY_PLACEMENT,
    WEST_GARDEN_CANOPY_LOOP_SECONDS, westGardenCanopyWindStepAt, ticker);
  effect.container.label = "west-garden-canopy-breeze";
  effect.container.zIndex = definition.depthY;
  return { ...effect, background: cleanBackground.container, destroy() {
    effect.destroy();
    cleanBackground.destroy();
  } };
}
