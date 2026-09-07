// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultScene, type PrevizAudioClip } from '@/features/previz/domain/scene';
import { monitorCameraId, usePrevizStore } from '@/features/previz/store';

function reset() {
  usePrevizStore.getState().loadScene(createDefaultScene());
}

function addCamera(): string {
  return usePrevizStore.getState().addObject('camera')!;
}

const source = {
  audioUrl: '/static/a.mp3',
  sourceName: 'a.mp3',
  durationMs: 2000,
  sourceNodeId: null,
};

describe('cutToCamera', () => {
  beforeEach(reset);

  it('inserts a cut at the playhead and records an undo step', () => {
    const cam = addCamera();
    usePrevizStore.getState().setTimelineFrame(10);
    const pastBefore = usePrevizStore.getState().past.length;
    expect(usePrevizStore.getState().cutToCamera(cam)).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([
      { startFrame: 10, endFrame: 120, cameraId: cam },
    ]);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore + 1);
  });

  it('returns the rejection and leaves history alone', () => {
    const cam = addCamera();
    usePrevizStore.getState().setTimelineFrame(10);
    usePrevizStore.getState().cutToCamera(cam);
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setTimelineFrame(50);
    expect(usePrevizStore.getState().cutToCamera(cam)).toBe('same-camera');
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });

  it('retargets a cut through setCutCamera', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camA);
    const clipId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    usePrevizStore.getState().setCutCamera(clipId, camB);
    expect(usePrevizStore.getState().scene.timeline.program[0]?.cameraId).toBe(camB);
  });

  it('drops the cuts of a removed camera in the same undo step', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camA);
    usePrevizStore.getState().setTimelineFrame(60);
    usePrevizStore.getState().cutToCamera(camB);
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().removeObject(camA);
    const { scene, past } = usePrevizStore.getState();
    expect(scene.timeline.program.map((cut) => cut.cameraId)).toEqual([camB]);
    expect(past.length).toBe(pastBefore + 1);
  });

  it('does not push undo when setCutCamera retargets to the same camera', () => {
    const cam = addCamera();
    usePrevizStore.getState().cutToCamera(cam);
    usePrevizStore.getState().markSaved();
    const clipId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setCutCamera(clipId, cam);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
    expect(usePrevizStore.getState().dirty).toBe(false);
  });
});

describe('monitor follow', () => {
  beforeEach(reset);

  it('follows the program by default and resolves the live camera', () => {
    const cam = addCamera();
    usePrevizStore.getState().cutToCamera(cam);
    usePrevizStore.getState().setTimelineFrame(5);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(cam);
  });

  it('falls back to the active camera in a gap', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().setTimelineFrame(60);
    usePrevizStore.getState().cutToCamera(camA);
    usePrevizStore.getState().setTimelineFrame(10);
    usePrevizStore.setState({ activeCameraId: camB });
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camB);
  });

  it('stops following when a camera is picked by hand and resumes on followProgram', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camA);
    usePrevizStore.getState().setActiveCamera(camB);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camB);
    usePrevizStore.getState().followProgram();
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camA);
  });

  it('resets to following when a scene is loaded', () => {
    usePrevizStore.getState().setActiveCamera(null);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
    reset();
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
  });

  it('does not put the follow flag into undo history', () => {
    const cam = addCamera();
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setActiveCamera(cam);
    usePrevizStore.getState().followProgram();
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });
});

describe('audio clips', () => {
  beforeEach(reset);

  it('adds a clip at the given frame, selects it and records undo', () => {
    const pastBefore = usePrevizStore.getState().past.length;
    expect(usePrevizStore.getState().addAudioClip(source, 10)).toBeNull();
    const { scene, selectedClipId, past } = usePrevizStore.getState();
    expect(scene.timeline.audio).toMatchObject([{ startFrame: 10, endFrame: 70 }]);
    expect(selectedClipId).toBe(scene.timeline.audio[0]?.id);
    expect(past.length).toBe(pastBefore + 1);
  });

  it('returns the rejection when there is no room', () => {
    usePrevizStore.getState().addAudioClip(source, 0);
    expect(usePrevizStore.getState().addAudioClip(source, 30)).toBe('no-room');
  });

  it('relocates a clip to the playhead', () => {
    usePrevizStore.getState().addAudioClip(source, 0);
    const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
    usePrevizStore.getState().setTimelineFrame(40);
    usePrevizStore.getState().relocateAudioClipToPlayhead(clipId);
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      startFrame: 40,
      endFrame: 100,
    });
  });

  it('keeps audio clips when the duration is shortened below them', () => {
    usePrevizStore.getState().addAudioClip(source, 100);
    usePrevizStore.getState().setDurationFrames(60);
    const clip: PrevizAudioClip | undefined = usePrevizStore.getState().scene.timeline.audio[0];
    expect(clip).toMatchObject({ startFrame: 100, endFrame: 120 });
  });
});

describe('seekSerial', () => {
  beforeEach(reset);

  it('bumps on seek and stop but not on playback ticks', () => {
    const start = usePrevizStore.getState().seekSerial;
    usePrevizStore.getState().setTimelineFrame(3);
    expect(usePrevizStore.getState().seekSerial).toBe(start + 1);
    usePrevizStore.getState().setTimelinePlaying(true);
    usePrevizStore.getState().tickPlayback(1000 / 30);
    expect(usePrevizStore.getState().seekSerial).toBe(start + 1);
    usePrevizStore.getState().stopPlayback();
    expect(usePrevizStore.getState().seekSerial).toBe(start + 2);
  });
});
