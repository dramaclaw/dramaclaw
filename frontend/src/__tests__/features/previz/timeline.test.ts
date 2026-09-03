// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  PREVIZ_TIMELINE_ZOOM,
  clearPathPoints,
  clipById,
  frameToU,
  insertPathPointAt,
  isPathClip,
  moveClip,
  pathClipAt,
  pinTrack,
  removeClip,
  removePathPoint,
  removeTrack,
  rulerTicks,
  splitClip,
  timelineSeconds,
  trackFor,
  trimClip,
  uToFrame,
  updatePathPoint,
  upsertClip,
  zoomToFit,
} from '@/features/previz/domain/timeline';
import {
  createDefaultScene,
  PREVIZ_DEFAULT_DURATION_FRAMES,
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
function drawnClip(): PrevizPathClip {
  return {
    id: 'c',
    kind: 'path',
    startFrame: 0,
    endFrame: 120,
    points: [
      { id: 'p0', u: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { id: 'p1', u: 0.5, position: [5, 0, 0], rotation: [0, 0, 0] },
      { id: 'p2', u: 1, position: [10, 0, 0], rotation: [0, 0, 0] },
    ],
  };
}

function sceneWithClip(clip: PrevizPathClip = drawnClip()): PrevizScene {
  return sceneWith([{ id: 't1', objectId: 'obj', clips: [clip] }]);
}

describe('upsertClip', () => {
  it('creates the track when the object has none', () => {
    const next = upsertClip(sceneWith([]), 'obj', drawnClip());
    expect(next.timeline.tracks).toHaveLength(1);
    expect(next.timeline.tracks[0].objectId).toBe('obj');
    expect(next.timeline.tracks[0].clips[0].id).toBe('c');
  });

  it('replaces a clip that already has that id', () => {
    const next = upsertClip(sceneWithClip(), 'obj', { ...drawnClip(), endFrame: 90 });
    expect(next.timeline.tracks[0].clips).toHaveLength(1);
    expect(next.timeline.tracks[0].clips[0].endFrame).toBe(90);
  });

  it('leaves the input scene untouched', () => {
    const scene = sceneWithClip();
    upsertClip(scene, 'obj', { ...drawnClip(), endFrame: 90 });
    // undo 栈存的是整份场景快照，就地改会把历史里的旧快照一起改掉。
    expect(scene.timeline.tracks[0].clips[0].endFrame).toBe(120);
  });
});

describe('moveClip', () => {
  it('shifts both ends by the same delta', () => {
    const next = moveClip(sceneWithClip({ ...drawnClip(), startFrame: 30, endFrame: 90 }), 'c', 20, 360);
    expect(next.timeline.tracks[0].clips[0].startFrame).toBe(50);
    expect(next.timeline.tracks[0].clips[0].endFrame).toBe(110);
  });

  it('stops at frame zero without shrinking the clip', () => {
    const next = moveClip(sceneWithClip({ ...drawnClip(), startFrame: 30, endFrame: 90 }), 'c', -999, 360);
    expect(next.timeline.tracks[0].clips[0].startFrame).toBe(0);
    // 撞到边界时长度必须守住，否则把片段推到头就顺手把它压扁了。
    expect(next.timeline.tracks[0].clips[0].endFrame).toBe(60);
  });

  it('stops at the timeline end without shrinking the clip', () => {
    const next = moveClip(sceneWithClip({ ...drawnClip(), startFrame: 30, endFrame: 90 }), 'c', 999, 120);
    expect(next.timeline.tracks[0].clips[0].endFrame).toBe(120);
    expect(next.timeline.tracks[0].clips[0].startFrame).toBe(60);
  });
});

describe('trimClip', () => {
  it('pulls the start edge in', () => {
    const next = trimClip(sceneWithClip(), 'c', 'start', 40);
    expect(next.timeline.tracks[0].clips[0].startFrame).toBe(40);
    expect(next.timeline.tracks[0].clips[0].endFrame).toBe(120);
  });

  it('never lets an edge cross the other one', () => {
    // 长度为 0 的片段会让 frameToU 无解，而且时间轴上点都点不中。
    expect(trimClip(sceneWithClip(), 'c', 'start', 999).timeline.tracks[0].clips[0].startFrame).toBe(
      119,
    );
    expect(trimClip(sceneWithClip(), 'c', 'end', -999).timeline.tracks[0].clips[0].endFrame).toBe(1);
  });
});

describe('splitClip', () => {
  it('produces two clips that meet at the cut frame', () => {
    const [left, right] = splitClip(sceneWithClip(), 'c', 60).timeline.tracks[0].clips;
    expect([left.startFrame, left.endFrame]).toEqual([0, 60]);
    expect([right.startFrame, right.endFrame]).toEqual([60, 120]);
  });

  it('leaves a keyframe on both sides of the cut', () => {
    const [left, right] = splitClip(sceneWithClip(), 'c', 60).timeline.tracks[0].clips as [
      PrevizPathClip,
      PrevizPathClip,
    ];
    // 剃刀切开后两半各自是完整轨迹；切点没有点的话，两半在接缝处会各自甩向别处。
    expect(left.points[left.points.length - 1].u).toBeCloseTo(1, 10);
    expect(left.points[left.points.length - 1].position[0]).toBeCloseTo(5, 6);
    expect(right.points[0].u).toBeCloseTo(0, 10);
    expect(right.points[0].position[0]).toBeCloseTo(5, 6);
  });

  it('renormalises u on both halves', () => {
    const [left, right] = splitClip(sceneWithClip(), 'c', 30).timeline.tracks[0].clips as [
      PrevizPathClip,
      PrevizPathClip,
    ];
    expect(left.points[0].u).toBe(0);
    expect(left.points[left.points.length - 1].u).toBeCloseTo(1, 10);
    expect(right.points[0].u).toBeCloseTo(0, 10);
    expect(right.points[right.points.length - 1].u).toBeCloseTo(1, 10);
  });

  it('gives the two halves different ids', () => {
    const [left, right] = splitClip(sceneWithClip(), 'c', 60).timeline.tracks[0].clips;
    expect(left.id).not.toBe(right.id);
  });

  it('refuses to cut on or outside the clip edges', () => {
    // 切在端点上会产出一个长度为 0 的片段。
    for (const frame of [0, 120, -5, 500]) {
      expect(splitClip(sceneWithClip(), 'c', frame).timeline.tracks[0].clips).toHaveLength(1);
    }
  });
});

describe('removeClip / removeTrack', () => {
  it('drops the clip but keeps the track', () => {
    const next = removeClip(sceneWithClip(), 'c');
    expect(next.timeline.tracks).toHaveLength(1);
    expect(next.timeline.tracks[0].clips).toHaveLength(0);
  });

  it('drops the whole track for an object', () => {
    expect(removeTrack(sceneWithClip(), 'obj').timeline.tracks).toHaveLength(0);
  });

  it('ignores ids that are not there', () => {
    const scene = sceneWithClip();
    expect(removeClip(scene, 'nope').timeline.tracks[0].clips).toHaveLength(1);
    expect(removeTrack(scene, 'nope').timeline.tracks).toHaveLength(1);
  });
});

describe('default duration', () => {
  it('matches the schema default so a fresh clip fills the timeline', () => {
    expect(PREVIZ_DEFAULT_DURATION_FRAMES).toBe(120);
  });
});
function pathClipOf(scene: PrevizScene, clipId: string): PrevizPathClip {
  const found = scene.timeline.tracks[0].clips.find((clip) => clip.id === clipId);
  return found as PrevizPathClip;
}

describe('insertPathPointAt', () => {
  it('adds a keyframe on the curve at the playhead', () => {
    const next = insertPathPointAt(sceneWithClip(), 'c', 30);
    const points = pathClipOf(next, 'c').points;
    expect(points).toHaveLength(4);
    // u = 0.25 处曲线上的位置，不是相邻两点的中点凑数。
    const inserted = points.find((point) => Math.abs(point.u - 0.25) < 1e-9);
    expect(inserted).toBeDefined();
    expect(inserted!.position[0]).toBeGreaterThan(0);
    expect(inserted!.position[0]).toBeLessThan(5);
  });

  it('keeps the points sorted by u', () => {
    const points = pathClipOf(insertPathPointAt(sceneWithClip(), 'c', 30), 'c').points;
    expect(points.map((point) => point.u)).toEqual([...points.map((point) => point.u)].sort((a, b) => a - b));
  });

  it('replaces the point already sitting on that frame', () => {
    // 同一帧上两个关键帧是无解的：谁生效取决于数组顺序。
    const points = pathClipOf(insertPathPointAt(sceneWithClip(), 'c', 60), 'c').points;
    expect(points).toHaveLength(3);
  });

  it('does nothing on a clip with no points', () => {
    const empty = { ...drawnClip(), points: [] };
    expect(pathClipOf(insertPathPointAt(sceneWithClip(empty), 'c', 30), 'c').points).toHaveLength(0);
  });
});

describe('updatePathPoint', () => {
  it('writes a new position', () => {
    const next = updatePathPoint(sceneWithClip(), 'c', 'p1', { position: [1, 2, 3] });
    expect(pathClipOf(next, 'c').points[1].position).toEqual([1, 2, 3]);
  });

  it('marks the point as edited when the rotation changes', () => {
    const next = updatePathPoint(sceneWithClip(), 'c', 'p1', { rotation: [0, 90, 0] });
    // 这个标记就是「朝向沿用至下一个手动调整过的点」的开关。
    expect(pathClipOf(next, 'c').points[1].rotationEdited).toBe(true);
  });

  it('does not mark the point as edited for a position-only change', () => {
    const next = updatePathPoint(sceneWithClip(), 'c', 'p1', { position: [1, 2, 3] });
    expect(pathClipOf(next, 'c').points[1].rotationEdited).toBeUndefined();
  });

  it('hands the point back to the automatic rotation', () => {
    const edited = updatePathPoint(sceneWithClip(), 'c', 'p1', { rotation: [0, 90, 0] });
    const next = updatePathPoint(edited, 'c', 'p1', { rotation: null });
    // 少了这条反向操作，手滑改过一次角度的点就永远脱离轨迹，只能删掉重插。
    expect(pathClipOf(next, 'c').points[1].rotationEdited).toBe(false);
  });
});

describe('removePathPoint / clearPathPoints', () => {
  it('drops one point', () => {
    expect(pathClipOf(removePathPoint(sceneWithClip(), 'c', 'p1'), 'c').points).toHaveLength(2);
  });

  it('empties the clip without deleting it', () => {
    const next = clearPathPoints(sceneWithClip(), 'c');
    expect(pathClipOf(next, 'c').points).toHaveLength(0);
    // 「清空轨迹」清的是点，片段还在——参照实现也是这样，重画不用先建片段。
    expect(next.timeline.tracks[0].clips).toHaveLength(1);
  });
});

describe('rulerTicks', () => {
  it('labels every major tick and leaves the minors bare', () => {
    const ticks = rulerTicks(10, PREVIZ_TIMELINE_ZOOM.default);

    const majors = ticks.filter((tick) => tick.major);
    expect(majors.map((tick) => tick.seconds)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(majors.map((tick) => tick.label)).toEqual([
      '0s', '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s',
    ]);
    // 次刻度只有位置没有文字：标满了尺子上全是字，读不出主刻度在哪。
    expect(ticks.filter((tick) => !tick.major).every((tick) => tick.label === null)).toBe(true);
  });

  it('coarsens the step as the scale shrinks instead of crowding the labels', () => {
    // 缩到很小时每秒一格会挤成一团，主刻度得自己退到 2s、5s……
    const zoomedOut = rulerTicks(10, PREVIZ_TIMELINE_ZOOM.min);
    const majors = zoomedOut.filter((tick) => tick.major).map((tick) => tick.seconds);

    expect(majors[1] - majors[0]).toBeGreaterThan(1);
    expect(majors[majors.length - 1]).toBe(10);
  });

  it('refines the step as the scale grows', () => {
    const zoomedIn = rulerTicks(2, PREVIZ_TIMELINE_ZOOM.max);
    const majors = zoomedIn.filter((tick) => tick.major).map((tick) => tick.seconds);

    expect(majors[1] - majors[0]).toBeLessThan(1);
    expect(majors[0]).toBe(0);
  });

  it('still yields the zero tick for an empty span', () => {
    // 时长为 0 的场景（还没建任何东西）不该让尺子渲染成空，起码留一根 0s。
    expect(rulerTicks(0, PREVIZ_TIMELINE_ZOOM.default)).toEqual([
      { seconds: 0, major: true, label: '0s' },
    ]);
  });
});

describe('zoomToFit', () => {
  it('spreads the whole timeline across the lane', () => {
    expect(zoomToFit(4, 600)).toBe(150);
  });

  it('clamps into the zoom range instead of collapsing', () => {
    // 极长的时间轴挤进窄面板时，比例会算到小于下限——夹住，别让片段缩成一根线。
    expect(zoomToFit(1000, 300)).toBe(PREVIZ_TIMELINE_ZOOM.min);
    expect(zoomToFit(0.1, 1200)).toBe(PREVIZ_TIMELINE_ZOOM.max);
  });

  it('falls back to the default before the lane has been measured', () => {
    expect(zoomToFit(4, 0)).toBe(PREVIZ_TIMELINE_ZOOM.default);
  });
});

describe('pinTrack', () => {
  function threeTracks(): PrevizScene {
    return sceneWith([
      { id: 't1', objectId: 'a', clips: [] },
      { id: 't2', objectId: 'b', clips: [] },
      { id: 't3', objectId: 'c', clips: [] },
    ]);
  }

  it('moves the track to the front', () => {
    const next = pinTrack(threeTracks(), 'c');
    expect(next.timeline.tracks.map((track) => track.objectId)).toEqual(['c', 'a', 'b']);
  });

  it('leaves an unknown object alone', () => {
    const scene = threeTracks();
    // 对象没有轨道时不该重排出一个空洞，也不该新建一条轨道。
    expect(pinTrack(scene, 'zz').timeline.tracks).toEqual(scene.timeline.tracks);
  });
});
