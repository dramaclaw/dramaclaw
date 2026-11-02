// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RESIDENT_MOTION_SRC, RESIDENT_TIMELINE, residentFrameAt } from "./resident-actor";
it("loads the unified gait v6 production atlas", () => {
  expect(RESIDENT_MOTION_SRC).toContain("resident-m01-motion-v8.png");
  expect(readFileSync("public" + RESIDENT_MOTION_SRC)).toEqual(readFileSync(
    "../piko-world/art/review/resident-m01-directions-v1/resident-m01-motion-v8.png",
  ));
});
it("uses the produced resident timeline and identical runtime sheet", () => {
  const root = "../piko-world/art/review/resident-m01-idle-v1/";
  const metadata = JSON.parse(readFileSync(root + "resident-m01-idle.json", "utf8"));
  expect(metadata.timeline).toEqual(RESIDENT_TIMELINE);
  expect(readFileSync("public/piko/world/characters/resident-m01-idle-v1/resident-m01-idle-sheet.png"))
    .toEqual(readFileSync(root + "resident-m01-idle-sheet.png"));
});
it("holds, breathes, blinks, and wraps seamlessly", () => {
  let elapsed = 0;
  for (const step of RESIDENT_TIMELINE) {
    expect(residentFrameAt(elapsed)).toBe(step.frame);
    elapsed += step.durationMs;
    expect(residentFrameAt(elapsed - 1)).toBe(step.frame);
  }
  expect(elapsed).toBe(4800);
  expect(residentFrameAt(elapsed)).toBe(0);
  expect(residentFrameAt(NaN)).toBe(0);
});
