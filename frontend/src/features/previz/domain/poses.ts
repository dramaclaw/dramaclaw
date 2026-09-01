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

/**
 * 每个姿势在 Quaternius UAL 模型里的 clip 名候选，按优先级排列；`sampleTime` 是把
 * 该 clip 定格在第几秒当静态姿势用。整张表原样取自 viewer-kit 的
 * `QUATERNIUS_POSE_CLIPS`（viewerApp.ts:1090），那是对着同一份 GLB 调出来的。
 * **别自己重挑 clip 名**——UAL2 里有几百条 clip，名字相近的定格效果差很多。
 *
 * 那个常量是 PlayCanvas 模块里的局部 const，import 不到（连测试都不行，一 import
 * 就把 playcanvas 拉起来），只能抄。`poses.test.ts` 有一条棘轮直接读 viewerApp.ts
 * 的源码文本比对，改这里就必须同步改那边。
 */
export const PREVIZ_POSE_CLIPS: Record<PrevizPoseId, { names: string[]; sampleTime: number }> = {
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

/** 硬编码中文，理由同 `PREVIZ_OBJECT_BASE_NAME`：姿势 id 会随场景落盘，标签只是展示。
 *  同样是 viewer-kit `POSE_LABELS` 的副本，同样由 `poses.test.ts` 的棘轮盯着。 */
export const PREVIZ_POSE_LABEL: Record<PrevizPoseId, string> = {
  standing: '站立',
  talking: '交谈',
  arms_crossed: '抱臂',
  sitting: '坐下',
  eating: '进食',
  crouching: '蹲伏',
  kneeling: '下跪',
  lying: '躺 / 倒地',
  walking: '行走',
  running: '奔跑',
  pointing: '指向',
  holding: '持物',
  interacting: '操作 / 互动',
  fighting: '格斗',
  sword: '持械',
};

/**
 * 在模型实际带的 clip 名集合里挑第一个命中的候选。全都没有时返回 null——
 * 调用方据此回落到占位几何体，而不是抛异常把整个场景搭建流程炸掉。
 * 姿势 id 本身不认识（场景是落盘数据，旧文件可能带着已删掉的 id）时同样返回 null，
 * 而不是在缺表项上抛 TypeError。
 */
export function resolvePoseClipName(
  pose: PrevizPoseId,
  available: ReadonlySet<string>,
): string | null {
  const config = isPrevizPoseId(pose) ? PREVIZ_POSE_CLIPS[pose] : undefined;
  return config?.names.find((name) => available.has(name)) ?? null;
}
