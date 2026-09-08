// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { createCharacterActor } from "./character-actor";
import { MAYOR_FRAME_COUNT, MAYOR_FRAME_SIZE, MAYOR_IDLE_DURATION, MAYOR_PIVOT,
  MAYOR_WORLD_SCALE, PIKO_MAYOR_POSITION, MAYOR_SHADOW_PROFILE, mayorIdleFrameAt } from "./mayor-idle";
export function createMayorActor(sheet: Texture, ticker: Ticker, isActive: () => boolean) {
  return createCharacterActor(sheet, ticker, isActive, {
    label: "piko-mayor", frameSize: MAYOR_FRAME_SIZE, frameCount: MAYOR_FRAME_COUNT,
    pivot: MAYOR_PIVOT, position: PIKO_MAYOR_POSITION, scale: MAYOR_WORLD_SCALE,
    shadow: MAYOR_SHADOW_PROFILE, durationMs: MAYOR_IDLE_DURATION, frameAt: mayorIdleFrameAt,
  });
}
