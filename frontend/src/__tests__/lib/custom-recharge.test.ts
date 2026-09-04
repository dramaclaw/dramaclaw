// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  normalizeWholeCnyCredits,
  wholeCnyRechargeBounds,
} from "@/lib/custom-recharge";

const config = {
  credits_per_cny: 15,
  min_credits: 500,
  max_credits: 500_000,
};

describe("whole-CNY custom recharge", () => {
  it("aligns configured bounds to complete CNY amounts", () => {
    expect(wholeCnyRechargeBounds(config)).toEqual({
      min: 510,
      max: 499_995,
      step: 15,
    });
  });

  it("rounds typed credits to the nearest whole CNY amount", () => {
    expect(normalizeWholeCnyCredits(524, config)).toBe(525);
    expect(normalizeWholeCnyCredits(517, config)).toBe(510);
  });

  it("clamps values after rounding", () => {
    expect(normalizeWholeCnyCredits(1, config)).toBe(510);
    expect(normalizeWholeCnyCredits(900_000, config)).toBe(499_995);
  });
});
