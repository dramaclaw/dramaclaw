// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { PREVIZ_MIN_CLIP_FRAMES, type PrevizCutClip, type PrevizScene } from './scene';

/**
 * 镜头轨：一串按起点排好、互不重叠的切片，每段说「这几帧监看谁」。
 * 全是纯函数——store 的 undo 存的是整份场景快照，就地改会把历史一起改掉。
 */

/** 切片上限。60 段对应最长的 360 帧时长下平均 6 帧一切，比任何正常剪辑都密了。 */
export const PREVIZ_MAX_CUTS = 60;

/** 覆盖这一帧的切片机位；null 是导演视角。起点含、终点不含，与其它片段一致。 */
export function liveCameraAt(scene: PrevizScene, frame: number): string | null {
  const cut = scene.timeline.program.find(
    (entry) => entry.startFrame <= frame && frame < entry.endFrame,
  );
  return cut?.cameraId ?? null;
}

export type CutRejection = 'same-camera' | 'no-room' | 'limit' | 'no-camera';

export type InsertCutResult =
  | { ok: true; scene: PrevizScene }
  | { ok: false; reason: CutRejection };

function withProgram(scene: PrevizScene, program: PrevizCutClip[]): PrevizScene {
  return { ...scene, timeline: { ...scene.timeline, program } };
}

/** 只换某一下标那段的机位，其它字段不动。`insertCut` 与 `retargetCut` 共用，别各写一份。 */
function swapCutCamera(program: PrevizCutClip[], index: number, cameraId: string): PrevizCutClip[] {
  return program.map((cut, i) => (i === index ? { ...cut, cameraId } : cut));
}

/**
 * 在 `frame` 处切到 `cameraId`。五种情形见设计文档「切镜操作」：
 * 0 覆盖播放头的那段已是该机位则不动；1 起点恰在播放头只换机位；
 * 2 播放头在段内则截断并新建后半段；3 空隙里新建到下一段或时间轴末尾；
 * 4 末尾没空间；5 达上限。
 * 拒绝时不返回场景：调用方拿到场景就会 applyScene，等于往 undo 栈塞一步空操作。
 */
export function insertCut(scene: PrevizScene, frame: number, cameraId: string): InsertCutResult {
  const camera = scene.objects.find((object) => object.id === cameraId);
  if (camera?.kind !== 'camera') return { ok: false, reason: 'no-camera' };
  // 帧号不是有限数就没有「这一帧」可切，按没空间处理，别让 NaN 混进快照。
  if (!Number.isFinite(frame)) return { ok: false, reason: 'no-room' };

  const at = Math.max(0, Math.round(frame));
  const program = scene.timeline.program;
  const index = program.findIndex((cut) => cut.startFrame <= at && at < cut.endFrame);
  const current = index >= 0 ? program[index] : undefined;

  if (current) {
    if (current.cameraId === cameraId) return { ok: false, reason: 'same-camera' };
    if (current.startFrame === at) {
      return { ok: true, scene: withProgram(scene, swapCutCamera(program, index, cameraId)) };
    }
    if (program.length >= PREVIZ_MAX_CUTS) return { ok: false, reason: 'limit' };
    // at 严格落在 (startFrame, endFrame) 内，两半都至少一帧。
    const head: PrevizCutClip = { ...current, endFrame: at };
    const tail: PrevizCutClip = {
      id: uuidv4(),
      kind: 'cut',
      startFrame: at,
      endFrame: current.endFrame,
      cameraId,
    };
    return {
      ok: true,
      scene: withProgram(scene, [
        ...program.slice(0, index),
        head,
        tail,
        ...program.slice(index + 1),
      ]),
    };
  }

  // 空隙：表是有序的，第一段起点在播放头之后的就是下一段。
  const nextIndex = program.findIndex((cut) => cut.startFrame > at);
  const end = nextIndex >= 0 ? program[nextIndex]!.startFrame : scene.settings.durationFrames;
  if (end - at < PREVIZ_MIN_CLIP_FRAMES) return { ok: false, reason: 'no-room' };
  if (program.length >= PREVIZ_MAX_CUTS) return { ok: false, reason: 'limit' };

  const cut: PrevizCutClip = { id: uuidv4(), kind: 'cut', startFrame: at, endFrame: end, cameraId };
  const next =
    nextIndex >= 0
      ? [...program.slice(0, nextIndex), cut, ...program.slice(nextIndex)]
      : [...program, cut];
  return { ok: true, scene: withProgram(scene, next) };
}

/**
 * 把某段切片改指到另一台机位。机位不是 camera、找不到切片、或已是这台时原样返回同一个对象，
 * 调用方按引用相等判断是不是空操作，别往 undo 栈塞一步没变化的记录。
 */
export function retargetCut(scene: PrevizScene, clipId: string, cameraId: string): PrevizScene {
  const camera = scene.objects.find((object) => object.id === cameraId);
  if (camera?.kind !== 'camera') return scene;

  const program = scene.timeline.program;
  // findIndex 而不是按 id 过滤：clipById 的注释说过，un-deduped 的场景里同 id 可能不止一条，
  // 按下标定位只改第一条命中的，不会把重复 id 的那几条一起改掉。
  const index = program.findIndex((cut) => cut.id === clipId);
  if (index < 0) return scene;
  if (program[index]!.cameraId === cameraId) return scene;

  return withProgram(scene, swapCutCamera(program, index, cameraId));
}
