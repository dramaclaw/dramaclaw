// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 姿势 id 与 viewer-kit 的 `PoseName` 取同一套字面量，但**不 import 它**：
 * 那边整个目录是 PlayCanvas 栈，运行时引用会把引擎拖进预演台的 chunk。
 * 两套表不许漂移，用测试棘轮盯着（见 poses.test.ts）。
 */
export type PrevizPoseId =
  | 'standing'
  | 'talking'
  | 'arms_crossed'
  | 'sitting'
  | 'eating'
  | 'crouching'
  | 'kneeling'
  | 'lying'
  | 'walking'
  | 'running'
  | 'pointing'
  | 'holding'
  | 'interacting'
  | 'fighting'
  | 'sword';

export const PREVIZ_POSES: readonly PrevizPoseId[] = [
  'standing',
  'talking',
  'arms_crossed',
  'sitting',
  'eating',
  'crouching',
  'kneeling',
  'lying',
  'walking',
  'running',
  'pointing',
  'holding',
  'interacting',
  'fighting',
  'sword',
];

export const PREVIZ_DEFAULT_POSE_ID: PrevizPoseId = 'standing';

export function isPrevizPoseId(value: unknown): value is PrevizPoseId {
  return typeof value === 'string' && (PREVIZ_POSES as readonly string[]).includes(value);
}
