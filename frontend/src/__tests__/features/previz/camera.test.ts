// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  OUTPUT_PIXEL_SIZE,
  PREVIZ_SENSOR_MM,
  aspectRatio,
  clampAperture,
  clampFocalMm,
  PREVIZ_APERTURE_STOPS,
  PREVIZ_FOCAL_STOPS,
  depthOfFieldClass,
  focalClass,
  focalFromHorizontalFovDeg,
  horizontalFovDeg,
  sensorVerticalFovDeg,
  stepStop,
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
  // 水平角却不该动——这组断言就是在钉这个不对称。
  it("derives the vertical field of view from the output aspect", () => {
    expect(verticalFovDeg(50, "ff", "16:9")).toBeCloseTo(22.8952, 3);
    expect(verticalFovDeg(50, "ff", "9:16")).toBeCloseTo(65.2385, 3);
    expect(verticalFovDeg(50, "ff", "4:3")).toBeCloseTo(30.2192, 3);
    expect(verticalFovDeg(35, "s35", "16:9")).toBeCloseTo(22.6208, 3);
    // 方形出片是这条不对称的支点：只有 1:1 时垂直角才等于水平角。
    expect(verticalFovDeg(50, "ff", "1:1")).toBeCloseTo(horizontalFovDeg(50, "ff"), 6);
  });

  it("round-trips focal length through the horizontal field of view", () => {
    expect(focalFromHorizontalFovDeg(horizontalFovDeg(85, "ff"), "ff")).toBeCloseTo(85, 6);
    expect(focalFromHorizontalFovDeg(horizontalFovDeg(85, "s35"), "s35")).toBeCloseTo(85, 6);
  });

  it("derives focal length from a field of view on each sensor", () => {
    // 90° 水平视场角的焦距正好是传感器半宽，两块传感器的答案必须不一样。
    expect(focalFromHorizontalFovDeg(90, "ff")).toBeCloseTo(18, 6);
    expect(focalFromHorizontalFovDeg(90, "s35")).toBeCloseTo(12.445, 6);
  });

  it("clamps focal length into the supported range", () => {
    expect(clampFocalMm(0)).toBe(12);
    expect(clampFocalMm(-50)).toBe(12);
    expect(clampFocalMm(1000)).toBe(200);
    expect(clampFocalMm(12)).toBe(12);
    expect(clampFocalMm(200)).toBe(200);
    expect(clampFocalMm(85)).toBe(85);
    expect(clampFocalMm(Number.NaN)).toBe(50);
    expect(clampFocalMm(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampFocalMm(Number.NEGATIVE_INFINITY)).toBe(50);
  });

  it("clamps aperture into the supported range", () => {
    expect(clampAperture(0)).toBe(1.2);
    expect(clampAperture(1.2)).toBe(1.2);
    expect(clampAperture(22)).toBe(22);
    expect(clampAperture(100)).toBe(22);
    expect(clampAperture(5.6)).toBe(5.6);
    expect(clampAperture(Number.NaN)).toBe(2.8);
    expect(clampAperture(Number.POSITIVE_INFINITY)).toBe(2.8);
  });

  // three 的 PerspectiveCamera 拿到 0 / 负 / NaN 的 fov 不会报错，只会给出零宽或
  // NaN 的视锥，症状要隔好几层才浮现。所以越界输入必须在这里就收敛掉。
  it("stays total for out-of-range input", () => {
    expect(horizontalFovDeg(0, "ff")).toBeCloseTo(horizontalFovDeg(12, "ff"), 6);
    expect(horizontalFovDeg(-50, "ff")).toBeCloseTo(horizontalFovDeg(12, "ff"), 6);
    expect(horizontalFovDeg(1000, "ff")).toBeCloseTo(horizontalFovDeg(200, "ff"), 6);
    expect(horizontalFovDeg(Number.NaN, "ff")).toBeCloseTo(horizontalFovDeg(50, "ff"), 6);

    expect(verticalFovDeg(0, "ff", "16:9")).toBeCloseTo(verticalFovDeg(12, "ff", "16:9"), 6);
    expect(verticalFovDeg(Number.NaN, "ff", "16:9")).toBeCloseTo(
      verticalFovDeg(50, "ff", "16:9"),
      6,
    );

    // 0 / 180 / 负角解不出可用焦距（分别是无穷远、零焦距、负焦距），回落到默认值。
    expect(focalFromHorizontalFovDeg(0, "ff")).toBe(50);
    expect(focalFromHorizontalFovDeg(180, "ff")).toBe(50);
    expect(focalFromHorizontalFovDeg(200, "ff")).toBe(50);
    expect(focalFromHorizontalFovDeg(-10, "ff")).toBe(50);
    expect(focalFromHorizontalFovDeg(Number.NaN, "ff")).toBe(50);
    // 170° 是合法角，解出来的 1.6 mm 却不是合法焦距——出口也得夹。
    expect(focalFromHorizontalFovDeg(170, "ff")).toBe(12);
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
      // 期望值从标签本身推，不从像素表推：否则拿像素表验像素表，写错也测不出来。
      const [labelWidth, labelHeight] = aspect.split(":").map(Number);
      expect(size.width / size.height).toBeCloseTo(labelWidth / labelHeight, 6);
      expect(aspectRatio(aspect)).toBeCloseTo(labelWidth / labelHeight, 6);
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

describe("lens stops and readouts", () => {
  it("reports the angle of view printed on a lens", () => {
    // 全画幅成像面高 24 mm：2·atan(12/50) ≈ 26.99°，四舍五入就是镜头表上的 27.0°。
    expect(sensorVerticalFovDeg(50, "ff")).toBeCloseTo(26.991, 3);
    // Super 35 更小，同一支 50 mm 只有 21.1°。
    expect(sensorVerticalFovDeg(50, "s35")).toBeCloseTo(21.1397, 3);
  });

  it("keeps every focal stop's readout on the documented value", () => {
    // 这张表就是创建对话框里「上一档 / 下一档」走过的全部读数，逐档钉死。
    const expected: Record<number, string> = {
      14: "81.2",
      18: "67.4",
      24: "53.1",
      35: "37.8",
      50: "27.0",
      85: "16.1",
      135: "10.2",
      200: "6.9",
    };
    for (const focal of PREVIZ_FOCAL_STOPS) {
      expect(sensorVerticalFovDeg(focal, "ff").toFixed(1)).toBe(expected[focal]);
    }
  });

  it("does not follow the output aspect the way the render fov does", () => {
    // 两者只在 3:2 附近相等。混用的后果是界面读数与实际取景对不上，所以这里钉一条
    // 反向断言：16:9 出片时 three 拿到的垂直角比镜头自身的纵向角小得多。
    expect(verticalFovDeg(50, "ff", "16:9")).toBeLessThan(sensorVerticalFovDeg(50, "ff"));
    expect(verticalFovDeg(50, "ff", "9:16")).toBeGreaterThan(sensorVerticalFovDeg(50, "ff"));
  });

  it("classifies focal lengths and apertures for the readout labels", () => {
    expect(PREVIZ_FOCAL_STOPS.map(focalClass)).toEqual([
      "ultrawide",
      "ultrawide",
      "wide",
      "standard",
      "standard",
      "teleShort",
      "tele",
      "tele",
    ]);
    expect(PREVIZ_APERTURE_STOPS.map(depthOfFieldClass)).toEqual([
      "shallow",
      "shallow",
      "standard",
      "standard",
      "standard",
      "deep",
      "deep",
      "deep",
      "deep",
    ]);
  });

  it("classifies hand-typed values between two stops", () => {
    // 属性面板允许敲任意值，分类不能只认档位表上的那几个数。
    expect(focalClass(63)).toBe("standard");
    expect(focalClass(19.9)).toBe("ultrawide");
    expect(depthOfFieldClass(3.5)).toBe("standard");
    expect(depthOfFieldClass(6)).toBe("deep");
  });

  it("walks the stop table one step at a time and stops at both ends", () => {
    expect(stepStop(PREVIZ_FOCAL_STOPS, 50, 1)).toBe(85);
    expect(stepStop(PREVIZ_FOCAL_STOPS, 50, -1)).toBe(35);
    expect(stepStop(PREVIZ_FOCAL_STOPS, 14, -1)).toBe(14);
    expect(stepStop(PREVIZ_FOCAL_STOPS, 200, 1)).toBe(200);
    expect(stepStop(PREVIZ_APERTURE_STOPS, 2.8, 1)).toBe(4);
  });

  it("snaps a value that is not on the table to the nearest stop first", () => {
    // 63 mm 离 50 更近（13）than 85（22），所以「上一档」是 35 而不是 50。
    expect(stepStop(PREVIZ_FOCAL_STOPS, 63, -1)).toBe(35);
    expect(stepStop(PREVIZ_FOCAL_STOPS, 63, 1)).toBe(85);
    // 非有限值没有「最近的一档」，落到首档再挪。
    expect(stepStop(PREVIZ_FOCAL_STOPS, Number.NaN, 1)).toBe(18);
  });
});
