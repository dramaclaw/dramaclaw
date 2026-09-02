// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from 'i18next';

import type {
  SkillDefinition,
  SkillParameterSpec,
} from '@/features/freezone/context/skillRoles';

/** 后端 skill 定义没给 label 时的兜底显示名。 */
const PARAMETER_LABEL_KEYS: Record<string, string> = {
  aspect_ratio: 'canvas.skillParams.aspectRatio',
  quality: 'canvas.skillParams.quality',
};

function fallbackParameterLabel(key: string): string {
  const labelKey = PARAMETER_LABEL_KEYS[key];
  return labelKey ? i18n.t(labelKey) : key;
}

export interface SkillParameterEntry {
  key: string;
  label: string;
  type: string;
  options: string[];
  value: string | boolean;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function parameterOptions(spec: SkillParameterSpec): string[] {
  return Array.isArray(spec.options)
    ? spec.options.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

export function selectedParameterValue(
  key: string,
  spec: SkillParameterSpec,
  storedParameters: Record<string, unknown>,
): string | boolean {
  if (spec.type === 'boolean') {
    const storedValue = storedParameters[key];
    if (typeof storedValue === 'boolean') {
      return storedValue;
    }
    if (typeof storedValue === 'string') {
      const normalized = storedValue.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return typeof spec.default === 'boolean' ? spec.default : false;
  }

  const options = parameterOptions(spec);
  const storedValue = typeof storedParameters[key] === 'string' ? storedParameters[key].trim() : '';
  if (storedValue && (options.length === 0 || options.includes(storedValue))) {
    return storedValue;
  }
  const defaultValue = typeof spec.default === 'string' ? spec.default.trim() : '';
  if (defaultValue && (options.length === 0 || options.includes(defaultValue))) {
    return defaultValue;
  }
  return options[0] ?? '';
}

export function skillParameterEntries(
  skill: SkillDefinition | null,
  parameters: unknown,
): SkillParameterEntry[] {
  const definitions = skill?.parameters ?? {};
  const storedParameters = recordValue(parameters) ?? {};
  return Object.entries(definitions)
    .map(([key, spec]) => {
      const options = parameterOptions(spec);
      const type = typeof spec.type === 'string' ? spec.type : 'string';
      return {
        key,
        label: typeof spec.label === 'string' && spec.label.trim()
          ? spec.label.trim()
          : fallbackParameterLabel(key),
        type,
        options,
        value: selectedParameterValue(key, spec, storedParameters),
      };
    })
    .filter((entry) => entry.type === 'boolean' || entry.options.length > 0);
}

export function normalizedSkillParameters(
  skill: SkillDefinition | null,
  parameters: unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    skillParameterEntries(skill, parameters).map((entry) => [entry.key, entry.value]),
  );
}
