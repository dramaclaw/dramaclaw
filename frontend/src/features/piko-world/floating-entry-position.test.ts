// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  clampFloatingEntryPosition,
  normalizeFloatingEntryPosition,
  restoreFloatingEntryPosition,
} from "./floating-entry-position";

describe("Piko World floating entry position", () => {
  const viewport = { width: 1280, height: 720 };
  const entry = { width: 168, height: 40 };

  it("keeps the entry inside the viewport", () => {
    expect(clampFloatingEntryPosition({ left: 2000, top: 900 }, viewport, entry)).toEqual({
      left: 1100,
      top: 668,
    });
    expect(clampFloatingEntryPosition({ left: -30, top: -20 }, viewport, entry)).toEqual({
      left: 12,
      top: 12,
    });
  });

  it("restores a persisted proportional position", () => {
    const normalized = normalizeFloatingEntryPosition({ left: 960, top: 540 }, viewport);
    expect(restoreFloatingEntryPosition(normalized, viewport, entry)).toEqual({
      left: 960,
      top: 540,
    });
  });
});
