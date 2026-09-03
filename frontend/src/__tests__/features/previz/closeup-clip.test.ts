// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  PREVIZ_RIG_DEFAULT,
  PREVIZ_RIG_SAMPLE_FRAMES,
  addRigClip,
  closeupTargets,
  createRigClip,
  rigClipToPath,
  updateRigClip,
} from '@/features/previz/domain/closeupClip';
import { PREVIZ_RIG_DISTANCE_RANGE } from '@/features/previz/domain/closeup';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  type PrevizPathClip,
  type PrevizRigClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import { clipById, isPathClip, isRigClip } from '@/features/previz/domain/timeline';

/** 一个人物（带一条 0~90 的轨迹）加一台机位。 */
function stage(): { scene: PrevizScene; characterId: string; cameraId: string } {
  const character = createPrevizObject('character', [], { heightCm: 180 });
  character.transform.position = [0, 0, 0];
  const camera = createPrevizObject('camera', [character]);
  const walk: PrevizPathClip = {
    id: 'walk',
    kind: 'path',
    startFrame: 0,
    endFrame: 90,
    points: [
      { id: 'a', u: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { id: 'b', u: 1, position: [6, 0, 0], rotation: [0, 0, 0] },
    ],
  };
  return {
    scene: {
      ...createDefaultScene(),
      objects: [character, camera],
      timeline: { tracks: [{ id: 'wt', objectId: character.id, clips: [walk] }] },
    },
    characterId: character.id,
    cameraId: camera.id,
  };
}

describe('closeupTargets', () => {
  it('offers every other object, spanning what it already has on the timeline', () => {
    const { scene, characterId, cameraId } = stage();
    const targets = closeupTargets(scene, cameraId);

    expect(targets).toEqual([
      { objectId: characterId, name: scene.objects[0]!.name, startFrame: 0, endFrame: 90 },
    ]);
  });

  it('spans the whole timeline for an object with no track yet', () => {
    const { scene, cameraId } = stage();
    scene.timeline = { tracks: [] };
    // 还没画轨迹的人物照样能跟：特写不要求对方先有一条路径。
    expect(closeupTargets(scene, cameraId)[0]).toMatchObject({
      startFrame: 0,
      endFrame: scene.settings.durationFrames,
    });
  });

  it('never offers the camera itself', () => {
    const { scene, cameraId } = stage();
    expect(closeupTargets(scene, cameraId).some((entry) => entry.objectId === cameraId)).toBe(false);
  });
});

describe('createRigClip', () => {
  it('starts on a three-quarter angle rather than dead-on', () => {
    const clip = createRigClip({ anchorObjectId: 'a', startFrame: 0, endFrame: 90 });
    // 正对着脸的 0/0 是证件照。默认给一个偏角，摆出来的第一眼就是能用的构图。
    expect(clip.azimuth).toBe(PREVIZ_RIG_DEFAULT.azimuth);
    expect(clip.azimuth).not.toBe(0);
    expect(clip.aimObjectId).toBe('a');
    expect(clip.bearing).toBe('front');
    expect(clip.kind).toBe('rig');
  });
});

describe('addRigClip', () => {
  it('hangs the closeup on the camera track, not the tracked object', () => {
    const { scene, characterId, cameraId } = stage();
    const clip = createRigClip({ anchorObjectId: characterId, startFrame: 0, endFrame: 90 });
    const next = addRigClip(scene, cameraId, clip);

    const found = clipById(next, clip.id);
    expect(found?.track.objectId).toBe(cameraId);
    // 被跟踪对象的轨道一点没动：特写是机位的属性，不是人物的。
    expect(next.timeline.tracks.find((track) => track.objectId === characterId)?.clips).toEqual(
      scene.timeline.tracks[0]!.clips,
    );
  });
});

describe('updateRigClip', () => {
  it('clamps the framing into its ranges', () => {
    const { scene, characterId, cameraId } = stage();
    const clip = createRigClip({ anchorObjectId: characterId, startFrame: 0, endFrame: 90 });
    const withClip = addRigClip(scene, cameraId, clip);

    const next = updateRigClip(withClip, clip.id, { distance: -5, elevation: 500 });
    const updated = clipById(next, clip.id)?.clip as PrevizRigClip;
    expect(updated.distance).toBe(PREVIZ_RIG_DISTANCE_RANGE.min);
    expect(updated.elevation).toBeLessThanOrEqual(85);
  });

  it('wraps the azimuth instead of clamping it', () => {
    const { scene, characterId, cameraId } = stage();
    const clip = createRigClip({ anchorObjectId: characterId, startFrame: 0, endFrame: 90 });
    const withClip = addRigClip(scene, cameraId, clip);
    // 水平角是循环量：从 0 往下按一格该绕到 350，而不是停在 0。
    const next = updateRigClip(withClip, clip.id, { azimuth: -10 });
    expect((clipById(next, clip.id)?.clip as PrevizRigClip).azimuth).toBe(350);
  });

  it('leaves a path clip alone', () => {
    const { scene } = stage();
    expect(updateRigClip(scene, 'walk', { distance: 1 })).toBe(scene);
  });
});

describe('rigClipToPath', () => {
  it('bakes the solved camera into a path clip of the same span', () => {
    const { scene, characterId, cameraId } = stage();
    const clip = createRigClip({ anchorObjectId: characterId, startFrame: 0, endFrame: 90 });
    const next = rigClipToPath(addRigClip(scene, cameraId, clip), clip.id);

    const baked = clipById(next, clip.id)?.clip;
    expect(baked && isRigClip(baked)).toBe(false);
    expect(baked && isPathClip(baked)).toBe(true);
    const path = baked as PrevizPathClip;
    expect(path.startFrame).toBe(0);
    expect(path.endFrame).toBe(90);
    expect(path.points.length).toBe(90 / PREVIZ_RIG_SAMPLE_FRAMES + 1);
    expect(path.points[0]!.u).toBe(0);
    expect(path.points[path.points.length - 1]!.u).toBe(1);
  });

  it('keeps the baked framing instead of re-aiming along the curve', () => {
    const { scene, characterId, cameraId } = stage();
    const clip = createRigClip({ anchorObjectId: characterId, startFrame: 0, endFrame: 90 });
    const next = rigClipToPath(addRigClip(scene, cameraId, clip), clip.id);
    const path = clipById(next, clip.id)?.clip as PrevizPathClip;

    // 每个点都标成「朝向已编辑」：不标的话轨迹会按切线自动转向，烤出来的构图当场没了。
    expect(path.points.every((point) => point.rotationEdited)).toBe(true);
    // 人物走到 6，机位跟着走——末点不该还停在起点附近。
    expect(path.points[path.points.length - 1]!.position[0]).toBeGreaterThan(4);
  });

  it('leaves anything that is not a closeup alone', () => {
    const { scene } = stage();
    expect(rigClipToPath(scene, 'walk')).toBe(scene);
    expect(rigClipToPath(scene, 'nope')).toBe(scene);
  });
});
