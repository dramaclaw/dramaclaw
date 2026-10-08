// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 拖动吸附：物件的包围盒边缘靠近别的物件的边缘时，自动贴上或对齐。
 *
 * 典型用法是拼地块：几块马路模型首尾相接，手拖总会留一道缝或者叠进去一截。只在水平面
 * (XZ) 上吸——竖直方向已经有松手落地（`domain/drop.ts`）在管。
 *
 * 这里只做纯数学：包围盒由渲染器用 three 量好（世界轴对齐盒的 XZ 投影），阈值也由它按
 * 当前缩放折算成米传进来，这样同一套判断在测试里不需要 three。
 */

export interface PrevizSnapBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PrevizSnapAxes {
  x: boolean;
  z: boolean;
}

/**
 * 算出拖动中的盒子该额外挪多少米才贴上邻居。每个轴各自取最近的那条边；超出阈值就不动。
 *
 * 每个邻居给四个候选：两个「贴边」（我的左边贴它的右边、我的右边贴它的左边），两个
 * 「对齐」（左对左、右对右）。贴边让地块首尾相接，对齐让并排的两块不错位。
 *
 * 只认另一个轴上挨着的邻居（投影重叠或间距在阈值内）：十米开外、根本不在一条线上的
 * 物件，边缘坐标碰巧接近也不该把手上这块拽过去。
 */
export function previzSnapOffset(
  moving: PrevizSnapBox,
  others: readonly PrevizSnapBox[],
  threshold: number,
  axes: PrevizSnapAxes,
): { dx: number; dz: number } {
  let dx = 0;
  let dz = 0;
  if (!(threshold > 0)) return { dx, dz };

  if (axes.x) {
    dx = nearest(
      others.filter((other) => near(moving.minZ, moving.maxZ, other.minZ, other.maxZ, threshold)),
      (other) => [
        other.maxX - moving.minX,
        other.minX - moving.maxX,
        other.minX - moving.minX,
        other.maxX - moving.maxX,
      ],
      threshold,
    );
  }
  if (axes.z) {
    // 用吸完 X 之后的位置判断 Z 向邻居：刚贴上的那一块正是要对齐的对象。
    const minX = moving.minX + dx;
    const maxX = moving.maxX + dx;
    dz = nearest(
      others.filter((other) => near(minX, maxX, other.minX, other.maxX, threshold)),
      (other) => [
        other.maxZ - moving.minZ,
        other.minZ - moving.maxZ,
        other.minZ - moving.minZ,
        other.maxZ - moving.maxZ,
      ],
      threshold,
    );
  }
  return { dx, dz };
}

/** 两段区间重叠，或者间距在阈值以内。 */
function near(aMin: number, aMax: number, bMin: number, bMax: number, threshold: number): boolean {
  return aMin <= bMax + threshold && bMin <= aMax + threshold;
}

function nearest(
  others: readonly PrevizSnapBox[],
  candidates: (other: PrevizSnapBox) => number[],
  threshold: number,
): number {
  let best = 0;
  let bestDistance = threshold;
  for (const other of others) {
    for (const delta of candidates(other)) {
      const distance = Math.abs(delta);
      if (distance <= bestDistance) {
        best = delta;
        bestDistance = distance;
      }
    }
  }
  return best;
}
