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

/** 内部定位函数导出给同模块的朝向采样用，不对外。 */
export { locate as locatePathSegment };
