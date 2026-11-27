// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

// Canonical protocol values stay in Chinese; only display labels are translated.
// i18n-exempt-start: backend CanonicalTimeOfDay values
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
