// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { clampToRange } from './camera';
import {
  PREVIZ_HEIGHT_CM_RANGE,
  nextCharacterColor,
  nextObjectName,
  type PrevizObjectOverrides,
} from './objects';
import { PREVIZ_DEFAULT_POSE_ID } from './poses';
import {
  PREVIZ_POSE_ADJUST_RANGE,
  type BodyType,
  type HeightPolicy,
  type PrevizCharacter,
  type PrevizObject,
} from './scene';

/**
 * 「创建人物」对话框正在编辑的那一个人——还没进场景，所以不是 `PrevizCharacter`：
 * 没有 id，站位也不是 `transform` 那三组三元组，而是俯视图上点出来的一对 XZ。
 * 两者的桥是 `characterDraftOverrides`。
 *
 * 站位单独拆成 `spot` 而不是直接放一个 `transform`，是因为对话框只让用户决定**平面上
 * 站在哪**：高度归「高度策略」管，朝向建完再转。摆一个完整的 transform 在这里，就得
 * 有人回答「用户没碰过的那六个分量此刻是什么」，而答案只会是一串写在别处的 0。
 */
export interface PrevizCharacterDraft {
  name: string;
  color: string;
  bodyType: BodyType;
  heightCm: number;
  basePoseId: string;
  poseAdjust: PrevizCharacter['poseAdjust'];
  heightPolicy: HeightPolicy;
  /** 俯视图点出来的 XZ，单位米。**没点过就是 null**，「创建」按钮按它禁用。 */
  spot: readonly [number, number] | null;
}

/**
 * 已经点过位的草稿。`characterDraftOverrides` 只收这一个，于是「没选位就创建」在
 * 编译期就过不去——留给运行时的话，漏挡的表现是人静静地站在世界原点，没有任何报错。
 *
 * 写成 `Omit` 再补一个 `spot` 而不是 `draft & { spot: … }`：后者把两个 `spot` 求交，
 * 读的人得自己在脑子里算一遍 `(T | null) & T`。
 */
export type PrevizPlacedCharacterDraft = Omit<PrevizCharacterDraft, 'spot'> & {
  spot: readonly [number, number];
};

export function isPlacedCharacterDraft(
  draft: PrevizCharacterDraft,
): draft is PrevizPlacedCharacterDraft {
  return draft.spot !== null;
}

/**
 * 新建的人物脚底落在哪一层，单位米。
 *
 * 0 是地面网格所在的那一层，而对象节点的原点就在**脚底**：占位胶囊自身以中心为原点，
 * 由 `sceneGraph.createCharacterPlaceholder` 抬高半个**胶囊**高（胶囊比身高矮一截，矮出
 * 来的那截归露在外面的球头），人物 GLB 的原点同样在脚下。所以「站在地上」就是 y = 0，
 * 不需要按身高算任何偏移。
 *
 * 单开一个常量而不是在下面写两个 0：`transform.position[1]` 与 `planeY` 必须是同一个数
 * ——用户建完人就切「锁定平面」时，锁的应该是他刚才建人的那一层。
 */
const PREVIZ_CHARACTER_SPAWN_Y = 0;

/**
 * 一份全新的人物草稿。默认值不是在这里另写一遍，而是从 `createPrevizObject` 的人物
 * 分支逐字对齐的（名字编号、辨识色轮换、体型、身高、基础姿势、姿态微调、高度策略）：
 * 两条创建路径给出的人不一样，是那种「从对话框建的人和直接建的人差一点点」的怪账。
 *
 * `objects` 只用来算下一个编号与下一个没人用的颜色，不会被改动。
 */
export function createCharacterDraft(objects: readonly PrevizObject[]): PrevizCharacterDraft {
  return {
    name: nextObjectName(objects, 'character'),
    color: nextCharacterColor(objects),
    bodyType: 'average',
    heightCm: PREVIZ_HEIGHT_CM_RANGE.default,
    basePoseId: PREVIZ_DEFAULT_POSE_ID,
    poseAdjust: { pitch: 0, turn: 0, lean: 0 },
    // 新建的人物跟随轨迹：另外两档都会去改 y，而用户此刻还没表达过任何高度意图。
    heightPolicy: 'follow',
    // 没点过俯视图。兜一个 [0, 0] 出来会让「不选位直接创建」悄悄成立。
    spot: null,
  };
}

/**
 * 把草稿里的每个数值字段收进各自的区间，理由同 `clampCameraDraft`：对话框上的数字
 * 输入框存的是用户敲进去的原样（逐键夹取会让「先删空再重输」没法用），收敛推迟到提交
 * 这个出口。
 *
 * 只夹数：身高按 `PREVIZ_HEIGHT_CM_RANGE`（parseScene、占位胶囊、`applyBodyScale`
 * 共用的那一份），姿态三轴按 `PREVIZ_POSE_ADJUST_RANGE`。名字与颜色不是数，`spot`
 * 也不夹——俯视图刻意允许把人点到现有地块之外（见 `PrevizTopDownPicker`），在这里
 * 补一次夹取等于把那个决定推翻掉。
 */
export function clampCharacterDraft(draft: PrevizCharacterDraft): PrevizCharacterDraft {
  return {
    ...draft,
    heightCm: clampToRange(draft.heightCm, PREVIZ_HEIGHT_CM_RANGE),
    poseAdjust: {
      pitch: clampToRange(draft.poseAdjust.pitch, PREVIZ_POSE_ADJUST_RANGE.pitch),
      turn: clampToRange(draft.poseAdjust.turn, PREVIZ_POSE_ADJUST_RANGE.turn),
      lean: clampToRange(draft.poseAdjust.lean, PREVIZ_POSE_ADJUST_RANGE.lean),
    },
  };
}

/**
 * 草稿 → `createPrevizObject('character', …)` 的初始字段。
 *
 * 这里是「俯视图上的一对 XZ」摊回「`[x, y, z]` 三元组」的唯一一处。夹取按上面那两组
 * 区间走，与 schema 落盘时会做的那一次一致——滑杆到不了界外，数字输入框能敲进去。
 *
 * 名字空着（或只剩空白）时**不带这个键**：`createPrevizObject` 用 `withoutUndefined`
 * 滤掉 undefined，于是工厂算出来的「人物 N」照常生效。写一个空串进去的话，图层面板上
 * 会多出一行没有标签的条目，而用户唯一的补救是去属性面板里重新起名。
 */
export function characterDraftOverrides(
  draft: PrevizPlacedCharacterDraft,
): PrevizObjectOverrides<'character'> {
  const safe = clampCharacterDraft(draft);
  // 落点读 `draft` 而不是 `safe`：`clampCharacterDraft` 的返回类型是可以没落点的
  // `PrevizCharacterDraft`，过一趟就把这个参数类型带来的「一定有落点」丢了。
  const [x, z] = draft.spot;
  const name = safe.name.trim();
  return {
    name: name || undefined,
    color: safe.color,
    bodyType: safe.bodyType,
    heightCm: safe.heightCm,
    basePoseId: safe.basePoseId,
    // 这个引用是 `clampCharacterDraft` 现搭的字面量，不是对话框 React state 里的那一
    // 个——这条得成立，否则建好的人物会跟着滑杆一起动，且绕过 store 无迹可循。所以
    // 那边即使三根滑杆都在界内也照样重搭 `poseAdjust`，别改成「界内就原样返回」。
    poseAdjust: safe.poseAdjust,
    heightPolicy: safe.heightPolicy,
    planeY: PREVIZ_CHARACTER_SPAWN_Y,
    transform: {
      position: [x, PREVIZ_CHARACTER_SPAWN_Y, z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  };
}
