// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  PREVIZ_PATH_AIM_PART,
  anchorHeightM,
  lookAtEulerDeg,
  rigAnchorPoint,
  rigCameraPosition,
} from './closeup';
import { samplePathPosition, samplePathRotation } from './pathCurve';
import type { PrevizObject, PrevizScene, Vec3 } from './scene';
import { frameToU, pathClipAt, rigClipAt } from './timeline';

/** 某一帧上单个对象的解算结果。 */
export interface EvaluatedObject {
  position: Vec3;
  rotation: Vec3;
  /** 人物用；其余对象恒为 null。 */
  poseId: string | null;
  /** 姿势内的时间，单位秒。动作片段（P4）才会给出非零值。 */
  poseTime: number;
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
 * action（姿势与姿势内时间）仍未实现。
 */
export function evaluateSceneAt(scene: PrevizScene, frame: number): EvaluatedFrame {
  const result: EvaluatedFrame = new Map();

  for (const object of scene.objects) {
    // 展开而不是直接引用：求值结果每帧都会被引擎读走并写进 three 节点，
    // 共享数组等于让渲染层握着一把能改场景的钥匙。
    result.set(object.id, {
      position: [...object.transform.position],
      rotation: [...object.transform.rotation],
      poseId: object.kind === 'character' ? object.basePoseId : null,
      poseTime: 0,
    });
  }

  for (const track of scene.timeline.tracks) {
    const target = result.get(track.objectId);
    // 悬空轨道 parseScene 已经丢过一轮，这里兜的是运行时脏值。
    if (!target) continue;

    const clip = pathClipAt(track, frame);
    // 「片段建好了还没画」是常态（末尾新建片段就是这样），这时不覆盖静态变换。
    if (!clip || clip.points.length === 0) continue;

    const u = frameToU(clip, frame);
    target.position = samplePathPosition(clip.points, u);
    target.rotation = samplePathRotation(clip.points, u);
  }

  const objectsById = lazyIndex(scene);
  applyCloseups(scene, frame, result, objectsById);
  applyPathAims(scene, frame, result, objectsById);
  return result;
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
