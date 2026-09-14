// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  PREVIZ_PRIMITIVE_SHAPES,
  previzPrimitiveNameKey,
  type PrevizPrimitiveShape,
} from './primitives';
import type { PrevizProp } from './scene';

/**
 * 模型库对话框的清单。纯数据，不 import three。
 *
 * 首版只有代码生成的基础几何体；以后接入外部素材（如 Kenney CC0）时，按同一个
 * `PrevizLibraryEntry` 形状追加条目、在 `PREVIZ_LIBRARY_CATEGORIES` 里加分类即可。
 * 对话框和编辑器都只认这份形状，不认条目从哪来。
 */
export type PrevizLibraryCategory = 'primitive';

/** 键序即左栏顺序。 */
export const PREVIZ_LIBRARY_CATEGORIES: Readonly<
  Record<PrevizLibraryCategory, { labelKey: string }>
> = {
  primitive: { labelKey: 'previz.library.category.primitive' },
};

export interface PrevizLibraryEntry {
  id: string;
  nameKey: string;
  category: PrevizLibraryCategory;
  /** 搜索用的额外词（英文名、别名）。 */
  tags: readonly string[];
  /** 卡片上的「N 面」。 */
  triangles: number;
  /** 挑中后原样写进物件：场景里「这个物件用什么模型」只有这两个字段一处真相。 */
  assetFormat: PrevizProp['assetFormat'];
  assetUrl: string;
}

export const PREVIZ_LIBRARY_ENTRIES: readonly PrevizLibraryEntry[] = (
  Object.keys(PREVIZ_PRIMITIVE_SHAPES) as PrevizPrimitiveShape[]
).map((shape) => ({
  id: `primitive-${shape}`,
  nameKey: previzPrimitiveNameKey(shape),
  category: 'primitive',
  tags: [shape, ...PREVIZ_PRIMITIVE_SHAPES[shape].aliases],
  triangles: PREVIZ_PRIMITIVE_SHAPES[shape].triangles,
  assetFormat: 'primitive',
  assetUrl: shape,
}));

export interface PrevizLibraryCounts {
  all: number;
  byCategory: Record<PrevizLibraryCategory, number>;
}

export function countByCategory(entries: readonly PrevizLibraryEntry[]): PrevizLibraryCounts {
  // 先把每个分类都铺成 0：空分类在左栏照样显示「0」，不是整行消失。
  const byCategory = Object.fromEntries(
    Object.keys(PREVIZ_LIBRARY_CATEGORIES).map((category) => [category, 0]),
  ) as Record<PrevizLibraryCategory, number>;
  for (const entry of entries) byCategory[entry.category] += 1;
  return { all: entries.length, byCategory };
}

/**
 * 对本地化名称与 tags 做不区分大小写的子串匹配。首尾空白忽略，空查询返回全部。
 * `translate` 由调用方传入（对话框传 i18next 的 `t`），好让本文件保持纯函数。
 *
 * 故意不搜 `entry.id`：清单里每条 id 都带 `primitive-` 这段共同前缀，"p"/"r"/"i"
 * 这类单字母查询会靠这段前缀命中全部条目，搜索框形同虚设。英文形状名已经是每条
 * `tags` 的第一项（见 `PREVIZ_LIBRARY_ENTRIES` 的映射），丢掉 id 不会漏搜任何
 * 真正该搜到的词。
 */
export function searchLibrary(
  entries: readonly PrevizLibraryEntry[],
  query: string,
  translate: (key: string) => string,
): PrevizLibraryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    [translate(entry.nameKey), ...entry.tags].some((text) => text.toLowerCase().includes(needle)),
  );
}
