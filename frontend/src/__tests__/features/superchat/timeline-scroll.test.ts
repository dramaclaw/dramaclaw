// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { calculateTimelineContextDelta } from "@/features/superchat/timeline-scroll";

describe("calculateTimelineContextDelta", () => {
  it("reveals hidden context only when the selected node enters an edge zone", () => {
    expect(calculateTimelineContextDelta({
      viewportHeight: 400,
      nodeCenter: 40,
      scrollTop: 200,
      scrollHeight: 1000,
    })).toBe(-48);
    expect(calculateTimelineContextDelta({
      viewportHeight: 400,
      nodeCenter: 360,
      scrollTop: 200,
      scrollHeight: 1000,
    })).toBe(48);
    expect(calculateTimelineContextDelta({
      viewportHeight: 400,
      nodeCenter: 200,
      scrollTop: 200,
      scrollHeight: 1000,
    })).toBe(0);
  });

  it("does not move beyond the real start or end of the timeline", () => {
    expect(calculateTimelineContextDelta({
      viewportHeight: 400,
      nodeCenter: 40,
      scrollTop: 0,
      scrollHeight: 1000,
    })).toBe(0);
    expect(calculateTimelineContextDelta({
      viewportHeight: 400,
      nodeCenter: 360,
      scrollTop: 600,
      scrollHeight: 1000,
    })).toBe(0);
  });
});
