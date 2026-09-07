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

  it('ignores setCutCamera when the target id is unknown', () => {
    const cam = addCamera();
    usePrevizStore.getState().cutToCamera(cam);
    const clipId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setCutCamera(clipId, 'nope');
    expect(usePrevizStore.getState().scene.timeline.program[0]?.cameraId).toBe(cam);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });

  it('ignores setCutCamera when the target id is not a camera', () => {
    const cam = addCamera();
    usePrevizStore.getState().cutToCamera(cam);
    const lightId = usePrevizStore.getState().addObject('light')!;
    const clipId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setCutCamera(clipId, lightId);
    expect(usePrevizStore.getState().scene.timeline.program[0]?.cameraId).toBe(cam);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
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

  it('resumes following when the active camera is removed', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camB);
    usePrevizStore.getState().setActiveCamera(camA);
    usePrevizStore.getState().removeObject(camA);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camB);
  });

  it('leaves the follow flag alone when the removed object is not the active camera', () => {
    const camB = addCamera();
    usePrevizStore.getState().setActiveCamera(camB);
    const lightId = usePrevizStore.getState().addObject('light')!;
    usePrevizStore.getState().removeObject(lightId);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
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
    const pastBefore = usePrevizStore.getState().past.length;
    expect(usePrevizStore.getState().addAudioClip(source, 30)).toBe('no-room');
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });

  it('relocates a clip to the playhead', () => {
    usePrevizStore.getState().addAudioClip(source, 10);
    const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
    usePrevizStore.getState().setTimelineFrame(40);
    usePrevizStore.getState().relocateAudioClipToPlayhead(clipId);
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      startFrame: 40,
      endFrame: 100,
    });
  });

  it('does not push undo when relocating to the frame the clip is already at', () => {
    usePrevizStore.getState().addAudioClip(source, 10);
    const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
    usePrevizStore.getState().markSaved();
    usePrevizStore.getState().setTimelineFrame(10);
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().relocateAudioClipToPlayhead(clipId);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
    expect(usePrevizStore.getState().dirty).toBe(false);
  });

  it('ignores relocate when the id names a program cut, not an audio clip', () => {
    const cam = addCamera();
    // 切在 60 帧起，留出前面的空当：切片顶在 0 帧起会被 moveClip 天然夹死在原地，
    // 关掉 found.table !== 'audio' 的判断这条用例也会绿，测不出这条判断的作用。
    usePrevizStore.getState().setTimelineFrame(60);
    usePrevizStore.getState().cutToCamera(cam);
    const cutId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    usePrevizStore.getState().setTimelineFrame(10);
    const pastBefore = usePrevizStore.getState().past.length;
    const programBefore = usePrevizStore.getState().scene.timeline.program;
    usePrevizStore.getState().relocateAudioClipToPlayhead(cutId);
    expect(usePrevizStore.getState().scene.timeline.program).toBe(programBefore);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });

  it('clamps a relocated clip so it keeps its length within the timeline', () => {
    usePrevizStore.getState().addAudioClip(source, 0);
    const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
    usePrevizStore.getState().setTimelineFrame(119);
    usePrevizStore.getState().relocateAudioClipToPlayhead(clipId);
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      startFrame: 60,
      endFrame: 120,
    });
  });

  it('leaves an audio clip past the new duration where it is', () => {
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
    usePrevizStore.getState().tickPlayback(1 / 30);
    expect(usePrevizStore.getState().timelineFrame).toBe(4);
    expect(usePrevizStore.getState().seekSerial).toBe(start + 1);
    usePrevizStore.getState().stopPlayback();
    expect(usePrevizStore.getState().seekSerial).toBe(start + 2);
  });

  it('does not bump when playback runs off the end and stops itself', () => {
    usePrevizStore.getState().setTimelineFrame(118);
    usePrevizStore.getState().setTimelinePlaying(true);
    const start = usePrevizStore.getState().seekSerial;
    usePrevizStore.getState().tickPlayback(1);
    expect(usePrevizStore.getState().timelinePlaying).toBe(false);
    expect(usePrevizStore.getState().seekSerial).toBe(start);
  });

  it('bumps when shortening the duration pulls the playhead back', () => {
    usePrevizStore.getState().setTimelineFrame(100);
    const start = usePrevizStore.getState().seekSerial;
    usePrevizStore.getState().setDurationFrames(60);
    expect(usePrevizStore.getState().timelineFrame).toBe(60);
    expect(usePrevizStore.getState().seekSerial).toBe(start + 1);
  });

  it('does not bump when the playhead is already inside the shortened duration', () => {
    usePrevizStore.getState().setTimelineFrame(10);
    const start = usePrevizStore.getState().seekSerial;
    usePrevizStore.getState().setDurationFrames(60);
    expect(usePrevizStore.getState().seekSerial).toBe(start);
  });
});
