// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  clipById,
  frameToU,
  isPathClip,
  pathClipAt,
  timelineSeconds,
  trackFor,
  uToFrame,
} from '@/features/previz/domain/timeline';
import {
  createDefaultScene,
  type PrevizPathClip,
  type PrevizScene,
  type PrevizTrack,
} from '@/features/previz/domain/scene';

function pathClip(id: string, startFrame: number, endFrame: number): PrevizPathClip {
  return { id, kind: 'path', startFrame, endFrame, points: [] };
}

function sceneWith(tracks: PrevizTrack[]): PrevizScene {
  return { ...createDefaultScene(), timeline: { tracks } };
}

describe('trackFor / clipById', () => {
  it('finds a track by its object id', () => {
    const scene = sceneWith([{ id: 't1', objectId: 'obj', clips: [] }]);
    expect(trackFor(scene, 'obj')?.id).toBe('t1');
    expect(trackFor(scene, 'missing')).toBeUndefined();
  });

  it('finds a clip together with the track it lives on', () => {
    const clip = pathClip('c1', 0, 120);
    const scene = sceneWith([{ id: 't1', objectId: 'obj', clips: [clip] }]);
    expect(clipById(scene, 'c1')).toEqual({ track: scene.timeline.tracks[0], clip });
    expect(clipById(scene, 'nope')).toBeUndefined();
  });
});

describe('pathClipAt', () => {
  it('returns undefined when no clip covers the frame', () => {
    const track: PrevizTrack = { id: 't', objectId: 'o', clips: [pathClip('c', 60, 120)] };
    expect(pathClipAt(track, 30)).toBeUndefined();
  });

  it('includes both ends of the clip range', () => {
    const track: PrevizTrack = { id: 't', objectId: 'o', clips: [pathClip('c', 60, 120)] };
    expect(pathClipAt(track, 60)?.id).toBe('c');
    expect(pathClipAt(track, 120)?.id).toBe('c');
  });

  it('prefers the later-starting clip when two overlap', () => {
    // 设计文档定的规则：同帧同对象有多个同类片段时取起始帧较晚者。
    const track: PrevizTrack = {
      id: 't',
      objectId: 'o',
      clips: [pathClip('early', 0, 200), pathClip('late', 100, 200)],
    };
    expect(pathClipAt(track, 150)?.id).toBe('late');
  });

  it('ignores clips that are not path clips', () => {
    const track: PrevizTrack = {
      id: 't',
      objectId: 'o',
      clips: [{ id: 'a', kind: 'action', startFrame: 0, endFrame: 60, poseId: 'walk' }],
    };
    expect(pathClipAt(track, 30)).toBeUndefined();
    expect(isPathClip(track.clips[0])).toBe(false);
  });
});

describe('frameToU / uToFrame', () => {
  it('maps the clip range onto 0..1 and back', () => {
    const clip = pathClip('c', 60, 180);
    expect(frameToU(clip, 60)).toBe(0);
    expect(frameToU(clip, 120)).toBeCloseTo(0.5, 10);
    expect(frameToU(clip, 180)).toBe(1);
    expect(uToFrame(clip, 0.5)).toBe(120);
  });

  it('clamps frames outside the clip', () => {
    const clip = pathClip('c', 60, 180);
    expect(frameToU(clip, 0)).toBe(0);
    expect(frameToU(clip, 999)).toBe(1);
    expect(uToFrame(clip, -1)).toBe(60);
    expect(uToFrame(clip, 2)).toBe(180);
  });

  it('collapses a zero-length clip to u = 0 instead of dividing by zero', () => {
    // 长度为 0 的片段本不该存在，但剃刀切在端点上、或者脏 JSON 都造得出来。
    // 不拦的话 (frame - start) / 0 是 NaN 或 Infinity，会一路毒进节点的 position。
    const clip = pathClip('c', 60, 60);
    expect(frameToU(clip, 60)).toBe(0);
    expect(uToFrame(clip, 0.5)).toBe(60);
  });
});

describe('timelineSeconds', () => {
  it('converts the scene duration at the fixed 30 fps', () => {
    expect(timelineSeconds(createDefaultScene())).toBeCloseTo(4, 10);
  });
});
