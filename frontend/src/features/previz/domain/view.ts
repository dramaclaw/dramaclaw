// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { DEG_TO_RAD, clampToRange } from './camera';
import type { PrevizRange } from './camera';
import type { Vec3 } from './scene';

/**
 * 六向视图与聚焦取景：给定一个要看的包围盒，算出相机站哪儿、看哪儿。
 *
 * 坐标约定与 three 一致——右手系、Y 轴朝上、单位是米。`front` / `back` / `left` /
 * `right` 指的是**世界轴**的方向，不是主体的左右：主体朝 +Z 站着时，「右视图」看到的
 * 是它的左半边。
 *
 * 这里的「正交」是**轴对齐方向**的意思——相机沿 ±X / ±Y / ±Z 摆正对准盒子中心——
 * 而不是换成正交投影；换投影会连带影响 OrbitControls 的推拉手感与属性面板上按透视
 * 相机算出的视角读数，真正的正交投影跟 P4 的四视图一起做。
 *
 * 本模块的函数都是**全函数**（`domain/` 的横切约定）：包围盒可能是 three 的空 `Box3`
 * （min=+∞ / max=-∞），画幅比可能是上游漏了护栏之后算出来的 0 或 Infinity。这类输入
 * 在内部收敛掉，绝不把 NaN、0 或负距离交给相机——three 拿到它们不会报错，只会给出
 * 一片黑，症状离病因隔着整个引擎层。
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
  /** 相机在世界坐标里的站位。 */
  position: Vec3;
  /** 世界坐标里的注视点，同时是 OrbitControls 的轨道中心；不是方向向量。 */
  target: Vec3;
}

/**
 * 视口相机的初始机位。`as const` 收成只读是有意的：这是全模块共享的单例，而
 * `viewPlacement()` 返回同形状的可变对象、它自己末尾就在就地改 `position[2]`，
 * 「顺手就地调一下机位」是很容易写出来的代码，改到这个常量上会污染所有后续调用。
 *
 * `PrevizRenderer.create()` 目前另有一份硬编码的相同数值，没有任何东西能发现两边漂移；
 * 要等 Task 7 让渲染器反过来 import 这个常量，才谈得上「一份真相」。
 */
export const PREVIZ_DEFAULT_VIEW = {
  position: [6, 4, 8],
  target: [0, 1, 0],
} as const;

/** 取景留白系数：包围球贴边填满画面太挤，退 25% 是常见取值。 */
const FRAMING_PADDING = 1.25;
/**
 * 半径为 0（灯光、空物件）时的兜底距离。取 1 m 是渲染器近裁面 0.1 的十倍——贴着近裁面
 * 站对象会被裁掉半截，留一个数量级的余量。
 */
const MIN_FRAMING_DISTANCE = 1;
/**
 * 取景可用的视场角区间，越界与非有限值都在 `framingDistance` 里收敛到这里。
 * 下界不能取 0：半角趋近 0 时距离发散成 Infinity。上界卡在 180° 内侧，因为超过
 * 180° 后半角的正弦反而开始变小，距离会算成一个「越广角退得越远」的荒谬值。
 * 非有限值回落到 50°，与预演台视口相机的视场角一致。
 */
const FRAMING_FOV_DEG: PrevizRange = { min: 1, max: 179, default: 50 };
/**
 * 取景可用的画幅比区间。下界是重点：画幅越竖水平方向越紧，`radius / sin(halfH)` 随
 * aspect 变小几乎线性发散——aspect=0.001 要退到半径的 2680 倍，早已越过渲染器 500 的
 * 远平面，画面直接全黑。0.25（1:4）比最竖的出片画幅 9:16 还窄一档，正常取景够不到，
 * 更窄的只可能是侧栏折叠动画中途那种瞬态尺寸，按 1:4 取景就够了。
 * 上界几乎是摆设：aspect > 1 时紧的那一边是垂直，水平项根本进不了 `Math.max`。
 * 非有限值回落到 1（方形），此时两个方向一样紧。
 */
const FRAMING_ASPECT: PrevizRange = { min: 0.25, max: 4, default: 1 };
/**
 * 顶/底视图偏离极轴的微倾比例（相对距离），加在 +Z 上。
 *
 * 正对着极轴站时 OrbitControls 的极角 `phi` 恰好是 0（顶）或 π（底），也就是
 * `Spherical.makeSafe()` 允许区间 `[EPS, π−EPS]` 的两个端点。`_update()` 的顺序是先把
 * 本帧的 `_sphericalDelta.phi` 加进去、再钳区间，所以从端点往区间外的那半边拖，整段
 * 增量都会被钳掉——纵向拖拽有一半方向是死的。微倾把 phi 挪到离极点 0.005 rad（0.29°）
 * 的区间内侧，两个方向就都能拖了。
 *
 * 第二件事是姿态：视线与 up 平行时 `Matrix4.lookAt` 会走兜底分支，给 `_z.z` 加 0.0001
 * 再归一化，相机的滚转实际由这个隐藏扰动决定。有了显式微倾，姿态就是我们自己定的；
 * 方向特意选 +Z，与那个兜底扰动同向，所以画面上看不出与正视有差别。
 *
 * **它解决不了方位角。** `setFromCartesianCoords` 算的是 `theta = atan2(x, z)`，微倾
 * 只动 z、x 仍是 0，`atan2(0, 0.005d)` 照样是 0。别指望它能保住切换视图前的方位角。
 *
 * 按比例给而不是给固定长度，大小场景才都是这 0.29°。
 */
const POLE_TILT_RATIO = 0.005;

interface AxisSpan {
  readonly center: number;
  readonly halfExtent: number;
}

/**
 * 单轴的中心与半长。任一端非有限就把这条轴收敛成「原点上的一个点」：three 的空 `Box3`
 * 是 min=+∞ / max=-∞，直接算 (min+max)/2 得到的是 NaN。端点顺序反了不当错，中心与
 * 半长都只跟这两个数本身有关。
 *
 * 这只是最后一道数学兜底，不是产品行为：引擎侧（Task 7）在把盒子递进来之前，就已经把
 * 空 `Box3` 换成人体尺寸的占位盒了，那答的是「用户点了聚焦、可对象没有几何体，画面上
 * 该看到什么」。两者答的是不同问题，别为了「统一」把其中一个改成另一个——`domain/`
 * 是纯几何层，没道理知道「人有 2 米高」这种业务事实。
 */
function axisSpan(min: number, max: number): AxisSpan {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { center: 0, halfExtent: 0 };
  return { center: (min + max) / 2, halfExtent: Math.abs(max - min) / 2 };
}

function boundsSpans(bounds: PrevizBounds): [AxisSpan, AxisSpan, AxisSpan] {
  return [
    axisSpan(bounds.min[0], bounds.max[0]),
    axisSpan(bounds.min[1], bounds.max[1]),
    axisSpan(bounds.min[2], bounds.max[2]),
  ];
}

/** 三轴端点是否都有限，即这个盒子能不能参与并集运算。 */
function hasFiniteBounds(bounds: PrevizBounds): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis])) return false;
  }
  return true;
}

export function boundsCenter(bounds: PrevizBounds): Vec3 {
  const [x, y, z] = boundsSpans(bounds);
  return [x.center, y.center, z.center];
}

/** 包围**球**半径（半对角线）。用最长半边会让立方体的角伸出取景框。 */
export function boundsRadius(bounds: PrevizBounds): number {
  const [x, y, z] = boundsSpans(bounds);
  return Math.sqrt(
    x.halfExtent * x.halfExtent + y.halfExtent * y.halfExtent + z.halfExtent * z.halfExtent,
  );
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
    if (!hasFiniteBounds(bounds)) continue;
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
  // 半径没有「太大」一说，也没有有意义的默认值，所以它不走 PrevizRange：非法值一律
  // 当成 0，再由 MIN_FRAMING_DISTANCE 接住。
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  // `* DEG_TO_RAD / 2`：先度转弧度，再取半角。
  const halfVertical = (clampToRange(verticalFovDeg, FRAMING_FOV_DEG) * DEG_TO_RAD) / 2;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * clampToRange(aspect, FRAMING_ASPECT));
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

  // 只有顶/底站在极轴上，需要按 POLE_TILT_RATIO 的说明躲开那两个退化端点；
  // 四个水平方向的极角本来就是 90°，正落在安全区间中间。
  // 这行整个覆盖掉 Z，所以 VIEW_DIRECTION_UNIT 里顶/底那两项的第三个分量是无效位。
  if (direction === 'top' || direction === 'bottom') {
    position[2] = target[2] + distance * POLE_TILT_RATIO;
  }

  return { position, target };
}
