// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  insertCut,
  liveCameraAt,
  retargetCut,
  PREVIZ_MAX_CUTS,
} from '@/features/previz/domain/program';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  type PrevizCutClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';

function cut(id: string, startFrame: number, endFrame: number, cameraId: string): PrevizCutClip {
  return { id, kind: 'cut', startFrame, endFrame, cameraId };
}

/** 两台机位 + 一个人物，时间轴 120 帧。 */
function seed(program: PrevizCutClip[] = []): { scene: PrevizScene; camA: string; camB: string } {
  const base = createDefaultScene();
  const camA = createPrevizObject('camera', base.objects);
  const camB = createPrevizObject('camera', [camA]);
  const man = createPrevizObject('character', [camA, camB]);
  const scene: PrevizScene = {
    ...base,
    objects: [camA, camB, man],
    timeline: { ...base.timeline, program },
  };
  return { scene, camA: camA.id, camB: camB.id };
}

describe('liveCameraAt', () => {
  it('returns the camera whose cut covers the frame, start inclusive and end exclusive', () => {
    const { scene, camA, camB } = seed([cut('c1', 0, 30, 'x'), cut('c2', 30, 60, 'y')]);
    const program = [cut('c1', 0, 30, camA), cut('c2', 30, 60, camB)];
    const staged = { ...scene, timeline: { ...scene.timeline, program } };
    expect(liveCameraAt(staged, 0)).toBe(camA);
    expect(liveCameraAt(staged, 29)).toBe(camA);
    expect(liveCameraAt(staged, 30)).toBe(camB);
    expect(liveCameraAt(staged, 60)).toBeNull();
  });

  it('returns null in a gap and on an empty program', () => {
    const { scene, camA } = seed();
    expect(liveCameraAt(scene, 10)).toBeNull();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 20, 30, camA)] } };
    expect(liveCameraAt(staged, 10)).toBeNull();
  });
});

describe('insertCut', () => {
  it('case 3: fills the gap from the playhead to the end of the timeline', () => {
    const { scene, camA } = seed();
    const result = insertCut(scene, 10, camA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.timeline.program).toMatchObject([
      { kind: 'cut', startFrame: 10, endFrame: 120, cameraId: camA },
    ]);
  });

  it('case 3: stops at the next cut when inserting into a gap', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 50, 80, camB)] } };
    const result = insertCut(staged, 10, camA);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [10, 50, camA],
      [50, 80, camB],
    ]);
  });

  it('case 2: splits the cut under the playhead and hands the tail to the new camera', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    const result = insertCut(staged, 20, camB);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [0, 20, camA],
      [20, 60, camB],
    ]);
    expect(result.scene.timeline.program[0]?.id).toBe('c1');
  });

  it('case 1: retargets the cut whose start is exactly at the playhead', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 20, 60, camA)] } };
    const result = insertCut(staged, 20, camB);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program).toEqual([cut('c1', 20, 60, camB)]);
  });

  it('case 0: rejects when the covering cut already uses that camera', () => {
    const { scene, camA } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    expect(insertCut(staged, 30, camA)).toEqual({ ok: false, reason: 'same-camera' });
    expect(insertCut(staged, 0, camA)).toEqual({ ok: false, reason: 'same-camera' });
  });

  it('case 4: rejects at the very end of the timeline', () => {
    const { scene, camA } = seed();
    expect(insertCut(scene, 120, camA)).toEqual({ ok: false, reason: 'no-room' });
    const packed = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 100, 120, camA)] } };
    // 播放头压在最后一段的末尾之后：空隙是 0 帧。
    expect(insertCut(packed, 120, camA)).toEqual({ ok: false, reason: 'no-room' });
  });

  it('case 5: rejects once the program holds PREVIZ_MAX_CUTS cuts', () => {
    const { scene, camA, camB } = seed();
    const program = Array.from({ length: PREVIZ_MAX_CUTS }, (_, index) =>
      cut(`c${index}`, index, index + 1, index % 2 ? camA : camB),
    );
    const staged = { ...scene, timeline: { ...scene.timeline, program } };
    expect(insertCut(staged, PREVIZ_MAX_CUTS + 5, camA)).toEqual({ ok: false, reason: 'limit' });
  });

  it('rejects an id that is not a camera', () => {
    const { scene } = seed();
    const man = scene.objects.find((object) => object.kind === 'character')!;
    expect(insertCut(scene, 0, man.id)).toEqual({ ok: false, reason: 'no-camera' });
    expect(insertCut(scene, 0, 'nope')).toEqual({ ok: false, reason: 'no-camera' });
  });

  it('never mutates the input scene', () => {
    const { scene, camA } = seed();
    const before = JSON.stringify(scene);
    insertCut(scene, 10, camA);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('never mutates the input scene when splitting a covered cut', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    const before = JSON.stringify(staged);
    insertCut(staged, 20, camB);
    expect(JSON.stringify(staged)).toBe(before);
  });

  it('never mutates the input scene when retargeting a cut at its start', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 20, 60, camA)] } };
    const before = JSON.stringify(staged);
    insertCut(staged, 20, camB);
    expect(JSON.stringify(staged)).toBe(before);
  });

  it('case 2: rejects a split once the program holds PREVIZ_MAX_CUTS cuts', () => {
    const { scene, camA, camB } = seed();
    // 每段 2 帧、正好排满 0..120：60 段撑到 PREVIZ_MAX_CUTS 上限，且每段都有可切的内部帧。
    const program = Array.from({ length: PREVIZ_MAX_CUTS }, (_, index) =>
      cut(`c${index}`, index * 2, index * 2 + 2, index % 2 ? camA : camB),
    );
    const staged = { ...scene, timeline: { ...scene.timeline, program } };
    // 第 0 段（0..2）是 camB，帧 1 落在段内部，换成 camA 会触发 split 而不是 retarget。
    expect(insertCut(staged, 1, camA)).toEqual({ ok: false, reason: 'limit' });
  });

  it('case 1: retargeting a cut succeeds even when the program is at PREVIZ_MAX_CUTS', () => {
    const { scene, camA, camB } = seed();
    const program = Array.from({ length: PREVIZ_MAX_CUTS }, (_, index) =>
      cut(`c${index}`, index * 2, index * 2 + 2, index % 2 ? camA : camB),
    );
    const staged = { ...scene, timeline: { ...scene.timeline, program } };
    const result = insertCut(staged, 0, camA);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program).toHaveLength(PREVIZ_MAX_CUTS);
    expect(result.scene.timeline.program[0]).toMatchObject({
      startFrame: 0,
      endFrame: 2,
      cameraId: camA,
    });
  });

  it('case 3: inserts into a gap between two existing cuts', () => {
    const { scene, camA, camB } = seed();
    const staged = {
      ...scene,
      timeline: { ...scene.timeline, program: [cut('c1', 0, 20, camA), cut('c2', 50, 80, camB)] },
    };
    const result = insertCut(staged, 30, camA);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [0, 20, camA],
      [30, 50, camA],
      [50, 80, camB],
    ]);
  });

  it('case 4: rejects when the gap to the end of a shortened timeline is zero frames', () => {
    const { scene, camA } = seed();
    const shortened = { ...scene, settings: { ...scene.settings, durationFrames: 30 } };
    const staged = {
      ...shortened,
      timeline: { ...shortened.timeline, program: [cut('c1', 0, 30, camA)] },
    };
    expect(insertCut(staged, 30, camA)).toEqual({ ok: false, reason: 'no-room' });
  });

  it('rejects a non-finite frame instead of producing a NaN cut', () => {
    const { scene, camA } = seed();
    expect(insertCut(scene, Number.NaN, camA)).toEqual({ ok: false, reason: 'no-room' });
  });
});

describe('retargetCut', () => {
  it('retargets the named cut', () => {
    const { scene, camA, camB } = seed();
    const staged = {
      ...scene,
      timeline: {
        ...scene.timeline,
        program: [cut('c1', 0, 60, camA), cut('c2', 60, 120, camB)],
      },
    };
    const next = retargetCut(staged, 'c1', camB);
    expect(next.timeline.program).toEqual([cut('c1', 0, 60, camB), cut('c2', 60, 120, camB)]);
  });

  it('returns the same object when the cut id is unknown', () => {
    const { scene, camA } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    expect(retargetCut(staged, 'nope', camA)).toBe(staged);
  });

  it('returns the same object when the target id is not a camera', () => {
    const { scene, camA } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    const man = scene.objects.find((object) => object.kind === 'character')!;
    expect(retargetCut(staged, 'c1', man.id)).toBe(staged);
  });

  it('returns the same object when the target camera id is unknown', () => {
    const { scene, camA } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    expect(retargetCut(staged, 'c1', 'nope')).toBe(staged);
  });

  it('returns the same object when the cut already points at that camera', () => {
    const { scene, camA } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    expect(retargetCut(staged, 'c1', camA)).toBe(staged);
  });

  it('only touches the first cut when two cuts share an id', () => {
    // parseScene 不去重；同 id 出现两次时，按下标定位应该只改命中的第一条。
    const { scene, camA, camB } = seed();
    const staged = {
      ...scene,
      timeline: {
        ...scene.timeline,
        program: [cut('dup', 0, 30, camA), cut('dup', 30, 60, camA)],
      },
    };
    const next = retargetCut(staged, 'dup', camB);
    expect(next.timeline.program).toEqual([cut('dup', 0, 30, camB), cut('dup', 30, 60, camA)]);
  });

  it('never mutates the input scene', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    const before = structuredClone(staged);
    retargetCut(staged, 'c1', camB);
    expect(staged).toEqual(before);
  });
});
