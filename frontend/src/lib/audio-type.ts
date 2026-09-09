// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

const AUDIO_TYPE_LABEL_KEYS: Record<string, string> = {
  narration: "audioType.narration",
  dialogue: "audioType.dialogue",
};

export function audioTypeLabel(type: string | null | undefined, t: TFunction): string {
  if (!type) return "";
  const key = AUDIO_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}
