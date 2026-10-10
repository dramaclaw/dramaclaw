// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_CHARACTER_RADIUS_M,
  clampToBounds,
  propWorldBox,
  pushOutOfBoxes,
  type PrevizXZBox,
} from "@/features/previz/domain/moveAssist";

/** 以原点为心、边长 2 的方盒。 */
const UNIT_BOX: PrevizXZBox = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };

describe("propWorldBox", () => {
  it("scales the local half-extents and moves the box onto this frame's position", () => {
    const box = propWorldBox({ id: "p", halfX: 0.5, halfZ: 2 }, [3, 0, 2], [2, 1, 1]);

    expect(box).toEqual({ minX: 2, maxX: 4, minZ: 0, maxZ: 4 });
  });

  // 镜像摆放（scale.x = -1）是合法场景数据。不取绝对值的话 minX > maxX，盒子翻过来，
  // 「在里面」永远判不成立，而推开会算出反方向——人被吸进道具里。
  it("never turns the box inside out for a mirrored prop", () => {
    const box = propWorldBox({ id: "p", halfX: 1, halfZ: 1 }, [0, 0, 0], [-1, 1, -1]);

    expect(box.minX).toBeLessThan(box.maxX);
    expect(box.minZ).toBeLessThan(box.maxZ);
  });

  // y 完全不参与：高度归高度策略管，两边的职责不能重叠。
  it("ignores the vertical axis entirely", () => {
    const low = propWorldBox({ id: "p", halfX: 1, halfZ: 1 }, [0, 0, 0], [1, 1, 1]);
    const high = propWorldBox({ id: "p", halfX: 1, halfZ: 1 }, [0, 9, 0], [1, 9, 1]);

    expect(high).toEqual(low);
  });
});

describe("pushOutOfBoxes", () => {
  it("leaves a point that already clears every box alone", () => {
    expect(pushOutOfBoxes([5, 0], 0.25, [UNIT_BOX])).toEqual([5, 0]);
  });

  it("pushes a point that is outside but too close out to exactly one radius", () => {
    const [x, z] = pushOutOfBoxes([1.1, 0], 0.25, [UNIT_BOX]);

    expect(x).toBeCloseTo(1.25, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it("pushes diagonally off a corner so both axes clear", () => {
    const [x, z] = pushOutOfBoxes([1.05, 1.05], 0.25, [UNIT_BOX]);

    expect(Math.hypot(x - 1, z - 1)).toBeCloseTo(0.25, 6);
    expect(x).toBeGreaterThan(1);
    expect(z).toBeGreaterThan(1);
  });

  it("lets a point trapped inside out through the nearest wall", () => {
    // (0.9, 0) 离 +X 边 0.1，离其余三边都更远。
    const [x, z] = pushOutOfBoxes([0.9, 0], 0.25, [UNIT_BOX]);

    expect(x).toBeCloseTo(1.25, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  // 四条边等距是退化情形，必须仍然推得出去——原地不动的话人会永远卡在道具正中央，
  // 而这正是「路径正好穿过桌子中心」时每一帧都会走到的那个点。
  it("still has a way out from the exact centre of a box", () => {
    const [x, z] = pushOutOfBoxes([0, 0], 0.25, [UNIT_BOX]);

    expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThan(1);
  });

  it("clears a point sitting exactly on the boundary", () => {
    // 圆心正压在边上时最近点就是它自己，距离 0，没有方向可推。留在边上等于没推。
    const [x] = pushOutOfBoxes([1, 0], 0.25, [UNIT_BOX]);

    expect(Math.abs(x)).toBeGreaterThan(1);
  });

  // 只扫一遍是刻意的：多轮松弛会让人在两个盒子的夹角里来回抖，而每帧抖动比偶尔擦一下
  // 墙角难看得多。这一条把「只扫一遍」连同它的代价一起钉死：两件道具之间只留 0.2 m 的
  // 缝，人（直径 0.5 m）被左边那件推进右边那件、再被右边那件推回左边那件里，最后停在
  // 第一个盒子内部——再扫一轮就会继续推。这不是缺陷漏网，是这个取舍的账面。
  it("makes a single pass over the boxes in order", () => {
    const left: PrevizXZBox = { minX: -1, maxX: 0, minZ: -1, maxZ: 1 };
    const right: PrevizXZBox = { minX: 0.2, maxX: 1.2, minZ: -1, maxZ: 1 };

    const [x] = pushOutOfBoxes([-0.1, 0], 0.25, [left, right]);

    // 从 -0.1 出发：出左盒到 0.25，再出右盒到 -0.05。动了，但没出去。
    expect(x).toBeCloseTo(-0.05, 6);
    expect(x).toBeGreaterThan(left.minX);
    expect(x).toBeLessThan(left.maxX);
  });

  it("returns the point untouched when there is nothing to avoid", () => {
    expect(pushOutOfBoxes([0.3, 0.4], 0.25, [])).toEqual([0.3, 0.4]);
  });
});

describe("clampToBounds", () => {
  const bounds = { minX: -6, maxX: 6, minZ: -6, maxZ: 6 };

  it("leaves a point inside the block alone", () => {
    expect(clampToBounds([1, 2], 0.25, bounds)).toEqual([1, 2]);
  });

  it("pulls a point outside the block back in by one radius", () => {
    expect(clampToBounds([100, -100], 0.25, bounds)).toEqual([5.75, -5.75]);
  });

  // 地块比人还窄时 `min + radius > max - radius`，直接 min/max 会把上下界夹反，
  // 结果反而跑到界外去。
  it("centres the point when the block is narrower than the character", () => {
    const narrow = { minX: -0.1, maxX: 0.1, minZ: -6, maxZ: 6 };

    const [x] = clampToBounds([100, 0], 0.25, narrow);

    expect(x).toBeCloseTo(0, 6);
  });
});

describe("PREVIZ_CHARACTER_RADIUS_M", () => {
  it("is a positive number of metres", () => {
    expect(PREVIZ_CHARACTER_RADIUS_M).toBeGreaterThan(0);
    expect(PREVIZ_CHARACTER_RADIUS_M).toBeLessThan(1);
  });
});
