// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/features/companion/petdex/PetGalleryDialog.tsx",
  "utf8",
);
const zh = JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8"));

describe("pet gallery grouping contract", () => {
  it("stacks official companions before the peripheral collection", () => {
    const officialSection = source.indexOf('aria-labelledby="official-companions-heading"');
    const peripheralSection = source.indexOf('aria-labelledby="peripheral-companions-heading"');

    expect(officialSection).toBeGreaterThan(-1);
    expect(peripheralSection).toBeGreaterThan(officialSection);
    expect(source).toContain('OFFICIAL_COMPANION_SLUGS = new Set(["zhizhi"])');
    expect(source).toContain("officialPets.map");
    expect(source).toContain("peripheralPets.map");
  });

  it("uses localized category labels and equal two-column cards", () => {
    expect(zh.myBuddy.gallery.officialGroup).toBe("官方搭子");
    expect(zh.myBuddy.gallery.peripheralGroup).toBe("周边搭子");
    expect(source.match(/grid grid-cols-2 gap-3/g)).toHaveLength(2);
    expect(source).toContain("max-w-[568px]");
    expect(source).not.toContain('className="h-px flex-1 bg-white/[0.07]"');
  });
});
