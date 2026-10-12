// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 关键元素：用户把画布节点手动标记成「关键元素」并归类（对标 liblib 的
 * 节点「...」→ 设置关键元素 → 人物/场景/物品/其他）。标记只写在节点 data 上
 * （data.keyElementCategory），是画布级、随节点持久化的纯展示元数据——工作流侧
 * 不读它，零影响。故事板顶部的关键元素栏据此把被标记的节点常驻展示 + 分类筛选。
 */
export type KeyElementCategory = 'character' | 'scene' | 'object' | 'other';

/** 稳定 key 顺序（人物 → 场景 → 物品 → 其他），栏内分类下拉与排序都按它。 */
export const KEY_ELEMENT_CATEGORY_KEYS: readonly KeyElementCategory[] = [
  'character',
  'scene',
  'object',
  'other',
];

export const KEY_ELEMENT_CATEGORY_LABEL: Record<KeyElementCategory, string> = {
  character: '人物',
  scene: '场景',
  object: '物品',
  other: '其他',
};

const CATEGORY_KEY_SET = new Set<string>(KEY_ELEMENT_CATEGORY_KEYS);

/** 从节点 data 读关键元素分类；未标记 / 值非法 → null。 */
export function readKeyElementCategory(data: unknown): KeyElementCategory | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>).keyElementCategory;
  return typeof raw === 'string' && CATEGORY_KEY_SET.has(raw) ? (raw as KeyElementCategory) : null;
}
