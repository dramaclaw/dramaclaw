// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_PRIMITIVE_SHAPES,
  isPrevizPrimitiveShape,
  previzPrimitiveNameKey,
} from "@/features/previz/domain/primitives";

describe("previz primitive catalogue", () => {
  // 键序就是模型库里卡片的展示顺序，写成字面量：跟着被测模块一起变的断言等于没有断言。
  it("lists the eight shapes in display order", () => {
    expect(Object.keys(PREVIZ_PRIMITIVE_SHAPES)).toEqual([
      "cube",
      "sphere",
      "cylinder",
      "cone",
      "plane",
      "capsule",
      "wedge",
      "torus",
    ]);
  });

  // 面数是否等于真实几何体，由 primitive-builder.test.ts 拿真 three 核对；这里只挡住
  // 手滑写成 0、负数或小数。
  it("gives every shape a positive whole triangle count", () => {
    for (const [shape, spec] of Object.entries(PREVIZ_PRIMITIVE_SHAPES)) {
      expect(Number.isInteger(spec.triangles), shape).toBe(true);
      expect(spec.triangles, shape).toBeGreaterThan(0);
    }
  });

  it("recognises every catalogue shape", () => {
    for (const shape of Object.keys(PREVIZ_PRIMITIVE_SHAPES)) {
      expect(isPrevizPrimitiveShape(shape), shape).toBe(true);
    }
  });

  // 与 scene.ts 的 isMember 同一个坑：`in` 会把原型链上的键也认成合法形状。
  it("rejects prototype keys, other casings and non-strings", () => {
    for (const value of ["constructor", "toString", "__proto__", "Cube", "", 42, null, undefined]) {
      expect(isPrevizPrimitiveShape(value), String(value)).toBe(false);
    }
  });

  it("names each shape under previz.library.primitive", () => {
    expect(previzPrimitiveNameKey("wedge")).toBe("previz.library.primitive.wedge");
  });
});
