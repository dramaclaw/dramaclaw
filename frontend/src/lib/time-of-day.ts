// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

/**
 * 时间段的取值是协议：后端 `novelvideo/time_of_day.py` 的 CanonicalTimeOfDay 是这
 * 七个中文字面量，剧本原值也按中文存。所以数组本身不能翻，只有渲染出来的 label
 * 走 i18n —— 用 value → key 的映射，认不出的值（剧本原值）原样带出。
 */
// i18n-exempt-start: 协议值，与后端 CanonicalTimeOfDay 逐字对应，翻译会写坏数据
export const STANDARD_TIME_OF_DAY_OPTIONS = [
  "清晨",
  "上午",
  "正午",
  "午后",
  "白天",
  "黄昏",
  "夜晚",
] as const;

const TIME_OF_DAY_LABEL_KEYS: Record<string, string> = {
  清晨: "timeOfDay.dawn",
  上午: "timeOfDay.forenoon",
  正午: "timeOfDay.noon",
  午后: "timeOfDay.afternoon",
  白天: "timeOfDay.day",
  黄昏: "timeOfDay.dusk",
  夜晚: "timeOfDay.night",
};
// i18n-exempt-end

export function timeOfDayOptions(...values: Array<string | null | undefined>): string[] {
  const options: string[] = [...STANDARD_TIME_OF_DAY_OPTIONS];
  const seen = new Set<string>(options);
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    options.push(trimmed);
  }
  return options;
}

export function timeOfDayLabel(value: string | null | undefined, t: TFunction): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return t("timeOfDay.none");
  const key = TIME_OF_DAY_LABEL_KEYS[trimmed];
  return key ? t(key) : t("timeOfDay.scriptOriginal", { value: trimmed });
}
