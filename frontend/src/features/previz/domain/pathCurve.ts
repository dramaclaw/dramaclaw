// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizPathPoint, Vec3 } from './scene';

/**
 * 轨迹点列的采样。本模块只认「一串带 u 的点」，不认片段、不认帧号——片段裁剪
 * （`timeline.ts`）与求值器（`evaluate.ts`）都要用它，把它单独拎出来是为了让那两个
 * 模块互相不依赖：求值器要采样、裁剪要在切点上补一个点，两边都从这里取，
 * 不会绕成环。
 */

/** u 落在哪一段、段内比例多少。点数 >= 2 时有效。 */
function locate(points: readonly PrevizPathPoint[], u: number): { index: number; local: number } {
  const clamped = Math.min(1, Math.max(0, u));
  const last = points.length - 2;
  for (let index = 0; index <= last; index++) {
    const a = points[index].u;
    const b = points[index + 1].u;
    // `index === last` 是兜底：u 大于最后一个点的 u（点没铺满 0..1）时也得落在末段，
    // 否则循环走完什么都不返回。
    if (clamped <= b || index === last) {
      const span = b - a;
      return { index, local: span > 0 ? Math.min(1, Math.max(0, (clamped - a) / span)) : 0 };
    }
  }
  return { index: 0, local: 0 };
}

/**
 * 均匀参数化的 Catmull-Rom。选它而不是折线，是因为参照实现打 4 个点得到的是一条弯
 * 曲线；选它而不是 centripetal 变体，是因为我们的点由等距重采样而来，段长本就接近
 * 相等，centripetal 那点抗打结的好处在这里换不到东西，却要多一层参数化。
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** 按 u 排序的副本。存进来的点本该有序，但脏 JSON 进得来，采样前先收敛一次。 */
export function sortedPathPoints(points: readonly PrevizPathPoint[]): PrevizPathPoint[] {
  return [...points].sort((a, b) => a.u - b.u);
}

export function samplePathPosition(points: readonly PrevizPathPoint[], u: number): Vec3 {
  const sorted = sortedPathPoints(points);
  if (sorted.length === 0) return [0, 0, 0];
  if (sorted.length === 1) return [...sorted[0].position];

  const { index, local } = locate(sorted, u);
  // 两端把邻点夹住复用自己：曲线在首尾不会甩出去。
  const p0 = sorted[Math.max(0, index - 1)].position;
  const p1 = sorted[index].position;
  const p2 = sorted[index + 1].position;
  const p3 = sorted[Math.min(sorted.length - 1, index + 2)].position;
  return [
    catmullRom(p0[0], p1[0], p2[0], p3[0], local),
    catmullRom(p0[1], p1[1], p2[1], p3[1], local),
    catmullRom(p0[2], p1[2], p2[2], p3[2], local),
  ];
}


/**
 * 把「未标记的点朝向由前一个已标记点向后传播」解开成逐点朝向。
 *
 * 首个已编辑点之前的点保留自己的朝向：那些是绘制时由切线推出来的值，用户一次都没动过，
 * 没有任何「前一个已编辑点」可以传播给它们。参照实现的滑杆 tooltip 说的也是这条：
 * 「该朝向沿用至下一个手动调整过朝向的点」——向后，不向前。
 */
export function resolvePathRotations(points: readonly PrevizPathPoint[]): Vec3[] {
  let carry: Vec3 | null = null;
  return points.map((point) => {
    if (point.rotationEdited) carry = point.rotation;
    return carry ?? point.rotation;
  });
}

/**
 * 度数的最短弧插值。359 → 1 走 +2°，不走 -358°。
 * 角度用线性插值而不是 Catmull-Rom：样条会冲出两个端点之间的区间，而角度一旦冲过
 * ±180 就在最短弧的另一侧了，表现是转弯时人物突然反向甩头——一个位置上看不出来、
 * 只在朝向上炸的 bug。
 */
export function lerpAngleDeg(from: number, to: number, t: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return from + delta * t;
}

export function samplePathRotation(points: readonly PrevizPathPoint[], u: number): Vec3 {
  const sorted = sortedPathPoints(points);
  if (sorted.length === 0) return [0, 0, 0];
  const rotations = resolvePathRotations(sorted);
  if (sorted.length === 1) return [...rotations[0]];

  const { index, local } = locate(sorted, u);
  const a = rotations[index];
  const b = rotations[index + 1];
  return [
    lerpAngleDeg(a[0], b[0], local),
    lerpAngleDeg(a[1], b[1], local),
    lerpAngleDeg(a[2], b[2], local),
  ];
}

/** 内部定位函数导出给同模块的朝向采样用，不对外。 */
export { locate as locatePathSegment };
