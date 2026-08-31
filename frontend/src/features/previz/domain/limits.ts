// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizObjectKind, PrevizScene } from './scene';

/**
 * 对象数量上限对齐调研基线。体积阈值是整画布 5 MB 请求体上限的前置护栏——
 * canvasSyncCore 收到 413 / canvas_payload_too_large 后会进终态并永久停掉自动
 * 保存，炸掉的是整张画布而不只是这一个节点，所以宁可在这里先拦。
 */
export const PREVIZ_LIMITS = {
  character: 50,
  camera: 30,
  light: 12,
  prop: 20,
  sceneWarnBytes: 256 * 1024,
  sceneOffloadBytes: 1024 * 1024,
} as const;

export function countObjects(scene: PrevizScene, kind: PrevizObjectKind): number {
  return scene.objects.filter((object) => object.kind === kind).length;
}

export function canAddObject(scene: PrevizScene, kind: PrevizObjectKind): boolean {
  return countObjects(scene, kind) < PREVIZ_LIMITS[kind];
}

export function estimateSceneBytes(scene: PrevizScene): number {
  return new TextEncoder().encode(JSON.stringify(scene)).length;
}

export type SceneSizeVerdict = 'ok' | 'warn' | 'offload';

export function classifySceneSize(bytes: number): SceneSizeVerdict {
  if (bytes >= PREVIZ_LIMITS.sceneOffloadBytes) return 'offload';
  if (bytes >= PREVIZ_LIMITS.sceneWarnBytes) return 'warn';
  return 'ok';
}
