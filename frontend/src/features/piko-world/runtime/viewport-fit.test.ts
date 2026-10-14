// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { containWorldInViewport } from "./viewport-fit";

const world = { width: 2048, height: 1152 };

describe("Piko World viewport fit", () => {
  it("shows the complete map without cropping in a wide viewport", () => {
    expect(containWorldInViewport({ width: 2056, height: 1026 }, world)).toEqual({
      scale: 0.890625,
      x: 116,
      y: 0,
    });
  });

  it("centers the complete map when the viewport is taller than the map", () => {
    expect(containWorldInViewport({ width: 1280, height: 800 }, world)).toEqual({
      scale: 0.625,
      x: 0,
      y: 40,
    });
  });
});
