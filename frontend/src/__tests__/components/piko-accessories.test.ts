// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PIKO_ACCESSORIES,
  PIKO_ACCESSORY_DISPLAY_OPTIONS,
} from "@/features/companion/piko-accessories";

describe("Piko accessories", () => {
  it("places Niu Lai before the Great Sage accessory", () => {
    const ids = PIKO_ACCESSORY_DISPLAY_OPTIONS.map(({ id }) => id);

    expect(ids.indexOf("piko-accessory-niulai")).toBe(
      ids.indexOf("piko-accessory-golden-hoop-staff") - 1,
    );
  });

  it("places Niu Lai at normal size to Piko's left with the sword's action binding", () => {
    const niulai = PIKO_ACCESSORIES["piko-accessory-niulai"];
    const sword = PIKO_ACCESSORIES["piko-accessory-cyan-energy-sword"];

    expect(niulai).toMatchObject({ slot: "front", x: -42, y: 0, size: 42 });
    expect(niulai.disabledActions).toEqual(sword.disabledActions);
  });
});
