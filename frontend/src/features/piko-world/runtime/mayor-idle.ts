// SPDX-License-Identifier: Elastic-2.0
export const PIKO_MAYOR_POSITION = { x: 1060, y: 450 };
export const PIKO_MAYOR_IDLE_SRC = "/piko/world/characters/mayor-idle-v1/mayor-idle-sheet.png";
export const MAYOR_FRAME_SIZE = 64;
export const MAYOR_FRAME_COUNT = 7;
export const MAYOR_PIVOT = { x: 32, y: 57 };
// 32 → 37 source pixels: ~15% wider, without stretching the pixel grid.
export const MAYOR_SHADOW_PROFILE = { width: 37, height: 8 } as const;
// Preserve the previously accepted ~82-map-pixel visible height.
export const MAYOR_WORLD_SCALE = 82 / 48;
export const MAYOR_IDLE_TIMELINE = [
  { frame: 0, durationMs: 900 }, { frame: 1, durationMs: 180 },
  { frame: 2, durationMs: 360 }, { frame: 3, durationMs: 180 },
  { frame: 4, durationMs: 180 }, { frame: 0, durationMs: 850 },
  { frame: 5, durationMs: 80 }, { frame: 6, durationMs: 100 },
  { frame: 5, durationMs: 80 }, { frame: 0, durationMs: 950 },
  { frame: 1, durationMs: 180 }, { frame: 2, durationMs: 360 },
  { frame: 3, durationMs: 180 }, { frame: 4, durationMs: 180 },
  { frame: 0, durationMs: 520 },
] as const;
export const MAYOR_IDLE_DURATION = MAYOR_IDLE_TIMELINE.reduce((sum, step) => sum + step.durationMs, 0);

export function mayorIdleFrameAt(elapsedMs: number): number {
  let remaining = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) % MAYOR_IDLE_DURATION : 0;
  for (const step of MAYOR_IDLE_TIMELINE) {
    if (remaining < step.durationMs) return step.frame;
    remaining -= step.durationMs;
  }
  return 0;
}
