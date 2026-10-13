// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  CROP_RATIO_PRESETS,
  containRect,
  dragCropHandle,
  fitRatioBox,
  initialCropBox,
  moveCropBox,
  resolveCropRatio,
  toEvenSourceRect,
} from "@/features/canvas/application/videoCrop/cropMath";

const SRC_W = 720;
const SRC_H = 1280;
const INITIAL = { x: 72, y: 128, width: 576, height: 1024 };

describe("resolveCropRatio", () => {
  it("maps presets to width/height ratios", () => {
    expect(CROP_RATIO_PRESETS).toEqual(["free", "original", "1:1", "9:16", "16:9", "4:3", "3:4"]);
    expect(resolveCropRatio("free", SRC_W, SRC_H)).toBeNull();
    expect(resolveCropRatio("original", SRC_W, SRC_H)).toBe(0.5625);
    expect(resolveCropRatio("16:9", SRC_W, SRC_H)).toBeCloseTo(16 / 9);
    expect(resolveCropRatio("3:4", SRC_W, SRC_H)).toBe(0.75);
  });
});

describe("containRect", () => {
  it("pillarboxes a portrait source inside a landscape container", () => {
    const rect = containRect(400, 300, SRC_W, SRC_H);
    expect(rect.width).toBeCloseTo(168.75);
    expect(rect.height).toBeCloseTo(300);
    expect(rect.left).toBeCloseTo(115.625);
    expect(rect.top).toBeCloseTo(0);
  });

  it("letterboxes a landscape source", () => {
    const rect = containRect(400, 300, 1920, 1080);
    expect(rect.width).toBeCloseTo(400);
    expect(rect.height).toBeCloseTo(225);
    expect(rect.top).toBeCloseTo(37.5);
  });

  it("returns an empty rect until sizes are known", () => {
    expect(containRect(0, 300, SRC_W, SRC_H)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
    expect(containRect(400, 300, 0, 0)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe("initialCropBox", () => {
  it("keeps the source ratio at 80% and centers it", () => {
    expect(initialCropBox(SRC_W, SRC_H)).toEqual(INITIAL);
  });

  it("floors out at the drag minimum when 80% of a small source is smaller", () => {
    expect(initialCropBox(70, 70)).toEqual({ x: 3, y: 3, width: 64, height: 64 });
    expect(initialCropBox(40, 40)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });
});

describe("fitRatioBox", () => {
  it("takes the largest box of the ratio around the current center", () => {
    expect(fitRatioBox(INITIAL, 1, SRC_W, SRC_H)).toEqual({ x: 0, y: 280, width: 720, height: 720 });
    const wide = fitRatioBox(INITIAL, 16 / 9, SRC_W, SRC_H);
    expect(wide.width).toBeCloseTo(720);
    expect(wide.height).toBeCloseTo(405);
    expect(wide.y).toBeCloseTo(437.5);
  });

  it("covers the whole frame for the original ratio", () => {
    expect(fitRatioBox(INITIAL, 0.5625, SRC_W, SRC_H)).toEqual({ x: 0, y: 0, width: 720, height: 1280 });
  });

  it("pushes the box back inside when the center is near an edge", () => {
    expect(fitRatioBox({ x: 0, y: 0, width: 100, height: 100 }, 1, SRC_W, SRC_H)).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 720,
    });
  });
});

describe("moveCropBox", () => {
  it("translates and clamps inside the frame", () => {
    expect(moveCropBox(INITIAL, 10, -20, SRC_W, SRC_H)).toEqual({ ...INITIAL, x: 82, y: 108 });
    expect(moveCropBox(INITIAL, 1000, -1000, SRC_W, SRC_H)).toEqual({ ...INITIAL, x: 144, y: 0 });
  });
});

describe("dragCropHandle (free)", () => {
  it("moves only the dragged edge and clamps to the frame", () => {
    expect(dragCropHandle(INITIAL, "e", 500, 0, null, SRC_W, SRC_H)).toEqual({ ...INITIAL, width: 648 });
    expect(dragCropHandle(INITIAL, "s", 0, 50, null, SRC_W, SRC_H)).toEqual({ ...INITIAL, height: 1074 });
  });

  it("moves both edges for a corner", () => {
    expect(dragCropHandle(INITIAL, "nw", -100, -200, null, SRC_W, SRC_H)).toEqual({
      x: 0,
      y: 0,
      width: 648,
      height: 1152,
    });
  });

  it("never shrinks below the minimum size", () => {
    expect(dragCropHandle(INITIAL, "w", 1000, 0, null, SRC_W, SRC_H)).toEqual({ ...INITIAL, x: 584, width: 64 });
  });

  it("stays put on a source smaller than the drag minimum instead of going negative", () => {
    const small = initialCropBox(70, 70);
    expect(dragCropHandle(small, "w", 0, 0, null, 70, 70)).toEqual(small);
  });

  it("stays inside the frame when the source is smaller than the drag minimum", () => {
    const tiny = initialCropBox(40, 40);
    const next = dragCropHandle(tiny, "nw", 5, 5, null, 40, 40);
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.y).toBeGreaterThanOrEqual(0);
    expect(next.x + next.width).toBeLessThanOrEqual(40);
    expect(next.y + next.height).toBeLessThanOrEqual(40);
  });
});

describe("dragCropHandle (locked ratio)", () => {
  it("keeps the ratio with the opposite corner anchored", () => {
    const next = dragCropHandle(INITIAL, "se", -100, 0, 0.5625, SRC_W, SRC_H);
    expect(next.x).toBe(72);
    expect(next.y).toBe(128);
    expect(next.width).toBe(476);
    expect(next.height).toBeCloseTo(476 / 0.5625);
  });

  it("grows toward the top-left from the bottom-right anchor", () => {
    expect(dragCropHandle({ x: 0, y: 280, width: 720, height: 720 }, "nw", 100, 50, 1, SRC_W, SRC_H)).toEqual({
      x: 100,
      y: 380,
      width: 620,
      height: 620,
    });
  });

  it("shrinks proportionally when hitting the frame or the minimum", () => {
    const square = { x: 100, y: 100, width: 200, height: 200 };
    expect(dragCropHandle(square, "se", 1000, 0, 1, SRC_W, SRC_H)).toEqual({ x: 100, y: 100, width: 620, height: 620 });
    expect(dragCropHandle(square, "se", -1000, 0, 1, SRC_W, SRC_H)).toEqual({ x: 100, y: 100, width: 64, height: 64 });
  });

  it("ignores edge handles while locked", () => {
    expect(dragCropHandle(INITIAL, "e", 50, 0, 0.5625, SRC_W, SRC_H)).toBe(INITIAL);
  });

  it("stays inside the frame on a source smaller than the drag minimum", () => {
    const tiny = initialCropBox(40, 40);
    const next = dragCropHandle(tiny, "nw", 5, 5, 1, 40, 40);
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.y).toBeGreaterThanOrEqual(0);
    expect(next.x + next.width).toBeLessThanOrEqual(40);
    expect(next.y + next.height).toBeLessThanOrEqual(40);
  });
});

describe("toEvenSourceRect", () => {
  it("floors sizes to even pixels and rounds the origin", () => {
    expect(toEvenSourceRect({ x: 71.6, y: 127.4, width: 577.9, height: 1025.3 }, SRC_W, SRC_H)).toEqual({
      left: 72,
      top: 127,
      width: 576,
      height: 1024,
    });
  });

  it("stays inside the frame", () => {
    expect(toEvenSourceRect({ x: 719, y: 0, width: 3, height: 3 }, SRC_W, SRC_H)).toEqual({
      left: 718,
      top: 0,
      width: 2,
      height: 2,
    });
    expect(toEvenSourceRect({ x: -5, y: 0, width: 800, height: 1300 }, SRC_W, SRC_H)).toEqual({
      left: 0,
      top: 0,
      width: 720,
      height: 1280,
    });
  });
});
