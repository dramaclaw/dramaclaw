// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PROJECT_NAME_MAX_LENGTH,
  getProjectNameValidationKey,
} from "@/routes/_app/index";

describe("项目名称长度校验", () => {
  it.each(["万事屋", "中文项目_2026", "Drama中文", "中".repeat(64), "胡来万事屋- 副本", "《弥寿计划》Ⅱ- 副本", "项目😀"])(
    "接受中文项目名 %s", (name) => {
      expect(getProjectNameValidationKey(name)).toBeNull();
    },
  );

  it.each(["", "_中文", "项目/目录", "../项目", "   ", "a|b", "项目\n", ".", ".."])(
    "拒绝非法项目名 %s", (name) => {
      expect(getProjectNameValidationKey(name)).toBe("project.nameInvalid");
    },
  );

  it("拒绝 65 个中文字符", () => {
    expect(getProjectNameValidationKey("中".repeat(65))).toBe("project.nameTooLong");
  });

  it("接受 64 字符名称", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(64);
    expect(getProjectNameValidationKey("a".repeat(64))).toBeNull();
  });

  it("拒绝 65 字符名称", () => {
    expect(getProjectNameValidationKey("a".repeat(65))).toBe("project.nameTooLong");
  });
});
