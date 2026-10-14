// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { axisGizmoDots } from "@/features/previz/domain/axisGizmo";
import type { PrevizAxisDot } from "@/features/previz/domain/axisGizmo";
import { PREVIZ_DEFAULT_VIEW, PREVIZ_VIEW_DIRECTIONS } from "@/features/previz/domain/view";
import type { PrevizViewDirection } from "@/features/previz/domain/view";

/** 从注视点望向 `direction` 那一侧的机位，距离随便取，投影只看方向。 */
const VIEWS = {
  front: { position: [0, 0, 10], target: [0, 0, 0] },
  back: { position: [0, 0, -10], target: [0, 0, 0] },
  right: { position: [10, 0, 0], target: [0, 0, 0] },
  left: { position: [-10, 0, 0], target: [0, 0, 0] },
  top: { position: [0, 10, 0], target: [0, 0, 0] },
  bottom: { position: [0, -10, 0], target: [0, 0, 0] },
} satisfies Record<PrevizViewDirection, { position: [number, number, number]; target: [number, number, number] }>;

function dotFor(dots: readonly PrevizAxisDot[], direction: PrevizViewDirection): PrevizAxisDot {
  const found = dots.find((dot) => dot.direction === direction);
  if (!found) throw new Error(`no dot for ${direction}`);
  return found;
}

describe("axisGizmoDots", () => {
  it("gives every half-axis exactly one dot", () => {
    const dots = axisGizmoDots(PREVIZ_DEFAULT_VIEW);

    expect(dots).toHaveLength(6);
    expect([...dots].map((dot) => dot.direction).sort()).toEqual([...PREVIZ_VIEW_DIRECTIONS].sort());
    // 三根轴各一正一负：写错映射（比如把 +X 接到 left）在这里现形。
    expect(dotFor(dots, "right")).toMatchObject({ axis: "x", positive: true });
    expect(dotFor(dots, "left")).toMatchObject({ axis: "x", positive: false });
    expect(dotFor(dots, "top")).toMatchObject({ axis: "y", positive: true });
    expect(dotFor(dots, "bottom")).toMatchObject({ axis: "y", positive: false });
    expect(dotFor(dots, "front")).toMatchObject({ axis: "z", positive: true });
    expect(dotFor(dots, "back")).toMatchObject({ axis: "z", positive: false });
  });

  // 站在 +Z 上看原点：+Z 这颗球正对着观众，应当落在正中央、深度最深；+X 在右、+Y 在上。
  it("puts the axis you are looking down in the middle", () => {
    const dots = axisGizmoDots(VIEWS.front);

    const front = dotFor(dots, "front");
    expect(front.x).toBeCloseTo(0, 6);
    expect(front.y).toBeCloseTo(0, 6);
    expect(front.depth).toBeCloseTo(1, 6);

    expect(dotFor(dots, "right")).toMatchObject({ x: expect.closeTo(1, 6), y: expect.closeTo(0, 6) });
    // y 向下，所以「屏幕上方」是负数。
    expect(dotFor(dots, "top").y).toBeCloseTo(-1, 6);
    expect(dotFor(dots, "bottom").y).toBeCloseTo(1, 6);
    expect(dotFor(dots, "back").depth).toBeCloseTo(-1, 6);
  });

  // 从背面看，左右要跟着翻过来——否则用户转到人物背后时，点「右」会往左边跑。
  it("mirrors left and right when the camera swings behind the scene", () => {
    const dots = axisGizmoDots(VIEWS.back);

    expect(dotFor(dots, "right").x).toBeCloseTo(-1, 6);
    expect(dotFor(dots, "left").x).toBeCloseTo(1, 6);
    expect(dotFor(dots, "top").y).toBeCloseTo(-1, 6);
  });

  /*
    顶视图是退化情况：视线与世界 up 平行，`up × back` 是零向量，天真的实现整块面板会
    变成 NaN（六个球一起从画面上消失）。方向也得对上 `view.ts` 摆顶视图时那点 +Z 微倾：
    实际画面里 +X 朝右、+Z 朝下，小球必须跟着，不能自己另选一套。
  */
  it.each([
    ["top", VIEWS.top],
    ["bottom", VIEWS.bottom],
  ] as const)("keeps the %s view off the degenerate pole", (direction, view) => {
    const dots = axisGizmoDots(view);

    for (const dot of dots) {
      expect(Number.isFinite(dot.x), `${dot.direction}.x`).toBe(true);
      expect(Number.isFinite(dot.y), `${dot.direction}.y`).toBe(true);
      expect(Number.isFinite(dot.depth), `${dot.direction}.depth`).toBe(true);
    }

    expect(dotFor(dots, direction).depth).toBeCloseTo(1, 3);
    // 两个方向都是 +X 朝右：`view.ts` 的微倾对顶和底都加在 +Z 上。
    expect(dotFor(dots, "right").x).toBeCloseTo(1, 3);
  });

  it("puts +Z at the bottom of the top view and at the top of the bottom view", () => {
    expect(dotFor(axisGizmoDots(VIEWS.top), "front").y).toBeCloseTo(1, 3);
    expect(dotFor(axisGizmoDots(VIEWS.bottom), "front").y).toBeCloseTo(-1, 3);
  });

  // 排序就是画的先后：近的排在后面，DOM 里后画的盖住先画的。少了它，背面那半个坐标系
  // 会盖在正面这半个上，用户点到的和看到的不是同一颗。
  it("hands the dots back painter-ordered, far first", () => {
    const dots = axisGizmoDots(PREVIZ_DEFAULT_VIEW);

    const depths = dots.map((dot) => dot.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(dots[dots.length - 1].depth).toBeGreaterThan(0);
  });

  it("keeps +Y above the centre from the default three-quarter view", () => {
    const dots = axisGizmoDots(PREVIZ_DEFAULT_VIEW);

    expect(dotFor(dots, "top").y).toBeLessThan(0);
    expect(dotFor(dots, "bottom").y).toBeGreaterThan(0);
    // 默认机位在 +X +Z 一侧，这两颗都该朝观众。
    expect(dotFor(dots, "right").depth).toBeGreaterThan(0);
    expect(dotFor(dots, "front").depth).toBeGreaterThan(0);
  });

  /*
    上游把机位写坏时（相机停在注视点上、或者某个分量成了 NaN）宁可指错方向，也不能交出
    NaN：坐标是 NaN 的话六颗球全部掉出容器，用户面板上只剩一块空地，而这时视口画面本身
    多半还是好的——症状离病因隔得极远。
  */
  it.each([
    ["camera sitting on its own target", { position: [1, 2, 3], target: [1, 2, 3] }],
    ["a NaN in the pose", { position: [Number.NaN, 4, 8], target: [0, 1, 0] }],
    ["an infinite pose", { position: [Infinity, 4, 8], target: [0, 1, 0] }],
  ] as const)("still lays the dots out with %s", (_case, view) => {
    const dots = axisGizmoDots({ position: [...view.position], target: [...view.target] });

    expect(dots).toHaveLength(6);
    for (const dot of dots) {
      expect(Number.isFinite(dot.x) && Number.isFinite(dot.y) && Number.isFinite(dot.depth)).toBe(
        true,
      );
    }
    // 兜底方向是正视图。
    expect(dotFor(dots, "front").depth).toBeCloseTo(1, 6);
  });

  // 面板是个正方形的小格子，坐标必须留在 [-1, 1] 里，否则球会画到容器外面去。
  it("keeps every dot inside the unit square", () => {
    for (const view of Object.values(VIEWS)) {
      for (const dot of axisGizmoDots(view)) {
        expect(Math.abs(dot.x)).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(dot.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});
