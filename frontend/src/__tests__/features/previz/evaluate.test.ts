// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { evaluateSceneAt } from '@/features/previz/domain/evaluate';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  type PrevizCharacter,
  type PrevizPathClip,
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
