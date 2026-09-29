// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  PREVIZ_PRIMITIVE_SHAPES,
  previzPrimitiveNameKey,
  type PrevizPrimitiveShape,
} from './primitives';
import { PREVIZ_LIBRARY_MODELS } from './libraryModels';
import type { PrevizProp } from './scene';

/**
 * 模型库对话框的清单。纯数据，不 import three。
 *
 * 两种来源：代码生成的基础几何体，与 CDN 上的 glb（Kenney CC0 素材，清单由
 * `scripts/build_previz_model_library.mjs` 生成进 `libraryModels.ts`）。
 * 对话框和编辑器都只认 `PrevizLibraryEntry` 这份形状，不认条目从哪来。
 */
export type PrevizLibraryCategory =
  | 'primitive'
  | 'furniture'
  | 'architecture'
  | 'city'
  | 'vehicle'
  | 'prop'
  | 'nature';

/** 键序即左栏顺序。 */
export const PREVIZ_LIBRARY_CATEGORIES: Readonly<
  Record<PrevizLibraryCategory, { labelKey: string }>
> = {
  primitive: { labelKey: 'previz.library.category.primitive' },
  furniture: { labelKey: 'previz.library.category.furniture' },
  architecture: { labelKey: 'previz.library.category.architecture' },
  city: { labelKey: 'previz.library.category.city' },
  vehicle: { labelKey: 'previz.library.category.vehicle' },
  prop: { labelKey: 'previz.library.category.prop' },
  nature: { labelKey: 'previz.library.category.nature' },
};

/**
 * 模型库在 CDN 上的根。版本号是路径的一段：模型或尺寸有变就整目录换个版本重传，
 * 旧版本留着——已经摆进场景的物件存的是这里拼出来的完整 URL，覆盖旧文件等于
 * 悄悄改掉别人已经排好的镜头。
 *
 * 本地开发可用 `VITE_PREVIZ_MODEL_LIBRARY_BASE` 改指同源目录（如 `/previz/models/v1`，
 * 文件放 `frontend/public/` 下、已 gitignore）。注意这时摆进场景的物件存的是这个本地
 * URL，换回 CDN 后这些旧物件不会跟着换。
 */
export const PREVIZ_MODEL_LIBRARY_BASE =
  import.meta.env.VITE_PREVIZ_MODEL_LIBRARY_BASE?.trim() ||
  'https://nfg-web-assets.cdnfg.com/dramaclaw/previz/models/v1';

/**
 * 这个 URL 是不是模型库里的模型（而不是用户自己导入的）。模型库的模型一律按白模显示，
 * 见 `engine/importedMaterials.ts` 的 `applyClayMaterial`。
 *
 * 认路径段而不是认 `PREVIZ_MODEL_LIBRARY_BASE` 前缀：根地址可以被本地 env 改指同源目录，
 * 换过根之后，之前摆进场景的那批物件存的还是旧根——它们照样是模型库的模型。
 */
export function isPrevizLibraryModelUrl(url: string): boolean {
  return /\/previz\/models\/v\d+\//.test(url);
}

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
  /** 卡片缩略图。基础几何体没有，卡片上画矢量示意图。 */
  thumbnailUrl?: string;
}

export const PREVIZ_LIBRARY_ENTRIES: readonly PrevizLibraryEntry[] = [
  ...(Object.keys(PREVIZ_PRIMITIVE_SHAPES) as PrevizPrimitiveShape[]).map(
    (shape): PrevizLibraryEntry => ({
      id: `primitive-${shape}`,
      nameKey: previzPrimitiveNameKey(shape),
      category: 'primitive',
      tags: [shape, ...PREVIZ_PRIMITIVE_SHAPES[shape].aliases],
      triangles: PREVIZ_PRIMITIVE_SHAPES[shape].triangles,
      assetFormat: 'primitive',
      assetUrl: shape,
    }),
  ),
  ...PREVIZ_LIBRARY_MODELS.map(
    (model): PrevizLibraryEntry => ({
      id: model.id,
      nameKey: `previz.library.model.${model.id}`,
      category: model.category,
      tags: model.tags,
      triangles: model.triangles,
      assetFormat: 'glb',
      assetUrl: `${PREVIZ_MODEL_LIBRARY_BASE}/${model.path}.glb`,
      thumbnailUrl: `${PREVIZ_MODEL_LIBRARY_BASE}/${model.path}.webp`,
    }),
  ),
];

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
 * 故意不搜 `entry.id`：id 都带分类前缀（`primitive-`、`furniture-`……），"p"/"r"/"i"
 * 这类单字母查询会靠这段前缀命中整个分类，搜索框形同虚设。英文名已经拆进每条
 * `tags`（见 `PREVIZ_LIBRARY_ENTRIES` 的映射与生成脚本），丢掉 id 不会漏搜任何
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
