// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  actionClipsUsing,
  addImportedMotions,
  fitActionToMotion,
  insertActionClip,
  newActionClipFrames,
  planActionClip,
  removeImportedMotion,
  renameImportedMotion,
  setActionMotion,
} from '@/features/previz/domain/actionClips';
import { PREVIZ_MOTION_LIMITS } from '@/features/previz/domain/limits';
import { builtinMotionById } from '@/features/previz/domain/motionLibrary';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  PREVIZ_FPS,
  createDefaultScene,
  type PrevizActionClip,
  type PrevizClip,
  type PrevizImportedMotion,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import {
  actionClipsOf,
  clipById,
  isActionClip,
  moveClip,
  splitClip,
  trimClip,
} from '@/features/previz/domain/timeline';

const LOOP = 'builtin:Idle_Talking_Loop';
const ONCE = 'builtin:Sitting_Enter';
const PUNCH = 'builtin:Melee_Hook';

function action(id: string, startFrame: number, endFrame: number, motionId = LOOP): PrevizActionClip {
  return { id, kind: 'action', startFrame, endFrame, motionId };
}

function imported(id: string, patch: Partial<PrevizImportedMotion> = {}): PrevizImportedMotion {
  return {
    id,
    name: id,
    url: `/u/${id}.bvh`,
    sourceFileName: `${id}.bvh`,
    format: 'bvh',
    skeleton: 'smpl',
    clipIndex: 0,
    durationSec: 1.5,
    loop: false,
    ...patch,
  };
}

/** 一个人物（id `hero`）+ 一台机位（id `cam`），人物轨道上挂着给定片段。时间轴 300 帧。 */
function sceneWith(clips: PrevizClip[] = []): PrevizScene {
  const base = createDefaultScene();
  const hero = { ...createPrevizObject('character', []), id: 'hero' };
  const cam = { ...createPrevizObject('camera', [hero]), id: 'cam' };
  return {
    ...base,
    settings: { ...base.settings, durationFrames: 300 },
    objects: [hero, cam],
    timeline: { ...base.timeline, tracks: [{ id: 't', objectId: 'hero', clips }] },
  };
}

function actionsOf(scene: PrevizScene): PrevizActionClip[] {
  return actionClipsOf(scene.timeline.tracks.find((track) => track.objectId === 'hero')!);
}

describe('timeline on action clips', () => {
  it('sorts the action row out of a mixed track', () => {
    const path: PrevizClip = { id: 'p', kind: 'path', startFrame: 0, endFrame: 300, points: [] };
    const track = { id: 't', objectId: 'hero', clips: [action('b', 100, 200), path, action('a', 0, 50)] };
    expect(actionClipsOf(track).map((clip) => clip.id)).toEqual(['a', 'b']);
    expect(isActionClip(path)).toBe(false);
  });

  it('stops a trimmed edge at the neighbouring action, not at the path clip in between', () => {
    const path: PrevizClip = { id: 'p', kind: 'path', startFrame: 0, endFrame: 300, points: [] };
    // 数组顺序故意打乱：邻居要按起点找，不能按混合数组的下标找。
    const scene = sceneWith([action('b', 100, 200), path, action('a', 0, 50)]);
    expect(clipById(trimClip(scene, 'a', 'end', 150), 'a')?.clip.endFrame).toBe(100);
    expect(clipById(trimClip(scene, 'b', 'start', 10), 'b')?.clip.startFrame).toBe(50);
  });

  it('nudges an action clip only as far as its neighbours allow', () => {
    const scene = sceneWith([action('a', 0, 50), action('b', 60, 100)]);
    expect(clipById(moveClip(scene, 'b', -30, 300), 'b')?.clip.startFrame).toBe(50);
  });

  it('lets path clips keep overlapping each other', () => {
    const scene = sceneWith([
      { id: 'p1', kind: 'path', startFrame: 0, endFrame: 100, points: [] },
      { id: 'p2', kind: 'path', startFrame: 50, endFrame: 150, points: [] },
    ]);
    expect(clipById(trimClip(scene, 'p1', 'end', 140), 'p1')?.clip.endFrame).toBe(140);
  });

  it('splits an action clip into two that both keep the motion', () => {
    const next = splitClip(sceneWith([action('a', 0, 100)]), 'a', 40);
    expect(actionsOf(next).map(({ startFrame, endFrame, motionId }) => ({ startFrame, endFrame, motionId }))).toEqual([
      { startFrame: 0, endFrame: 40, motionId: LOOP },
      { startFrame: 40, endFrame: 100, motionId: LOOP },
    ]);
  });

  it('trims the start handle flush against the previous action clip, half-open ranges touching', () => {
    const scene = sceneWith([action('a', 0, 50), action('b', 100, 200)]);
    const next = trimClip(scene, 'b', 'start', 10);
    // 半开区间 [start, end) 首尾相接：a 止于 50，b 也从 50 开始，交界帧只属于 b。
    expect(clipById(next, 'a')?.clip.endFrame).toBe(50);
    expect(clipById(next, 'b')?.clip.startFrame).toBe(50);
  });

  it('refuses to split when the action row is already full', () => {
    // 59 条占位（各 1 帧，互不重叠）+ 1 条留给真正要切的宽片段，凑满上限 60 条。
    const filler = Array.from({ length: PREVIZ_MOTION_LIMITS.clipsPerCharacter - 1 }, (_, index) =>
      action(`c${index}`, index * 2, index * 2 + 1),
    );
    const wide = action('wide', 120, 200);
    const scene = sceneWith([...filler, wide]);
    // 满行时切一刀会多出一段、变成 61 段——读档时 `slice(0, 60)` 会悄悄丢掉最后一段，
    // 所以这里要拒绝，交回同一个场景引用。
    expect(splitClip(scene, 'wide', 150)).toBe(scene);
  });
});

describe('planActionClip', () => {
  it('sizes a new clip from the motion', () => {
    expect(newActionClipFrames({ durationSec: 2.933, loop: true })).toBe(2 * PREVIZ_FPS);
    expect(newActionClipFrames({ durationSec: 1.3, loop: false })).toBe(39);
    // 太短的单次动作撑到 1 秒，否则时间轴上点不中。
    expect(newActionClipFrames({ durationSec: 0.467, loop: false })).toBe(PREVIZ_FPS);
  });

  it('starts at the playhead when the row is free', () => {
    expect(planActionClip(sceneWith(), 'hero', ONCE, 12)).toEqual({
      ok: true,
      startFrame: 12,
      endFrame: 12 + Math.round(builtinMotionById(ONCE)!.durationSec * PREVIZ_FPS),
    });
  });

  it('pushes past clips it would overlap to the first gap that fits', () => {
    // 60 帧的循环动作：50..90 之间只有 40 帧，放不下，继续顺延到 150。
    const scene = sceneWith([action('a', 0, 50), action('b', 90, 150)]);
    expect(planActionClip(scene, 'hero', LOOP, 20)).toEqual({ ok: true, startFrame: 150, endFrame: 210 });
  });

  it('fits into a gap exactly as wide as the clip needs', () => {
    // 60 帧的循环动作：50..110 之间正好 60 帧，不多不少，应该放得进去。
    const scene = sceneWith([action('a', 0, 50), action('b', 110, 150)]);
    expect(planActionClip(scene, 'hero', LOOP, 0)).toEqual({ ok: true, startFrame: 50, endFrame: 110 });
  });

  it('starts right where the playhead lands, even exactly on the previous clip end', () => {
    // 半开区间：frame 50 已经不属于 a（[0, 50)），落在这一帧不该被当成重叠再顺延。
    const scene = sceneWith([action('a', 0, 50)]);
    expect(planActionClip(scene, 'hero', LOOP, 50)).toEqual({ ok: true, startFrame: 50, endFrame: 110 });
  });

  it('refuses when pushing would run off the timeline', () => {
    expect(planActionClip(sceneWith([action('a', 0, 260)]), 'hero', LOOP, 10)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('refuses non-characters, unknown motions and a full row', () => {
    expect(planActionClip(sceneWith(), 'cam', LOOP, 0)).toEqual({ ok: false, reason: 'not-character' });
    expect(planActionClip(sceneWith(), 'hero', 'import:gone', 0)).toEqual({
      ok: false,
      reason: 'unknown-motion',
    });
    const full = Array.from({ length: PREVIZ_MOTION_LIMITS.clipsPerCharacter }, (_, index) =>
      action(`c${index}`, index * 2, index * 2 + 1),
    );
    expect(planActionClip(sceneWith(full), 'hero', PUNCH, 200)).toEqual({ ok: false, reason: 'limit' });
  });

  it('creates the track for a character that has none yet', () => {
    const scene = { ...sceneWith(), timeline: { ...createDefaultScene().timeline } };
    const result = insertActionClip(scene, 'hero', LOOP, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(actionsOf(result.scene)).toEqual([
      { id: result.clipId, kind: 'action', startFrame: 0, endFrame: 60, motionId: LOOP },
    ]);
  });
});

describe('setActionMotion', () => {
  it('swaps the motion and keeps the range', () => {
    const next = setActionMotion(sceneWith([action('a', 10, 70)]), 'a', ONCE);
    expect(actionsOf(next)).toEqual([action('a', 10, 70, ONCE)]);
  });

  it('hands back the same scene for a no-op or an unknown motion', () => {
    const scene = sceneWith([action('a', 10, 70)]);
    expect(setActionMotion(scene, 'a', LOOP)).toBe(scene);
    expect(setActionMotion(scene, 'a', 'import:gone')).toBe(scene);
    expect(setActionMotion(scene, 'missing', ONCE)).toBe(scene);
  });
});

describe('fitActionToMotion', () => {
  it('ends the clip where the motion finishes', () => {
    const next = fitActionToMotion(sceneWith([action('a', 10, 200, ONCE)]), 'a');
    expect(clipById(next, 'a')?.clip.endFrame).toBe(10 + Math.round(builtinMotionById(ONCE)!.durationSec * PREVIZ_FPS));
  });

  it('stops at the next clip and at the end of the timeline', () => {
    const blocked = fitActionToMotion(sceneWith([action('a', 10, 20, LOOP), action('b', 40, 60)]), 'a');
    expect(clipById(blocked, 'a')?.clip.endFrame).toBe(40);
    const late = fitActionToMotion(sceneWith([action('a', 280, 290, LOOP)]), 'a');
    expect(clipById(late, 'a')?.clip.endFrame).toBe(300);
  });

  it('hands back the same scene when already aligned', () => {
    const scene = sceneWith([action('a', 0, Math.round(builtinMotionById(LOOP)!.durationSec * PREVIZ_FPS))]);
    expect(fitActionToMotion(scene, 'a')).toBe(scene);
  });
});

describe('imported motions', () => {
  it('appends up to the limit', () => {
    const scene = { ...sceneWith(), motions: Array.from({ length: PREVIZ_MOTION_LIMITS.imported - 1 }, (_, index) => imported(`m${index}`)) };
    const next = addImportedMotions(scene, [imported('x'), imported('y')]);
    expect(next.motions.map((motion) => motion.id).slice(-1)).toEqual(['x']);
    expect(addImportedMotions(next, [imported('z')])).toBe(next);
  });

  it('drops ids already in the scene and duplicates within the same batch', () => {
    const scene = { ...sceneWith(), motions: [imported('m1')] };
    const next = addImportedMotions(scene, [imported('m1'), imported('x'), imported('x')]);
    expect(next.motions.map((motion) => motion.id)).toEqual(['m1', 'x']);
    // 整批都是重复 id 时一条都加不进去，交回同一个场景引用。
    expect(addImportedMotions(scene, [imported('m1')])).toBe(scene);
  });

  it('renames with a trimmed, non-empty name', () => {
    const scene = { ...sceneWith(), motions: [imported('m1')] };
    expect(renameImportedMotion(scene, 'm1', '  Wave ').motions[0]?.name).toBe('Wave');
    expect(renameImportedMotion(scene, 'm1', '   ')).toBe(scene);
    expect(renameImportedMotion(scene, 'm1', 'm1')).toBe(scene);
  });

  it('removes a motion together with every clip that plays it', () => {
    const scene = {
      ...sceneWith([action('a', 0, 50, 'import:m1'), action('b', 60, 100), action('c', 120, 160, 'import:m1')]),
      motions: [imported('m1'), imported('m2')],
    };
    expect(actionClipsUsing(scene, 'm1')).toBe(2);
    const next = removeImportedMotion(scene, 'm1');
    expect(next.motions.map((motion) => motion.id)).toEqual(['m2']);
    expect(actionsOf(next).map((clip) => clip.id)).toEqual(['b']);
    expect(removeImportedMotion(next, 'm1')).toBe(next);
  });
});
