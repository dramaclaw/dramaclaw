// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { characterMainCopyForSpineTemplate } from "@/lib/character-main-copy";

// 只回显 key，断言选中的是哪一组文案，不依赖具体译文。
const echoKey = ((key: string) => key) as unknown as TFunction;

describe("characterMainCopyForSpineTemplate", () => {
  it("uses plain protagonist copy for premium drama projects", () => {
    expect(characterMainCopyForSpineTemplate("drama", echoKey)).toMatchObject({
      label: "character.main.drama.label",
      makeMain: "character.main.drama.makeMain",
      unsetMain: "character.main.drama.unsetMain",
      mainSet: "character.main.drama.mainSet",
      mainUnset: "character.main.drama.mainUnset",
    });
  });

  it("uses narrator protagonist copy for narrated projects", () => {
    expect(characterMainCopyForSpineTemplate("narrated", echoKey)).toMatchObject({
      label: "character.main.narrated.label",
      makeMain: "character.main.narrated.makeMain",
      unsetMain: "character.main.narrated.unsetMain",
      mainSet: "character.main.narrated.mainSet",
      mainUnset: "character.main.narrated.mainUnset",
    });
  });
});
