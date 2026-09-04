// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 姿势 id 与 viewer-kit 的 `PoseName` 取同一套字面量，但**不 import 它**：
 * 那边整个目录是 PlayCanvas 栈，运行时引用会把引擎拖进预演台的 chunk。
 * 两套表不许漂移，`poses.test.ts` 有一条棘轮对着 viewer-kit 的 `POSES` 盯着这件事——
 * 比的是集合而不是顺序。顺序本身也别乱动：它就是属性面板里姿势下拉框的排列顺序。
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

/** 一个姿势要用哪条 clip、定格在哪一秒。抽成具名类型是为了让引擎侧 hover
 *  `PREVIZ_POSE_CLIPS[pose]` 时能看见下面这两行语义，而不是一个裸结构。 */
export interface PrevizPoseClipConfig {
  /** 候选 clip 名，按优先级排列——取第一个在模型里存在的。 */
  readonly names: readonly string[];
  /** 定格在动画的第几秒。 */
  readonly sampleTime: number;
}

/**
 * 每个姿势在 Quaternius UAL 模型里的 clip 名候选与采样时刻。整张表和 viewer-kit 的
 * `QUATERNIUS_POSE_CLIPS`（`features/viewer-kit/three-d/engine/poses.ts`）是同一份——
 * 那边是对着同一批 GLB 挑出来的，逐条的来历与两处取值特例（`lying` 的首帧、`pointing`
 * 超出 clip 时长）都写在那个常量的注释里。**别自己重挑 clip 名。**
 *
 * 这里保一份副本而不是 re-export：预演台的**运行时**代码不许引用 `features/viewer-kit/**`，
 * 那边是 PlayCanvas 栈，一旦被引到就会把整个引擎拖进预演台的 chunk。测试没有这个顾虑——
 * `engine/poses.ts` 是零 import 的纯数据模块，`poses.test.ts` 直接 import 它那份常量做
 * `toEqual`。改这里就必须同步改那边，反之亦然。
 */
export const PREVIZ_POSE_CLIPS: Readonly<Record<PrevizPoseId, PrevizPoseClipConfig>> = {
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

/** 姿势名的界面文案：只存 i18n key，渲染时由调用方带着 `t` 解析（`PREVIZ_POSES` 才是
 *  会随场景落盘的协议值）。key 与词条都跟 viewer-kit 的 `POSE_LABEL_KEYS` 共用同一批
 *  `viewer.threeD.poses.*`——同一个姿势在预演台和 3D 导演里必须叫同一个名字，
 *  `poses.test.ts` 有一条棘轮盯着两张表逐字相等。 */
export const PREVIZ_POSE_LABEL_KEYS: Readonly<Record<PrevizPoseId, string>> = {
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
 * 在模型实际带的 clip 名集合里挑第一个命中的候选。全都没有时返回 null——
 * 调用方据此回落到占位几何体，而不是抛异常把整个场景搭建流程炸掉。
 *
 * `pose` 收 `string` 而不是 `PrevizPoseId`：真正的入参来自落盘的场景
 * （`PrevizCharacter.basePoseId` 就是 `string`，旧文件可能带着已删掉的 id），
 * 收窄成联合类型只会逼调用点写 cast，把守卫的作用又还回去。认不出的 id 走同一条
 * null 回落，而不是在缺失的表项上抛 TypeError。
 */
export function resolvePoseClipName(
  pose: string,
  available: ReadonlySet<string>,
): string | null {
  const config = isPrevizPoseId(pose) ? PREVIZ_POSE_CLIPS[pose] : undefined;
  return config?.names.find((name) => available.has(name)) ?? null;
}
