// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizSkeletonKind } from './scene';

/**
 * 导入动作的骨骼名映射：`源骨骼名 → UAL 骨骼名`。
 *
 * 表里的键都是 `normalizeBoneName` 之后的形式，所以同一套骨架的常见写法差异
 * （`mixamorig:Hips` / `mixamorig1:Hips` / `Hips`，`L_Hip` / `left_hip`，SMPL 导出时带的
 * `m_avg_` / `f_avg_` 前缀）只需一个键。三张表各自独立匹配，互相撞键没有关系。
 */

/** 必须全部命中的 16 根。缺任何一根，重定向出来的人要么断手断脚、要么整条链停在静止姿势。 */
export const PREVIZ_CORE_BONES = [
  'pelvis',
  'spine_01',
  'neck_01',
  'Head',
  'upperarm_l',
  'lowerarm_l',
  'hand_l',
  'upperarm_r',
  'lowerarm_r',
  'hand_r',
  'thigh_l',
  'calf_l',
  'foot_l',
  'thigh_r',
  'calf_r',
  'foot_r',
] as const;

export function normalizeBoneName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^mixamorig\d*/, '')
    .replace(/^[mf]avg/, '');
}

/** UAL 自己：核心骨骼 + 可选的脊柱中段、锁骨、脚掌。手指不传递，保持静止姿势。 */
const UAL_BONES = [
  ...PREVIZ_CORE_BONES,
  'spine_02',
  'spine_03',
  'clavicle_l',
  'clavicle_r',
  'ball_l',
  'ball_r',
];

const UAL_TABLE: Readonly<Record<string, string>> = Object.fromEntries(
  UAL_BONES.map((bone) => [normalizeBoneName(bone), bone]),
);

const MIXAMO_TABLE: Readonly<Record<string, string>> = {
  hips: 'pelvis',
  spine: 'spine_01',
  spine1: 'spine_02',
  spine2: 'spine_03',
  neck: 'neck_01',
  head: 'Head',
  leftshoulder: 'clavicle_l',
  leftarm: 'upperarm_l',
  leftforearm: 'lowerarm_l',
  lefthand: 'hand_l',
  rightshoulder: 'clavicle_r',
  rightarm: 'upperarm_r',
  rightforearm: 'lowerarm_r',
  righthand: 'hand_r',
  leftupleg: 'thigh_l',
  leftleg: 'calf_l',
  leftfoot: 'foot_l',
  lefttoebase: 'ball_l',
  rightupleg: 'thigh_r',
  rightleg: 'calf_r',
  rightfoot: 'foot_r',
  righttoebase: 'ball_r',
};

/**
 * SMPL / SMPL-X 的 22 个身体关节。注意 SMPL 的 `shoulder` 是上臂、`collar` 才是锁骨，
 * `ankle` 是脚踝（对 UAL 的 `foot`）、`foot` 是脚掌（对 `ball`）——按字面对会整条错一位。
 */
const SMPL_JOINTS: ReadonlyArray<readonly [string, string]> = [
  ['pelvis', 'pelvis'],
  ['spine1', 'spine_01'],
  ['spine2', 'spine_02'],
  ['spine3', 'spine_03'],
  ['neck', 'neck_01'],
  ['head', 'Head'],
  ['collar', 'clavicle'],
  ['shoulder', 'upperarm'],
  ['elbow', 'lowerarm'],
  ['wrist', 'hand'],
  ['hip', 'thigh'],
  ['knee', 'calf'],
  ['ankle', 'foot'],
  ['foot', 'ball'],
];

const SMPL_TABLE: Readonly<Record<string, string>> = Object.fromEntries(
  SMPL_JOINTS.flatMap(([joint, bone]) => {
    // 不分左右的六根（骨盆、脊柱、脖子、头）两种写法本来就一样。
    if (!['collar', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'foot'].includes(joint)) {
      return [[joint, bone]];
    }
    return [
      [`l${joint}`, `${bone}_l`],
      [`left${joint}`, `${bone}_l`],
      [`r${joint}`, `${bone}_r`],
      [`right${joint}`, `${bone}_r`],
    ];
  }),
);

/** 识别顺序：UAL 放最前，同骨架导入不必绕一圈映射。 */
const SKELETON_TABLES: ReadonlyArray<readonly [PrevizSkeletonKind, Readonly<Record<string, string>>]> = [
  ['ual', UAL_TABLE],
  ['mixamo', MIXAMO_TABLE],
  ['smpl', SMPL_TABLE],
];

export type PrevizSkeletonDetection =
  | { ok: true; kind: PrevizSkeletonKind; map: ReadonlyMap<string, string> }
  | { ok: false; error: 'unsupported_skeleton'; missing: string[] };

/**
 * 识别源骨架。返回的 `map` 以**源文件里的原始骨骼名**为键（重定向按原名找节点）。
 * 同一张表里两个源骨骼归一化后撞到同一根 UAL 骨骼时，先出现的赢。
 * 全不中时报「命中最多的那张表」缺哪几根——用户拿着这份名单最可能看懂差在哪。
 */
export function detectSkeleton(boneNames: readonly string[]): PrevizSkeletonDetection {
  let best: { missing: string[] } | null = null;
  for (const [kind, table] of SKELETON_TABLES) {
    const map = new Map<string, string>();
    const taken = new Set<string>();
    for (const name of boneNames) {
      const bone = table[normalizeBoneName(name)];
      if (!bone || taken.has(bone)) continue;
      taken.add(bone);
      map.set(name, bone);
    }
    const missing = PREVIZ_CORE_BONES.filter((bone) => !taken.has(bone));
    if (missing.length === 0) return { ok: true, kind, map };
    if (!best || missing.length < best.missing.length) best = { missing };
  }
  return { ok: false, error: 'unsupported_skeleton', missing: best?.missing ?? [...PREVIZ_CORE_BONES] };
}
