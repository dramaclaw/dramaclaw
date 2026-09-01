// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 姿势 id 与 viewer-kit 的 `PoseName` 取同一套字面量，但**不 import 它**：
 * 那边整个目录是 PlayCanvas 栈，运行时引用会把引擎拖进预演台的 chunk。
 * 两套表不许漂移，Task 3 会补一条对着 viewer-kit 姿势表的棘轮测试盯住这件事；
 * 在那之前，顺序也不要动——棘轮是按顺序比的。
 */
export const PREVIZ_POSES = [
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
] as const;

/** 从数组派生而不是另写一遍字面量：两处手写必然有一天对不上，那时类型允许的姿势
 *  会比 `isPrevizPoseId` 认的多，而这个文件的全部意义就是当唯一真相。 */
export type PrevizPoseId = (typeof PREVIZ_POSES)[number];

export const PREVIZ_DEFAULT_POSE_ID: PrevizPoseId = 'standing';

export function isPrevizPoseId(value: unknown): value is PrevizPoseId {
  return typeof value === 'string' && (PREVIZ_POSES as readonly string[]).includes(value);
}
