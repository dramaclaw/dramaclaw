// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { clampToRange } from './camera';
import type { PrevizRange } from './camera';
import type { Vec3 } from './scene';

/**
 * 六向视图与聚焦取景：给定一个要看的包围盒，算出相机站哪儿、看哪儿。
 * 这里的「正交」是**轴对齐方向**的意思——相机沿 ±X / ±Y / ±Z 摆正对准盒子中心——
 * 而不是换成正交投影；换投影会连带影响 OrbitControls 的推拉手感与属性面板上按透视
 * 相机算出的视角读数，真正的正交投影跟 P4 的四视图一起做。
 *
 * 本模块的函数都是**全函数**：包围盒可能是 three 的空 `Box3`（min=+∞ / max=-∞），
 * 画幅比可能是画布高度为 0 时算出来的 Infinity。这类输入在内部收敛掉，绝不把 NaN、
 * 0 或负距离交给相机——three 拿到它们不会报错，只会给出一片黑，症状离病因隔着整个引擎层。
 */

export type PrevizViewDirection = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export const PREVIZ_VIEW_DIRECTIONS: readonly PrevizViewDirection[] = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
];

/** 从注视点指向相机的单位向量。正视图在 +Z：three 的相机默认朝 -Z。 */
const VIEW_DIRECTION_UNIT: Record<PrevizViewDirection, Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

export interface PrevizBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface PrevizViewPlacement {
  position: Vec3;
  target: Vec3;
}

/** 与 `PrevizRenderer.create()` 建相机时用的初始机位保持一份真相。 */
export const PREVIZ_DEFAULT_VIEW: PrevizViewPlacement = {
  position: [6, 4, 8],
  target: [0, 1, 0],
};

/** 取景留白系数：包围球贴边填满画面太挤，退 25% 是常见取值。 */
const FRAMING_PADDING = 1.25;
/** 半径为 0（灯光、空物件）时的兜底距离，避免相机贴脸进近裁面。 */
const MIN_FRAMING_DISTANCE = 1;
/**
 * 取景可用的视场角区间，越界与非有限值都在 `framingDistance` 里收敛到这里。
 * 下界不能取 0：半角趋近 0 时距离发散成 Infinity。上界卡在 180° 内侧，因为超过
 * 180° 后半角的正弦反而开始变小，距离会算成一个「越广角退得越远」的荒谬值。
 * 非有限值回落到 50°，与预演台视口相机的视场角一致。
 */
const FRAMING_FOV_DEG: PrevizRange = { min: 1, max: 179, default: 50 };
/**
 * 顶/底视图偏离极轴的微倾比例（相对距离）。正对着极轴站，OrbitControls 的极角会落到
 * 0（顶）或 π（底），它的 `makeSafe()` 把两端都夹到 EPS 的同时会把方位角一并归零，
 * 用户下一次拖拽会看到画面猛跳一下。0.5% 对应 0.29°，比 EPS（1e-6 rad）大了三个数量级
 * 还多，肉眼又看不出来它不是正视。按比例给而不是给固定长度，才能在大小场景里都是这个角度。
 */
const POLE_TILT_RATIO = 0.005;

/**
 * 单轴的中心与半长。任一端非有限就把这条轴收敛成「原点上的一个点」：three 的空
 * `Box3` 是 min=+∞ / max=-∞，直接算 (min+max)/2 得到的是 NaN。端点顺序反了不当错，
 * 中心与半长都只跟这两个数本身有关。
 */
function axisSpan(min: number, max: number): { center: number; half: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { center: 0, half: 0 };
  return { center: (min + max) / 2, half: Math.abs(max - min) / 2 };
}

/** 三轴端点是否都有限，即这个盒子能不能参与并集运算。 */
function isUsableBounds(bounds: PrevizBounds): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis])) return false;
  }
  return true;
}

export function boundsCenter(bounds: PrevizBounds): Vec3 {
  return [
    axisSpan(bounds.min[0], bounds.max[0]).center,
    axisSpan(bounds.min[1], bounds.max[1]).center,
    axisSpan(bounds.min[2], bounds.max[2]).center,
  ];
}

/** 包围**球**半径（半对角线）。用最长半边会让立方体的角伸出取景框。 */
export function boundsRadius(bounds: PrevizBounds): number {
  const dx = axisSpan(bounds.min[0], bounds.max[0]).half;
  const dy = axisSpan(bounds.min[1], bounds.max[1]).half;
  const dz = axisSpan(bounds.min[2], bounds.max[2]).half;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 合并包围盒，空列表返回 `null`（没选中对象、或场景是空的）。
 * 端点非有限的盒子直接跳过——没有几何体的对象会贡献一个空 `Box3`，放进并集会把
 * ±∞ 传染给整个结果；跳完之后一个不剩，等同于没东西可看。
 */
export function unionBounds(list: readonly PrevizBounds[]): PrevizBounds | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let used = 0;
  for (const bounds of list) {
    if (!isUsableBounds(bounds)) continue;
    used += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], bounds.min[axis]);
      max[axis] = Math.max(max[axis], bounds.max[axis]);
    }
  }
  return used === 0 ? null : { min, max };
}

/**
 * 让半径 `radius` 的包围球在两个方向上都进画的相机距离。垂直方向由 `verticalFovDeg`
 * 定，水平方向由它和 `aspect` 推出来，取两者中更远的那个——只按垂直算的话，竖幅
 * （9:16）下左右会被裁掉。半径用的是包围球而不是包围盒，所以距离与朝向无关，
 * 六个方向共用这一个值。
 */
export function framingDistance(radius: number, verticalFovDeg: number, aspect: number): number {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  // 非有限或非正的画幅比按方形处理：这时水平与垂直一样紧，退化不成 0 距离。
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfVertical = (clampToRange(verticalFovDeg, FRAMING_FOV_DEG) * Math.PI) / 360;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * safeAspect);
  const distance = Math.max(
    safeRadius / Math.sin(halfVertical),
    safeRadius / Math.sin(halfHorizontal),
  );
  return Math.max(MIN_FRAMING_DISTANCE, distance * FRAMING_PADDING);
}

export function viewPlacement(
  direction: PrevizViewDirection,
  bounds: PrevizBounds,
  verticalFovDeg: number,
  aspect: number,
): PrevizViewPlacement {
  const target = boundsCenter(bounds);
  const distance = framingDistance(boundsRadius(bounds), verticalFovDeg, aspect);
  const unit = VIEW_DIRECTION_UNIT[direction];
  const position: Vec3 = [
    target[0] + unit[0] * distance,
    target[1] + unit[1] * distance,
    target[2] + unit[2] * distance,
  ];

  // 只有顶/底站在极轴上需要躲开 makeSafe()，四个水平方向的极角本来就是 90°。
  if (direction === 'top' || direction === 'bottom') {
    position[2] = target[2] + distance * POLE_TILT_RATIO;
  }

  return { position, target };
}
