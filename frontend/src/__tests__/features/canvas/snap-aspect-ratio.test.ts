// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";

import {
  IMAGE_GENERATION_ASPECT_RATIOS,
  VIDEO_GENERATION_ASPECT_RATIOS,
  snapToAllowedAspectRatio,
} from "@/features/canvas/application/imageData";

const IMG = IMAGE_GENERATION_ASPECT_RATIOS;
const VID = VIDEO_GENERATION_ASPECT_RATIOS;

describe("snapToAllowedAspectRatio (image set)", () => {
  it("snaps a raw pixel-derived ratio to the closest allowed value", () => {
    // 1290x720 → reduced 43:24 ≈ 1.79 → closest is 16:9.
    expect(snapToAllowedAspectRatio("43:24", IMG, "1:1")).toBe("16:9");
  });

  it("keeps an already-allowed ratio unchanged", () => {
    expect(snapToAllowedAspectRatio("3:2", IMG, "1:1")).toBe("3:2");
    expect(snapToAllowedAspectRatio("4:5", IMG, "1:1")).toBe("4:5");
  });

  it("never emits a value outside the allowed set", () => {
    for (const raw of ["43:24", "7:3", "1248:704", "100:99", "2:1"]) {
      expect(IMG).toContain(snapToAllowedAspectRatio(raw, IMG, "1:1"));
    }
  });

  it("keeps 21:9 for images (issue #52: was wrongly snapped to 16:9)", () => {
    // The image node dropdown offers 21:9 and the backend preset set supports it,
    // so a user-picked 21:9 must survive submit untouched — not snap to 16:9.
    expect(IMG).toContain("21:9");
    expect(snapToAllowedAspectRatio("21:9", IMG, "1:1")).toBe("21:9");
  });

  it("resolves 'auto' / non-ratio input to the fallback", () => {
    expect(snapToAllowedAspectRatio("auto", IMG, "1:1")).toBe("1:1");
    expect(snapToAllowedAspectRatio("", IMG, "1:1")).toBe("1:1");
  });
});

describe("snapToAllowedAspectRatio (video set)", () => {
  it("includes 21:9 for video and keeps it", () => {
    expect(VID).toContain("21:9");
    expect(snapToAllowedAspectRatio("21:9", VID, "16:9")).toBe("21:9");
  });

  it("snaps a raw ratio to the closest allowed video value", () => {
    expect(snapToAllowedAspectRatio("1248:704", VID, "16:9")).toBe("16:9");
    // 3:2 ≈ 1.5 is not a video preset → closest is 4:3 (1.33), not 16:9 (1.78).
    expect(snapToAllowedAspectRatio("3:2", VID, "16:9")).toBe("4:3");
  });

  it("resolves 'auto' to the fallback", () => {
    expect(snapToAllowedAspectRatio("auto", VID, "16:9")).toBe("16:9");
  });
});
