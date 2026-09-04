// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

import type {
  SkillDefinition,
  SkillCardinality,
  SkillInputRole,
  SkillOutputRole,
  SkillProvider,
} from "@/features/freezone/context/skillRoles";

function tWithFallback(t: TFunction, key: string, fallback: string): string {
  const translated = t(key);
  return translated && translated !== key ? translated : fallback;
}

function skillKey(skillId: string): string {
  return skillId.split(".").join("_");
}

function optionKey(optionValue: string): string {
  return optionValue.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** 技能来源分组的标题（「主线技能」「Agent 技能」…）。 */
export function translateSkillProviderLabel(provider: SkillProvider, t: TFunction): string {
  return t(`viewer.threeD.skillProviderLabels.${provider}`);
}

export function translateSkillName(skill: SkillDefinition, t: TFunction): string {
  return tWithFallback(
    t,
    `viewer.threeD.skillDefinitions.${skillKey(skill.id)}.name`,
    skill.display_name,
  );
}

export function translateSkillDescription(skill: SkillDefinition, t: TFunction): string {
  return tWithFallback(
    t,
    `viewer.threeD.skillDefinitions.${skillKey(skill.id)}.description`,
    skill.description,
  );
}

export function translateSkillInputLabel(
  role: SkillInputRole,
  fallback: string,
  t: TFunction,
): string {
  return tWithFallback(t, `viewer.threeD.skillInputLabels.${role}`, fallback);
}

export function translateSkillOutputLabel(
  role: SkillOutputRole,
  fallback: string,
  t: TFunction,
): string {
  return tWithFallback(t, `viewer.threeD.skillOutputLabels.${role}`, fallback);
}

export function translateSkillParameterLabel(
  skillId: string,
  parameterKey: string,
  fallback: string,
  t: TFunction,
): string {
  return tWithFallback(
    t,
    `viewer.threeD.skillParameterLabels.${skillKey(skillId)}.${parameterKey}`,
    fallback,
  );
}

export function translateSkillParameterOption(
  skillId: string,
  parameterKey: string,
  optionValue: string,
  t: TFunction,
): string {
  return tWithFallback(
    t,
    `viewer.threeD.skillParameterOptions.${skillKey(skillId)}.${parameterKey}.${optionKey(optionValue)}`,
    optionValue,
  );
}

export function translateSkillRequirement(required: boolean, t: TFunction): string {
  return tWithFallback(
    t,
    required
      ? "viewer.threeD.skillRequirement.required"
      : "viewer.threeD.skillRequirement.optional",
    required ? "required" : "optional",
  );
}

export function translateSkillCardinality(
  cardinality: SkillCardinality,
  t: TFunction,
): string {
  return tWithFallback(t, `viewer.threeD.skillCardinality.${cardinality}`, cardinality);
}
