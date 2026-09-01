// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { samplePathPosition, samplePathRotation } from './pathCurve';
import type { PrevizScene, Vec3 } from './scene';
import { frameToU, pathClipAt } from './timeline';

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
 * 本期（P3）只解 path 片段。action（姿势与姿势内时间）与 rig（依据锚点对象的当前解算
 * 结果反推机位）是 P4：rig 必须排在它依赖的对象**之后**求值，所以那一步要在这个循环
 * 结束之后再开一轮，而不是塞进同一轮里——现在没有 rig，提前搭那层空壳只会和 P4 真正
 * 需要的形状对不上。
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

  return result;
}
