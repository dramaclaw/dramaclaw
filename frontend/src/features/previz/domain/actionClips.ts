// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { PREVIZ_MOTION_LIMITS } from './limits';
import { importMotionRef, isKnownMotionId, motionInfo, type PrevizMotionInfo } from './motionLibrary';
import {
  PREVIZ_FPS,
  type PrevizActionClip,
  type PrevizImportedMotion,
  type PrevizScene,
} from './scene';
import { actionClipsOf, clipById, isActionClip, trackFor, trimClip, upsertClip } from './timeline';

/**
 * 动作片段与导入动作的场景操作。同 `timeline.ts`：纯函数，无变化时交回同一个场景对象，
 * store 靠引用相等跳过 undo 快照。
 */

/** 循环动作新建时铺多长：绕一两圈足够看出是什么动作，又不至于一下占掉半条时间轴。 */
const LOOP_DEFAULT_SEC = 2;
/** 新建片段的最短长度：比这短的单次动作（出拳 0.47 秒）在时间轴上几乎点不中。 */
const MIN_NEW_CLIP_SEC = 1;

export type ActionInsertRejection = 'no-room' | 'limit' | 'unknown-motion' | 'not-character';

export type ActionClipPlan =
  | { ok: true; startFrame: number; endFrame: number }
  | { ok: false; reason: ActionInsertRejection };

/** 新建片段的帧数：单次动作取自身时长，循环动作取 2 秒，都不短于 1 秒。 */
export function newActionClipFrames(info: PrevizMotionInfo): number {
  const seconds = info.loop ? LOOP_DEFAULT_SEC : info.durationSec;
  return Math.max(Math.round(MIN_NEW_CLIP_SEC * PREVIZ_FPS), Math.round(seconds * PREVIZ_FPS));
}

function importedIds(scene: PrevizScene): Set<string> {
  return new Set(scene.motions.map((motion) => motion.id));
}

/**
 * 在 `frame` 处给人物放一段动作会落在哪。与已有动作片段重叠时顺延到其后第一个放得下
 * 的空位；顺延到超出时间轴就放不下。动作库对话框拿它决定「添加」按钮能不能按。
 */
export function planActionClip(
  scene: PrevizScene,
  objectId: string,
  motionId: string,
  frame: number,
): ActionClipPlan {
  const object = scene.objects.find((entry) => entry.id === objectId);
  if (object?.kind !== 'character') return { ok: false, reason: 'not-character' };
  if (!isKnownMotionId(motionId, importedIds(scene))) return { ok: false, reason: 'unknown-motion' };
  const info = motionInfo(scene.motions, motionId);
  if (!info) return { ok: false, reason: 'unknown-motion' };

  const track = trackFor(scene, objectId);
  const clips = track ? actionClipsOf(track) : [];
  if (clips.length >= PREVIZ_MOTION_LIMITS.clipsPerCharacter) return { ok: false, reason: 'limit' };
  // 帧号不是有限数就没有「这一帧」可放，同 `audioInsertBlockedAt`。
  if (!Number.isFinite(frame)) return { ok: false, reason: 'no-room' };

  const length = newActionClipFrames(info);
  let start = Math.max(0, Math.round(frame));
  for (const clip of clips) {
    if (clip.endFrame <= start) continue;
    if (clip.startFrame >= start + length) break;
    start = clip.endFrame;
  }
  if (start + length > scene.settings.durationFrames) return { ok: false, reason: 'no-room' };
  return { ok: true, startFrame: start, endFrame: start + length };
}

export type InsertActionClipResult =
  | { ok: true; scene: PrevizScene; clipId: string }
  | { ok: false; reason: ActionInsertRejection };

export function insertActionClip(
  scene: PrevizScene,
  objectId: string,
  motionId: string,
  frame: number,
): InsertActionClipResult {
  const plan = planActionClip(scene, objectId, motionId, frame);
  if (!plan.ok) return plan;
  const clip: PrevizActionClip = {
    id: uuidv4(),
    kind: 'action',
    startFrame: plan.startFrame,
    endFrame: plan.endFrame,
    motionId,
  };
  return { ok: true, scene: upsertClip(scene, objectId, clip), clipId: clip.id };
}

/** 换动作，区间不变。换成同一条、或换成解析不出的引用时原样交回。 */
export function setActionMotion(scene: PrevizScene, clipId: string, motionId: string): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || found.table !== 'tracks' || !isActionClip(found.clip)) return scene;
  if (found.clip.motionId === motionId) return scene;
  if (!isKnownMotionId(motionId, importedIds(scene))) return scene;
  return upsertClip(scene, found.track.objectId, { ...found.clip, motionId });
}

/**
 * 「对齐动作时长」：结束帧改成恰好播完一遍。夹取与手动拖右缘同一套（`trimClip`：
 * 不压到下一段），另外不超出时间轴。
 */
export function fitActionToMotion(scene: PrevizScene, clipId: string): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isActionClip(found.clip)) return scene;
  const info = motionInfo(scene.motions, found.clip.motionId);
  if (!info) return scene;
  const target = Math.min(
    scene.settings.durationFrames,
    found.clip.startFrame + Math.max(1, Math.round(info.durationSec * PREVIZ_FPS)),
  );
  const next = trimClip(scene, clipId, 'end', target);
  const trimmed = clipById(next, clipId)?.clip;
  return trimmed?.endFrame === found.clip.endFrame ? scene : next;
}

/**
 * 追加导入动作，超出上限的部分丢掉。对话框在上传前已经按剩余名额拦过，这里只是兜底。
 *
 * 按 id 去重（已在场景里的、以及本批内部重复的都跳过），与 `parseScene` 里 `parseMotions`
 * 的 `seen` 集合同一套规则——否则一次导入回调打两次，或者候选列表本身带重复 id，
 * 就会在 `scene.motions` 里插进两条同 id 的记录，谁生效全看后面按 id 找的时候先碰到哪条。
 */
export function addImportedMotions(
  scene: PrevizScene,
  motions: readonly PrevizImportedMotion[],
): PrevizScene {
  const room = PREVIZ_MOTION_LIMITS.imported - scene.motions.length;
  if (room <= 0 || motions.length === 0) return scene;
  const seen = new Set(scene.motions.map((motion) => motion.id));
  const fresh: PrevizImportedMotion[] = [];
  for (const motion of motions) {
    if (fresh.length >= room) break;
    if (seen.has(motion.id)) continue;
    seen.add(motion.id);
    fresh.push(motion);
  }
  if (fresh.length === 0) return scene;
  return { ...scene, motions: [...scene.motions, ...fresh] };
}

export function renameImportedMotion(scene: PrevizScene, importedId: string, name: string): PrevizScene {
  const trimmed = name.trim();
  const index = scene.motions.findIndex((motion) => motion.id === importedId);
  // 空名字在卡片上是一块空白，没法再点回来改。
  if (index < 0 || trimmed === '' || scene.motions[index]!.name === trimmed) return scene;
  return {
    ...scene,
    motions: scene.motions.map((motion, at) => (at === index ? { ...motion, name: trimmed } : motion)),
  };
}

/** 引用这条导入动作的片段数，删除确认框写「N 个片段会一并删除」。 */
export function actionClipsUsing(scene: PrevizScene, importedId: string): number {
  const ref = importMotionRef(importedId);
  return scene.timeline.tracks.reduce(
    (count, track) =>
      count + track.clips.filter((clip) => isActionClip(clip) && clip.motionId === ref).length,
    0,
  );
}

/**
 * 删掉一条导入动作，连同引用它的片段。不留悬空片段：下次 `parseScene` 反正会丢，
 * 留到那时再丢等于让用户在这次会话里看着一段红色斜纹、却找不到它指向的动作。
 */
export function removeImportedMotion(scene: PrevizScene, importedId: string): PrevizScene {
  if (!scene.motions.some((motion) => motion.id === importedId)) return scene;
  const ref = importMotionRef(importedId);
  return {
    ...scene,
    motions: scene.motions.filter((motion) => motion.id !== importedId),
    timeline: {
      ...scene.timeline,
      tracks: scene.timeline.tracks.map((track) =>
        track.clips.some((clip) => isActionClip(clip) && clip.motionId === ref)
          ? { ...track, clips: track.clips.filter((clip) => !isActionClip(clip) || clip.motionId !== ref) }
          : track,
      ),
    },
  };
}
