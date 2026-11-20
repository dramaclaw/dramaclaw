// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it } from "vitest";

import {
  PREVIZ_RECENT_LIMIT,
  readRecentLibraryIds,
  rememberRecentLibraryId,
} from "@/features/previz/domain/recentLibrary";

describe("recent library entries", () => {
  afterEach(() => localStorage.clear());

  it("keeps the newest first without duplicates", () => {
    rememberRecentLibraryId("a");
    rememberRecentLibraryId("b");
    rememberRecentLibraryId("a");

    expect(readRecentLibraryIds()).toEqual(["a", "b"]);
  });

  it("caps the list", () => {
    for (let i = 0; i < PREVIZ_RECENT_LIMIT + 3; i += 1) rememberRecentLibraryId(String(i));

    expect(readRecentLibraryIds()).toHaveLength(PREVIZ_RECENT_LIMIT);
    expect(readRecentLibraryIds()[0]).toBe(String(PREVIZ_RECENT_LIMIT + 2));
  });

  it("treats corrupt storage as empty", () => {
    localStorage.setItem("previz.library.recent", "{oops");

    expect(readRecentLibraryIds()).toEqual([]);
  });
});
