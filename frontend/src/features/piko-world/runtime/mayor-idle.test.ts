// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MAYOR_IDLE_DURATION, MAYOR_IDLE_TIMELINE, mayorIdleFrameAt } from "./mayor-idle";

it("uses the approved non-uniform timeline unchanged", () => {
  const approved = JSON.parse(readFileSync("../piko-world/art/review/mayor-idle-v1/mayor-idle.json", "utf8"));
  expect(MAYOR_IDLE_TIMELINE).toEqual(approved.timeline);
  expect(MAYOR_IDLE_DURATION).toBe(5280);
  const runtime = readFileSync("public/piko/world/characters/mayor-idle-v1/mayor-idle-sheet.png");
  const source = readFileSync("../piko-world/art/review/mayor-idle-v1/mayor-idle-sheet.png");
  expect(runtime.equals(source)).toBe(true);
});

it("switches frames exactly at their boundaries and loops without interpolating", () => {
  let time = 0;
  for (const step of MAYOR_IDLE_TIMELINE) {
    expect(mayorIdleFrameAt(time)).toBe(step.frame);
    expect(mayorIdleFrameAt(time + step.durationMs - 1)).toBe(step.frame);
    time += step.durationMs;
  }
  expect(mayorIdleFrameAt(time)).toBe(0);
  expect(mayorIdleFrameAt(time * 100 + 900)).toBe(1);
});

it("keeps invalid or negative elapsed times on the rest frame", () => {
  for (const time of [-1, NaN, Infinity]) expect(mayorIdleFrameAt(time)).toBe(0);
});
