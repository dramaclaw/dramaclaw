// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  PREVIZ_PATH_SPACING_M,
  pathPointSeeds,
  resampleByDistance,
  smoothStroke,
  tangentYawDeg,
} from '@/features/previz/domain/pathDraw';
import type { Vec3 } from '@/features/previz/domain/scene';

describe('smoothStroke', () => {
  it('keeps the two endpoints exactly where the user put them', () => {
    const stroke: Vec3[] = [
      [0, 0, 0],
      [1, 0, 5],
      [2, 0, 0],
      [3, 0, 5],
      [4, 0, 0],
    ];
    const smoothed = smoothStroke(stroke, 4);
    // 起终点是用户按下与松开的位置，平滑不能把它们挪走。
    expect(smoothed[0]).toEqual([0, 0, 0]);
    expect(smoothed[smoothed.length - 1]).toEqual([4, 0, 0]);
  });

  it('damps the zig-zag in the middle', () => {
    const stroke: Vec3[] = [
      [0, 0, 0],
      [1, 0, 5],
      [2, 0, 0],
      [3, 0, 5],
      [4, 0, 0],
    ];
    // 手绘笔画每帧一个采样点，抖动全在里面；参照实现松手后「自动平滑」。
    expect(Math.abs(smoothStroke(stroke, 4)[1][2])).toBeLessThan(5);
  });

  it('passes strokes shorter than three points straight through', () => {
    expect(smoothStroke([[0, 0, 0]], 4)).toEqual([[0, 0, 0]]);
  });
});

describe('resampleByDistance', () => {
  it('lays points down at the requested spacing', () => {
    const resampled = resampleByDistance(
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      1,
    );
    expect(resampled).toHaveLength(11);
    expect(resampled[3][0]).toBeCloseTo(3, 10);
  });

  it('always ends exactly on the stroke end', () => {
    // 松手的位置就是轨迹终点；差半米对不上会很显眼。
    const resampled = resampleByDistance(
      [
        [0, 0, 0],
        [2.4, 0, 0],
      ],
      1,
    );
    expect(resampled[resampled.length - 1]).toEqual([2.4, 0, 0]);
  });

  it('carries the leftover distance across segment boundaries', () => {
    // 每段各自从零起算的话，折线的每个拐点都会多挤出一个点。
    const resampled = resampleByDistance(
      [
        [0, 0, 0],
        [0.6, 0, 0],
        [1.2, 0, 0],
        [1.8, 0, 0],
      ],
      1,
    );
    expect(resampled.map((point) => Number(point[0].toFixed(3)))).toEqual([0, 1, 1.8]);
  });

  it('keeps a stroke shorter than one spacing as two points', () => {
    const resampled = resampleByDistance(
      [
        [0, 0, 0],
        [0.3, 0, 0],
      ],
      1,
    );
    expect(resampled).toEqual([
      [0, 0, 0],
      [0.3, 0, 0],
    ]);
  });

  it('survives a stroke that never moved', () => {
    // 点一下不拖也会走到这里，重复点会让弧长为 0、u 全变 NaN。
    expect(
      resampleByDistance(
        [
          [1, 0, 1],
          [1, 0, 1],
        ],
        1,
      ),
    ).toEqual([[1, 0, 1]]);
  });
});

describe('tangentYawDeg', () => {
  it('faces +X with a -90 degree yaw', () => {
    // three 的对象在 rotation 全零时朝 -Z：R_y(θ)·(0,0,-1) = (-sinθ, 0, -cosθ)，
    // 所以朝向 +X 要 θ = -90°。抄成 atan2(dx, dz) 的话人物会背朝前走。
    expect(tangentYawDeg([0, 0, 0], [1, 0, 0])).toBeCloseTo(-90, 10);
  });

  it('faces -Z with a zero yaw', () => {
    expect(tangentYawDeg([0, 0, 0], [0, 0, -1])).toBeCloseTo(0, 10);
  });

  it('faces +Z with a 180 degree yaw', () => {
    expect(Math.abs(tangentYawDeg([0, 0, 0], [0, 0, 1]))).toBeCloseTo(180, 10);
  });

  it('returns zero for two identical points', () => {
    expect(tangentYawDeg([2, 0, 2], [2, 0, 2])).toBe(0);
  });
});

describe('pathPointSeeds', () => {
  it('spaces u by arc length, not by index', () => {
    // 实测参照实现一笔得到的帧是 0/40/45/56/…/120——按弧长分配，不是等分。
    const seeds = pathPointSeeds([
      [0, 0, 0],
      [1, 0, 0],
      [4, 0, 0],
    ]);
    expect(seeds[0].u).toBe(0);
    expect(seeds[1].u).toBeCloseTo(0.25, 10);
    expect(seeds[2].u).toBe(1);
  });

  it('gives every seed a distinct id', () => {
    const seeds = pathPointSeeds([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(new Set(seeds.map((seed) => seed.id)).size).toBe(3);
  });

  it('derives yaw from the tangent and leaves pitch and roll at zero', () => {
    const seeds = pathPointSeeds([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(seeds[0].rotation[1]).toBeCloseTo(-90, 10);
    // 地面轨迹上让人物仰头侧倾是错的，俯仰与横滚留给用户手调。
    expect(seeds[0].rotation[0]).toBe(0);
    expect(seeds[0].rotation[2]).toBe(0);
  });

  it('reuses the previous tangent for the last seed', () => {
    const seeds = pathPointSeeds([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    // 末点没有「下一个点」可以求切线；沿用上一段的朝向，而不是掉回 0（那会让人物
    // 走到终点时突然转向 -Z）。
    expect(seeds[1].rotation[1]).toBeCloseTo(-90, 10);
  });

  it('marks no seed as manually edited', () => {
    const seeds = pathPointSeeds([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    // 绘制出来的朝向不是「用户调过的」，否则它会把后面所有点的朝向都传播成自己。
    expect(seeds.every((seed) => !seed.rotationEdited)).toBe(true);
  });
});

describe('PREVIZ_PATH_SPACING_M', () => {
  it('defaults to one metre inside a 0.05..5 range', () => {
    expect(PREVIZ_PATH_SPACING_M).toEqual({ min: 0.05, max: 5, default: 1 });
  });
});
