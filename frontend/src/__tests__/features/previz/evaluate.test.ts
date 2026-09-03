// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  PREVIZ_RIG_ANCHOR_FRACTION,
  PREVIZ_RIG_ORBIT_DEG,
} from '@/features/previz/domain/closeup';
import { evaluateSceneAt } from '@/features/previz/domain/evaluate';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  type PrevizCamera,
  type PrevizCharacter,
  type PrevizPathClip,
  type PrevizRigClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';

function sceneWithCharacter(): { scene: PrevizScene; character: PrevizCharacter } {
  const character = createPrevizObject('character', []) as PrevizCharacter;
  character.transform.position = [5, 0, 5];
  character.transform.rotation = [0, 45, 0];
  return { scene: { ...createDefaultScene(), objects: [character] }, character };
}

function clipFor(startFrame: number, endFrame: number): PrevizPathClip {
  return {
    id: 'clip',
    kind: 'path',
    startFrame,
    endFrame,
    points: [
      { id: 'a', u: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { id: 'b', u: 1, position: [10, 0, 0], rotation: [0, 90, 0] },
    ],
  };
}

describe('evaluateSceneAt', () => {
  it('falls back to the static transform for objects with no track', () => {
    const { scene, character } = sceneWithCharacter();
    const frame = evaluateSceneAt(scene, 0);
    expect(frame.get(character.id)?.position).toEqual([5, 0, 5]);
    expect(frame.get(character.id)?.rotation).toEqual([0, 45, 0]);
  });

  it('reports the character base pose and a null pose for everything else', () => {
    const { scene, character } = sceneWithCharacter();
    const camera = createPrevizObject('camera', scene.objects);
    scene.objects.push(camera);
    const frame = evaluateSceneAt(scene, 0);
    expect(frame.get(character.id)?.poseId).toBe(character.basePoseId);
    expect(frame.get(character.id)?.poseTime).toBe(0);
    expect(frame.get(camera.id)?.poseId).toBeNull();
  });

  it('lets a covering path clip override position and rotation', () => {
    const { scene, character } = sceneWithCharacter();
    scene.timeline = { tracks: [{ id: 't', objectId: character.id, clips: [clipFor(0, 120)] }] };
    const mid = evaluateSceneAt(scene, 60).get(character.id);
    expect(mid?.position[0]).toBeCloseTo(5, 10);
    expect(mid?.rotation[1]).toBeCloseTo(45, 10);
  });

  it('leaves the static transform alone outside the clip range', () => {
    const { scene, character } = sceneWithCharacter();
    scene.timeline = { tracks: [{ id: 't', objectId: character.id, clips: [clipFor(60, 120)] }] };
    // 片段之外对象回到自己的静态位置，而不是钉在片段首帧上。
    expect(evaluateSceneAt(scene, 10).get(character.id)?.position).toEqual([5, 0, 5]);
  });

  it('ignores a clip with no points', () => {
    const { scene, character } = sceneWithCharacter();
    const empty: PrevizPathClip = { ...clipFor(0, 120), points: [] };
    scene.timeline = { tracks: [{ id: 't', objectId: character.id, clips: [empty] }] };
    // 「片段建好了还没画」是常态（末尾新建片段就是这样），不能把对象拽到原点。
    expect(evaluateSceneAt(scene, 60).get(character.id)?.position).toEqual([5, 0, 5]);
  });

  it('skips a track whose object is gone', () => {
    const { scene } = sceneWithCharacter();
    scene.timeline = { tracks: [{ id: 't', objectId: 'ghost', clips: [clipFor(0, 120)] }] };
    // parseScene 已经丢掉悬空轨道，这条兜的是运行时脏值（JS 调用方、旧快照）。
    expect(() => evaluateSceneAt(scene, 60)).not.toThrow();
    expect(evaluateSceneAt(scene, 60).has('ghost')).toBe(false);
  });

  it('does not alias the scene transform arrays', () => {
    const { scene, character } = sceneWithCharacter();
    const evaluated = evaluateSceneAt(scene, 0).get(character.id);
    evaluated!.position[0] = 999;
    // 求值结果每帧都会被写进 three 节点；共享数组的话改一次采样就把场景改了。
    expect(scene.objects[0].transform.position[0]).toBe(5);
  });
});

/** 一个人物 + 一台特写机位跟着他。人物身高钉成 180 cm，锚点高度才算得出定值。 */
function sceneWithCloseup(
  patch: Partial<PrevizRigClip> = {},
): { scene: PrevizScene; character: PrevizCharacter; camera: PrevizCamera; clip: PrevizRigClip } {
  const character = createPrevizObject('character', [], { heightCm: 180 });
  character.transform.position = [0, 0, 0];
  const camera = createPrevizObject('camera', [character]);
  camera.transform.position = [99, 99, 99];

  const clip: PrevizRigClip = {
    id: 'rig',
    kind: 'rig',
    startFrame: 0,
    endFrame: 120,
    anchorObjectId: character.id,
    anchorPart: 'face',
    aimObjectId: character.id,
    azimuth: 0,
    elevation: 0,
    distance: 3,
    height: 0,
    bearing: 'custom',
    motion: 'static',
    ...patch,
  };

  return {
    scene: {
      ...createDefaultScene(),
      objects: [character, camera],
      timeline: { tracks: [{ id: 'rt', objectId: camera.id, clips: [clip] }] },
    },
    character,
    camera,
    clip,
  };
}

describe('evaluateSceneAt closeup clips', () => {
  it('parks the camera in front of the tracked face and points it there', () => {
    const { scene, camera } = sceneWithCloseup();
    const state = evaluateSceneAt(scene, 0).get(camera.id);

    const faceY = 1.8 * PREVIZ_RIG_ANCHOR_FRACTION.face;
    expect(state?.position[0]).toBeCloseTo(0, 6);
    expect(state?.position[1]).toBeCloseTo(faceY, 6);
    expect(state?.position[2]).toBeCloseTo(-3, 6);
    // 机位站在人物正面（-Z 一侧）回头看他，所以朝向是掉转过来的 180°，而不是 0。
    expect(state?.rotation[1]).toBeCloseTo(180, 6);
    expect(state?.rotation[0]).toBeCloseTo(0, 6);
  });

  it('follows the tracked object along its own path', () => {
    const { scene, character, camera } = sceneWithCloseup();
    // 人物这一段走 0 → 10；特写必须跟着走，而不是钉在他出发的地方。
    scene.timeline.tracks.push({ id: 'pt', objectId: character.id, clips: [clipFor(0, 120)] });

    const state = evaluateSceneAt(scene, 120).get(camera.id);
    expect(state?.position[0]).toBeCloseTo(10, 6);
    expect(state?.position[2]).toBeCloseTo(-3, 6);
  });

  it('tips down to a low anchor', () => {
    const { scene, camera } = sceneWithCloseup({ anchorPart: 'pelvis', height: 2 });
    const state = evaluateSceneAt(scene, 0).get(camera.id);
    // 机位抬高到锚点之上，视线跟着往下压——朝向是从解算出来的机位反推的，
    // 不是照抄片段里那个俯仰角。
    expect(state?.rotation[0]).toBeLessThan(0);
  });

  it('carries the orbit around over the clip', () => {
    const { scene, camera } = sceneWithCloseup({ motion: 'orbit' });
    const half = evaluateSceneAt(scene, 60).get(camera.id);
    // 半程转过半圈：从 -Z 侧转到 +Z 侧。
    expect(half?.position[2]).toBeCloseTo(3, 6);
    expect(PREVIZ_RIG_ORBIT_DEG).toBe(360);
  });

  it('keeps the camera on its own rotation when nothing is aimed at', () => {
    const { scene, camera } = sceneWithCloseup({ aimObjectId: null });
    scene.objects[1]!.transform.rotation = [0, 33, 0];
    const state = evaluateSceneAt(scene, 0).get(camera.id);
    // 位置照样接管，朝向留给用户——「只定机位不定朝向」是手动构图的用法。
    expect(state?.position[2]).toBeCloseTo(-3, 6);
    expect(state?.rotation[1]).toBe(33);
  });

  it('leaves the camera alone outside the clip and when the anchor is gone', () => {
    const outside = sceneWithCloseup({ startFrame: 60, endFrame: 120 });
    expect(evaluateSceneAt(outside.scene, 10).get(outside.camera.id)?.position).toEqual([
      99, 99, 99,
    ]);

    const orphan = sceneWithCloseup({ anchorObjectId: 'ghost' });
    expect(evaluateSceneAt(orphan.scene, 0).get(orphan.camera.id)?.position).toEqual([99, 99, 99]);
  });

  it('refuses to have a camera track itself', () => {
    const { scene, camera } = sceneWithCloseup();
    scene.timeline.tracks[0]!.clips = [
      { ...(scene.timeline.tracks[0]!.clips[0] as PrevizRigClip), anchorObjectId: camera.id },
    ];
    // 自己跟自己没有不动点：解出来的位置又成了下一帧的锚点。原地不动才是老实的。
    expect(evaluateSceneAt(scene, 0).get(camera.id)?.position).toEqual([99, 99, 99]);
  });
});
