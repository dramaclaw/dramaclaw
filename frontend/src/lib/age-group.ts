// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * 后端（identity_planner._normalize_age_group_value）把年龄段归一成这四个 code，
 * 生成数据里带的是 code 而不是中文，所以界面按 code 查词条就能跟着语言走。
 * 词条 key 里 youth 写作 young，是历史命名，别改动词条那边（老快照还在用）。
 */
export const AGE_GROUP_CODES = ["child", "youth", "middle", "elder"] as const;

export type AgeGroupCode = (typeof AGE_GROUP_CODES)[number];

const AGE_GROUP_LABEL_KEYS: Record<AgeGroupCode, string> = {
  child: "characters.ageGroups.child",
  youth: "characters.ageGroups.young",
  middle: "characters.ageGroups.middle",
  elder: "characters.ageGroups.elder",
};

export function isAgeGroupCode(value: string | null | undefined): value is AgeGroupCode {
  return AGE_GROUP_CODES.includes(String(value ?? "") as AgeGroupCode);
}

/** 认得的 code 返回本地化标签；认不得（老数据里直接存了中文）就原样回显。 */
export function ageGroupLabel(value: string | null | undefined, t: TFn): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return isAgeGroupCode(raw) ? t(AGE_GROUP_LABEL_KEYS[raw]) : raw;
}
