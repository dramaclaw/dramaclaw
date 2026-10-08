// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 组节点背景色预设（参考 libtv 的组配色）。value 为基础色，渲染时叠加低透明度做底色。
export interface GroupColorPreset {
  key: string;
  /** 无障碍/title 用的颜色名词条 key——这张表跟着界面语言走，源码里只留 key。 */
  labelKey: string;
  /** 基础色 hex。 */
  value: string;
}

export const GROUP_COLOR_PRESETS: ReadonlyArray<GroupColorPreset> = [
  { key: 'red', labelKey: 'canvas.groupColor.red', value: '#ef4444' },
  { key: 'orange', labelKey: 'canvas.groupColor.orange', value: '#f97316' },
  { key: 'yellow', labelKey: 'canvas.groupColor.yellow', value: '#eab308' },
  { key: 'green', labelKey: 'canvas.groupColor.green', value: '#22c55e' },
  { key: 'cyan', labelKey: 'canvas.groupColor.cyan', value: '#06b6d4' },
  { key: 'blue', labelKey: 'canvas.groupColor.blue', value: '#3b82f6' },
  { key: 'purple', labelKey: 'canvas.groupColor.purple', value: '#8b5cf6' },
  { key: 'pink', labelKey: 'canvas.groupColor.pink', value: '#ec4899' },
  { key: 'gray', labelKey: 'canvas.groupColor.gray', value: '#6b7280' },
];

/** 把组背景色基础 hex 叠加固定透明度，得到组卡片底色 / 边框色（8 位 hex）。 */
export function groupColorBackground(color: string | null | undefined): string | undefined {
  const hex = normalizeGroupColor(color);
  return hex ? `${hex}1a` : undefined; // 10% background, matching the source canvas.
}

export function groupColorBorder(color: string | null | undefined): string | undefined {
  const hex = normalizeGroupColor(color);
  return hex ? `${hex}33` : undefined; // 20% border.
}

export function normalizeGroupColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toUpperCase() : undefined;
}

/** Source palette colors use opaque dark labels, independently of the translucent group surface. */
export function groupColorLabel(color: string | null | undefined): string | undefined {
  const hex = normalizeGroupColor(color);
  if (!hex) return undefined;
  const tokens: Record<string, string> = {
    '#FF3B30': 'red', '#EF4444': 'red',
    '#30D5C8': 'cyan', '#06B6D4': 'cyan',
    '#34C759': 'green', '#22C55E': 'green',
  };
  const token = tokens[hex];
  return token ? `var(--group-label-${token})` : `color-mix(in srgb, ${hex} 28%, #121212)`;
}
