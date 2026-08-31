// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizObjectKind, PrevizScene } from './scene';

/** 每种对象的数量上限，来源见设计文档「限制」一节。Record 保证新增对象类型时这里编译期报错。 */
export const PREVIZ_OBJECT_LIMITS: Record<PrevizObjectKind, number> = {
  character: 50,
  camera: 30,
  light: 12,
  prop: 20,
};

/**
 * 场景字节阈值。这是整画布 5 MB 请求体上限的前置护栏——canvasSyncCore 收到
 * 413 / canvas_payload_too_large 后会进终态并永久停掉自动保存，炸掉的是整张
 * 画布而不只是这一个节点，所以宁可在这里先拦。
 */
export const PREVIZ_SCENE_BYTE_LIMITS = {
  warn: 256 * 1024,
  offload: 1024 * 1024,
} as const;

export function countObjects(scene: PrevizScene, kind: PrevizObjectKind): number {
  return scene.objects.filter((object) => object.kind === kind).length;
}

export function canAddObject(scene: PrevizScene, kind: PrevizObjectKind): boolean {
  return countObjects(scene, kind) < PREVIZ_OBJECT_LIMITS[kind];
}

/** 估算的是 scene 子树自身，不含它写回 node.data 后外层 key 的开销（个位数字节，可忽略）。 */
export function estimateSceneBytes(scene: PrevizScene): number {
  return new TextEncoder().encode(JSON.stringify(scene)).length;
}

export type SceneSizeVerdict = 'ok' | 'warn' | 'offload';

/** 非有限输入按最严档处理：判错的代价是丢掉整张画布的自动保存，不能往宽松方向兜。 */
export function classifySceneSize(bytes: number): SceneSizeVerdict {
  if (!Number.isFinite(bytes)) return 'offload';
  if (bytes >= PREVIZ_SCENE_BYTE_LIMITS.offload) return 'offload';
  if (bytes >= PREVIZ_SCENE_BYTE_LIMITS.warn) return 'warn';
  return 'ok';
}
