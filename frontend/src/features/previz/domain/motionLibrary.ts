// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizImportedMotion } from './scene';

/**
 * 内置动作目录：随仓库发布的 Quaternius UAL1 / UAL2（CC0）里挑出来的动画。
 *
 * 纯数据、不进场景：场景里只存 `builtin:<clip 名>`，目录改了（加条目、调分类）不需要
 * 迁移任何存档。`durationSec` 与 GLB 里的真实时长由 `motion-library.test.ts` 逐条对过，
 * 求值器按它绕圈与定格——对不上的话循环动作会在接缝处跳一下。
 *
 * 不入目录的三类（设计文档「入选规则」）：`_RM` 根位移版本（根位移会被剥掉，与无后缀
 * 版本重复；没有无后缀版本的 `ClimbUp_1m_RM`、`Shield_Dash_RM`、`Sword_Dash_RM` 同样
 * 排除——剥掉位移之后是原地抽动）、`_Rec` 收招、`A_TPose`。
 */

export const PREVIZ_MOTION_CATEGORIES = ['daily', 'locomotion', 'interact', 'combat', 'other'] as const;
export type PrevizMotionCategory = (typeof PREVIZ_MOTION_CATEGORIES)[number];

export const BUILTIN_MOTION_PREFIX = 'builtin:';
export const IMPORT_MOTION_PREFIX = 'import:';

export interface PrevizBuiltinMotion {
  id: `builtin:${string}`;
  clipName: string;
  category: PrevizMotionCategory;
  labelKey: string;
  loop: boolean;
  durationSec: number;
}

/** `[clip 名, 分类, 时长秒]`。按 GLB 分两段、段内按分类排，方便对照 GLB 查漏。 */
const CATALOGUE: ReadonlyArray<readonly [string, PrevizMotionCategory, number]> = [
  // UAL1
  ['Idle_Loop', 'daily', 2.5],
  ['Idle_Talking_Loop', 'daily', 2.933],
  ['Idle_Torch_Loop', 'daily', 1.267],
  ['Sitting_Enter', 'daily', 1.3],
  ['Sitting_Exit', 'daily', 1.033],
  ['Sitting_Idle_Loop', 'daily', 1.667],
  ['Sitting_Talking_Loop', 'daily', 2.933],
  ['Crouch_Idle_Loop', 'daily', 2.933],
  ['Dance_Loop', 'daily', 1],
  ['Driving_Loop', 'daily', 1.667],
  ['Walk_Loop', 'locomotion', 1.333],
  ['Walk_Formal_Loop', 'locomotion', 1.333],
  ['Jog_Fwd_Loop', 'locomotion', 0.933],
  ['Sprint_Loop', 'locomotion', 0.667],
  ['Crouch_Fwd_Loop', 'locomotion', 2],
  ['Jump_Start', 'locomotion', 1.333],
  ['Jump_Loop', 'locomotion', 2.5],
  ['Jump_Land', 'locomotion', 1.267],
  ['Roll', 'locomotion', 1.467],
  ['Swim_Fwd_Loop', 'locomotion', 1.333],
  ['Swim_Idle_Loop', 'locomotion', 3.333],
  ['Interact', 'interact', 2],
  ['PickUp_Table', 'interact', 0.833],
  ['Push_Loop', 'interact', 2.667],
  ['Fixing_Kneeling', 'interact', 5.2],
  ['Punch_Jab', 'combat', 0.867],
  ['Punch_Cross', 'combat', 1],
  ['Sword_Idle', 'combat', 1.667],
  ['Sword_Attack', 'combat', 1.533],
  ['Pistol_Idle_Loop', 'combat', 1.667],
  ['Pistol_Shoot', 'combat', 0.633],
  ['Pistol_Reload', 'combat', 1.667],
  ['Hit_Chest', 'combat', 0.333],
  ['Hit_Head', 'combat', 0.433],
  ['Death01', 'combat', 2.4],
  ['Spell_Simple_Enter', 'other', 0.533],
  ['Spell_Simple_Idle_Loop', 'other', 2.1],
  ['Spell_Simple_Shoot', 'other', 0.5],
  ['Spell_Simple_Exit', 'other', 0.433],
  // UAL2
  ['Idle_FoldArms_Loop', 'daily', 2.5],
  ['Idle_No_Loop', 'daily', 2.5],
  ['Idle_TalkingPhone_Loop', 'daily', 2.933],
  ['Idle_Lantern_Loop', 'daily', 2.5],
  ['Idle_Rail_Loop', 'daily', 2.5],
  ['Idle_Rail_Call', 'daily', 2.5],
  ['Yes', 'daily', 2.5],
  ['Consume', 'daily', 1.333],
  ['LayToIdle', 'daily', 1.533],
  ['Walk_Carry_Loop', 'locomotion', 2],
  ['NinjaJump_Start', 'locomotion', 0.967],
  ['NinjaJump_Idle_Loop', 'locomotion', 2],
  ['NinjaJump_Land', 'locomotion', 1.267],
  ['Slide_Start', 'locomotion', 0.833],
  ['Slide_Loop', 'locomotion', 2],
  ['Slide_Exit', 'locomotion', 0.5],
  ['Chest_Open', 'interact', 1.367],
  ['Farm_Harvest', 'interact', 2.5],
  ['Farm_PlantSeed', 'interact', 2.767],
  ['Farm_Watering', 'interact', 3.8],
  ['TreeChopping_Loop', 'interact', 0.967],
  ['OverhandThrow', 'interact', 1.333],
  ['Sword_Block', 'combat', 1.233],
  ['Sword_Regular_A', 'combat', 0.433],
  ['Sword_Regular_B', 'combat', 0.533],
  ['Sword_Regular_C', 'combat', 2],
  ['Sword_Regular_Combo', 'combat', 3],
  ['Melee_Hook', 'combat', 0.467],
  ['Idle_Shield_Loop', 'combat', 2.5],
  ['Idle_Shield_Break', 'combat', 1.067],
  ['Shield_OneShot', 'combat', 0.833],
  ['Hit_Knockback', 'combat', 0.833],
  ['Zombie_Idle_Loop', 'other', 1.333],
  ['Zombie_Walk_Fwd_Loop', 'other', 1.333],
  ['Zombie_Scratch', 'other', 1.8],
];

/**
 * 循环与否按名字判：UAL 的循环动作一律带 `_Loop`。`Sword_Idle` 是唯一的例外——它是
 * 持剑待机，首尾同一姿态，按单次播会在播完后定格成一个僵住的人。
 */
function isLoopClip(clipName: string): boolean {
  return clipName.includes('_Loop') || clipName === 'Sword_Idle';
}

export const PREVIZ_BUILTIN_MOTIONS: readonly PrevizBuiltinMotion[] = CATALOGUE.map(
  ([clipName, category, durationSec]) => ({
    id: `builtin:${clipName}` as const,
    clipName,
    category,
    labelKey: `previz.motion.builtin.${clipName}`,
    loop: isLoopClip(clipName),
    durationSec,
  }),
);

const BUILTIN_BY_ID = new Map<string, PrevizBuiltinMotion>(
  PREVIZ_BUILTIN_MOTIONS.map((motion) => [motion.id, motion]),
);

export function builtinMotionById(id: string): PrevizBuiltinMotion | undefined {
  return BUILTIN_BY_ID.get(id);
}

export function importMotionRef(importedId: string): string {
  return `${IMPORT_MOTION_PREFIX}${importedId}`;
}

/** `import:<id>` 里的那个 id；不是导入引用就是 null。 */
export function importedIdOf(ref: string): string | null {
  return ref.startsWith(IMPORT_MOTION_PREFIX) ? ref.slice(IMPORT_MOTION_PREFIX.length) : null;
}

/** 解析场景时用：内置目录里有，或者指向一条还在的导入动作。 */
export function isKnownMotionId(id: unknown, importedIds: ReadonlySet<string>): id is string {
  if (typeof id !== 'string') return false;
  if (BUILTIN_BY_ID.has(id)) return true;
  const importedId = importedIdOf(id);
  return importedId !== null && importedIds.has(importedId);
}

export interface PrevizMotionInfo {
  durationSec: number;
  loop: boolean;
}

/** 求值器与片段操作共用的「这条动作多长、绕不绕圈」。找不到返回 null。 */
export function motionInfo(
  motions: readonly PrevizImportedMotion[],
  ref: string,
): PrevizMotionInfo | null {
  const builtin = BUILTIN_BY_ID.get(ref);
  if (builtin) return { durationSec: builtin.durationSec, loop: builtin.loop };
  const importedId = importedIdOf(ref);
  if (importedId === null) return null;
  const motion = motions.find((entry) => entry.id === importedId);
  return motion ? { durationSec: motion.durationSec, loop: motion.loop } : null;
}

/**
 * 导入动作从文件到可播放 clip 路上会栽在哪。导入确认前（本地文件）与打开编辑器后
 * （按 URL 重新拉取）走同一条流水线，所以共用一张表；文案键是 `previz.motion.error.<code>`。
 */
export type PrevizMotionLoadError =
  | {
      code:
        | 'bad_extension'
        | 'too_large'
        | 'fetch_failed'
        | 'parse_failed'
        | 'no_animation'
        | 'zero_duration';
    }
  | { code: 'unsupported_skeleton'; missing: string[] };

/** 一条导入动作在本次会话里的加载状态，时间线与属性面板据此画红色斜纹、写原因。 */
export type PrevizMotionStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; error: PrevizMotionLoadError };
