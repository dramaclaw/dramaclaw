// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  createShotBreakdownSink,
  normalizeShotBreakdownGroups,
  readStreamedGroups,
  spawnShotBreakdownNodes,
  type ShotBreakdownGroup,
} from '@/features/canvas/application/shotBreakdownNodes';

const RESULT = {
  groups: [
    {
      key: 'storyboard',
      name: '分镜组01｜起手→收势',
      layout: {
        positions: [
          { x: 36, y: 66 },
          { x: 422, y: 66 },
        ],
        width: 808,
        height: 452,
      },
      items: [
        { kind: 'image', name: 'S01｜中景·固定｜起手', url: '/static/a.jpg', shot_index: 0, position: 'first' },
        { kind: 'image', name: 'S02｜近景·固定｜收势', url: '/static/b.jpg', shot_index: 0, position: 'last' },
      ],
    },
    {
      key: 'musicRef',
      name: '音乐｜参考音轨',
      layout: { positions: [{ x: 36, y: 66 }], width: 422, height: 452 },
      items: [{ kind: 'audio', name: 'BGM｜11s·参考音轨', url: '/static/bgm.m4a' }],
    },
  ],
};

function makeDeps(groupId: string | null = 'group-1') {
  return {
    addNode: vi.fn((_type, _position, _data) => `node-${Math.random().toString(36).slice(2, 7)}`),
    // 形参要写出来：`vi.fn(() => ...)` 推出来的调用元组是空的，
    // `mock.calls[0][1]` 会在 tsc 里报 TS2493（空元组没有下标 1），挡住整个 typecheck。
    addEdge: vi.fn((_source: string, _target: string) => 'edge-1'),
    groupNodes: vi.fn(() => groupId),
  };
}

describe('normalizeShotBreakdownGroups', () => {
  it('reads the backend result and keeps snake_case fields', () => {
    const groups = normalizeShotBreakdownGroups(RESULT);
    expect(groups.map((group) => group.key)).toEqual(['storyboard', 'musicRef']);
    expect(groups[0].items[0]).toMatchObject({ kind: 'image', shotIndex: 0, position: 'first' });
  });

  it('drops items without a url instead of spawning an empty node', () => {
    const groups = normalizeShotBreakdownGroups({
      groups: [{ key: 'storyboard', name: 'x', items: [{ kind: 'image', name: 'no url' }] }],
    });
    expect(groups).toEqual([]);
  });

  it('survives a result shape it does not recognise', () => {
    expect(normalizeShotBreakdownGroups(null)).toEqual([]);
    expect(normalizeShotBreakdownGroups({ groups: 'nope' })).toEqual([]);
  });

  it('falls back to a column when the backend gave no positions', () => {
    const groups = normalizeShotBreakdownGroups({
      groups: [
        {
          key: 'storyboard',
          name: 'x',
          items: [
            { kind: 'image', name: 'a', url: '/a.jpg' },
            { kind: 'image', name: 'b', url: '/b.jpg' },
          ],
        },
      ],
    });
    expect(groups[0].layout.positions).toEqual([{ x: 0, y: 0 }, { x: 0, y: 386 }]);
  });
});

describe('spawnShotBreakdownNodes', () => {
  const groups = normalizeShotBreakdownGroups(RESULT) as ShotBreakdownGroup[];

  it('places every item to the right of the source and groups each dimension', () => {
    const deps = makeDeps();
    const result = spawnShotBreakdownNodes(
      { id: 'video-1', position: { x: 100, y: 200 }, width: 480 },
      groups,
      deps,
    );
    expect(result.nodeIds).toHaveLength(3);
    expect(deps.groupNodes).toHaveBeenCalledTimes(2);
    // 第一组第一个素材：源右侧 100 + 480 + 120 = 700，再加组内偏移 36。
    expect(deps.addNode.mock.calls[0][1]).toEqual({ x: 736, y: 266 });
    // 第二组整体下移一组高度 + 组间距。
    expect(deps.addNode.mock.calls[2][1]).toEqual({ x: 736, y: 200 + 452 + 80 + 66 });
  });

  it('connects the source to the group, not to every asset', () => {
    const deps = makeDeps();
    spawnShotBreakdownNodes({ id: 'video-1', position: { x: 0, y: 0 } }, groups, deps);
    expect(deps.addEdge).toHaveBeenCalledTimes(2);
    expect(deps.addEdge.mock.calls[0]).toEqual(['video-1', 'group-1']);
  });

  it('falls back to the lone node when a group could not be formed', () => {
    const deps = makeDeps(null);
    const result = spawnShotBreakdownNodes({ id: 'video-1', position: { x: 0, y: 0 } }, groups, deps);
    expect(result.groupIds).toEqual([]);
    expect(deps.addEdge.mock.calls[0][1]).toBe(result.nodeIds[0]);
  });
});

describe('readStreamedGroups', () => {
  it('reads groups pushed while the task is still running', () => {
    const groups = readStreamedGroups({ metadata: { shot_breakdown_groups: RESULT.groups } });
    expect(groups.map((group) => group.key)).toEqual(['storyboard', 'musicRef']);
  });

  it('also reads them from result.task_metadata once the task completed', () => {
    const groups = readStreamedGroups({
      result: { task_metadata: { shot_breakdown_groups: RESULT.groups } },
    });
    expect(groups).toHaveLength(2);
  });

  it('returns nothing when the task carries no breakdown yet', () => {
    expect(readStreamedGroups({})).toEqual([]);
    expect(readStreamedGroups({ metadata: { other: 1 } })).toEqual([]);
  });
});

describe('createShotBreakdownSink', () => {
  it('spawns each dimension once even though pushes are cumulative', () => {
    const deps = makeDeps();
    const sink = createShotBreakdownSink({ id: 'video-1', position: { x: 0, y: 0 } }, deps);
    const all = normalizeShotBreakdownGroups(RESULT);

    const first = sink.accept([all[0]]);
    expect(first.nodeIds).toHaveLength(2);
    // 后端推的是累计清单：第一组又来了一遍，不能落两次。
    const second = sink.accept(all);
    expect(second.nodeIds).toHaveLength(1);
    expect(sink.spawnedKeys()).toEqual(['storyboard', 'musicRef']);
    expect(deps.addNode).toHaveBeenCalledTimes(3);
  });

  it('keeps stacking downward across pushes instead of overlapping', () => {
    const deps = makeDeps();
    const sink = createShotBreakdownSink({ id: 'video-1', position: { x: 0, y: 0 } }, deps);
    const all = normalizeShotBreakdownGroups(RESULT);
    sink.accept([all[0]]);
    sink.accept([all[1]]);
    const ys = deps.addNode.mock.calls.map((call) => (call[1] as { y: number }).y);
    // 第一组 66，第二组落在第一组高度 452 + 组间距 80 之后。
    expect(ys).toEqual([66, 66, 452 + 80 + 66]);
  });

  it('is a no-op when a push carries nothing new', () => {
    const deps = makeDeps();
    const sink = createShotBreakdownSink({ id: 'video-1', position: { x: 0, y: 0 } }, deps);
    expect(sink.accept([]).nodeIds).toEqual([]);
    expect(deps.addNode).not.toHaveBeenCalled();
  });

  it('does not spawn orphan assets after the source node was deleted', () => {
    const deps = { ...makeDeps(), targetExists: vi.fn(() => false) };
    const sink = createShotBreakdownSink(
      { id: 'video-1', position: { x: 0, y: 0 } },
      deps,
    );

    expect(sink.accept(normalizeShotBreakdownGroups(RESULT)).nodeIds).toEqual([]);
    expect(sink.spawnedKeys()).toEqual([]);
    expect(deps.targetExists).toHaveBeenCalledWith('video-1');
    expect(deps.addNode).not.toHaveBeenCalled();
    expect(deps.addEdge).not.toHaveBeenCalled();
  });
});
