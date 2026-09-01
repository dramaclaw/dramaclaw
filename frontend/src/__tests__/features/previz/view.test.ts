// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_DEFAULT_VIEW,
  PREVIZ_VIEW_DIRECTIONS,
  boundsCenter,
  boundsRadius,
  framingDistance,
  unionBounds,
  viewPlacement,
} from "@/features/previz/domain/view";
import type { PrevizViewDirection } from "@/features/previz/domain/view";

/** three 的空 `Box3`：`makeEmpty()` 之后就是这副样子，取景路径上会真的收到它。 */
const EMPTY_BOX = {
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
} as const;

describe("bounds helpers", () => {
  it("takes the centre and the half-diagonal of a box", () => {
    const bounds = { min: [-1, 0, -1] as const, max: [1, 2, 1] as const };

    expect(boundsCenter(bounds)).toEqual([0, 1, 0]);
    // 半对角线而不是最长半边：用半边长会让立方体的角伸出取景框。
    expect(boundsRadius(bounds)).toBeCloseTo(Math.sqrt(3), 6);
  });

  // 上面那个盒子对称又居中，实现里把结果写死也能过；这个盒子三轴各不相同且偏离原点。
  it("follows an off-centre box with unequal extents", () => {
    const bounds = { min: [2, -4, 10] as const, max: [8, 0, 12] as const };

    expect(boundsCenter(bounds)).toEqual([5, -2, 11]);
    expect(boundsRadius(bounds)).toBeCloseTo(Math.sqrt(9 + 4 + 1), 6);
  });

  it("unions boxes and returns null for an empty list", () => {
    expect(unionBounds([])).toBeNull();
    expect(
      unionBounds([
        { min: [-1, -1, -1], max: [0, 0, 0] },
        { min: [1, 1, 1], max: [2, 3, 2] },
      ]),
    ).toEqual({ min: [-1, -1, -1], max: [2, 3, 2] });
  });

  // 一个没有几何体的对象会贡献一个空 Box3。让 ±∞ 进了并集，中心就是 NaN，
  // 相机被赋成 NaN 之后画面全黑，而报错点离病因隔着整个引擎层。
  it("skips unusable boxes when unioning", () => {
    expect(unionBounds([EMPTY_BOX])).toBeNull();
    expect(unionBounds([EMPTY_BOX, { min: [1, 1, 1], max: [2, 3, 2] }])).toEqual({
      min: [1, 1, 1],
      max: [2, 3, 2],
    });
  });

  it("collapses an unusable box to a point instead of yielding NaN", () => {
    expect(boundsCenter(EMPTY_BOX)).toEqual([0, 0, 0]);
    expect(boundsRadius(EMPTY_BOX)).toBe(0);
  });
});

describe("framingDistance", () => {
  it("backs off far enough for the tighter of the two axes", () => {
    // 16:9 下水平比垂直宽，垂直是紧的那一边，距离由垂直视场角决定。
    expect(framingDistance(1, 50, 16 / 9)).toBeCloseTo(2.9578, 3);
    // 9:16 反过来：水平是紧的那一边，同样半径要退得更远。
    expect(framingDistance(1, 50, 9 / 16)).toBeCloseTo(4.9268, 3);
    expect(framingDistance(2.5, 50, 1)).toBeCloseTo(7.3944, 3);
  });

  it("backs off less as the field of view widens", () => {
    // 90° 方形画幅：半角 45°，半径 1 的包围球在 √2 处正好切到视锥，再乘留白系数。
    expect(framingDistance(1, 90, 1)).toBeCloseTo(1.7678, 3);
    expect(framingDistance(1, 90, 1)).toBeLessThan(framingDistance(1, 50, 1));
  });

  // 180° 以上半角的正弦掉头变小，不钳上界的话 359°（半角 179.5°，正弦只剩 0.0087）
  // 会算出 143 这种「越广角退得越远」的距离。钳到 179° 之后它就是个贴脸的广角。
  it("clamps an absurdly wide field of view instead of backing away", () => {
    expect(framingDistance(1, 359, 1)).toBe(framingDistance(1, 179, 1));
    expect(framingDistance(1, 359, 1)).toBeCloseTo(1.25, 3);
    expect(framingDistance(1, 359, 1)).toBeLessThan(framingDistance(1, 50, 1));
  });

  it("never returns a degenerate distance for a zero-size target", () => {
    // 一盏灯的包围盒是个点。距离算成 0 会把相机塞进对象里，近裁面直接吃掉画面。
    expect(framingDistance(0, 50, 16 / 9)).toBeGreaterThanOrEqual(1);
  });

  // 视场角与画幅比都可能是上游算出来的：画布高度为 0 时 aspect 就是 Infinity。
  it("stays finite for non-finite inputs", () => {
    for (const distance of [
      framingDistance(NaN, 50, 16 / 9),
      framingDistance(1, NaN, 16 / 9),
      framingDistance(1, 0, 16 / 9),
      framingDistance(1, 180, 16 / 9),
      framingDistance(1, -50, 16 / 9),
      framingDistance(1, 50, NaN),
      framingDistance(1, 50, Infinity),
      framingDistance(1, 50, 0),
      framingDistance(-3, 50, 16 / 9),
    ]) {
      expect(Number.isFinite(distance)).toBe(true);
      expect(distance).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("viewPlacement", () => {
  const bounds = { min: [-1, 0, -1] as const, max: [1, 2, 1] as const };

  it("puts the camera on the requested axis, looking at the centre", () => {
    const front = viewPlacement("front", bounds, 50, 16 / 9);

    expect(front.target).toEqual([0, 1, 0]);
    expect(front.position[0]).toBeCloseTo(0, 6);
    expect(front.position[1]).toBeCloseTo(1, 6);
    // 正视图站在 +Z 一侧：three 的相机默认朝 -Z，从 +Z 看回原点才是「正面」。
    expect(front.position[2]).toBeCloseTo(framingDistance(Math.sqrt(3), 50, 16 / 9), 6);

    const left = viewPlacement("left", bounds, 50, 16 / 9);
    expect(left.position[0]).toBeLessThan(0);
    expect(left.position[1]).toBeCloseTo(1, 6);
    expect(left.position[2]).toBeCloseTo(0, 6);
  });

  // 六个方向各自站在自己的轴上，且都退到同一个取景距离——只对了正视图那一个方向的
  // 实现（比如把 back 也放到 +Z）在这里会红。
  it("places every direction on its own axis at the framing distance", () => {
    const distance = framingDistance(boundsRadius(bounds), 50, 16 / 9);
    const axes: Record<PrevizViewDirection, { index: 0 | 1 | 2; sign: 1 | -1 }> = {
      front: { index: 2, sign: 1 },
      back: { index: 2, sign: -1 },
      right: { index: 0, sign: 1 },
      left: { index: 0, sign: -1 },
      top: { index: 1, sign: 1 },
      bottom: { index: 1, sign: -1 },
    };

    for (const direction of PREVIZ_VIEW_DIRECTIONS) {
      const { index, sign } = axes[direction];
      const placement = viewPlacement(direction, bounds, 50, 16 / 9);

      expect(placement.target).toEqual([0, 1, 0]);
      expect(placement.position[index] - placement.target[index]).toBeCloseTo(sign * distance, 6);
    }
  });

  // 顶视图正上方站位会让 OrbitControls 的极角变成 0，它内部 makeSafe() 会夹到
  // 一个极小值并顺手把方位角归零 —— 表现是「点顶视图之后第一次拖拽画面猛地一跳」。
  // 给个可忽略的微倾就绕开了。
  it("tilts the top and bottom views off the pole", () => {
    const top = viewPlacement("top", bounds, 50, 16 / 9);

    expect(top.position[1]).toBeGreaterThan(1);
    expect(Math.abs(top.position[2])).toBeGreaterThan(0);
    expect(Math.abs(top.position[2])).toBeLessThan(0.05);

    const bottom = viewPlacement("bottom", bounds, 50, 16 / 9);
    expect(bottom.position[1]).toBeLessThan(1);
  });

  // 底视图的极角是 π，`makeSafe()` 在 π−EPS 那一端钳得一样狠，所以它同样不能正落在
  // −Y 极点上。两个极点共用同一个微倾，差别只在 Y 的符号。
  it("tilts the bottom view off the pole exactly like the top view", () => {
    const distance = framingDistance(boundsRadius(bounds), 50, 16 / 9);
    const top = viewPlacement("top", bounds, 50, 16 / 9);
    const bottom = viewPlacement("bottom", bounds, 50, 16 / 9);

    expect(Math.abs(bottom.position[2] - bottom.target[2])).toBeGreaterThan(0);
    expect(bottom.position[2]).toBeCloseTo(top.position[2], 12);
    expect(bottom.position[1] - bottom.target[1]).toBeCloseTo(-distance, 6);
    expect(top.position[1] - top.target[1]).toBeCloseTo(distance, 6);
  });

  // 微倾按距离成比例给，才能在大小场景里都是同一个「几乎看不出来」的角度：
  // 写成固定长度的话，小盒子会歪得很明显，大场景又退化回正极点。
  it("keeps the pole tilt proportional to the framing distance", () => {
    const big = viewPlacement("top", { min: [-10, -10, -10], max: [10, 10, 10] }, 50, 16 / 9);
    const small = viewPlacement("top", { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] }, 50, 16 / 9);

    const bigRatio = (big.position[2] - 0) / (big.position[1] - 0);
    const smallRatio = (small.position[2] - 0) / (small.position[1] - 0);
    expect(bigRatio).toBeCloseTo(smallRatio, 9);
    expect(bigRatio).toBeGreaterThan(0);
  });

  // 空场景聚焦（一个没几何体的对象、或者根本没选中东西）不该把 NaN 喂给相机。
  it("stays finite for an unusable box", () => {
    const placement = viewPlacement("front", EMPTY_BOX, 50, 16 / 9);

    expect(placement.target).toEqual([0, 0, 0]);
    expect(placement.position.every((value) => Number.isFinite(value))).toBe(true);
    expect(placement.position[2]).toBeGreaterThanOrEqual(1);
  });

  it("exposes all six directions and a default placement", () => {
    expect(PREVIZ_VIEW_DIRECTIONS).toEqual(["front", "back", "left", "right", "top", "bottom"]);
    // 默认机位与 PrevizRenderer.create() 里建相机时用的一致，别各写一份。
    expect(PREVIZ_DEFAULT_VIEW).toEqual({ position: [6, 4, 8], target: [0, 1, 0] });
  });
});
