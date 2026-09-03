// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import {
  STANDARD_TIME_OF_DAY_OPTIONS,
  timeOfDayLabel,
  timeOfDayOptions,
} from "@/lib/time-of-day";

describe("time-of-day helpers", () => {
  it("exposes the closed standard list without the none value", () => {
    expect(STANDARD_TIME_OF_DAY_OPTIONS).toEqual([
      "清晨",
      "上午",
      "正午",
      "午后",
      "白天",
      "黄昏",
      "夜晚",
    ]);
  });

  it("appends non-standard current values as legacy choices", () => {
    expect(timeOfDayOptions("亥时")).toEqual([
      "清晨",
      "上午",
      "正午",
      "午后",
      "白天",
      "黄昏",
      "夜晚",
      "亥时",
    ]);
  });

  it("labels empty and legacy values explicitly", () => {
    // 回显 key + 插值，断言映射到哪条文案，不依赖具体译文。
    const echoKey = ((key: string, opts?: Record<string, unknown>) =>
      opts?.value ? `${key}:${String(opts.value)}` : key) as unknown as TFunction;
    expect(timeOfDayLabel("", echoKey)).toBe("timeOfDay.none");
    expect(timeOfDayLabel("白天", echoKey)).toBe("timeOfDay.day");
    expect(timeOfDayLabel("夜晚", echoKey)).toBe("timeOfDay.night");
    expect(timeOfDayLabel("亥时", echoKey)).toBe("timeOfDay.scriptOriginal:亥时");
  });
});
