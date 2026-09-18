// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  PREVIZ_PATH_AIM_PART,
  anchorHeightM,
  lookAtEulerDeg,
  rigAnchorPoint,
  rigCameraPosition,
} from './closeup';
import {
  PREVIZ_CHARACTER_RADIUS_M,
  clampToBounds,
  propWorldBox,
  pushOutOfBoxes,
  type PrevizPropExtent,
  type PrevizXZBox,
} from './moveAssist';
import { motionInfo } from './motionLibrary';
import { samplePathPosition, samplePathRotation } from './pathCurve';
import { locomotionPoseFor, poseSampleTime } from './poses';
import {
  PREVIZ_FPS,
  type PrevizActionClip,
  type PrevizCharacter,
  type PrevizObject,
  type PrevizScene,
  type Vec3,
} from './scene';
import { actionClipsOf, frameToU, lastEndedPathClip, pathClipAt, rigClipAt } from './timeline';
import { sceneTopDownBounds, type PrevizTopDownFootprint } from './topDownMap';

/** 动作片段之间交叉淡化的时长。设计文档决策 8：固定值，不给用户调。 */
export const PREVIZ_MOTION_BLEND_SEC = 0.2;

/** 身体这一帧播哪条动画的哪一秒。 */
export interface EvaluatedMotionSample {
  /** 姿势 id（`PrevizPoseId`，引擎按候选表挑 clip）或 `motionId`（`builtin:` / `import:`）。 */
  ref: string;
  /** 秒，循环已绕圈、单次已定格，引擎直接拿去推动画。 */
  time: number;
}

export interface EvaluatedMotion {
  primary: EvaluatedMotionSample;
  /** 过渡中被淡出的那一条；不在过渡里时缺省。 */
  secondary?: EvaluatedMotionSample;
  /** `primary` 的权重，0..1，`secondary` 拿剩下的。没有 `secondary` 时恒为 1。 */
  weight: number;
}

/** 某一帧上单个对象的解算结果。 */
export interface EvaluatedObject {
  position: Vec3;
  rotation: Vec3;
  /**
   * 人物用；其余对象恒为 null。底层是静止时的基础姿势定格、沿路径走位时的走 / 跑循环，
   * 落在动作片段里时换成片段的动作，片段首尾各有一段交叉淡化。
   */
  motion: EvaluatedMotion | null;
}

export type EvaluatedFrame = Map<string, EvaluatedObject>;

/**
 * 时间轴求值器：给一帧，算出这一帧上每个对象在哪、朝哪、摆什么姿势。
 * 预览播放与将来的录制调用的是同一个函数——两套求值迟早对不上，那种 bug 只在导出的
 * 视频里看得见。
 *
 * 求值顺序按设计文档：先取对象静态 transform 作为基线，再按轨道叠加片段。
 * 走位与朝向分三轮：特写机位的位置是从锚点**这一帧解算完的**位置反推的，「看向」又是
 * 从看的人与被看的人**都解算完**的位置反推的。塞进同一轮里的话，跟不跟得上取决于两条
 * 轨道在数组里的先后——那种 bug 只在某几个场景里出现。
 * 姿势跟着走位一起解：静止是基础姿势定格的那一秒，沿路径走位换成走 / 跑的循环并给出
 * 片段内时间，引擎按它推动画；动作片段再盖在这层底子上（`applyActionClips`）。
 */
export function evaluateSceneAt(
  scene: PrevizScene,
  frame: number,
  /**
   * 每件道具在本地坐标下的 XZ 半尺寸，由 `PrevizRenderer.propExtents()` 量出来。
   *
   * 可选：本模块是纯计算、拿不到 three，量不出这份数据；而模型还在下载的那几帧、以及
   * 没有渲染器的调用点（测试、将来的服务端求值）本来就没有它。不给就等于场上一件道具
   * 都没有——移动辅助那一轮**照跑**，只是没有盒子可推，「限制在场景范围」仍然按默认
   * 地块夹。这比「没有尺寸表就整轮跳过」好：后者会让人在模型下完的那一刻突然跳一下。
   */
  extents: readonly PrevizPropExtent[] = [],
): EvaluatedFrame {
  const result: EvaluatedFrame = new Map();

  for (const object of scene.objects) {
    // 展开而不是直接引用：求值结果每帧都会被引擎读走并写进 three 节点，
    // 共享数组等于让渲染层握着一把能改场景的钥匙。
    result.set(object.id, {
      position: [...object.transform.position],
      rotation: [...object.transform.rotation],
      motion:
        object.kind === 'character'
          ? {
              primary: { ref: object.basePoseId, time: poseSampleTime(object.basePoseId) },
              weight: 1,
            }
          : null,
    });
  }

  for (const track of scene.timeline.tracks) {
    const target = result.get(track.objectId);
    // 悬空轨道 parseScene 已经丢过一轮，这里兜的是运行时脏值。
    if (!target) continue;

    // 「片段建好了还没画」是常态（末尾新建片段就是这样），空片段不算覆盖这一帧。
    const covering = pathClipAt(track, frame);
    const walking = covering && covering.points.length > 0 ? covering : undefined;
    // 走完之后停在终点，而不是弹回摆放位置——`frameToU` 会把片段之外的帧夹到 1，
    // 所以停住这件事不需要另写一套采样，还是同一条曲线的末端。
    const clip = walking ?? lastEndedPathClip(track, frame);
    if (!clip) continue;

    const u = frameToU(clip, frame);
    target.position = samplePathPosition(clip.points, u);
    target.rotation = samplePathRotation(clip.points, u);
    // 位置在变而脚不动，看着是整个人被平移过去的：沿路径走位的人物换成走 / 跑的循环，
    // 时间从片段首帧起算。只有人物有姿势（其余对象 motion 恒为 null）；只有一个点的
    // 路径没有位移，原地迈腿是在踏步，所以保持静止姿势。
    // 停住的那几帧不进这个分支：人已经站定了，脚不该还在迈。
    // 走到这里 motion 必然还是初始化时那份基础姿势，`primary.ref` 就是 `basePoseId`。
    if (walking && target.motion !== null && clip.points.length >= 2) {
      target.motion = {
        primary: {
          ref: locomotionPoseFor(target.motion.primary.ref),
          time: (frame - clip.startFrame) / PREVIZ_FPS,
        },
        weight: 1,
      };
    }
  }

  // 必须排在走位之后：动作片段的过渡要拿「没有这段动作时身体在干什么」当底子，走 / 跑
  // 循环正是走位那一轮给出来的。位置与朝向这一轮一概不碰（决策 3：动作管身体，路径管位置）。
  applyActionClips(scene, frame, result);

  // 排在走位之后：`samplePathPosition` 转头就把曲线上的 XZ 原样写回来，推开排在它之前
  // 等于没推。排在特写与「看向」之前：那两轮都是拿人这一帧解算完的位置反推机位的，排在
  // 它们后面的话，机位会一直盯着人被推开**之前**的地方——而那个地方在道具肚子里。
  // 与 `applyHeightPolicies` 的先后无所谓：那一轮只动 y，这一轮只动 XZ。
  applyMoveAssist(scene, result, extents);

  applyHeightPolicies(scene, result);

  const objectsById = lazyIndex(scene);
  applyCloseups(scene, frame, result, objectsById);
  applyPathAims(scene, frame, result, objectsById);
  return result;
}

/**
 * 动作片段那一轮。区间半开 `[start, end)`，见 `PrevizActionClip`。
 *
 * 过渡帧数 `blend = min(0.2 秒, 片段长的一半)`——短片段首尾两段过渡各占一半，恰好不重叠，
 * 所以下面两个分支互斥。
 * - 进入：前 `blend` 帧从旧身体淡入。旧身体是**紧邻的前一段动作**（首尾相接），
 *   没有就是底层（基础姿势或走 / 跑）。
 * - 离开：后 `blend` 帧淡回底层。下一段紧挨着时不做——那一次过渡归下一段的进入，
 *   两边各做一次等于在交界处叠两层淡化，身体会先塌回底层再被拉起来。
 *
 * 动作解析不出（导入动作被删了、目录改了名）时整段当没有：保留底层，而不是让人定格成
 * 绑定姿势。
 */
function applyActionClips(scene: PrevizScene, frame: number, result: EvaluatedFrame): void {
  const blendCap = Math.round(PREVIZ_MOTION_BLEND_SEC * PREVIZ_FPS);
  for (const track of scene.timeline.tracks) {
    const target = result.get(track.objectId);
    // 非人物没有身体；parseScene 已经不让动作片段挂在非人物轨道上，这里兜运行时脏值。
    if (!target?.motion) continue;

    const clips = actionClipsOf(track);
    const index = clips.findIndex((clip) => clip.startFrame <= frame && frame < clip.endFrame);
    if (index < 0) continue;
    const clip = clips[index]!;
    const primary = actionSample(scene, clip, frame);
    if (!primary) continue;

    const base = target.motion.primary;
    const blend = Math.min(blendCap, Math.floor((clip.endFrame - clip.startFrame) / 2));
    const entered = frame - clip.startFrame;
    const remaining = clip.endFrame - frame;
    const previous = clips[index - 1];
    const next = clips[index + 1];

    if (entered < blend) {
      const adjoining = previous?.endFrame === clip.startFrame ? previous : undefined;
      const secondary = (adjoining && actionSample(scene, adjoining, frame)) || base;
      target.motion = { primary, secondary, weight: entered / blend };
    } else if (remaining < blend && next?.startFrame !== clip.endFrame) {
      target.motion = { primary, secondary: base, weight: remaining / blend };
    } else {
      target.motion = { primary, weight: 1 };
    }
  }
}

/**
 * 动作片段在某一帧上的采样。时间从片段首帧起算：循环动作绕圈，单次动作播完定格在最后
 * 一帧直到片段结束。帧号可以在片段之外（前一段在过渡里被淡出时就是），同一套规则照算。
 */
function actionSample(
  scene: PrevizScene,
  clip: PrevizActionClip,
  frame: number,
): EvaluatedMotionSample | null {
  const info = motionInfo(scene.motions, clip.motionId);
  if (!info) return null;
  const elapsed = Math.max(0, (frame - clip.startFrame) / PREVIZ_FPS);
  const time = info.loop ? elapsed % info.durationSec : Math.min(elapsed, info.durationSec);
  return { ref: clip.motionId, time };
}

/**
 * 高度策略里能纯算的那一半：锁定平面。
 *
 * 夹在走位与特写 /「看向」之间，三边都是硬约束：
 * 排在走位之前，`samplePathPosition` 转头就把曲线上的 y 原样写回来，压平等于没压；
 * 排在特写之后，`applyCloseups` 是拿 `anchorState.position` 反推机位的，机位会停在
 * 人物根本不在的那一层；排在「看向」之后，`applyPathAims` 是拿 `aimState.position`
 * 反推俯仰的，镜头会盯着二楼的人低头看一楼。
 *
 * 「贴合地面」不在这里：它要往场景几何体上打射线，而本模块是纯计算、拿不到 three
 * 的场景——那一半在 `PrevizRenderer` 里。这里顺手压到 `planeY` 上，是拿「锁定平面」
 * 的答案冒充落地高度。
 */
function applyHeightPolicies(scene: PrevizScene, result: EvaluatedFrame): void {
  for (const object of scene.objects) {
    if (object.kind !== 'character' || object.heightPolicy !== 'plane') continue;
    const state = result.get(object.id);
    // 这一行是类型上的必需，不是运行时的兜底：`result` 照着同一个 `scene.objects` 建，
    // `get` 必然有值。和走位那一轮同款的判断不是一回事——那边的键来自轨道，指得到一个
    // 已经不存在的对象。
    if (!state) continue;
    // `planeY` 原样用，不校验有限性：这一层对数值一律不设防（路径点与静态 transform
    // 的 y 同样直通），单给它补一道校验只会让「哪些数被洗过」变得说不清。
    state.position = [state.position[0], object.planeY, state.position[2]];
  }
}

/**
 * 移动辅助那一轮：把勾了开关的人物在地面上推开、夹住。
 *
 * 「静止摆位不受影响」不需要在这里特判——这一轮跑在**求值**里，而求值的结果只在播放
 * 与预览时写进节点；用户手摆的那份 `transform` 是场景数据，本模块从头到尾没写过它。
 *
 * 两个开关都勾时先推后夹：范围是硬边界，推开可以把人推出界，反过来不行。
 */
function applyMoveAssist(
  scene: PrevizScene,
  result: EvaluatedFrame,
  extents: readonly PrevizPropExtent[],
): void {
  const assisted: PrevizCharacter[] = [];
  for (const object of scene.objects) {
    if (object.kind !== 'character') continue;
    if (object.avoidCollision || object.stayInBounds) assisted.push(object);
  }
  // 绝大多数场景两个开关都没勾。下面那两张表白建一遍是每帧一次的开销，同 `lazyIndex`。
  if (assisted.length === 0) return;

  const objectsById = new Map(scene.objects.map((object) => [object.id, object]));

  // 推开用的盒子按**这一帧解算出的**道具位置算：挂着走位的道具（会动的平台、被推开的
  // 门）走到哪，人就从哪儿被推开。
  const boxes: PrevizXZBox[] = [];
  // 夹取用的那块地按道具的**静止摆位**算，刻意与前者不同：这块地就是创建人物对话框
  // 左栏画出来的那块（同一个 `sceneTopDownBounds`、同样的入参），用户勾「限制在场景
  // 范围」时看到的是它。跟着走位一起呼吸的话，一件开走的道具会把围栏拖着走，被夹住的
  // 人跟着滑——而画面上没有任何东西解释他为什么在动。
  const restingFootprints: PrevizTopDownFootprint[] = [];

  for (const extent of extents) {
    const object = objectsById.get(extent.id);
    const state = result.get(extent.id);
    // 尺寸表是渲染器另外量的一份快照，与这里的 `scene` 不保证同一时刻：道具可能已经
    // 被删了。同 `sceneTopDownBounds` 对轮廓做的那道筛。
    if (!object || !state) continue;
    boxes.push(propWorldBox(extent, state.position, object.transform.scale));
    restingFootprints.push({
      id: extent.id,
      ...propWorldBox(extent, object.transform.position, object.transform.scale),
    });
  }

  const bounds = sceneTopDownBounds(scene.objects, restingFootprints);

  for (const character of assisted) {
    const state = result.get(character.id);
    // 类型上的必需，不是运行时兜底：`result` 照着同一个 `scene.objects` 建，同
    // `applyHeightPolicies` 里的那一行。
    if (!state) continue;
    let point: [number, number] = [state.position[0], state.position[2]];
    if (character.avoidCollision) {
      point = pushOutOfBoxes(point, PREVIZ_CHARACTER_RADIUS_M, boxes);
    }
    if (character.stayInBounds) {
      point = clampToBounds(point, PREVIZ_CHARACTER_RADIUS_M, bounds);
    }
    state.position = [point[0], state.position[1], point[1]];
  }
}

/**
 * 只在真有片段用到时才建的对象索引。绝大多数场景一条特写、一个「看向」都没有，
 * 这张表白建一遍是每帧一次的开销。
 */
function lazyIndex(scene: PrevizScene): () => Map<string, PrevizObject> {
  let index: Map<string, PrevizObject> | null = null;
  return () => (index ??= new Map(scene.objects.map((object) => [object.id, object])));
}

/**
 * 第三轮：路径片段的「看向」。沿路走的机位多半不看正前方，而是一路盯着主角——
 * 这一轮把切线朝向覆盖掉，所以必须等所有走位（含特写机位）都解完。
 */
function applyPathAims(
  scene: PrevizScene,
  frame: number,
  result: EvaluatedFrame,
  objectsById: () => Map<string, PrevizObject>,
): void {
  for (const track of scene.timeline.tracks) {
    const target = result.get(track.objectId);
    if (!target) continue;

    const clip = pathClipAt(track, frame);
    if (!clip?.aimObjectId) continue;
    // 自己看自己解不出方向，交出来的会是一个假的正前方。
    if (clip.aimObjectId === track.objectId) continue;

    const aimObject = objectsById().get(clip.aimObjectId);
    const aimState = result.get(clip.aimObjectId);
    // 被看的对象删掉之后「看向」会留在片段上（删对象不该顺手改别人的片段），
    // 此时退回切线朝向。
    if (!aimObject || !aimState) continue;

    const euler = lookAtEulerDeg(
      target.position,
      rigAnchorPoint(aimState.position, anchorHeightM(aimObject), PREVIZ_PATH_AIM_PART),
    );
    // 人看人是转身，不是整个人前倾。俯仰只有机位担得起。
    const mover = objectsById().get(track.objectId);
    target.rotation = mover?.kind === 'camera' ? euler : [0, euler[1], 0];
  }
}

/**
 * 第二轮：特写片段。机位不自己走位，而是跟着锚点对象的某个部位，停在离它多远、
 * 哪个方位的地方，并且始终看着它——所以必须等第一轮把锚点这一帧的位置解完。
 */
function applyCloseups(
  scene: PrevizScene,
  frame: number,
  result: EvaluatedFrame,
  objectsById: () => Map<string, PrevizObject>,
): void {
  for (const track of scene.timeline.tracks) {
    const target = result.get(track.objectId);
    if (!target) continue;

    const clip = rigClipAt(track, frame);
    if (!clip) continue;
    // 自己跟自己没有不动点：解出来的位置又成了下一帧的锚点，机位会一路飘走。
    if (clip.anchorObjectId === track.objectId) continue;

    const anchorObject = objectsById().get(clip.anchorObjectId);
    const anchorState = result.get(clip.anchorObjectId);
    // 锚点被删掉之后特写片段会留在轨道上（删对象不该顺手改别人的轨道）。
    // 此时机位停在自己的静态位置，而不是塌到世界原点。
    if (!anchorObject || !anchorState) continue;

    const anchor = rigAnchorPoint(
      anchorState.position,
      anchorHeightM(anchorObject),
      clip.anchorPart,
    );
    target.position = rigCameraPosition(anchor, anchorState.rotation[1], clip, frameToU(clip, frame));

    if (!clip.aimObjectId) continue;
    const aimObject = objectsById().get(clip.aimObjectId);
    const aimState = result.get(clip.aimObjectId);
    if (!aimObject || !aimState) continue;
    // 看向点用的是同一个部位：跟着面部拍却看向脚底，画面上是一个低头的怪角度。
    target.rotation = lookAtEulerDeg(
      target.position,
      rigAnchorPoint(aimState.position, anchorHeightM(aimObject), clip.anchorPart),
    );
  }
}
