// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 模型库首批条目：代码生成的基础几何体。
 *
 * 场景里用 `assetFormat: 'primitive'` + `assetUrl: <形状名>` 表示（见 `scene.ts` 的
 * `PrevizProp`），加载时由 `engine/primitiveBuilder.ts` 现造。本文件是纯数据，不 import
 * three——模型库对话框在首屏包里也要读它。
 *
 * 统一约定：底面落在自身原点（y 最小值为 0），XZ 以原点居中，最长边 1 m。于是
 * `propUnitScale` 对它们一个都不换算，摆出来就是 1 m 见方上下。
 */
export type PrevizPrimitiveShape =
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'plane'
  | 'capsule'
  | 'wedge'
  | 'torus';

export interface PrevizPrimitiveSpec {
  /**
   * 三角面数，卡片上的「N 面」。写死而不是现算：清单不 import three。
   * 与真实几何体是否一致，由 `primitive-builder.test.ts` 拿真 three 逐个核对。
   */
  triangles: number;
  /** 搜索用的英文别名（形状名本身之外）。 */
  aliases: readonly string[];
}

/** 键序即模型库里的展示顺序。 */
export const PREVIZ_PRIMITIVE_SHAPES: Readonly<Record<PrevizPrimitiveShape, PrevizPrimitiveSpec>> = {
  cube: { triangles: 12, aliases: ['box', 'block'] },
  sphere: { triangles: 720, aliases: ['ball'] },
  cylinder: { triangles: 96, aliases: ['pillar', 'column'] },
  cone: { triangles: 48, aliases: [] },
  plane: { triangles: 2, aliases: ['floor', 'ground'] },
  capsule: { triangles: 288, aliases: ['pill'] },
  wedge: { triangles: 8, aliases: ['ramp', 'slope'] },
  torus: { triangles: 768, aliases: ['ring', 'donut'] },
};

export function isPrevizPrimitiveShape(value: unknown): value is PrevizPrimitiveShape {
  // hasOwnProperty 而不是 `in`：`in` 会把 'constructor' 这类原型链上的键也认成合法形状。
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(PREVIZ_PRIMITIVE_SHAPES, value)
  );
}

/** 形状的本地化名称 key。模型库卡片与属性面板共用这一处，免得两边各拼一遍。 */
export function previzPrimitiveNameKey(shape: PrevizPrimitiveShape): string {
  return `previz.library.primitive.${shape}`;
}
