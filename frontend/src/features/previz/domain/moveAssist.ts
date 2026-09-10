// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Vec3 } from './scene';
import type { PrevizTopDownBounds } from './topDownMap';

/**
 * 移动辅助的纯几何：把人在地面上（XZ）推开、夹住。
 *
 * **只谈平面。** 高度归高度策略管（`evaluate.ts` 的 `applyHeightPolicies` 与
 * `PrevizRenderer.standGroundCharacters`），两边互不覆盖：这里一个 y 都不碰。分不清
 * 谁改了 y 的话，「人物突然沉进地里」这种故障要在两个模块之间来回找。
 */

/**
 * 一件道具在**本地**坐标下的 XZ 半尺寸，由 `PrevizRenderer.propExtents()` 量出来。
 *
 * 记本地而不是世界，是为了让挂着走位的道具（会动的平台、被推开的门）也对：世界盒由
 * 求值层拿**这一帧解算出的** transform 现算（见 `propWorldBox`），道具走到哪，人就从
 * 哪儿被推开。把世界盒缓存下来的话，人只会绕着道具的开场位置走，而道具本人早走了。
 */
export interface PrevizPropExtent {
  readonly id: string;
  readonly halfX: number;
  readonly halfZ: number;
}

/** 地面上的一块轴对齐矩形，世界坐标、米。 */
export interface PrevizXZBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * 人在地面上占的半径，米。
 *
 * 0.25 是成年人肩宽的一半上下。取一个常数而不是按 `heightCm` 折算：折算只在「人越高
 * 越宽」这一条上更真，而它带来的是「改身高会悄悄改走位」——用户拖身高滑杆时不会预期
 * 轨迹跟着变。真要按体型分档，那是 `bodyType` 的事，等有人提再说。
 */
export const PREVIZ_CHARACTER_RADIUS_M = 0.25;

/**
 * 本地半尺寸 + 这一帧的 transform → 世界 XZ 盒。
 *
 * **只吃位置与缩放，不吃旋转。** 旋转只在 90° 的整数倍上严格；其余角度这个盒子比真实
 * 轮廓大一圈（人会离斜着摆的桌子稍远一点）。这是刻意的近似：算真正的有向包围盒要引进
 * 一套分离轴判定，而它买到的精度在「别让人穿模」这个用途上看不出来。上游那份
 * `PrevizTopDownFootprint` 的注释里记的是同一条取舍。
 */
export function propWorldBox(extent: PrevizPropExtent, position: Vec3, scale: Vec3): PrevizXZBox {
  // 取绝对值：镜像摆放（scale 为负）是合法场景数据，不取的话盒子会翻过来——「在里面」
  // 永远判不成立，推开还会算出反方向，人被吸进道具里。
  const halfX = Math.abs(extent.halfX * scale[0]);
  const halfZ = Math.abs(extent.halfZ * scale[2]);
  return {
    minX: position[0] - halfX,
    maxX: position[0] + halfX,
    minZ: position[2] - halfZ,
    maxZ: position[2] + halfZ,
  };
}

/**
 * 把一个半径为 `radius` 的圆推到每个盒子外面。
 *
 * **只扫一遍**，按给的顺序逐个推。多轮松弛会让人在两个盒子的夹角里来回抖，而每帧抖动
 * 比偶尔擦一下墙角难看得多；真需要收敛的场面（窄走廊）该由用户把路径画开，不该由这里
 * 每帧解一个约束系统。代价写在这里：穿过两件挨得很近的道具时，人可能被第二个盒子推回
 * 第一个里面。
 */
export function pushOutOfBoxes(
  point: readonly [number, number],
  radius: number,
  boxes: readonly PrevizXZBox[],
): [number, number] {
  let [x, z] = point;
  for (const box of boxes) {
    if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) {
      // 陷在里面：从最近的那条边出去。四条边等距时（正中心）`Math.min` 取到第一个，
      // 于是永远有确定的出口——原地不动的话人会卡在道具正中央，而「路径正好穿过桌子
      // 中心」时每一帧都会走到那个点。
      const toMinX = x - box.minX;
      const toMaxX = box.maxX - x;
      const toMinZ = z - box.minZ;
      const toMaxZ = box.maxZ - z;
      const nearest = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
      if (nearest === toMinX) x = box.minX - radius;
      else if (nearest === toMaxX) x = box.maxX + radius;
      else if (nearest === toMinZ) z = box.minZ - radius;
      else z = box.maxZ + radius;
      continue;
    }
    // 在外面：算圆心到盒子的最近点，不够一个半径就沿「最近点 → 圆心」推到刚好够。
    const nearX = Math.min(Math.max(x, box.minX), box.maxX);
    const nearZ = Math.min(Math.max(z, box.minZ), box.maxZ);
    const dx = x - nearX;
    const dz = z - nearZ;
    const distance = Math.hypot(dx, dz);
    if (distance >= radius) continue;
    if (distance === 0) {
      // 圆心正压在盒子边界上（严格在内的已被上面接走）。没有方向可推，沿 +X 出去——
      // 任选一个方向都比留在边上强，留下就等于这一帧没推。
      x = box.maxX + radius;
      continue;
    }
    const push = radius / distance;
    x = nearX + dx * push;
    z = nearZ + dz * push;
  }
  return [x, z];
}

/**
 * 把点夹进边界内，且离每条边至少一个半径。
 *
 * 地块比人还窄时（`min + radius > max - radius`）夹到正中：直接 `min`/`max` 会把上下界
 * 夹反，结果反而跑到界外去。
 */
export function clampToBounds(
  point: readonly [number, number],
  radius: number,
  bounds: PrevizTopDownBounds,
): [number, number] {
  return [
    clampAxis(point[0], radius, bounds.minX, bounds.maxX),
    clampAxis(point[1], radius, bounds.minZ, bounds.maxZ),
  ];
}

function clampAxis(value: number, radius: number, min: number, max: number): number {
  const low = min + radius;
  const high = max - radius;
  if (low > high) return (min + max) / 2;
  return Math.min(Math.max(value, low), high);
}
