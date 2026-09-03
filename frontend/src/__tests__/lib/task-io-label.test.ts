// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";
import { taskIoLabel } from "@/lib/task-io-label";
import { zhT, enT } from "../helpers/i18n-fixtures";

const zh = zhT as unknown as (k: string, o?: Record<string, unknown>) => string;
const en = enT as unknown as (k: string, o?: Record<string, unknown>) => string;

describe("taskIoLabel", () => {
  it("localizes freezone source/target labels in English", () => {
    expect(taskIoLabel("草图 + 背景 + 身份/道具", en)).toBe(
      "Sketch + background + identities/props",
    );
    expect(taskIoLabel("当前分镜", en)).toBe("Current storyboard");
    expect(taskIoLabel("360 全景", en)).toBe("360° panorama");
  });

  it("renders identically to the source string in Chinese", () => {
    for (const raw of [
      "Beat 上下文",
      "Master + Reverse",
      "场景 Master + Reverse",
      "导演合成图",
      "背景",
      "当前背景",
      "背景候选",
      "输入参考",
      "草图 + 背景 + 身份/道具",
      "360 全景",
      "当前草图",
      "草图候选",
      "当前草图候选",
      "当前分镜",
      "分镜候选",
    ]) {
      expect(taskIoLabel(raw, zh)).toBe(raw);
    }
  });

  it("passes unknown labels through untouched", () => {
    expect(taskIoLabel("某个新标签", en)).toBe("某个新标签");
    expect(taskIoLabel("", en)).toBe("");
    expect(taskIoLabel(null, en)).toBe("");
    expect(taskIoLabel(undefined, en)).toBe("");
  });
});
