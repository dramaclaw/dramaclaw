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

/**
 * 每个姿势在 Quaternius UAL 模型里的 clip 名候选，按优先级排列——取第一个模型里真的
 * 带着的；`sampleTime` 是把该 clip 定格在第几秒当静态姿势用。
 *
 * 候选名是对着 `public/viewer-kit/quaternius/ual2/UAL2_Standard.glb`（43 条 clip）与
 * `ual1/UAL1_Standard.glb`（45 条，同骨架的补充库；两份去重后共 87 条）挑出来的。
 * 别凭名字重挑：库里名字相近而定格效果差很多的 clip 不少。
 *
 * 放在这个文件（而不是 `viewerApp.ts` 的函数体里）是为了让它能被 import：预演台
 * `features/previz/domain/poses.ts` 保着一份同样的表，两张表指的是同一批 GLB，漂移了
 * 没有任何运行时信号。这个文件是纯数据、零 import，预演台的测试因此可以直接引它比对，
 * 不会把 playcanvas 拉起来——所以**别往这个文件里加 import**。
 *
 * 两个看着像笔误、其实不是的取值：
 * - `lying` 的 0.02 是全表唯一低一个数量级的值，取的是首帧。首选 `LayToIdle` 时长 1.53 s、
 *   演的是「躺→起身」，躺姿只在开头那一瞬，往后取就站起来了。
 * - `pointing` 的 0.35 超过了首选 `Pistol_Aim_Neutral` 的时长（0.17 s），实际会夹到末帧。
 *   那是条只有几帧的瞄准定格，首末帧差别不大，所以画面上没问题——但这个数字本身没有意义，
 *   谁要按它推断 clip 长度会推错。
 */
export const QUATERNIUS_POSE_CLIPS: Record<PoseName, { names: string[]; sampleTime: number }> = {
  standing: { names: ['Idle_Loop', 'Idle_No_Loop', 'Idle_FoldArms_Loop', 'A_TPose'], sampleTime: 0.25 },
  talking: { names: ['Idle_Talking_Loop', 'Idle_Rail_Call', 'Yes'], sampleTime: 0.3 },
  arms_crossed: { names: ['Idle_FoldArms_Loop', 'Idle_No_Loop'], sampleTime: 0.25 },
  sitting: { names: ['Sitting_Idle_Loop', 'Sitting_Talking_Loop', 'Idle_Rail_Loop'], sampleTime: 0.45 },
  eating: { names: ['Consume', 'Idle_Talking_Loop', 'Farm_Harvest'], sampleTime: 0.75 },
  crouching: { names: ['Crouch_Idle_Loop', 'Crouch_Fwd_Loop'], sampleTime: 0.25 },
  kneeling: { names: ['Fixing_Kneeling', 'Farm_PlantSeed'], sampleTime: 0.35 },
  lying: { names: ['LayToIdle', 'Death01'], sampleTime: 0.02 },
  walking: { names: ['Walk_Loop', 'Walk_Formal_Loop', 'Walk_Carry_Loop'], sampleTime: 0.35 },
  running: { names: ['Sprint_Loop', 'Jog_Fwd_Loop', 'Shield_Dash_RM'], sampleTime: 0.25 },
  pointing: { names: ['Pistol_Aim_Neutral', 'Spell_Simple_Shoot', 'OverhandThrow'], sampleTime: 0.35 },
  holding: { names: ['Walk_Carry_Loop', 'Idle_Lantern_Loop', 'PickUp_Table'], sampleTime: 0.18 },
  interacting: { names: ['Interact', 'Chest_Open', 'Farm_Harvest', 'Farm_PlantSeed'], sampleTime: 0.55 },
  fighting: { names: ['Punch_Cross', 'Punch_Jab', 'Melee_Hook'], sampleTime: 0.28 },
  sword: { names: ['Sword_Idle', 'Sword_Block', 'Sword_Regular_A'], sampleTime: 0.25 },
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
