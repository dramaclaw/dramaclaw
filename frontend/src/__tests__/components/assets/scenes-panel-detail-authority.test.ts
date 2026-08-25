// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { selectAuthoritativeSceneDetails } from "@/components/assets/scenes-panel";
import type { SceneAsset } from "@/types/scene";

const summary = [
  { name: "Hall", master_url: "/canonical/master.png?v=1" },
] as SceneAsset[];

describe("scene detail authority", () => {
  it("uses summary data only while authoritative details are unresolved", () => {
    expect(selectAuthoritativeSceneDetails(summary, undefined, false)).toBe(
      summary,
    );
  });

  it("does not treat an empty successful detail response as existing media", () => {
    expect(selectAuthoritativeSceneDetails(summary, [], true)).toBeNull();
  });

  it("uses the authoritative detail payload after it succeeds", () => {
    const details = [{ name: "Hall", master_url: null }] as SceneAsset[];
    expect(selectAuthoritativeSceneDetails(summary, details, true)).toBe(
      details,
    );
  });
});
