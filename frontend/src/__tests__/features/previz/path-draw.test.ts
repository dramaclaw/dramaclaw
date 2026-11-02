// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  PREVIZ_PATH_SPACING_M,
  PREVIZ_PATH_SPEED_MPS,
  appendPathPoint,
  drawPlaneHeight,
  drawSeedRotation,
  pathPointSeeds,
  polylineLength,
  resampleByDistance,
  smoothStroke,
  strokeDurationFrames,
  tangentYawDeg,
} from '@/features/previz/domain/pathDraw';
import {
  createDefaultScene,
  type PrevizPathClip,
  type PrevizPathPoint,
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

  it('starts a seeded stroke at the aim it was handed', () => {
    const seeds = pathPointSeeds(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      [-16.7, 200, 0],
    );

    // 起手那一刻的取景不该被切线抹掉：俯仰、横滚原样留住（切线只给得出 yaw），
    // yaw 也还是同一个方向——200° 与 -160° 是同一条视线，收进 ±180 是为了让轨迹点
    // 检查器上那三根滑杆够得着。
    expect(seeds[0].rotation[0]).toBe(-16.7);
    expect(seeds[0].rotation[1]).toBeCloseTo(-160, 10);
    expect(seeds[0].rotation[2]).toBe(0);
  });

  it('swings a seeded aim along with the stroke', () => {
    const seeds = pathPointSeeds(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ],
      [-16.7, 200, 0],
    );

    // 笔画在第二点右转了 90°（切线 -90° → -180°），镜头得跟着摇过去同样的 90°，
    // 而不是一路盯死起手那个方向。-160 - 90 收回区间就是 110。
    expect(seeds[1].rotation[1]).toBeCloseTo(110, 10);
    expect(seeds[2].rotation[1]).toBeCloseTo(110, 10);
    // 摇的是水平，俯仰不跟着变：推轨拐个弯不该让镜头自己抬头。
    expect(seeds.map((seed) => seed.rotation[0])).toEqual([-16.7, -16.7, -16.7]);
  });

  it('keeps a seeded aim square to a straight stroke', () => {
    const seeds = pathPointSeeds(
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [0, 0, 0],
    );

    // 直线上没有相对转角，整笔就该保持同一个朝向——「跟着轨迹转」不等于「每一点都
    // 抖一下」。
    expect(seeds.map((seed) => seed.rotation[1])).toEqual([0, 0, 0]);
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

describe('PREVIZ_PATH_SPEED_MPS', () => {
  it('defaults to walking pace inside a 0.1..20 range', () => {
    // 1.4 m/s 是成年人正常步行（约 5 km/h）：预演台里画得最多的就是人物走位。
    expect(PREVIZ_PATH_SPEED_MPS).toEqual({ min: 0.1, max: 20, default: 1.4 });
  });
});

describe('polylineLength', () => {
  it('adds the segments up', () => {
    expect(polylineLength([
      [0, 0, 0],
      [3, 0, 0],
      [3, 0, 4],
    ])).toBe(7);
  });

  it('is zero for a stroke that goes nowhere', () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([[1, 2, 3]])).toBe(0);
  });
});

describe('strokeDurationFrames', () => {
  const straight = (metres: number): Vec3[] => [
    [0, 0, 0],
    [metres, 0, 0],
  ];

  it('turns length over speed into frames', () => {
    // 6 米、2 m/s = 3 秒 = 90 帧。
    expect(strokeDurationFrames(straight(6), 2)).toBe(90);
  });

  it('gives a longer stroke more frames at the same speed', () => {
    expect(strokeDurationFrames(straight(2), 1)).toBeLessThan(
      strokeDurationFrames(straight(8), 1),
    );
  });

  it('clamps the speed into its range instead of dividing by it', () => {
    // 0 会算出 Infinity 帧，负数会算出负帧——两者写进场景都是一条点不中的片段。
    expect(strokeDurationFrames(straight(6), 0)).toBe(strokeDurationFrames(straight(6), 0.1));
    expect(strokeDurationFrames(straight(6), -5)).toBe(strokeDurationFrames(straight(6), 0.1));
  });

  it('never returns less than one frame', () => {
    // 0 长度的片段 `frameToU` 无解，时间轴上也再点不中它。
    expect(strokeDurationFrames([], 1)).toBe(1);
    expect(strokeDurationFrames(straight(0.001), 20)).toBe(1);
  });

  it('caps at the longest timeline there is', () => {
    // 超出去的那一段永远落在时间轴外面：既播不到，也剪不着。
    expect(strokeDurationFrames(straight(1000), 0.1)).toBe(360);
  });

  it('survives a stroke with NaN in it', () => {
    // 上游漏了护栏时宁可给一帧，也不能把 NaN 写进场景——那会让整条时间轴算不出来。
    expect(strokeDurationFrames([
      [0, 0, 0],
      [Number.NaN, 0, 0],
    ], 1)).toBe(1);
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

describe('appendPathPoint', () => {
  /** 沿 +X 走两米的两个点：首点朝 +X（yaw -90），末点沿用上一段。 */
  const walked = (): PrevizPathPoint[] =>
    pathPointSeeds([
      [0, 0, 0],
      [2, 0, 0],
    ]);

  it('seeds a single point when there is nothing to append to', () => {
    const points = appendPathPoint([], [1, 0, 1], null);
    expect(points).toHaveLength(1);
    expect(points[0].position).toEqual([1, 0, 1]);
    expect(points[0].u).toBe(0);
  });

  it('keeps the ids of the points already there', () => {
    const before = walked();
    const after = appendPathPoint(before, [2, 0, -6]);
    // id 换了，检查器里正选着的点当场失去选中。
    expect(after.slice(0, 2).map((point) => point.id)).toEqual(before.map((point) => point.id));
    expect(new Set(after.map((point) => point.id)).size).toBe(3);
  });

  it('re-spaces u by arc length over the whole path', () => {
    const after = appendPathPoint(walked(), [2, 0, -6]);
    // 2 m 之后再接 6 m：原来的末点从 u=1 退到 0.25。
    expect(after.map((point) => point.u)).toEqual([0, 0.25, 1]);
  });

  it('turns the former last point toward the new segment', () => {
    const before = walked();
    expect(before[1].rotation[1]).toBeCloseTo(-90, 10);

    const after = appendPathPoint(before, [2, 0, -6]);

    // 末点之前没有下一段，朝向沿用上一段（+X）；现在有了，改按新切线（-Z，yaw 0）。
    expect(after[1].rotation[1]).toBeCloseTo(0, 10);
    expect(after[2].rotation[1]).toBeCloseTo(0, 10);
  });

  it('keeps a hand-set rotation and its flag, but re-derives the rest', () => {
    const before = walked();
    before[0] = { ...before[0], rotation: [10, 20, 30], rotationEdited: true };

    const after = appendPathPoint(before, [2, 0, -6]);

    // 手调过的朝向被自动朝向盖掉，等于把用户的活儿白做。
    expect(after[0].rotation).toEqual([10, 20, 30]);
    expect(after[0].rotationEdited).toBe(true);
    // 各拿一份拷贝：共享数组的话，在检查器里调一个点会让另一个点跟着转。
    expect(after[0].rotation).not.toBe(before[0].rotation);
    expect(after[1].rotationEdited).toBeFalsy();
    expect(after[1].rotation[1]).toBeCloseTo(0, 10);
  });

  it('measures a camera path against its first point, not the seed handed in', () => {
    const before = pathPointSeeds(
      [
        [0, 0, 0],
        [2, 0, 0],
      ],
      [15, 45, 0],
    );

    const after = appendPathPoint(before, [2, 0, -6], [15, 200, 0]);

    // 机位的起手朝向存在首点里。播放头挪到片段外时调用方解算出来的朝向退回了静态
    // transform，拿它当 seed 会让整条轨迹的 yaw 整体偏一次。
    expect(after[0].rotation).toEqual([15, 45, 0]);
    // 第二段相对首段转了 +90°（-90 → 0），机位 yaw 跟着转：45 + 90。俯角原样留住。
    expect(after[1].rotation[1]).toBeCloseTo(135, 10);
    expect(after[1].rotation[0]).toBe(15);
  });

  it('uses the seed only while the path is still empty', () => {
    const [only] = appendPathPoint([], [0, 0, 0], [15, 45, 0]);
    expect(only.rotation).toEqual([15, 45, 0]);
  });

  it('does not mutate the points it was given', () => {
    const before = walked();
    const snapshot = structuredClone(before);

    appendPathPoint(before, [2, 0, -6]);

    expect(before).toEqual(snapshot);
  });

  it('sorts a path that arrived out of order before appending', () => {
    const before = walked().reverse();

    const after = appendPathPoint(before, [2, 0, -6]);

    // 脏 JSON 进得来；不先收敛，新点会接在乱序的末尾。
    expect(after.map((point) => point.position)).toEqual([
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, -6],
    ]);
  });
});
