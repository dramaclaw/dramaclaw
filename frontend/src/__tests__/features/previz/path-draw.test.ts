// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  PREVIZ_PATH_SPACING_M,
  drawPlaneHeight,
  drawSeedRotation,
  pathPointSeeds,
  resampleByDistance,
  smoothStroke,
  tangentYawDeg,
} from '@/features/previz/domain/pathDraw';
import {
  createDefaultScene,
  type PrevizPathClip,
  type PrevizScene,
  type Vec3,
} from '@/features/previz/domain/scene';

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

  it('holds one rotation on every seed when the caller hands one in', () => {
    const seeds = pathPointSeeds(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ],
      [-16.7, 200, 0],
    );

    // 推轨镜头是车走、镜头照旧盯着被摄体；把机位焊在轨道车头上（切线朝向）等于
    // 画完一笔它就不再看着人物了。俯仰也得留住，切线只给得出 yaw。
    expect(seeds.map((seed) => seed.rotation)).toEqual([
      [-16.7, 200, 0],
      [-16.7, 200, 0],
      [-16.7, 200, 0],
    ]);
  });

  it('gives each held seed its own array', () => {
    const seeds = pathPointSeeds(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      [0, 90, 0],
    );
    seeds[0].rotation[1] = 0;

    // 共享同一个数组的话，在检查器里调一个轨迹点的朝向，整条轨迹会一起转。
    expect(seeds[1].rotation[1]).toBe(90);
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

describe('drawSeedRotation', () => {
  function sceneWith(kind: 'camera' | 'character', rotation: Vec3) {
    const object = createPrevizObject(kind, []);
    object.transform.rotation = rotation;
    return { scene: { ...createDefaultScene(), objects: [object] }, objectId: object.id };
  }

  it('lets a character face along its own stroke', () => {
    const { scene, objectId } = sceneWith('character', [0, 30, 0]);
    // 人走路就是朝行进方向走。null 表示「别管我，用切线」。
    expect(drawSeedRotation(scene, objectId, 0)).toBeNull();
  });

  it('holds the camera aim it had before the stroke', () => {
    const { scene, objectId } = sceneWith('camera', [-16.7, 200, 0]);
    expect(drawSeedRotation(scene, objectId, 0)).toEqual([-16.7, 200, 0]);
  });

  it('has no opinion about an object that is not there', () => {
    const { scene } = sceneWith('camera', [-16.7, 200, 0]);
    expect(drawSeedRotation(scene, 'gone', 0)).toBeNull();
  });
});

describe('drawPlaneHeight', () => {
  function sceneWith(position: Vec3): { scene: PrevizScene; objectId: string } {
    const object = createPrevizObject('camera', []);
    object.transform.position = position;
    return { scene: { ...createDefaultScene(), objects: [object] }, objectId: object.id };
  }

  it('draws on the ground when nothing is selected', () => {
    expect(drawPlaneHeight(createDefaultScene(), null, 0)).toBe(0);
  });

  it('draws on the ground for an object that is no longer there', () => {
    const { scene } = sceneWith([0, 4, 0]);
    // 选中的对象刚被删掉、笔画又已经按下去了。掉回地面至少还能画，抛异常是整个画布罢工。
    expect(drawPlaneHeight(scene, 'gone', 0)).toBe(0);
  });

  it('draws at the height the selected object sits at', () => {
    const { scene, objectId } = sceneWith([2, 4, 8]);
    // 给 4 米高的机位画走位，画完机位不该掉到地上：这一笔就该整条落在 4 米的水平面上。
    expect(drawPlaneHeight(scene, objectId, 0)).toBe(4);
  });

  it('takes the height the object has on the current frame, not its static one', () => {
    const { scene, objectId } = sceneWith([0, 4, 0]);
    const clip: PrevizPathClip = {
      id: 'clip',
      kind: 'path',
      startFrame: 0,
      endFrame: 100,
      points: [
        { id: 'a', u: 0, position: [0, 10, 0], rotation: [0, 0, 0] },
        { id: 'b', u: 1, position: [10, 10, 0], rotation: [0, 0, 0] },
      ],
    };
    const withTrack: PrevizScene = {
      ...scene,
      timeline: { ...scene.timeline, tracks: [{ id: 'track', objectId, clips: [clip] }] },
    };

    // 重画一条已有的轨迹是常事。读静态 transform 的话，机位明明在 10 米高飞着，
    // 重画一笔就掉回它出生时的 4 米——而那个高度用户早就不记得了。
    expect(drawPlaneHeight(withTrack, objectId, 50)).toBe(10);
  });
});
