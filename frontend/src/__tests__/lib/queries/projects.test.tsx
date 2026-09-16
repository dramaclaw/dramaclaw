import { describe, expect, it } from "vitest";

import { normalizeUserSearchQuery } from "@/lib/queries/projects";

describe("normalizeUserSearchQuery", () => {
  it("removes pinyin separators while preserving the username characters", () => {
    expect(normalizeUserSearchQuery("  huang'jiao  ")).toBe("huangjiao");
  });
});
