// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import {
  depthToGray,
  fitHeight,
  percentileRange,
  smoothRange,
} from "@/features/canvas/application/depthCapture/depthMath";

describe("fitHeight", () => {
  it("caps height and keeps an even, proportional width", () => {
    expect(fitHeight(720, 1280, 1080)).toEqual({ width: 606, height: 1080 });
    expect(fitHeight(720, 1280, 518)).toEqual({ width: 290, height: 518 });
  });

  it("keeps smaller sources, only rounding down to even", () => {
    expect(fitHeight(1920, 1080, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitHeight(641, 361, 1080)).toEqual({ width: 638, height: 360 });
  });
});

describe("percentileRange", () => {
  it("picks the 1%/99% samples", () => {
    const values = Array.from({ length: 101 }, (_, i) => i);
    expect(percentileRange(values)).toEqual({ lo: 1, hi: 99 });
  });

  it("ignores a single outlier", () => {
    const values = new Float32Array(1000).fill(0.5);
    values[10] = 1e6;
    expect(percentileRange(values)).toEqual({ lo: 0.5, hi: 0.5 });
  });

  it("returns a zero range for empty input", () => {
    expect(percentileRange([])).toEqual({ lo: 0, hi: 0 });
  });
});

describe("smoothRange", () => {
  it("takes the first frame directly", () => {
    expect(smoothRange(null, { lo: 2, hi: 8 })).toEqual({ lo: 2, hi: 8 });
  });

  it("moves toward the new range by alpha", () => {
    const next = smoothRange({ lo: 0, hi: 10 }, { lo: 10, hi: 20 }, 0.1);
    expect(next.lo).toBeCloseTo(1);
    expect(next.hi).toBeCloseTo(11);
  });
});

describe("depthToGray", () => {
  it("maps near (large) to white, clamps and writes opaque RGBA", () => {
    const rgba = new Uint8ClampedArray(5 * 4);
    depthToGray([0, 5, 10, -3, 20], { lo: 0, hi: 10 }, rgba);
    expect(Array.from(rgba.filter((_, i) => i % 4 === 0))).toEqual([0, 128, 255, 0, 255]);
    expect(Array.from(rgba.filter((_, i) => i % 4 === 3))).toEqual([255, 255, 255, 255, 255]);
    expect(rgba[4]).toBe(rgba[5]);
    expect(rgba[5]).toBe(rgba[6]);
  });

  it("paints black when the range collapses", () => {
    const rgba = new Uint8ClampedArray(2 * 4);
    depthToGray([3, 3], { lo: 3, hi: 3 }, rgba);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
});
