// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

export type CharacterMainCopy = {
  label: string;
  makeMain: string;
  unsetMain: string;
  mainSet: string;
  mainUnset: string;
};

/**
 * 「主角 / 解说主角」这组文案随 spine_template 变，是界面文案不是协议值，所以这里
 * 只存 key，由调用方带着 t 进来在渲染时解析。
 */
const MAIN_COPY_KEY_PREFIX = {
  drama: "character.main.drama",
  narrated: "character.main.narrated",
} as const;

export function characterMainCopyForSpineTemplate(
  spineTemplate: string | null | undefined,
  t: TFunction,
): CharacterMainCopy {
  const prefix =
    spineTemplate === "narrated" ? MAIN_COPY_KEY_PREFIX.narrated : MAIN_COPY_KEY_PREFIX.drama;
  return {
    label: t(`${prefix}.label`),
    makeMain: t(`${prefix}.makeMain`),
    unsetMain: t(`${prefix}.unsetMain`),
    mainSet: t(`${prefix}.mainSet`),
    mainUnset: t(`${prefix}.mainUnset`),
  };
}
