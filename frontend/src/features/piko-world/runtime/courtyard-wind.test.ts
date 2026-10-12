// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import {
  COURTYARD_WIND_FPS,
  COURTYARD_WIND_LOOP_SECONDS,
  courtyardWindFrameAt,
  courtyardWindStepAt,
} from "./courtyard-wind";

it("keeps every courtyard tree on one repeating gust clock", () => {
  expect(COURTYARD_WIND_LOOP_SECONDS).toBe(6);
  expect(COURTYARD_WIND_FPS).toBeCloseTo(2 / 3);
  expect([0, 1500, 3000, 4500, 6000].map(time => courtyardWindStepAt(time)))
    .toEqual([0, 1, 2, 3, 0]);
  expect([0, 1500, 3000, 4500, 6000].map(time =>
    courtyardWindFrameAt(time, [0, 1, 1, 0]))).toEqual([0, 1, 1, 0, 0]);
});
