// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  audioFileExtension,
  audioFramesAvailable,
  framesToMs,
  insertAudioClip,
  isAcceptedAudioFile,
  PREVIZ_MAX_AUDIO_BYTES,
  PREVIZ_MAX_AUDIO_CLIPS,
  type PrevizAudioSource,
} from '@/features/previz/domain/audioTrack';
import {
  createDefaultScene,
  type PrevizAudioClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';

function audio(id: string, startFrame: number, endFrame: number): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 10_000,
    offsetMs: 0,
    sourceNodeId: null,
  };
}

function sceneWith(clips: PrevizAudioClip[]): PrevizScene {
  const base = createDefaultScene();
  return { ...base, timeline: { ...base.timeline, audio: clips } };
}

const source: PrevizAudioSource = {
  audioUrl: '/static/new.mp3',
  sourceName: 'new.mp3',
  durationMs: 2000,
  sourceNodeId: null,
};

describe('conversions', () => {
  it('turns the remaining material into whole frames, rounding down', () => {
    expect(audioFramesAvailable(2000, 0, 30)).toBe(60);
    expect(audioFramesAvailable(2000, 500, 30)).toBe(45);
    expect(audioFramesAvailable(1050, 0, 30)).toBe(31);
    expect(audioFramesAvailable(500, 800, 30)).toBe(0);
  });

  it('turns frames into milliseconds without rounding', () => {
    expect(framesToMs(30, 30)).toBe(1000);
    expect(framesToMs(1, 30)).toBeCloseTo(33.333, 3);
  });

  it('does not lose a frame when offsetMs is a repeating decimal from framesToMs', () => {
    for (let k = 1; k < 30; k += 1) {
      expect(audioFramesAvailable(2000, framesToMs(k, 30), 30)).toBe(60 - k);
    }
  });
});

describe('insertAudioClip', () => {
  it('starts at the playhead and lasts as long as the material when the gap is wider', () => {
    const result = insertAudioClip(createDefaultScene(), 10, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio).toMatchObject([
      {
        kind: 'audio',
        startFrame: 10,
        endFrame: 70,
        audioUrl: '/static/new.mp3',
        sourceName: 'new.mp3',
        durationMs: 2000,
        offsetMs: 0,
        sourceNodeId: null,
      },
    ]);
    expect(result.clipId).toBe(result.scene.timeline.audio[0]?.id);
  });

  it('is cut short by the next audio clip', () => {
    const result = insertAudioClip(sceneWith([audio('b', 40, 80)]), 10, source);
    if (!result.ok) throw new Error(result.reason);
    expect(
      result.scene.timeline.audio.map((c) => [c.id === 'b' ? 'b' : 'new', c.startFrame, c.endFrame]),
    ).toEqual([
      ['new', 10, 40],
      ['b', 40, 80],
    ]);
  });

  it('is cut short by the end of the timeline', () => {
    const result = insertAudioClip(createDefaultScene(), 100, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio[0]).toMatchObject({ startFrame: 100, endFrame: 120 });
  });

  it('refuses when the playhead sits inside an existing clip', () => {
    expect(insertAudioClip(sceneWith([audio('a', 0, 30)]), 15, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
    expect(insertAudioClip(sceneWith([audio('a', 0, 30)]), 0, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('refuses when the gap is under one frame', () => {
    expect(insertAudioClip(createDefaultScene(), 120, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('allows the playhead right at the end of a clip', () => {
    const result = insertAudioClip(sceneWith([audio('a', 0, 30)]), 30, source);
    expect(result.ok).toBe(true);
  });

  it('refuses at the clip limit', () => {
    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, index) =>
      audio(`a${index}`, index, index + 1),
    );
    expect(insertAudioClip(sceneWith(clips), 100, source)).toEqual({ ok: false, reason: 'limit' });
  });

  it('records the upstream node id when given', () => {
    const result = insertAudioClip(createDefaultScene(), 0, { ...source, sourceNodeId: 'audio-9' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio[0]?.sourceNodeId).toBe('audio-9');
  });

  it('rejects a non-finite frame instead of producing a NaN clip', () => {
    expect(insertAudioClip(createDefaultScene(), Number.NaN, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('rejects a NaN material duration instead of producing a NaN clip', () => {
    expect(insertAudioClip(createDefaultScene(), 0, { ...source, durationMs: Number.NaN })).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('rejects an infinite material duration instead of stretching to the timeline end', () => {
    expect(
      insertAudioClip(createDefaultScene(), 0, { ...source, durationMs: Number.POSITIVE_INFINITY }),
    ).toEqual({ ok: false, reason: 'no-room' });
  });

  it('rejects a zero material duration', () => {
    expect(insertAudioClip(createDefaultScene(), 0, { ...source, durationMs: 0 })).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('clamps a negative playhead to frame 0', () => {
    const result = insertAudioClip(createDefaultScene(), -5, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio[0]).toMatchObject({ startFrame: 0, endFrame: 60 });
  });

  it('refuses a negative playhead when a clip already starts at 0', () => {
    expect(insertAudioClip(sceneWith([audio('a', 0, 30)]), -5, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('keeps the track sorted when inserting into a gap between two clips', () => {
    const scene = sceneWith([audio('a', 0, 20), audio('c', 60, 90)]);
    const result = insertAudioClip(scene, 30, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio.map((c) => c.startFrame)).toEqual([0, 30, 60]);
    expect(result.scene.timeline.audio[1]?.endFrame).toBe(60); // 被 c 截断
  });

  it('does not mutate the scene it is given', () => {
    const scene = sceneWith([audio('b', 40, 80)]);
    const before = JSON.stringify(scene);
    insertAudioClip(scene, 10, source);
    expect(JSON.stringify(scene)).toBe(before);
  });
});

describe('file validation', () => {
  it('reads the extension case-insensitively', () => {
    expect(audioFileExtension('Take 1.MP3')).toBe('mp3');
    expect(audioFileExtension('noext')).toBe('');
  });

  it('accepts mp3 / wav / m4a / ogg under the size limit', () => {
    expect(isAcceptedAudioFile('a.mp3', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.wav', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.m4a', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.ogg', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.flac', 1024)).toBe('extension');
    expect(isAcceptedAudioFile('a.mp3', PREVIZ_MAX_AUDIO_BYTES + 1)).toBe('size');
    expect(isAcceptedAudioFile('a.mp3', PREVIZ_MAX_AUDIO_BYTES)).toBe('ok');
    expect(isAcceptedAudioFile('a.flac', PREVIZ_MAX_AUDIO_BYTES + 1)).toBe('extension');
    expect(isAcceptedAudioFile('Take 1.MP3', 1024)).toBe('ok');
  });
});
