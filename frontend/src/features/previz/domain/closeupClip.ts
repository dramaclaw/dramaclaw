// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { clampToRange } from './camera';
import { normalizeYawDeg } from './cameraDraft';
import {
  PREVIZ_RIG_DISTANCE_RANGE,
  PREVIZ_RIG_ELEVATION_RANGE,
  PREVIZ_RIG_HEIGHT_RANGE,
} from './closeup';
import { evaluateSceneAt } from './evaluate';
import type {
  PrevizPathClip,
  PrevizPathPoint,
  PrevizRigClip,
  PrevizScene,
  PrevizTrack,
} from './scene';
import { clipById, isRigClip, upsertClip } from './timeline';

/**
 * 特写片段的增删改。纯函数，入参是场景出参是新场景——与 `timeline.ts` 同一套约定。
 *
 * 单独一个文件而不是并进 `timeline.ts`：烤成路径要逐帧问求值器，而求值器自己依赖
 * `timeline.ts`，写在一起就是循环 import。
 */

/**
 * 新建特写时的默认取景。
 *
 * 水平角不取 0：正对着脸的 0/0 是一张证件照，而人像的通用起手式是四分之三侧。
 * 略带俯角同理——齐眼平拍在预演里最常见的用途是对话，稍高一点更像镜头而不是监控。
 * 距离 2.75 m 是半身景别，改一个数就能推到大特写或拉到全身。
 */
export const PREVIZ_RIG_DEFAULT = {
  anchorPart: 'face',
  azimuth: 30,
  elevation: 8,
  distance: PREVIZ_RIG_DISTANCE_RANGE.default,
  height: 0,
  bearing: 'front',
  motion: 'static',
} as const;

/**
 * 烤成路径时每隔多少帧采一个关键帧。
 *
 * 逐帧采会得到一百多个关键帧，之后没人再改得动；隔太远则环绕运镜会烤成一个多边形。
 * 10 帧（1/3 秒）在 120 帧的片段上给 13 个点，而点之间走的是 Catmull-Rom 样条，
 * 弧线补得回来。
 */
export const PREVIZ_RIG_SAMPLE_FRAMES = 10;

export interface CloseupTarget {
  objectId: string;
  name: string;
  startFrame: number;
  endFrame: number;
}

/** 某条轨道已经占到的帧范围；没有片段时返回 undefined。 */
function trackSpan(track: PrevizTrack | undefined): { startFrame: number; endFrame: number } | undefined {
  if (!track || track.clips.length === 0) return undefined;
  return {
    startFrame: track.clips.reduce((start, clip) => Math.min(start, clip.startFrame), Infinity),
    endFrame: track.clips.reduce((end, clip) => Math.max(end, clip.endFrame), 0),
  };
}

/**
 * 这台机位可以跟谁，以及跟上去的话这段特写覆盖哪几帧。
 *
 * 帧范围抄自对方现有的轨道——「跟着这个人走的这一段」是新建特写时唯一想说的话。
 * 对方还没有轨道时铺满整条时间轴：特写不要求被跟的人先画一条路径。
 */
export function closeupTargets(scene: PrevizScene, cameraObjectId: string): CloseupTarget[] {
  return scene.objects
    .filter((object) => object.id !== cameraObjectId)
    .map((object) => {
      const span = trackSpan(scene.timeline.tracks.find((track) => track.objectId === object.id));
      return {
        objectId: object.id,
        name: object.name,
        startFrame: span?.startFrame ?? 0,
        endFrame: span?.endFrame ?? scene.settings.durationFrames,
      };
    });
}

export function createRigClip(params: {
  anchorObjectId: string;
  startFrame: number;
  endFrame: number;
}): PrevizRigClip {
  return {
    id: uuidv4(),
    kind: 'rig',
    startFrame: params.startFrame,
    endFrame: params.endFrame,
    anchorObjectId: params.anchorObjectId,
    // 默认看向跟的那个人。分成两个字段是为了让「跟着 A 却看向 B」成为可能
    // （过肩镜头就是这么摆的），但默认值没有理由不是同一个。
    aimObjectId: params.anchorObjectId,
    ...PREVIZ_RIG_DEFAULT,
  };
}

/** 把特写片段挂到**机位**的轨道上。被跟的对象一点不动——特写是机位的属性。 */
export function addRigClip(
  scene: PrevizScene,
  cameraObjectId: string,
  clip: PrevizRigClip,
): PrevizScene {
  return upsertClip(scene, cameraObjectId, clip);
}

/** 可以从属性面板改的那些字段。起止帧走 `moveClip` / `trimClip`，不从这里改。 */
export type RigClipPatch = Partial<
  Pick<
    PrevizRigClip,
    | 'anchorObjectId'
    | 'anchorPart'
    | 'aimObjectId'
    | 'azimuth'
    | 'elevation'
    | 'distance'
    | 'height'
    | 'bearing'
    | 'motion'
  >
>;

/** 改一条特写片段，数值字段就地收进各自区间。 */
export function updateRigClip(
  scene: PrevizScene,
  clipId: string,
  patch: RigClipPatch,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isRigClip(found.clip)) return scene;
  const clip = found.clip;

  const next: PrevizRigClip = {
    ...clip,
    ...patch,
    // 水平角是循环量：从 0 往下按一格该绕到 350，而不是停在 0。其余三个是有物理
    // 边界的量，夹取。
    azimuth: normalizeYawDeg(patch.azimuth ?? clip.azimuth),
    elevation: clampToRange(patch.elevation ?? clip.elevation, PREVIZ_RIG_ELEVATION_RANGE),
    distance: clampToRange(patch.distance ?? clip.distance, PREVIZ_RIG_DISTANCE_RANGE),
    height: clampToRange(patch.height ?? clip.height, PREVIZ_RIG_HEIGHT_RANGE),
  };

  return upsertClip(scene, found.track.objectId, next);
}

/**
 * 把特写烤成一条普通的路径片段。
 *
 * 跟踪解出来的机位是「跟着谁」的函数，改不了单帧；烤成关键帧之后每一个点都能手调，
 * 代价是从此不再跟着人物走。这是一条单向门，与参照实现的「转为路径片段」同义。
 *
 * 采样走的是求值器本身，而不是在这里重算一遍几何：两套解算迟早对不上，而那种偏差
 * 只在烤完之后的画面里看得见。
 */
export function rigClipToPath(scene: PrevizScene, clipId: string): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isRigClip(found.clip)) return scene;
  const clip = found.clip;
  const objectId = found.track.objectId;

  const span = Math.max(0, clip.endFrame - clip.startFrame);
  const steps = Math.max(1, Math.round(span / PREVIZ_RIG_SAMPLE_FRAMES));

  const points: PrevizPathPoint[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const u = step / steps;
    const state = evaluateSceneAt(scene, clip.startFrame + u * span).get(objectId);
    if (!state) continue;
    points.push({
      id: uuidv4(),
      u,
      position: [...state.position],
      rotation: [...state.rotation],
      // 标成「朝向已编辑」，否则轨迹会按切线自动转向，烤出来的构图当场就没了。
      rotationEdited: true,
    });
  }

  const baked: PrevizPathClip = {
    // 沿用同一个 id：属性面板正选着它，换 id 会让选中态在按下按钮的瞬间落空。
    id: clip.id,
    kind: 'path',
    startFrame: clip.startFrame,
    endFrame: clip.endFrame,
    points,
  };
  return upsertClip(scene, objectId, baked);
}
