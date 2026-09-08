// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import type { PrevizObject } from '@/features/previz/domain/scene';
import {
  PREVIZ_TOP_DOWN_DEFAULT_BOUNDS,
  PREVIZ_TOP_DOWN_PADDING_M,
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  worldToCanvas,
} from '@/features/previz/domain/topDownMap';

/** 只有 x/z 参与俯视映射，y 随手给个非零值，免得用例在「其实读的是 y」上蒙混过关。 */
function objectAt(x: number, y: number, z: number): PrevizObject {
  const created = createPrevizObject('character', []);
  return { ...created, transform: { ...created.transform, position: [x, y, z] } };
}

/** 默认地块的边长（12 m），下面好几条用例要拿它算「最小尺度」。 */
const DEFAULT_SPAN =
  PREVIZ_TOP_DOWN_DEFAULT_BOUNDS.maxX - PREVIZ_TOP_DOWN_DEFAULT_BOUNDS.minX;

/**
 * 定死种子的线性同余，用来喂往返用例。
 *
 * 不用 `Math.random()`：往返是这个模块唯一的整体性质，用随机点扫是值得的，但随机种子
 * 会让一次红变成不可复现的红——同一个失败点第二次跑就不出现了，没法定位。
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('sceneTopDownBounds', () => {
  it('still gives a usable view for an empty scene', () => {
    expect(sceneTopDownBounds([])).toEqual(PREVIZ_TOP_DOWN_DEFAULT_BOUNDS);
  });

  it('pads the bounds so a character at the very edge is not clipped by the frame', () => {
    // 场景本身已经比默认地块宽（x 跨 20 m、z 跨 16 m），最小尺度那条不介入，
    // 于是这里量到的正是纯粹的留边：四条边各外扩一个 PREVIZ_TOP_DOWN_PADDING_M。
    const bounds = sceneTopDownBounds([objectAt(-10, 1, -8), objectAt(10, 1, 8)]);
    expect(bounds).toEqual({ minX: -12, maxX: 12, minZ: -10, maxZ: 10 });
    expect(PREVIZ_TOP_DOWN_PADDING_M).toBe(2);
  });

  it('does not shrink the ground just because the scene gained its first character', () => {
    // 只留边的话，一个站在原点的人物会把 12 m 的默认地块缩成 4 m 见方——
    // 「新建了第一个人物，能点的地方反而变小了」是用户开局第一步就会撞上的。
    const bounds = sceneTopDownBounds([objectAt(0, 1, 0)]);
    expect(bounds.maxX - bounds.minX).toBe(DEFAULT_SPAN);
    expect(bounds.maxZ - bounds.minZ).toBe(DEFAULT_SPAN);
    // 撑开是两头对称加的，人物仍然在正中。
    expect(bounds).toEqual(PREVIZ_TOP_DOWN_DEFAULT_BOUNDS);
  });

  it('centres the minimum-sized ground on the objects rather than on the world origin', () => {
    const bounds = sceneTopDownBounds([objectAt(20, 1, 0), objectAt(21, 1, 0)]);
    expect((bounds.minX + bounds.maxX) / 2).toBe(20.5);
    expect(bounds.maxX - bounds.minX).toBe(DEFAULT_SPAN);
  });

  it('keeps a scene whose objects all sit on one spot from collapsing to zero span', () => {
    const bounds = sceneTopDownBounds([objectAt(3, 0, 3), objectAt(3, 2, 3), objectAt(3, 9, 3)]);
    expect(bounds.maxX - bounds.minX).toBeGreaterThan(0);
    expect(bounds.maxZ - bounds.minZ).toBeGreaterThan(0);
    // 真正要挡的是下一步：跨度为 0 会让 pixelsPerMeter 变成 Infinity。
    const view = topDownView(bounds, 300, 300);
    expect(Number.isFinite(view.pixelsPerMeter)).toBe(true);
    expect(view.pixelsPerMeter).toBeGreaterThan(0);
  });

  it('ignores objects whose position is not finite instead of poisoning the whole frame', () => {
    const objects = [objectAt(-10, 1, -8), objectAt(10, 1, 8), objectAt(NaN, 1, 0)];
    const bounds = sceneTopDownBounds(objects);
    expect(bounds).toEqual({ minX: -12, maxX: 12, minZ: -10, maxZ: 10 });
  });

  it('falls back to the default ground when every object is unusable', () => {
    expect(sceneTopDownBounds([objectAt(NaN, 1, 0), objectAt(0, 1, Infinity)])).toEqual(
      PREVIZ_TOP_DOWN_DEFAULT_BOUNDS,
    );
  });
});

describe('topDownView', () => {
  it('keeps the scale square so a circle is not drawn as an ellipse', () => {
    // 20 m 宽、4 m 深铺在 300×300 上：窄的是 x 方向（300 / 20 = 15），
    // 宽的那一边是 300 / 4 = 75。取窄边才装得下整块地。
    const wide = topDownView({ minX: -10, maxX: 10, minZ: -2, maxZ: 2 }, 300, 300);
    expect(wide.pixelsPerMeter).toBe(15);

    // 把同一块地转 90°。「永远按 x 算」会在这里给出 75，只有「取窄边」还是 15。
    const deep = topDownView({ minX: -2, maxX: 2, minZ: -10, maxZ: 10 }, 300, 300);
    expect(deep.pixelsPerMeter).toBe(15);
  });

  it('maps a metre to the same number of pixels on both axes', () => {
    // 上一条只看一个标量；这一条直接量圆：从中心各走 1 m，两个方向的像素位移得等长。
    const view = topDownView({ minX: -10, maxX: 10, minZ: -2, maxZ: 2 }, 300, 300);
    const centre = worldToCanvas(view, [0, 0]);
    const alongX = worldToCanvas(view, [1, 0])[0] - centre[0];
    const alongZ = worldToCanvas(view, [0, 1])[1] - centre[1];
    expect(alongZ).toBe(alongX);
    expect(alongX).toBe(15);
  });

  it('letterboxes the slack instead of pinning the ground to one edge', () => {
    // 窄边定了比例之后，另一个方向必然有富余。这块地只占中间 4 * 15 = 60 px 高，
    // 上下各空 120 px；靠上边排的话，用户点在画面正中会落到地块的上四分之一。
    const view = topDownView({ minX: -10, maxX: 10, minZ: -2, maxZ: 2 }, 300, 300);
    expect(worldToCanvas(view, [0, 0])).toEqual([150, 150]);
    expect(worldToCanvas(view, [0, -2])).toEqual([150, 120]);
    expect(worldToCanvas(view, [0, 2])).toEqual([150, 180]);
  });

  it('centres the ground on a canvas that is not square either', () => {
    const view = topDownView({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, 400, 200);
    expect(view.pixelsPerMeter).toBe(20);
    expect(worldToCanvas(view, [0, 0])).toEqual([200, 100]);
  });

  it('keeps the centre off the world origin when the ground is', () => {
    const view = topDownView({ minX: 10, maxX: 20, minZ: -30, maxZ: -20 }, 300, 300);
    expect(view.centerX).toBe(15);
    expect(view.centerZ).toBe(-25);
    expect(worldToCanvas(view, [15, -25])).toEqual([150, 150]);
  });

  it('survives a canvas that has not been laid out yet', () => {
    const bounds = { minX: -5, maxX: 5, minZ: -5, maxZ: 5 };
    expect(() => topDownView(bounds, 0, 0)).not.toThrow();

    // 「不抛」远远不够：0 宽高最容易算出 0 / Infinity / NaN 的比例，而那三样都会让
    // 之后每一次点击都映射成 NaN——画面上没有任何报错，人就是放不下去。
    const view = topDownView(bounds, 0, 0);
    expect(view.width).toBeGreaterThanOrEqual(1);
    expect(view.height).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(view.pixelsPerMeter)).toBe(true);
    expect(view.pixelsPerMeter).toBeGreaterThan(0);

    const canvas = worldToCanvas(view, [2.5, -1.25]);
    expect(canvas.every(Number.isFinite)).toBe(true);
    const world = canvasToWorld(view, canvas);
    expect(world.every(Number.isFinite)).toBe(true);
    expect(world[0]).toBeCloseTo(2.5, 9);
    expect(world[1]).toBeCloseTo(-1.25, 9);
  });

  it('survives a canvas whose size is not a number yet', () => {
    const view = topDownView({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, NaN, NaN);
    expect(view.width).toBeGreaterThanOrEqual(1);
    expect(view.height).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(view.pixelsPerMeter)).toBe(true);
    expect(view.pixelsPerMeter).toBeGreaterThan(0);
  });

  it('survives bounds that are degenerate or not finite', () => {
    for (const bounds of [
      { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      { minX: 5, maxX: -5, minZ: 5, maxZ: -5 },
      { minX: NaN, maxX: NaN, minZ: 0, maxZ: 1 },
      { minX: -Infinity, maxX: Infinity, minZ: -1, maxZ: 1 },
    ]) {
      const view = topDownView(bounds, 300, 200);
      expect(Number.isFinite(view.pixelsPerMeter)).toBe(true);
      expect(view.pixelsPerMeter).toBeGreaterThan(0);
      expect(worldToCanvas(view, [1, 1]).every(Number.isFinite)).toBe(true);
    }
  });
});

describe('worldToCanvas / canvasToWorld', () => {
  const SQUARE = topDownView({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, 300, 300);

  it('puts +Z below the centre on screen', () => {
    // 与 `domain/view.ts` 的 `orthoPlacement` 对齐：顶视图的 up 取 [0, 0, -1]，
    // 也就是世界 -Z 朝屏幕上方，所以 +Z 必须往画布 y 增大的方向走。
    expect(worldToCanvas(SQUARE, [0, 1])[1]).toBeGreaterThan(worldToCanvas(SQUARE, [0, -1])[1]);
  });

  it('puts +X to the right of the centre on screen', () => {
    expect(worldToCanvas(SQUARE, [1, 0])[0]).toBeGreaterThan(worldToCanvas(SQUARE, [-1, 0])[0]);
  });

  it('round-trips a world point through the canvas and back', () => {
    // 这一组数逐位相等不是巧合：ppm 是 30、原点是 150、两个坐标都是二进制有限小数，
    // 乘完再除回来没有舍入。一般情形下**不成立**——同样的公式扫 50 万个随机点，
    // 有四成回不到原值（实测最大偏差 5e-13），所以下面那条扫描用的是容差比较。
    const point: [number, number] = [2.5, -1.25];
    expect(canvasToWorld(SQUARE, worldToCanvas(SQUARE, point))).toEqual(point);
  });

  it('round-trips the corners of the ground and of the canvas', () => {
    // 非方形画布配非方形地块：letterbox 的偏移在两个方向上都不为零，
    // 少一次减法或除法在这里必然露馅。
    const view = topDownView({ minX: -3, maxX: 17, minZ: 4, maxZ: 12 }, 640, 360);
    for (const point of [
      [-3, 4],
      [17, 4],
      [-3, 12],
      [17, 12],
      [7, 8],
    ] as const) {
      const back = canvasToWorld(view, worldToCanvas(view, [point[0], point[1]]));
      expect(back[0]).toBeCloseTo(point[0], 9);
      expect(back[1]).toBeCloseTo(point[1], 9);
    }
    for (const pixel of [
      [0, 0],
      [640, 0],
      [0, 360],
      [640, 360],
    ] as const) {
      const back = worldToCanvas(view, canvasToWorld(view, [pixel[0], pixel[1]]));
      expect(back[0]).toBeCloseTo(pixel[0], 6);
      expect(back[1]).toBeCloseTo(pixel[1], 6);
    }
  });

  it('round-trips a spread of points on a non-square canvas', () => {
    // 容差取 1e-9 米：比上面实测的浮点极限（5e-13）宽三个数量级，比任何真 bug
    // 窄得多——符号写反差着好几米，少一次居中偏移差着半块地，
    // 就算只错一个像素，在这个视图上也有 0.05 m。
    const view = topDownView({ minX: -12, maxX: 8, minZ: -4, maxZ: 26 }, 512, 288);
    const next = lcg(20260908);
    for (let i = 0; i < 2000; i++) {
      const point: [number, number] = [next() * 60 - 30, next() * 60 - 30];
      const back = canvasToWorld(view, worldToCanvas(view, point));
      expect(back[0]).toBeCloseTo(point[0], 9);
      expect(back[1]).toBeCloseTo(point[1], 9);
    }
  });

  it('reads a click near the top-left of the canvas as the far-left, far-back corner', () => {
    // 把「点哪儿人就站哪儿」正着写一遍：画布左上角对应的是 -X / -Z 那一角。
    const world = canvasToWorld(SQUARE, [0, 0]);
    expect(world[0]).toBeLessThan(SQUARE.centerX);
    expect(world[1]).toBeLessThan(SQUARE.centerZ);
    expect(world).toEqual([-5, -5]);
  });

  it('spreads the visible world symmetrically about the ground centre', () => {
    // letterbox 的另一半：富余方向上多出来的世界范围，中心两侧一样多。
    const view = topDownView({ minX: -10, maxX: 10, minZ: -2, maxZ: 2 }, 300, 300);
    const top = canvasToWorld(view, [0, 0]);
    const bottom = canvasToWorld(view, [300, 300]);
    expect((top[0] + bottom[0]) / 2).toBeCloseTo(view.centerX, 9);
    expect((top[1] + bottom[1]) / 2).toBeCloseTo(view.centerZ, 9);
    expect(bottom[1] - top[1]).toBeCloseTo(20, 9);
  });
});
