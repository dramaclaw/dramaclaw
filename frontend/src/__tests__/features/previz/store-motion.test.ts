// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultScene,
  type PrevizActionClip,
  type PrevizImportedMotion,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import { actionClipsOf, clipById } from '@/features/previz/domain/timeline';
import { usePrevizStore } from '@/features/previz/store';

const LOOP = 'builtin:Idle_Talking_Loop';
const PUNCH = 'builtin:Melee_Hook';

function imported(id: string): PrevizImportedMotion {
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
  };
}

function reset() {
  usePrevizStore.getState().loadScene(createDefaultScene());
}

function state() {
  return usePrevizStore.getState();
}

function addCharacter(): string {
  return state().addObject('character')!;
}

function actionsOf(scene: PrevizScene, objectId: string): PrevizActionClip[] {
  const track = scene.timeline.tracks.find((candidate) => candidate.objectId === objectId);
  return track ? actionClipsOf(track) : [];
}

describe('motion dialog and status', () => {
  beforeEach(reset);

  it('opens and closes without touching history', () => {
    const past = state().past.length;
    state().openMotionDialog({ mode: 'add', objectId: 'hero' });
    expect(state().motionDialog).toEqual({ mode: 'add', objectId: 'hero' });
    state().closeMotionDialog();
    expect(state().motionDialog).toBeNull();
    expect(state().past.length).toBe(past);
  });

  it('is cleared when another scene loads', () => {
    state().openMotionDialog({ mode: 'replace', clipId: 'c' });
    state().setMotionStatus({ m: { state: 'loading' } });
    reset();
    expect(state().motionDialog).toBeNull();
    expect(state().motionStatus).toEqual({});
  });
});

describe('addActionClip', () => {
  beforeEach(reset);

  it('inserts at the playhead, selects it and records one undo step', () => {
    const hero = addCharacter();
    state().setTimelineFrame(15);
    const past = state().past.length;
    expect(state().addActionClip(hero, LOOP)).toBeNull();
    const [clip] = actionsOf(state().scene, hero);
    expect(clip).toMatchObject({ startFrame: 15, motionId: LOOP });
    expect(state().selectedClipId).toBe(clip!.id);
    expect(state().past.length).toBe(past + 1);
  });

  it('returns the rejection and leaves history alone', () => {
    const hero = addCharacter();
    const past = state().past.length;
    expect(state().addActionClip(hero, 'builtin:Nope')).toBe('unknown-motion');
    expect(state().past.length).toBe(past);
  });
});

describe('editing action clips', () => {
  beforeEach(reset);

  it('changes the motion and fits the clip to it', () => {
    const hero = addCharacter();
    state().addActionClip(hero, LOOP);
    const id = state().selectedClipId!;
    state().setClipMotion(id, PUNCH);
    expect(clipById(state().scene, id)?.clip).toMatchObject({ motionId: PUNCH });
    const past = state().past.length;
    state().fitClipToMotion(id);
    const fitted = clipById(state().scene, id)!.clip;
    expect(fitted.endFrame - fitted.startFrame).toBeLessThan(60);
    expect(state().past.length).toBe(past + 1);
  });

  it('skips the undo step when nothing changes', () => {
    const hero = addCharacter();
    state().addActionClip(hero, LOOP);
    const id = state().selectedClipId!;
    const past = state().past.length;
    state().setClipMotion(id, LOOP);
    state().fitClipToMotion('missing');
    expect(state().past.length).toBe(past);
  });

  it('appends path clips after path clips only', () => {
    const hero = addCharacter();
    const duration = state().scene.settings.durationFrames;
    // 动作铺到时间轴末尾；旧逻辑会把它当成「已铺满」而不追加。
    state().setTimelineFrame(duration - 60);
    state().addActionClip(hero, LOOP);
    state().appendClip(hero);
    const track = state().scene.timeline.tracks.find((candidate) => candidate.objectId === hero)!;
    expect(track.clips.find((clip) => clip.kind === 'path')).toMatchObject({ startFrame: 0, endFrame: duration });
  });
});

describe('imported motions', () => {
  beforeEach(reset);

  it('imports, renames and removes with the clips that use it in one step', () => {
    const hero = addCharacter();
    state().importMotions([imported('m')]);
    state().renameMotion('m', '  挥手  ');
    expect(state().scene.motions[0]!.name).toBe('挥手');
    state().addActionClip(hero, 'import:m');
    expect(state().selectedClipId).not.toBeNull();
    const past = state().past.length;
    state().removeMotion('m');
    expect(state().scene.motions).toEqual([]);
    expect(actionsOf(state().scene, hero)).toEqual([]);
    expect(state().selectedClipId).toBeNull();
    expect(state().past.length).toBe(past + 1);
  });

  it('ignores an empty import', () => {
    const past = state().past.length;
    state().importMotions([]);
    expect(state().past.length).toBe(past);
  });

  it('clears the replace dialog when it points at a clip that got cascade-deleted', () => {
    const hero = addCharacter();
    state().importMotions([imported('m')]);
    state().addActionClip(hero, 'import:m');
    const clipId = state().selectedClipId!;
    state().openMotionDialog({ mode: 'replace', clipId });
    state().removeMotion('m');
    expect(state().motionDialog).toBeNull();
  });

  it('leaves the replace dialog alone when the clip it targets survives', () => {
    const hero = addCharacter();
    state().importMotions([imported('m'), imported('n')]);
    state().addActionClip(hero, 'import:m');
    const keep = state().selectedClipId!;
    state().addActionClip(hero, 'import:n');
    const dialog = { mode: 'replace' as const, clipId: keep };
    state().openMotionDialog(dialog);
    state().removeMotion('n');
    expect(state().motionDialog).toEqual(dialog);
  });

  it('keeps the selection when the removed motion has nothing to do with it', () => {
    const hero = addCharacter();
    state().importMotions([imported('m')]);
    state().addActionClip(hero, LOOP);
    const kept = state().selectedClipId!;
    state().removeMotion('m');
    expect(state().selectedClipId).toBe(kept);
  });
});

describe('no-op guards leave the scene and history untouched', () => {
  beforeEach(reset);

  it('renameMotion: same name or an empty name', () => {
    state().importMotions([imported('m')]);
    const sceneRef = state().scene;
    const past = state().past.length;
    state().renameMotion('m', 'm');
    expect(state().scene).toBe(sceneRef);
    expect(state().past.length).toBe(past);
    state().renameMotion('m', '   ');
    expect(state().scene).toBe(sceneRef);
    expect(state().past.length).toBe(past);
  });

  it('removeMotion: an id that is not in the scene', () => {
    const sceneRef = state().scene;
    const past = state().past.length;
    state().removeMotion('missing');
    expect(state().scene).toBe(sceneRef);
    expect(state().past.length).toBe(past);
  });

  it('fitClipToMotion: a clip already fit to its motion', () => {
    const hero = addCharacter();
    state().addActionClip(hero, LOOP);
    const id = state().selectedClipId!;
    state().fitClipToMotion(id); // 先对齐一次，让区间跟动作时长实际一致
    const sceneRef = state().scene;
    const past = state().past.length;
    state().fitClipToMotion(id);
    expect(state().scene).toBe(sceneRef);
    expect(state().past.length).toBe(past);
  });
});
