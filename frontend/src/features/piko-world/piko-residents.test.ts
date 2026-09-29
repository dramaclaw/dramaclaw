// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PIKO_RESIDENT_ID,
  PIKO_RESIDENT_OPTIONS,
  resolvePikoResidentId,
} from "./piko-residents";

describe("Piko resident selection", () => {
  it("provides ten unique resident presets", () => {
    expect(PIKO_RESIDENT_OPTIONS).toHaveLength(10);
    expect(new Set(PIKO_RESIDENT_OPTIONS.map((resident) => resident.id)).size).toBe(10);
  });

  it("keeps every resident image available in the public runtime bundle", () => {
    for (const resident of PIKO_RESIDENT_OPTIONS) {
      expect(existsSync(`public${resident.src}`), resident.src).toBe(true);
    }
  });

  it("restores only known resident ids", () => {
    expect(DEFAULT_PIKO_RESIDENT_ID).toBe("m01");
    expect(resolvePikoResidentId("f05")).toBe("f05");
    expect(resolvePikoResidentId("unknown")).toBe(DEFAULT_PIKO_RESIDENT_ID);
    expect(resolvePikoResidentId(null)).toBe(DEFAULT_PIKO_RESIDENT_ID);
  });
});

import { PIKO_PLAYABLE_RESIDENTS, isPlayablePikoResident, resolvePlayablePikoResident } from "./piko-residents";

it("offers only complete motion atlases for playable residents", () => {
  expect(Object.keys(PIKO_PLAYABLE_RESIDENTS)).toEqual(["m01", "f01"]);
  for (const src of Object.values(PIKO_PLAYABLE_RESIDENTS)) expect(existsSync(`public${src}`)).toBe(true);
  expect(isPlayablePikoResident("f01")).toBe(true);
  expect(isPlayablePikoResident("f05")).toBe(false);
  expect(resolvePlayablePikoResident("f05")).toBe("m01");
});
