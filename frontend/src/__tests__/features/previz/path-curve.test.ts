// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { samplePathPosition } from '@/features/previz/domain/pathCurve';
import type { PrevizPathPoint, Vec3 } from '@/features/previz/domain/scene';

function point(u: number, position: Vec3, rotation: Vec3 = [0, 0, 0]): PrevizPathPoint {
  return { id: `p${u}`, u, position, rotation };
}

describe('samplePathPosition', () => {
  it('returns the origin when there are no points', () => {
    expect(samplePathPosition([], 0.5)).toEqual([0, 0, 0]);
  });

  it('pins to the only point when there is one', () => {
    expect(samplePathPosition([point(0, [1, 2, 3])], 0.9)).toEqual([1, 2, 3]);
  });

  it('hits every point exactly at its own u', () => {
    const points = [point(0, [0, 0, 0]), point(0.5, [1, 0, 2]), point(1, [4, 0, 0])];
    expect(samplePathPosition(points, 0)).toEqual([0, 0, 0]);
    // Catmull-Rom 过点：中间点在自己的 u 上必须原样取回，插值不能把它挤开。
    expect(samplePathPosition(points, 0.5)[0]).toBeCloseTo(1, 10);
    expect(samplePathPosition(points, 0.5)[2]).toBeCloseTo(2, 10);
    expect(samplePathPosition(points, 1)).toEqual([4, 0, 0]);
  });

  it('clamps u outside 0..1 to the ends', () => {
    const points = [point(0, [0, 0, 0]), point(1, [10, 0, 0])];
    expect(samplePathPosition(points, -3)).toEqual([0, 0, 0]);
    expect(samplePathPosition(points, 7)).toEqual([10, 0, 0]);
  });

  it('bends between three points instead of drawing a polyline', () => {
    // 三点摆成一个「凸」形：直线插值在 u=0.25 的 z 会正好是 0.5，
    // 平滑曲线必须比它更鼓。参照实现里 4 个点得到的是弯的而不是折的。
    const points = [point(0, [0, 0, 0]), point(0.5, [1, 0, 1]), point(1, [2, 0, 0])];
    expect(samplePathPosition(points, 0.25)[2]).toBeGreaterThan(0.5);
  });

  it('sorts points that arrive out of order', () => {
    // u 的顺序是数据的一部分，但脏 JSON 进得来；乱序时不能采出乱跳的曲线。
    const points = [point(1, [10, 0, 0]), point(0, [0, 0, 0])];
    expect(samplePathPosition(points, 0)).toEqual([0, 0, 0]);
    expect(samplePathPosition(points, 1)).toEqual([10, 0, 0]);
  });
});
