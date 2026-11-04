// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { previzSnapOffset, type PrevizSnapBox } from "@/features/previz/domain/snap";

const BOTH = { x: true, z: true };

function box(minX: number, maxX: number, minZ: number, maxZ: number): PrevizSnapBox {
  return { minX, maxX, minZ, maxZ };
}

describe("previzSnapOffset", () => {
  // 两块 4×10 的马路：手上这块拖到另一块 +Z 那头，留了 0.3 m 的缝、X 上错开 0.2 m。
  it("butts a road tile against its neighbour and lines the sides up", () => {
    const offset = previzSnapOffset(box(0.2, 4.2, 10.3, 20.3), [box(0, 4, 0, 10)], 0.5, BOTH);

    expect(offset.dx).toBeCloseTo(-0.2);
    expect(offset.dz).toBeCloseTo(-0.3);
  });

  it("pulls an overlapping tile back out to the edge", () => {
    const offset = previzSnapOffset(box(0, 4, 9.8, 19.8), [box(0, 4, 0, 10)], 0.5, BOTH);

    expect(offset.dz).toBeCloseTo(0.2);
  });

  it("leaves the tile alone when nothing is within the threshold", () => {
    expect(previzSnapOffset(box(0, 4, 11, 21), [box(0, 4, 0, 10)], 0.5, BOTH)).toEqual({
      dx: 0,
      dz: 0,
    });
  });

  it("picks the closest edge when several are in range", () => {
    const others = [box(0, 4, 0, 10), box(0, 4.1, 10, 20)];

    const offset = previzSnapOffset(box(4.3, 8.3, 0, 10), others, 0.5, { x: true, z: false });

    expect(offset.dx).toBeCloseTo(-0.2);
  });

  // 十米开外、不在一条线上的物件，边缘坐标碰巧接近也不该把手上这块拽过去。
  it("ignores props that are not next to it on the other axis", () => {
    expect(previzSnapOffset(box(4.2, 8.2, 0, 10), [box(0, 4, 30, 40)], 0.5, BOTH)).toEqual({
      dx: 0,
      dz: 0,
    });
  });

  it("respects the axes being dragged", () => {
    const offset = previzSnapOffset(box(0.2, 4.2, 10.3, 20.3), [box(0, 4, 0, 10)], 0.5, {
      x: false,
      z: true,
    });

    expect(offset.dx).toBe(0);
    expect(offset.dz).toBeCloseTo(-0.3);
  });
});
