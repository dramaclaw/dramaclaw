// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import {
  markCurrentReleaseSeen,
  markUpgradeSeen,
  markUpgradeSkipped,
  releaseSeenKey,
  releaseUpgradeKey,
  shouldAutoShowCurrentRelease,
  shouldShowUpgradeNudge,
  RELEASE_NOTIFICATIONS_MUTED_KEY,
} from "@/lib/release-notification-state";
import type { ReleaseFeed } from "@/lib/queries/release-notifications";

const baseFeed: ReleaseFeed = {
  source: "local_file+github",
  current_version: "1.0.2",
  current_tag: "v1.0.2",
  current_items: [
    {
      id: "release:v1.0.2:abc12345",
      kind: "release",
      icon: "sparkles",
      title: "Current",
      body: "Body",
    },
  ],
  update_available: true,
  latest_version: "1.0.5",
  latest_tag: "v1.0.5",
  release_url: "https://example.test/v1.0.5",
  update_items: [],
  attention: "medium",
  latest_published_at: "2026-07-01T08:00:00Z",
};

describe("release notification local state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps current-release and upgrade keys separate", () => {
    expect(releaseSeenKey("v1.0.5")).toBe("dramaclaw:release-seen:v1.0.5");
    expect(releaseUpgradeKey("v1.0.5")).toBe("dramaclaw:release-upgrade:v1.0.5");

    markUpgradeSeen("v1.0.5");

    expect(shouldAutoShowCurrentRelease({ ...baseFeed, current_tag: "v1.0.5" })).toBe(true);
    expect(shouldShowUpgradeNudge(baseFeed)).toBe(false);
  });

  it("auto-shows current release once and never constructs null-tag keys", () => {
    expect(shouldAutoShowCurrentRelease(baseFeed)).toBe(true);

    markCurrentReleaseSeen(baseFeed.current_tag);

    expect(localStorage.getItem("dramaclaw:release-seen:v1.0.2")).toBe("seen");
    expect(shouldAutoShowCurrentRelease(baseFeed)).toBe(false);
    expect(releaseSeenKey(null)).toBeNull();
    expect(releaseUpgradeKey(null)).toBeNull();

    markCurrentReleaseSeen(null);
    markUpgradeSeen(null);
    markUpgradeSkipped(null);

    expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i))).not.toContain(
      "dramaclaw:release-seen:null",
    );
  });

  it("routes upgrade red-dot state by attention, seen/skipped, null tags, and muted flag", () => {
    expect(shouldShowUpgradeNudge({ ...baseFeed, attention: "low" })).toBe(false);
    expect(shouldShowUpgradeNudge({ ...baseFeed, attention: "medium" })).toBe(true);
    expect(shouldShowUpgradeNudge({ ...baseFeed, attention: "high" })).toBe(true);
    expect(shouldShowUpgradeNudge({ ...baseFeed, latest_tag: null })).toBe(false);

    markUpgradeSkipped(baseFeed.latest_tag);
    expect(shouldShowUpgradeNudge(baseFeed)).toBe(false);

    localStorage.clear();
    markUpgradeSeen(baseFeed.latest_tag);
    expect(shouldShowUpgradeNudge(baseFeed)).toBe(false);

    localStorage.clear();
    localStorage.setItem(RELEASE_NOTIFICATIONS_MUTED_KEY, "true");
    expect(shouldAutoShowCurrentRelease(baseFeed)).toBe(false);
    expect(shouldShowUpgradeNudge(baseFeed)).toBe(false);
  });
});
