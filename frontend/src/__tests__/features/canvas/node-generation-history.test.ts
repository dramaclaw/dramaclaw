// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  hasCompletedHistoryRecords,
  historyRecordHtmlIdentity,
} from "@/features/canvas/ui/NodeGenerationHistory";
import type { FreezoneGenerationHistoryRecord } from "@/api/ops";

function record(status: string): FreezoneGenerationHistoryRecord {
  return { id: `r-${status}`, status, recorded_at: "2026-06-15T00:00:00Z" } as unknown as FreezoneGenerationHistoryRecord;
}

describe("hasCompletedHistoryRecords", () => {
  it("is false with no records", () => {
    expect(hasCompletedHistoryRecords([])).toBe(false);
  });

  it("is false when every record is failed/pending (the empty-box bug case)", () => {
    expect(hasCompletedHistoryRecords([record("failed"), record("pending")])).toBe(false);
  });

  it("is true when at least one record completed/succeeded", () => {
    expect(hasCompletedHistoryRecords([record("failed"), record("completed")])).toBe(true);
    expect(hasCompletedHistoryRecords([record("succeeded")])).toBe(true);
  });
});

describe("historyRecordHtmlIdentity", () => {
  it("recognizes an HTML Artifact result without requiring a media URL", () => {
    const value = {
      ...record("completed"),
      media_type: "html",
      result: { artifact_id: "page-a", version: 3, title: "Page" },
    } as FreezoneGenerationHistoryRecord;
    expect(historyRecordHtmlIdentity(value)).toEqual({ artifactId: "page-a", version: 3 });
  });

  it("rejects malformed or non-HTML results", () => {
    expect(historyRecordHtmlIdentity(record("completed"))).toBeNull();
  });
});
