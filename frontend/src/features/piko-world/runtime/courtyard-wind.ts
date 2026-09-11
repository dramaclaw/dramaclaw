// SPDX-License-Identifier: Elastic-2.0

export const COURTYARD_WIND_LOOP_SECONDS = 6;
export const COURTYARD_WIND_STEP_COUNT = 4;
export const COURTYARD_WIND_FPS = COURTYARD_WIND_STEP_COUNT / COURTYARD_WIND_LOOP_SECONDS;

/** Derive one shared phase from Pixi's ticker clock so asynchronously loaded foliage cannot drift apart. */
export function courtyardWindStepAt(timeMS: number, loopSeconds = COURTYARD_WIND_LOOP_SECONDS,
  phaseSeconds = 0) {
  const elapsed = Math.max(0, timeMS / 1000 + phaseSeconds);
  const fps = COURTYARD_WIND_STEP_COUNT / loopSeconds;
  return Math.floor((elapsed + 1e-8) * fps) % COURTYARD_WIND_STEP_COUNT;
}

export function courtyardWindFrameAt(timeMS: number, sequence: readonly number[]) {
  if (sequence.length !== COURTYARD_WIND_STEP_COUNT) throw new Error("Invalid courtyard wind sequence");
  return sequence[courtyardWindStepAt(timeMS)];
}
