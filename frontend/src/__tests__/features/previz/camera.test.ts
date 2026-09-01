// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  OUTPUT_PIXEL_SIZE,
  PREVIZ_SENSOR_MM,
  aspectValue,
  clampFocalMm,
  focalFromHorizontalFovDeg,
  horizontalFovDeg,
  verticalFovDeg,
} from "@/features/previz/domain/camera";
import type { OutputAspect } from "@/features/previz/domain/scene";

describe("focal length and field of view", () => {
  it("derives the horizontal field of view from the sensor width", () => {
    // 全画幅 36 mm 宽、50 mm 焦距 → 2·atan(18/50) ≈ 39.60°，是标准镜的教科书值。
    expect(horizontalFovDeg(50, "ff")).toBeCloseTo(39.5978, 3);
    expect(horizontalFovDeg(24, "ff")).toBeCloseTo(73.7398, 3);
    expect(horizontalFovDeg(35, "s35")).toBeCloseTo(39.1479, 3);
  });

  // three 的 PerspectiveCamera.fov 是垂直角，出片画幅一变垂直角就得跟着变，
  // 水平角却不该动——这条断言就是在钉这个不对称。
  it("derives the vertical field of view from the output aspect", () => {
    expect(verticalFovDeg(50, "ff", "16:9")).toBeCloseTo(22.8952, 3);
    expect(verticalFovDeg(50, "ff", "1:1")).toBeCloseTo(39.5978, 3);
    expect(verticalFovDeg(50, "ff", "9:16")).toBeCloseTo(65.2385, 3);
    expect(horizontalFovDeg(50, "ff")).toBeCloseTo(39.5978, 3);
  });

  it("round-trips focal length through the horizontal field of view", () => {
    expect(focalFromHorizontalFovDeg(horizontalFovDeg(85, "ff"), "ff")).toBeCloseTo(85, 6);
  });

  it("clamps focal length into the supported range", () => {
    expect(clampFocalMm(0)).toBe(12);
    expect(clampFocalMm(1000)).toBe(200);
    expect(clampFocalMm(Number.NaN)).toBe(50);
    expect(clampFocalMm(85)).toBe(85);
  });
});

describe("output sizes", () => {
  it("maps every aspect to an even pixel size that matches its ratio", () => {
    const aspects: OutputAspect[] = ["16:9", "9:16", "1:1", "4:3"];
    for (const aspect of aspects) {
      const size = OUTPUT_PIXEL_SIZE[aspect];
      // 编码器和大多数缩放路径都讨厌奇数边长；这里全是常量，钉住免得以后手滑。
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
      expect(size.width / size.height).toBeCloseTo(aspectValue(aspect), 6);
    }
    expect(OUTPUT_PIXEL_SIZE["16:9"]).toEqual({ width: 1920, height: 1080 });
    expect(OUTPUT_PIXEL_SIZE["9:16"]).toEqual({ width: 1080, height: 1920 });
    expect(OUTPUT_PIXEL_SIZE["1:1"]).toEqual({ width: 1440, height: 1440 });
    expect(OUTPUT_PIXEL_SIZE["4:3"]).toEqual({ width: 1600, height: 1200 });
  });

  it("keeps both sensors' physical dimensions", () => {
    expect(PREVIZ_SENSOR_MM.ff).toEqual({ width: 36, height: 24 });
    expect(PREVIZ_SENSOR_MM.s35).toEqual({ width: 24.89, height: 18.66 });
  });
});
