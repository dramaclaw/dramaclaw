// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PENDING_OUTLINE_METADATA_KEY,
  parsePendingStoryOutline,
} from "@/features/canvas/story/pendingStoryOutline";

function validOutline(records: Record<string, unknown> = {}) {
  return {
    schema_version: "pending_story_outline.v1",
    outline_id: "outline-round-1",
    kind: "story",
    title: "雨夜出租车",
    premise: "司机接到一位自称来自十年前的乘客。",
    plot_summary: "三幕结构，两条分支在加油站汇合。",
    interaction_summary: "两个选择点。",
    endings_summary: "双结局。",
    duration_budget_sec: 240,
    open_questions: ["画风待确认"],
    status: "pending",
    story_id: null,
    updated_at: "2026-09-21T00:00:00+00:00",
    ...records,
  };
}

describe("parsePendingStoryOutline", () => {
  it("parses the backend v1 slot written into canvas metadata", () => {
    const parsed = parsePendingStoryOutline({
      [PENDING_OUTLINE_METADATA_KEY]: validOutline(),
      shotMetadata: { angle: "low" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.outline_id).toBe("outline-round-1");
    expect(parsed?.status).toBe("pending");
    expect(parsed?.duration_budget_sec).toBe(240);
    expect(parsed?.open_questions).toEqual(["画风待确认"]);
  });

  it("keeps optional fields fail-soft", () => {
    const slot = validOutline();
    delete (slot as Record<string, unknown>).interaction_summary;
    delete (slot as Record<string, unknown>).duration_budget_sec;
    (slot as Record<string, unknown>).open_questions = ["ok", 42, "  "];
    const parsed = parsePendingStoryOutline({ [PENDING_OUTLINE_METADATA_KEY]: slot });
    expect(parsed?.interaction_summary).toBe("");
    expect(parsed?.duration_budget_sec).toBeNull();
    expect(parsed?.open_questions).toEqual(["ok"]);
  });

  it("accepts every lifecycle status the backend writes", () => {
    for (const status of ["pending", "needs_revision", "confirmed", "linked"]) {
      const parsed = parsePendingStoryOutline({
        [PENDING_OUTLINE_METADATA_KEY]: validOutline({
          status,
          story_id: status === "linked" ? "story-1" : null,
        }),
      });
      expect(parsed?.status).toBe(status);
    }
  });

  it("returns null for missing, malformed or unknown-schema slots", () => {
    expect(parsePendingStoryOutline(null)).toBeNull();
    expect(parsePendingStoryOutline(undefined)).toBeNull();
    expect(parsePendingStoryOutline({})).toBeNull();
    expect(parsePendingStoryOutline({ [PENDING_OUTLINE_METADATA_KEY]: "x" })).toBeNull();
    expect(
      parsePendingStoryOutline({
        [PENDING_OUTLINE_METADATA_KEY]: validOutline({ schema_version: "v2" }),
      }),
    ).toBeNull();
    expect(
      parsePendingStoryOutline({
        [PENDING_OUTLINE_METADATA_KEY]: validOutline({ status: "confirmed_by_agent" }),
      }),
    ).toBeNull();
    expect(
      parsePendingStoryOutline({
        [PENDING_OUTLINE_METADATA_KEY]: validOutline({ title: "  " }),
      }),
    ).toBeNull();
    expect(
      parsePendingStoryOutline({
        [PENDING_OUTLINE_METADATA_KEY]: validOutline({ kind: "documentary" }),
      }),
    ).toBeNull();
  });
});
