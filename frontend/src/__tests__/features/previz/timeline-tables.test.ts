// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { createRigClip } from '@/features/previz/domain/closeupClip';
import {
  createDefaultScene,
  type PrevizAudioClip,
  type PrevizCutClip,
  type PrevizScene,
  type PrevizTrack,
} from '@/features/previz/domain/scene';
import {
  clipById,
  isAudioClip,
  isCutClip,
  moveClip,
  removeClip,
  splitClip,
  trimClip,
} from '@/features/previz/domain/timeline';

function cut(id: string, startFrame: number, endFrame: number): PrevizCutClip {
  return { id, kind: 'cut', startFrame, endFrame, cameraId: 'cam' };
}

function audio(
  id: string,
  startFrame: number,
  endFrame: number,
  extra: Partial<PrevizAudioClip> = {},
): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: '/static/a.mp3',
    sourceName: 'a.mp3',
    durationMs: 4000, // 30 fps 下 120 帧
    offsetMs: 0,
    sourceNodeId: null,
    ...extra,
  };
}

function sceneWith(tables: {
  tracks?: PrevizTrack[];
  program?: PrevizCutClip[];
  audio?: PrevizAudioClip[];
}): PrevizScene {
  const base = createDefaultScene();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: tables.tracks ?? [],
      program: tables.program ?? [],
      audio: tables.audio ?? [],
    },
  };
}

describe('clipById across tables', () => {
  it('finds cuts and audio clips and reports which table they live in', () => {
    const scene = sceneWith({ program: [cut('c1', 0, 10)], audio: [audio('a1', 0, 10)] });
    expect(clipById(scene, 'c1')).toEqual({ table: 'program', index: 0, clip: cut('c1', 0, 10) });
    expect(clipById(scene, 'a1')).toEqual({ table: 'audio', index: 0, clip: audio('a1', 0, 10) });
    expect(clipById(scene, 'nope')).toBeUndefined();
  });

  it('exposes type guards for the two new kinds', () => {
    expect(isCutClip(cut('c', 0, 1))).toBe(true);
    expect(isAudioClip(cut('c', 0, 1))).toBe(false);
    expect(isAudioClip(audio('a', 0, 1))).toBe(true);
  });
});

describe('moveClip on program and audio', () => {
  it('moves a cut and clamps it against its neighbours', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20), cut('b', 30, 50), cut('c', 60, 80)] });
    const left = moveClip(scene, 'b', -100, 120);
    expect(left.timeline.program.map((c) => [c.startFrame, c.endFrame])).toEqual([
      [0, 20],
      [20, 40],
      [60, 80],
    ]);
    const right = moveClip(scene, 'b', 100, 120);
    expect(right.timeline.program[1]).toMatchObject({ startFrame: 40, endFrame: 60 });
  });

  it('clamps the last cut to the timeline end', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(moveClip(scene, 'a', 500, 120).timeline.program[0]).toMatchObject({
      startFrame: 100,
      endFrame: 120,
    });
  });

  it('moves an audio clip and keeps its offset', () => {
    const scene = sceneWith({ audio: [audio('a', 10, 40, { offsetMs: 500 })] });
    expect(moveClip(scene, 'a', 5, 120).timeline.audio[0]).toMatchObject({
      startFrame: 15,
      endFrame: 45,
      offsetMs: 500,
    });
  });

  it('returns the same scene when there is no actual displacement', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(moveClip(scene, 'a', 0, 120)).toBe(scene);
  });

  it('ignores non-finite deltas', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(moveClip(scene, 'a', Number.NaN, 120)).toBe(scene);
    expect(moveClip(scene, 'a', Number.POSITIVE_INFINITY, 120)).toBe(scene);
  });
});

describe('trimClip on program', () => {
  it('trims the start no earlier than the previous cut ends', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20), cut('b', 30, 50)] });
    expect(trimClip(scene, 'b', 'start', 5).timeline.program[1]).toMatchObject({
      startFrame: 20,
      endFrame: 50,
    });
  });

  it('trims the end no later than the next cut starts', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20), cut('b', 30, 50)] });
    expect(trimClip(scene, 'a', 'end', 45).timeline.program[0]).toMatchObject({
      startFrame: 0,
      endFrame: 30,
    });
  });

  it('keeps at least one frame', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(trimClip(scene, 'a', 'start', 99).timeline.program[0]).toMatchObject({
      startFrame: 19,
      endFrame: 20,
    });
  });
});

describe('trimClip on audio', () => {
  it('shifts the offset when the start moves right', () => {
    const scene = sceneWith({ audio: [audio('a', 0, 60, { offsetMs: 0 })] });
    expect(trimClip(scene, 'a', 'start', 30).timeline.audio[0]).toMatchObject({
      startFrame: 30,
      endFrame: 60,
      offsetMs: 1000,
    });
  });

  it('cannot pull the start earlier than the material allows', () => {
    // 偏移 1000 ms = 30 帧，最多只能往左拉 30 帧。
    const scene = sceneWith({ audio: [audio('a', 40, 60, { offsetMs: 1000 })] });
    expect(trimClip(scene, 'a', 'start', 0).timeline.audio[0]).toMatchObject({
      startFrame: 10,
      endFrame: 60,
      offsetMs: 0,
    });
  });

  it('caps the end at what is left of the material', () => {
    // 4000 ms − 1000 ms = 3000 ms = 90 帧。
    const scene = sceneWith({ audio: [audio('a', 10, 40, { offsetMs: 1000 })] });
    expect(trimClip(scene, 'a', 'end', 500).timeline.audio[0]).toMatchObject({
      startFrame: 10,
      endFrame: 100,
      offsetMs: 1000,
    });
  });

  it('caps the end at the next audio clip', () => {
    const scene = sceneWith({ audio: [audio('a', 0, 20), audio('b', 30, 50)] });
    expect(trimClip(scene, 'a', 'end', 45).timeline.audio[0]).toMatchObject({ endFrame: 30 });
  });

  it('caps the end at the material floor, never below one frame', () => {
    // 素材只剩 0 帧（1000 ms 时长，offset 就是 1000 ms），但最小长度守着 1 帧。
    const scene = sceneWith({ audio: [audio('a', 0, 20, { durationMs: 1000, offsetMs: 1000 })] });
    expect(trimClip(scene, 'a', 'end', 100).timeline.audio[0]).toMatchObject({ endFrame: 1 });
  });

  it('does not strand a frame when offsetMs is a repeating decimal (C-1)', () => {
    // trim 到 31 帧后 offsetMs = 1033.333…ms；再 trim 回 0 应该精确落回 startFrame 0 / offsetMs 0，
    // 不能因为取整误差卡在 1 帧回不去。
    const scene = sceneWith({ audio: [audio('a', 0, 200, { offsetMs: 0 })] });
    const trimmedRight = trimClip(scene, 'a', 'start', 31);
    const trimmedBack = trimClip(trimmedRight, 'a', 'start', 0);
    expect(trimmedBack.timeline.audio[0]).toEqual(
      expect.objectContaining({ startFrame: 0, offsetMs: 0 }),
    );
  });

  it('ignores non-finite frames', () => {
    const scene = sceneWith({ audio: [audio('a', 10, 40, { offsetMs: 500 })] });
    expect(trimClip(scene, 'a', 'start', Number.NaN)).toBe(scene);
    expect(trimClip(scene, 'a', 'start', Number.POSITIVE_INFINITY)).toBe(scene);
    expect(trimClip(scene, 'a', 'end', Number.NaN)).toBe(scene);
    expect(trimClip(scene, 'a', 'end', Number.POSITIVE_INFINITY)).toBe(scene);
  });
});

describe('splitClip on program and audio', () => {
  it('splits a cut into two with fresh ids', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    const next = splitClip(scene, 'a', 5);
    expect(next.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [0, 5, 'cam'],
      [5, 20, 'cam'],
    ]);
    expect(next.timeline.program[0]?.id).not.toBe('a');
    expect(next.timeline.program[0]?.id).not.toBe(next.timeline.program[1]?.id);
  });

  it('splits an audio clip and advances the right half offset', () => {
    const scene = sceneWith({ audio: [audio('a', 0, 60, { offsetMs: 500 })] });
    const next = splitClip(scene, 'a', 30);
    expect(next.timeline.audio.map((c) => [c.startFrame, c.endFrame, c.offsetMs])).toEqual([
      [0, 30, 500],
      [30, 60, 1500],
    ]);
  });

  it('ignores a cut outside the clip', () => {
    const scene = sceneWith({ program: [cut('a', 10, 20)] });
    expect(splitClip(scene, 'a', 10)).toBe(scene);
    expect(splitClip(scene, 'a', 20)).toBe(scene);
  });

  it('is a no-op on a rig clip — closeups have no keyframes to split', () => {
    const rig = createRigClip({ anchorObjectId: 'target', startFrame: 0, endFrame: 40 });
    const scene = sceneWith({ tracks: [{ id: 't1', objectId: 'cam', clips: [rig] }] });
    expect(splitClip(scene, rig.id, 20)).toBe(scene);
  });

  it('ignores non-finite frames', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(splitClip(scene, 'a', Number.NaN)).toBe(scene);
    expect(splitClip(scene, 'a', Number.POSITIVE_INFINITY)).toBe(scene);
  });
});

describe('duplicate ids (I-3): withClips must act on the located index, not re-search by id', () => {
  // parseScene 不做去重，重复 id 在读盘之后仍可能存在——按 id 搜索会把两条一起改掉。
  it('splits only the clip actually located, leaving the other duplicate alone', () => {
    const scene = sceneWith({ program: [cut('dup', 0, 10), cut('dup', 20, 30)] });
    const next = splitClip(scene, 'dup', 5);
    expect(next.timeline.program.map((c) => [c.startFrame, c.endFrame])).toEqual([
      [0, 5],
      [5, 10],
      [20, 30],
    ]);
  });

  it('moves only the clip actually located, leaving the other duplicate alone', () => {
    const scene = sceneWith({ program: [cut('dup', 0, 10), cut('dup', 20, 30)] });
    const next = moveClip(scene, 'dup', 3, 120);
    expect(next.timeline.program.map((c) => [c.startFrame, c.endFrame])).toEqual([
      [3, 13],
      [20, 30],
    ]);
  });
});

describe('purity (I-2)', () => {
  it('never touches the scene it was handed', () => {
    const scene = sceneWith({
      program: [cut('a', 0, 20), cut('b', 30, 50)],
      audio: [audio('x', 0, 20)],
    });
    const before = structuredClone(scene);
    moveClip(scene, 'b', 5, 120);
    trimClip(scene, 'x', 'start', 10);
    splitClip(scene, 'a', 10);
    removeClip(scene, 'a');
    expect(scene).toEqual(before);
  });
});

describe('removeClip on program and audio', () => {
  it('removes from whichever table holds the id', () => {
    const scene = sceneWith({ program: [cut('c1', 0, 10)], audio: [audio('a1', 0, 10)] });
    expect(removeClip(scene, 'c1').timeline.program).toEqual([]);
    expect(removeClip(scene, 'c1').timeline.audio).toHaveLength(1);
    expect(removeClip(scene, 'a1').timeline.audio).toEqual([]);
  });
});
