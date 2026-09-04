// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isPikoMapId,
  PIKO_MAP_TRANSITIONS,
} from "./piko-map-transitions";

describe("Piko map transition definitions", () => {
  it("registers one transition title for every planned map", () => {
    expect(Object.keys(PIKO_MAP_TRANSITIONS)).toHaveLength(15);
    expect(new Set(Object.values(PIKO_MAP_TRANSITIONS).map(({ src }) => src)).size).toBe(
      15,
    );
  });

  it("keeps every registered title in the public runtime bundle", () => {
    for (const definition of Object.values(PIKO_MAP_TRANSITIONS)) {
      expect(existsSync(`public${definition.src}`), definition.src).toBe(true);
    }
  });

  it("keeps the approved Welcome Courtyard copy", () => {
    expect(PIKO_MAP_TRANSITIONS["welcome-courtyard"]).toMatchObject({
      title: "初遇庭院",
      subtitle: "风从泉水边带来问候",
    });
  });

  it("narrows only known map ids", () => {
    expect(isPikoMapId("welcome-courtyard")).toBe(true);
    expect(isPikoMapId("unknown-map")).toBe(false);
  });
});
