// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  PREVIZ_AGENT_EDIT_MAX_OPS,
  agentSceneCatalog,
  agentSceneDigest,
  applyAgentSceneEdit,
} from '@/features/previz/domain/agentEdit';
import { PREVIZ_PRIMITIVE_LIMIT } from '@/features/previz/domain/limits';
import { createDefaultScene, type PrevizScene } from '@/features/previz/domain/scene';
import { evaluateSceneAt } from '@/features/previz/domain/evaluate';
import { trackFor } from '@/features/previz/domain/timeline';

function edit(scene: PrevizScene, value: unknown): PrevizScene {
  const result = applyAgentSceneEdit(scene, value);
  if (!result.ok) throw new Error(result.error);
  return result.scene;
}

function errorOf(scene: PrevizScene, value: unknown): string {
  const result = applyAgentSceneEdit(scene, value);
  if (result.ok) throw new Error('expected the edit to be rejected');
  return result.error;
}

const wall = { kind: 'prop', shape: 'cube', name: '墙', position: [2, 0, 0], scale: [4, 2, 0.2] };

describe('applyAgentSceneEdit', () => {
  it('adds a primitive wall and a camera aimed at it', () => {
    const scene = edit(createDefaultScene(), {
      add: [wall, { kind: 'camera', position: [0, 1.6, 6], lookAt: [0, 1.6, 0], focalMm: 35 }],
    });

    const [prop, camera] = scene.objects;
    expect(prop).toMatchObject({
      kind: 'prop',
      name: '墙',
      assetUrl: 'cube',
      assetFormat: 'primitive',
      transform: { position: [2, 0, 0], scale: [4, 2, 0.2] },
    });
    expect(camera).toMatchObject({ kind: 'camera', focalMm: 35 });
    // 平视正前方：没有俯仰也没有滚转。
    expect(camera.transform.rotation[0]).toBeCloseTo(0);
    expect(camera.transform.rotation[2]).toBeCloseTo(0);
    expect(prop.id).not.toBe(camera.id);
  });

  it('reports what it did by id and shows the result in the digest', () => {
    const result = applyAgentSceneEdit(createDefaultScene(), { add: [wall] });
    if (!result.ok) throw new Error(result.error);

    expect(result.addedIds).toEqual([result.scene.objects[0].id]);
    expect(agentSceneDigest(result.scene)).toMatchObject({
      objectCount: 1,
      primitiveCount: 1,
      primitiveLimit: PREVIZ_PRIMITIVE_LIMIT,
      objects: [{ kind: 'prop', name: '墙', shape: 'cube', position: [2, 0, 0], scale: [4, 2, 0.2] }],
    });
  });

  it('updates only the fields given and removes by id', () => {
    const base = edit(createDefaultScene(), { add: [wall, { ...wall, name: '墙2', position: [0, 0, 3] }] });
    const [first, second] = base.objects;

    const next = edit(base, { update: [{ id: first.id, position: [5, 0, 0] }], remove: [second.id] });

    expect(next.objects).toHaveLength(1);
    expect(next.objects[0]).toMatchObject({
      id: first.id,
      name: '墙',
      transform: { position: [5, 0, 0], scale: [4, 2, 0.2] },
    });
  });

  it('drops the tracks and cuts of a removed object', () => {
    const base = edit(createDefaultScene(), { add: [{ kind: 'camera', position: [0, 1, 5] }] });
    const cameraId = base.objects[0].id;
    const withTimeline = {
      ...base,
      timeline: {
        ...base.timeline,
        tracks: [{ objectId: cameraId }],
        program: [{ cameraId }],
      },
    } as unknown as PrevizScene;

    const next = edit(withTimeline, { remove: [cameraId] });

    expect(next.timeline.tracks).toEqual([]);
    expect(next.timeline.program).toEqual([]);
  });

  it('leaves locked objects alone', () => {
    const base = edit(createDefaultScene(), { add: [wall] });
    const locked = { ...base, objects: [{ ...base.objects[0], locked: true }] } as PrevizScene;
    const id = locked.objects[0].id;

    expect(errorOf(locked, { update: [{ id, position: [0, 0, 0] }] })).toContain('locked');
    expect(errorOf(locked, { remove: [id] })).toContain('locked');
  });

  it('is atomic: one bad entry rejects the whole batch and names it', () => {
    const scene = createDefaultScene();

    expect(errorOf(scene, { add: [wall, { ...wall, shape: 'teapot' }] })).toContain('sceneEdit.add[1].shape');
    expect(scene.objects).toEqual([]);
  });

  it.each([
    ['a model url instead of a primitive', { add: [{ ...wall, assetUrl: 'https://example.com/a.glb' }] }, 'unsupported fields'],
    ['an unknown kind', { add: [{ kind: 'vehicle', position: [0, 0, 0] }] }, 'kind'],
    ['a missing position', { add: [{ kind: 'prop', shape: 'cube' }] }, 'position is required'],
    ['a non-finite coordinate', { add: [{ ...wall, position: [0, Number.NaN, 0] }] }, 'finite'],
    ['a far-away coordinate', { add: [{ ...wall, position: [0, 0, 9999] }] }, 'out of range'],
    ['both lookAt and rotation', { add: [{ kind: 'camera', position: [0, 1, 5], lookAt: [0, 1, 0], rotation: [0, 0, 0] }] }, 'both lookAt and rotation'],
    ['a field of another kind', { add: [{ ...wall, focalMm: 35 }] }, 'unsupported fields'],
    ['an unknown id', { update: [{ id: 'nope', position: [0, 0, 0] }] }, 'does not match'],
    ['an unknown top-level key', { objects: [] }, 'unsupported fields'],
    ['an empty edit', {}, 'empty'],
    ['a non-object', 'make a maze', 'must be an object'],
  ])('rejects %s', (_label, value, message) => {
    expect(errorOf(createDefaultScene(), value)).toContain(message);
  });

  it('refuses to go past the primitive limit, and past the batch size', () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => ({ ...wall, position: [i, 0, 0] }));

    expect(applyAgentSceneEdit(createDefaultScene(), { add: many(PREVIZ_PRIMITIVE_LIMIT) }).ok).toBe(true);
    expect(errorOf(createDefaultScene(), { add: many(PREVIZ_PRIMITIVE_LIMIT + 1) })).toContain('primitive limit');
    expect(errorOf(createDefaultScene(), { add: many(PREVIZ_AGENT_EDIT_MAX_OPS + 1) })).toContain('operations');
  });
});

describe('applyAgentSceneEdit timeline', () => {
  const cast = {
    add: [
      { kind: 'character', ref: 'hero', position: [0, 0, 0] },
      { kind: 'camera', ref: 'cam', position: [0, 1.6, 6] },
    ],
  };

  function staged(): { scene: PrevizScene; heroId: string; camId: string } {
    const scene = edit(createDefaultScene(), cast);
    return { scene, heroId: scene.objects[0].id, camId: scene.objects[1].id };
  }

  it('adds a character, walks it, follows it and cuts to the camera in one batch', () => {
    const scene = edit(createDefaultScene(), {
      ...cast,
      timeline: {
        paths: [{ objectId: 'hero', points: [[0, 0, 0], [0, 0, -7]], speedMps: 1.4 }],
        follows: [{ cameraId: 'cam', targetId: 'hero', distance: 4, azimuth: 180 }],
        actions: [{ objectId: 'hero', motion: 'Walk_Loop', startFrame: 0, endFrame: 150 }],
        cuts: [{ frame: 0, cameraId: 'cam' }],
      },
    });
    const [hero, camera] = scene.objects;

    // 7 米按 1.4 m/s 走 5 秒 = 150 帧；默认 120 帧的时间轴被拉长到刚好装下。
    expect(scene.settings.durationFrames).toBe(150);
    expect(trackFor(scene, hero.id)?.clips).toMatchObject([
      { kind: 'path', startFrame: 0, endFrame: 150 },
      { kind: 'action', startFrame: 0, endFrame: 150, motionId: 'builtin:Walk_Loop' },
    ]);
    // 跟拍的帧范围抄的是被跟的人那条走位。
    expect(trackFor(scene, camera.id)?.clips).toMatchObject([
      { kind: 'rig', startFrame: 0, endFrame: 150, anchorObjectId: hero.id, aimObjectId: hero.id, distance: 4, azimuth: 180 },
    ]);
    expect(scene.timeline.program).toMatchObject([{ startFrame: 0, endFrame: 150, cameraId: camera.id }]);

    // 求值器真的照着走：人到了半路，机位离开了摆放的位置跟在后面。
    const midway = evaluateSceneAt(scene, 75);
    expect(midway.get(hero.id)?.position[2]).toBeCloseTo(-3.5, 0);
    expect(midway.get(camera.id)?.position[2]).toBeGreaterThan(-3.5);
    expect(midway.get(camera.id)?.position[2]).toBeLessThan(6);
  });

  it('shows clips and cuts in the digest by the names the edit uses', () => {
    const { scene, heroId, camId } = staged();
    const next = edit(scene, {
      timeline: {
        paths: [{ objectId: heroId, points: [[0, 0, 0], [3, 0, 0]], endFrame: 60, aimObjectId: camId }],
        follows: [{ cameraId: camId, targetId: heroId, motion: 'orbit' }],
        actions: [{ objectId: heroId, motion: 'builtin:Idle_Loop' }],
        cuts: [{ frame: 30, cameraId: camId }],
      },
    });
    const digest = agentSceneDigest(next);

    expect(digest).toMatchObject({ fps: 30, durationFrames: 120 });
    expect(digest.objects[0].clips).toMatchObject([
      { kind: 'path', startFrame: 0, endFrame: 60, points: 2, from: [0, 0, 0], to: [3, 0, 0], aimObjectId: camId },
      { kind: 'action', startFrame: 0, endFrame: 60, motion: 'Idle_Loop' },
    ]);
    expect(digest.objects[1].clips).toMatchObject([
      { kind: 'follow', startFrame: 0, endFrame: 60, targetId: heroId, motion: 'orbit' },
    ]);
    expect(digest.cuts).toMatchObject([{ startFrame: 30, endFrame: 120, cameraId: camId }]);
  });

  it('replaces a clip by removing it and adding another in the same batch', () => {
    const { scene, heroId } = staged();
    const walked = edit(scene, { timeline: { paths: [{ objectId: heroId, points: [[0, 0, 0], [2, 0, 0]] }] } });
    const oldClipId = trackFor(walked, heroId)!.clips[0].id;

    const redone = edit(walked, {
      timeline: { removeClips: [oldClipId], paths: [{ objectId: heroId, points: [[0, 0, 0], [0, 0, 2]] }] },
    });

    const clips = trackFor(redone, heroId)!.clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].id).not.toBe(oldClipId);
  });

  it('sets the duration explicitly and never shrinks it for a short path', () => {
    const { scene, heroId } = staged();
    const longer = edit(scene, { timeline: { durationFrames: 300 } });
    expect(longer.settings.durationFrames).toBe(300);

    const walked = edit(longer, { timeline: { paths: [{ objectId: heroId, points: [[0, 0, 0], [1, 0, 0]] }] } });
    expect(walked.settings.durationFrames).toBe(300);
  });

  it('rejects timeline entries it cannot place, naming the entry', () => {
    const { scene, heroId, camId } = staged();
    const timeline = (value: unknown) => errorOf(scene, { timeline: value });

    expect(timeline({ paths: [{ objectId: 'nobody', points: [[0, 0, 0], [1, 0, 0]] }] })).toContain(
      'timeline.paths[0].objectId',
    );
    expect(timeline({ paths: [{ objectId: heroId, points: [[0, 0, 0]] }] })).toContain('at least 2 points');
    expect(timeline({ paths: [{ objectId: heroId, points: [[0, 0, 0], [100, 0, 0]] }] })).toContain(
      'timeline maximum is 360',
    );
    expect(timeline({ paths: [{ objectId: heroId, points: [[0, 0, 0], [1, 0, 0]], url: 'x' }] })).toContain(
      'unsupported fields: url',
    );
    expect(timeline({ follows: [{ cameraId: heroId, targetId: camId }] })).toContain('is not a camera');
    expect(timeline({ follows: [{ cameraId: camId, targetId: camId }] })).toContain('camera itself');
    expect(timeline({ follows: [{ cameraId: camId, targetId: heroId, distance: 500 }] })).toContain('out of range');
    expect(timeline({ actions: [{ objectId: camId, motion: 'Walk_Loop' }] })).toContain('is not a character');
    expect(timeline({ actions: [{ objectId: heroId, motion: 'Moonwalk' }] })).toContain('not a known motion');
    expect(timeline({ actions: [{ objectId: heroId, motion: 'Walk_Loop', endFrame: 200 }] })).toContain(
      'past the timeline end',
    );
    expect(timeline({ cuts: [{ frame: 0, cameraId: heroId }] })).toContain('is not a camera');
    expect(timeline({ cuts: [{ frame: 120, cameraId: camId }] })).toContain('timeline end');
    expect(timeline({ removeClips: ['missing'] })).toContain('timeline.removeClips[0]');
    expect(timeline({ audio: [] })).toContain('unsupported fields: audio');
  });

  it('refuses overlapping action clips and animating a locked object', () => {
    const { scene, heroId } = staged();
    const acted = edit(scene, { timeline: { actions: [{ objectId: heroId, motion: 'Walk_Loop', endFrame: 60 }] } });

    expect(
      errorOf(acted, { timeline: { actions: [{ objectId: heroId, motion: 'Idle_Loop', startFrame: 30, endFrame: 90 }] } }),
    ).toContain('overlaps action clip');
    // 首尾相接不算重叠：动作片段是半开区间。
    edit(acted, { timeline: { actions: [{ objectId: heroId, motion: 'Idle_Loop', startFrame: 60, endFrame: 90 }] } });

    const locked: PrevizScene = {
      ...scene,
      objects: scene.objects.map((object) => (object.id === heroId ? { ...object, locked: true } : object)),
    };
    expect(
      errorOf(locked, { timeline: { paths: [{ objectId: heroId, points: [[0, 0, 0], [1, 0, 0]] }] } }),
    ).toContain('locked by the user');
  });

  it('is atomic across objects and timeline', () => {
    const scene = createDefaultScene();
    const error = errorOf(scene, {
      ...cast,
      timeline: { paths: [{ objectId: 'hero', points: [[0, 0, 0], [1, 0, 0]] }], cuts: [{ frame: 0, cameraId: 'hero' }] },
    });

    expect(error).toContain('timeline.cuts[0]');
    expect(scene.objects).toHaveLength(0);
  });
});

describe('applyAgentSceneEdit library models', () => {
  it('places a library model by id and reports it in the digest', () => {
    const scene = edit(createDefaultScene(), {
      add: [{ kind: 'prop', model: 'furniture-chair', position: [1, 0, 1] }],
    });

    expect(scene.objects[0]).toMatchObject({ kind: 'prop', assetFormat: 'glb', name: 'chair' });
    expect((scene.objects[0] as { assetUrl: string }).assetUrl).toMatch(/\/previz\/models\/v\d+\/furniture\/chair\.glb$/);
    expect(agentSceneDigest(scene).objects[0]).toMatchObject({ shape: 'model', model: 'furniture-chair' });
    // 模型不占基础几何体的名额。
    expect(agentSceneDigest(scene).primitiveCount).toBe(0);
  });

  it('accepts only library ids: no URLs, no primitive ids, not both shape and model', () => {
    const add = (prop: Record<string, unknown>) =>
      errorOf(createDefaultScene(), { add: [{ kind: 'prop', position: [0, 0, 0], ...prop }] });

    expect(add({ model: 'https://evil.example/x.glb' })).toContain('not a model library id');
    expect(add({ model: 'primitive-cube' })).toContain('not a model library id');
    expect(add({ shape: 'cube', model: 'furniture-chair' })).toContain('exactly one of shape');
    expect(add({})).toContain('exactly one of shape');
    expect(add({ model: 'furniture-chair', assetUrl: 'https://evil.example/x.glb' })).toContain(
      'unsupported fields: assetUrl',
    );
  });

  it('lists every motion and model the agent may name', () => {
    const catalog = agentSceneCatalog();

    expect(Object.values(catalog.motions).flat()).toContain('Walk_Loop');
    expect(Object.values(catalog.models).flat()).toContain('furniture-chair');
    // 目录里的每一个名字都得真的放得进去，否则说明在骗 Agent。
    const scene = edit(createDefaultScene(), {
      add: [{ kind: 'character', position: [0, 0, 0] }],
      timeline: { durationFrames: 360 },
    });
    for (const motion of Object.values(catalog.motions).flat()) {
      edit(scene, { timeline: { actions: [{ objectId: scene.objects[0].id, motion }] } });
    }
    for (const model of Object.values(catalog.models).flat().slice(0, 150)) {
      edit(createDefaultScene(), { add: [{ kind: 'prop', model, position: [0, 0, 0] }] });
    }
  });
});
