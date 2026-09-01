// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  PREVIZ_FPS,
  type PrevizClip,
  type PrevizPathClip,
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
