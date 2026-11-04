// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 导入模型的单位换算。
 *
 * glTF 规定长度单位就是米，但**导出器普遍不遵守**：从 Blender、3ds Max、SketchUp 里按
 * 厘米或毫米建的模型，导出时那串数字原样落进文件，于是一栋 8 m 的小屋进来是 800。
 * 预演台里人物是按真实身高摆的（1.7 m 上下），两者差 100 倍的后果不是「有点大」，是
 * 相机开场就停在墙体内部，用户看到的是一片灰——他不会往单位上想，只会觉得导入坏了。
 *
 * 这里只做**整十倍的单位换算**，不做「缩放到看着合适」。两者的区别是后者会把一把本来
 * 就按米建的椅子也缩一道，而单位换算对已经在合理区间里的模型一个字节都不碰。
 */

/**
 * 一件道具合理尺寸的下界，米。
 *
 * 2 cm：比这还小的东西在预演台里连一个像素都占不到，摆进来没有意义，所以落在这以下
 * 的更可能是单位错了（按米导出的毫米模型）。
 */
export const PREVIZ_PROP_MIN_PLAUSIBLE_M = 0.02;

/**
 * 一件道具合理尺寸的上界，米。
 *
 * 200 m 是拍出来的，挑的时候在两种错之间权衡：
 * - 定低了，一栋真按米建的高层（120 m）会被当成厘米模型缩成 1.2 m；
 * - 定高了，一份按厘米建的小屋（800 单位）逃过换算，还是那面挡住整个视口的墙。
 *
 * 200 m 之上的单体建筑在分镜预演里极少见，而厘米模型极常见，所以往高了放。**代价写在
 * 这里**：真要摆一栋 300 m 的塔，它会被误当成厘米模型缩掉 100 倍，得去属性面板把
 * scale 改回来。
 */
export const PREVIZ_PROP_MAX_PLAUSIBLE_M = 200;

/**
 * 候选换算系数，**按优先级**排。
 *
 * 先试厘米再试毫米：一份 800 单位的模型两种解释都能落进合理区间（8 m 和 0.8 m），而
 * 厘米是常见得多的那一种。顺序反过来，小屋会变成鞋盒。
 */
const UNIT_SCALES = [0.01, 0.001, 100, 1000] as const;

/**
 * 按模型最长边算出该乘上去的单位换算系数。合理区间内的模型、量不出尺寸的模型，以及
 * 怎么换都落不进区间的模型，一律返回 1——**换不明白就别动**，留给用户自己在属性面板里
 * 改，总好过替他猜一个错的。
 */
export function propUnitScale(largestDimensionM: number): number {
  if (!Number.isFinite(largestDimensionM) || largestDimensionM <= 0) return 1;
  if (isPlausible(largestDimensionM)) return 1;
  for (const scale of UNIT_SCALES) {
    if (isPlausible(largestDimensionM * scale)) return scale;
  }
  return 1;
}

function isPlausible(size: number): boolean {
  return size >= PREVIZ_PROP_MIN_PLAUSIBLE_M && size <= PREVIZ_PROP_MAX_PLAUSIBLE_M;
}
