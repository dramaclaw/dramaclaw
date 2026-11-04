// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { enTranslation, zhT, zhTranslation } from "@/__tests__/helpers/i18n-fixtures";
import {
  isPikoMapId,
  PIKO_MAP_TRANSITIONS,
  pikoMapSubtitleKey,
  pikoMapTitleKey,
} from "./piko-map-transitions";

describe("Piko map transition definitions", () => {
  it("registers one transition title for every planned map", () => {
    expect(Object.keys(PIKO_MAP_TRANSITIONS)).toHaveLength(17);
    expect(new Set(Object.values(PIKO_MAP_TRANSITIONS).map(({ src }) => src)).size).toBe(
      17,
    );
  });

  it("keeps every registered title in the public runtime bundle", () => {
    for (const definition of Object.values(PIKO_MAP_TRANSITIONS)) {
      expect(existsSync(`public${definition.src}`), definition.src).toBe(true);
    }
  });

  it("keeps the approved Welcome Courtyard copy", () => {
    expect(zhT(pikoMapTitleKey("welcome-courtyard"))).toBe("初遇庭院");
    expect(zhT(pikoMapSubtitleKey("welcome-courtyard"))).toBe("风从泉水边带来问候");
  });

  it("translates every map title and subtitle in each locale", () => {
    for (const translation of [zhTranslation, enTranslation] as Array<Record<string, unknown>>) {
      const maps = (translation.pikoWorld as { maps: Record<string, Record<string, string>> }).maps;
      expect(Object.keys(maps).sort()).toEqual(Object.keys(PIKO_MAP_TRANSITIONS).sort());
      for (const copy of Object.values(maps)) {
        expect(copy.title).toBeTruthy();
        expect(copy.subtitle).toBeTruthy();
      }
    }
  });

  it("narrows only known map ids", () => {
    expect(isPikoMapId("welcome-courtyard")).toBe(true);
    expect(isPikoMapId("unknown-map")).toBe(false);
  });
});
