// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { samplePathPosition, samplePathRotation, sortedPathPoints } from './pathCurve';
import {
  PREVIZ_FPS,
  type PrevizClip,
  type PrevizPathClip,
  type PrevizPathPoint,
  type PrevizScene,
  type PrevizTrack,
} from './scene';

/**
 * 时间轴的查询与操作。全部是纯函数：入参是场景，出参是新场景，一次都不改原对象——
 * store 的 undo 栈存的就是整份场景快照，就地改会把历史里的旧快照一起改掉。
 */

export function isPathClip(clip: PrevizClip): clip is PrevizPathClip {
  return clip.kind === 'path';
}

export function trackFor(scene: PrevizScene, objectId: string): PrevizTrack | undefined {
  return scene.timeline.tracks.find((track) => track.objectId === objectId);
}

export function clipById(
  scene: PrevizScene,
  clipId: string,
): { track: PrevizTrack; clip: PrevizClip } | undefined {
  for (const track of scene.timeline.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

/**
 * 这一帧生效的路径片段。区间闭合（两端都算），重叠时取起始帧较晚者——设计文档
 * 「同帧同对象存在多个同类片段时取起始帧较晚者」。起始帧也相同时取数组里靠后的那条，
 * 因为新建的片段总是 push 在后面，「后建的盖住先建的」是用户能预期的方向。
 */
export function pathClipAt(track: PrevizTrack, frame: number): PrevizPathClip | undefined {
  let best: PrevizPathClip | undefined;
  for (const clip of track.clips) {
    if (!isPathClip(clip)) continue;
    if (frame < clip.startFrame || frame > clip.endFrame) continue;
    if (!best || clip.startFrame >= best.startFrame) best = clip;
  }
  return best;
}

/**
 * 帧号 → 片段内归一化参数。区间外夹到两端；长度为 0 的片段返回 0 而不是 NaN
 * ——NaN 会一路流进节点的 position，症状是对象凭空消失，病因隔着五层。
 */
export function frameToU(clip: PrevizClip, frame: number): number {
  const span = clip.endFrame - clip.startFrame;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (frame - clip.startFrame) / span));
}

export function uToFrame(clip: PrevizClip, u: number): number {
  const span = Math.max(0, clip.endFrame - clip.startFrame);
  return clip.startFrame + Math.round(Math.min(1, Math.max(0, u)) * span);
}

/** 时间轴总秒数。fps 是 schema 里钉死的 30，不从 settings 里读一个可能被改脏的值。 */
export function timelineSeconds(scene: PrevizScene): number {
  return scene.settings.durationFrames / PREVIZ_FPS;
}

/** 片段最短长度（帧）。0 长片段的 `frameToU` 无解，时间轴上也点不中。 */
export const PREVIZ_MIN_CLIP_FRAMES = 1;

/** 换掉某条轨道，其余原样。所有写操作都经过它，免得每个函数各写一遍 map。 */
function withTrack(scene: PrevizScene, trackId: string, next: PrevizTrack): PrevizScene {
  return {
    ...scene,
    timeline: {
      tracks: scene.timeline.tracks.map((track) => (track.id === trackId ? next : track)),
    },
  };
}

/** 换掉某个片段（换成数组是为了让剃刀能用同一条路径把一个片段变成两个）。 */
function withClips(scene: PrevizScene, clipId: string, next: PrevizClip[]): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  return withTrack(scene, found.track.id, {
    ...found.track,
    clips: found.track.clips.flatMap((clip) => (clip.id === clipId ? next : [clip])),
  });
}

/** 新建或替换一个路径片段；对象还没有轨道时顺手建一条。 */
export function upsertPathClip(
  scene: PrevizScene,
  objectId: string,
  clip: PrevizPathClip,
): PrevizScene {
  const track = trackFor(scene, objectId);
  if (!track) {
    return {
      ...scene,
      timeline: {
        tracks: [...scene.timeline.tracks, { id: uuidv4(), objectId, clips: [clip] }],
      },
    };
  }
  const exists = track.clips.some((entry) => entry.id === clip.id);
  return withTrack(scene, track.id, {
    ...track,
    clips: exists
      ? track.clips.map((entry) => (entry.id === clip.id ? clip : entry))
      : [...track.clips, clip],
  });
}

/**
 * 整体平移片段。撞到 0 或时间轴末尾时**保长**——夹的是起点，不是两端各夹各的，
 * 后者会在边界上把片段压扁。
 */
export function moveClip(
  scene: PrevizScene,
  clipId: string,
  deltaFrames: number,
  maxFrame: number,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  const { clip } = found;
  const span = clip.endFrame - clip.startFrame;
  const start = Math.min(
    Math.max(0, maxFrame - span),
    Math.max(0, clip.startFrame + Math.round(deltaFrames)),
  );
  return withClips(scene, clipId, [{ ...clip, startFrame: start, endFrame: start + span }]);
}

/** 把某一边拉到指定帧。两边至少留 `PREVIZ_MIN_CLIP_FRAMES` 帧，不许交叉。 */
export function trimClip(
  scene: PrevizScene,
  clipId: string,
  edge: 'start' | 'end',
  frame: number,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  const { clip } = found;
  const target = Math.round(frame);

  if (edge === 'start') {
    const start = Math.min(Math.max(0, target), clip.endFrame - PREVIZ_MIN_CLIP_FRAMES);
    return withClips(scene, clipId, [{ ...clip, startFrame: start }]);
  }
  const end = Math.max(target, clip.startFrame + PREVIZ_MIN_CLIP_FRAMES);
  return withClips(scene, clipId, [{ ...clip, endFrame: end }]);
}

/** 把点列按切点重新归一化到 0..1，并保证切点两侧各有一个点。 */
function halfPoints(clip: PrevizPathClip, uCut: number, side: 'left' | 'right'): PrevizPathPoint[] {
  const sorted = sortedPathPoints(clip.points);
  if (sorted.length === 0) return [];

  const cut: PrevizPathPoint = {
    id: uuidv4(),
    u: side === 'left' ? 1 : 0,
    position: samplePathPosition(sorted, uCut),
    rotation: samplePathRotation(sorted, uCut),
    // 切点的朝向是从曲线采出来的，不是用户调的——标成已编辑会让它把右半段后面所有
    // 点的朝向都传播成自己。
  };

  if (side === 'left') {
    const kept = sorted
      .filter((point) => point.u < uCut)
      .map((point) => ({ ...point, u: point.u / uCut }));
    return [...kept, cut];
  }
  const kept = sorted
    .filter((point) => point.u > uCut)
    .map((point) => ({ ...point, u: (point.u - uCut) / (1 - uCut) }));
  return [cut, ...kept];
}

/**
 * 剃刀：在某一帧把路径片段切成两条各自完整的轨迹。切点两侧各留一个关键帧——不留的话
 * 两半在接缝处会各自朝下一个远处的点甩出去，播放起来是一个明显的跳。
 * 切在端点或片段之外一律不动：那会产出长度为 0 的片段。
 */
export function splitClip(scene: PrevizScene, clipId: string, frame: number): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isPathClip(found.clip)) return scene;
  const clip = found.clip;
  const cut = Math.round(frame);
  if (cut <= clip.startFrame || cut >= clip.endFrame) return scene;

  const uCut = frameToU(clip, cut);
  return withClips(scene, clipId, [
    { ...clip, id: uuidv4(), endFrame: cut, points: halfPoints(clip, uCut, 'left') },
    { ...clip, id: uuidv4(), startFrame: cut, points: halfPoints(clip, uCut, 'right') },
  ]);
}

export function removeClip(scene: PrevizScene, clipId: string): PrevizScene {
  return withClips(scene, clipId, []);
}

export function removeTrack(scene: PrevizScene, objectId: string): PrevizScene {
  return {
    ...scene,
    timeline: { tracks: scene.timeline.tracks.filter((track) => track.objectId !== objectId) },
  };
}
