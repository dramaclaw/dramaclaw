// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { sceneTypeLabel, sceneTypeOptions } from "@/lib/scene-type";

import { zhT } from "../helpers/i18n-fixtures";

describe("scene type labels", () => {
  it("renders canonical scene type values through i18n", () => {
    expect(sceneTypeOptions(null, zhT)).toEqual([
      { value: "interior", label: "室内" },
      { value: "exterior", label: "室外" },
      { value: "mixed", label: "室内外" },
      { value: "other", label: "其他" },
    ]);
    expect(sceneTypeLabel("interior", zhT)).toBe("室内");
    expect(sceneTypeLabel("exterior", zhT)).toBe("室外");
  });

  it("keeps unknown legacy values readable", () => {
    expect(sceneTypeLabel("underground", zhT)).toBe("underground");
    expect(sceneTypeLabel("", zhT)).toBe("");
    // 项目自扩的类型要能选中，不能因为不在规范表里就从下拉里消失
    expect(sceneTypeOptions("underground", zhT)).toContainEqual({
      value: "underground",
      label: "underground",
    });
  });
});
