// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type PoseName =
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

export const POSES: PoseName[] = [
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

/** 姿势名的界面文案：只存 key，渲染时由调用方带着 t 解析（POSES 才是协议值）。 */
export const POSE_LABEL_KEYS: Record<PoseName, string> = {
  standing: 'viewer.threeD.poses.standing',
  talking: 'viewer.threeD.poses.talking',
  arms_crossed: 'viewer.threeD.poses.arms_crossed',
  sitting: 'viewer.threeD.poses.sitting',
  eating: 'viewer.threeD.poses.eating',
  crouching: 'viewer.threeD.poses.crouching',
  kneeling: 'viewer.threeD.poses.kneeling',
  lying: 'viewer.threeD.poses.lying',
  walking: 'viewer.threeD.poses.walking',
  running: 'viewer.threeD.poses.running',
  pointing: 'viewer.threeD.poses.pointing',
  holding: 'viewer.threeD.poses.holding',
  interacting: 'viewer.threeD.poses.interacting',
  fighting: 'viewer.threeD.poses.fighting',
  sword: 'viewer.threeD.poses.sword',
};
export function isPoseName(value: unknown): value is PoseName {
  return typeof value === 'string' && (POSES as string[]).includes(value);
}

export function requirePoseName(value: unknown, context = 'pose'): PoseName {
  if (isPoseName(value)) return value;
  throw new Error(`Invalid 3GS actor ${context}: ${String(value)}`);
}

export function nextPose(current: PoseName, dir: 1 | -1): PoseName {
  const idx = POSES.indexOf(current);
  const base = idx < 0 ? 0 : idx;
  const next = (base + dir + POSES.length) % POSES.length;
  return POSES[next];
}
