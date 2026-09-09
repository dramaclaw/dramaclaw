// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

/**
 * 场景类型的 value 是协议（后端存的就是 interior/exterior/...），label 只是界面文案，
 * 所以这里只留 value → key 的映射，中文/英文由调用方带 t 进来解析。认不出的 value
 * （项目自己扩的类型）原样显示。
 */
const SCENE_TYPE_LABEL_KEYS: Record<string, string> = {
  interior: "assets.scenes.types.interior",
  exterior: "assets.scenes.types.exterior",
  mixed: "assets.scenes.types.mixed",
  other: "assets.scenes.types.other",
};

export const SCENE_TYPE_VALUES = ["interior", "exterior", "mixed", "other"] as const;

export function sceneTypeLabel(value: string | null | undefined, t: TFunction): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const key = SCENE_TYPE_LABEL_KEYS[trimmed];
  return key ? t(key) : trimmed;
}

export function sceneTypeOptions(
  value: string | null | undefined,
  t: TFunction,
): Array<{ value: string; label: string }> {
  const options = SCENE_TYPE_VALUES.map((item) => ({ value: item, label: sceneTypeLabel(item, t) }));
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed in SCENE_TYPE_LABEL_KEYS) return options;
  return [...options, { value: trimmed, label: trimmed }];
}
