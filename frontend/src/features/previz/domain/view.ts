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
 * `viewPlacement()` 的「正交」是**轴对齐方向**的意思——相机沿 ±X / ±Y / ±Z 摆正对准
 * 盒子中心——而不是换成正交投影；换投影会连带影响 OrbitControls 的推拉手感与属性面板
 * 上按透视相机算出的视角读数。真的换投影的是 `orthoPlacement()`，它只服务四视图那两块
 * 预览画布，那里既没有轨道控制也没有读数。
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

export interface PrevizOrthoPlacement extends PrevizViewPlacement {
  /** 相机的上方向；顶/底视图不能用世界 up（与视线平行）。 */
  up: Vec3;
  /** 取景窗的半宽 / 半高，单位是米，直接喂 `OrthographicCamera` 的 left/right/top/bottom。 */
  halfWidth: number;
  halfHeight: number;
  near: number;
  far: number;
}

/**
 * 视口相机的初始机位。`as const` 收成只读是有意的：这是全模块共享的单例，而
 * `viewPlacement()` 返回同形状的可变对象、它自己末尾就在就地改 `position[2]`，
 * 「顺手就地调一下机位」是很容易写出来的代码，改到这个常量上会污染所有后续调用。
 *
 * `PrevizRenderer.create()` 的初始机位与初始轨道中心都从这里读，`resetView()` 也是，
 * 不再另抄一份数值；渲染器用例里「重置回共享的默认机位」那条把这三处一起锁在本常量上。
 */
export const PREVIZ_DEFAULT_VIEW = {
  position: [6, 4, 8],
  target: [0, 1, 0],
} as const;

/** 视口相机与正交预览共用的近平面，单位米。同值，两处的裁切表现因此一致。 */
export const PREVIZ_VIEW_NEAR_M = 0.1;

/**
 * 视口相机远平面的**下界**，单位米。
 *
 * 它曾经是唯一的远平面，写死在渲染器的相机构造里。写死的代价是：用户自备的模型没有
 * 单位约定，一份按厘米建的房子进来就是几百米高，聚焦它要退到七八百米开外——而那时
 * 整个模型都落在远平面之外。画面上不是「什么都没有」，是模型被齐刷刷切掉一截、后面
 * 的地面网格从缺口里透出来，看着像模型本身坏了，没人会想到是相机的锅。
 *
 * 现在它只是下界：轨道距离在 125 m 以内的场景（也就是过去能正常工作的每一个场景）
 * 深度范围与从前逐位相同，只有大过它的才往外推。见 `orbitDepthRange`。
 */
export const PREVIZ_VIEW_FAR_M = 500;

/**
 * 远平面相对轨道距离的倍数。
 *
 * 取景一个半径 R 的包围球要退到约 3R（`framingDistance`，含 25% 留白），要让整个球
 * 都进画，远平面至少得够到 3R + R。4 倍在这个基础上还留了富余，装得下「主体之外还
 * 站着别的东西」这种常见情形。
 */
const FAR_DISTANCE_RATIO = 4;

/**
 * 远近平面比值的上限。
 *
 * 透视投影的深度精度是按 `near` 分配的：near 钉死在 0.1 而让 far 涨到几万，远处相邻
 * 的两个面会落进同一个深度值，表现是墙面上一片随镜头闪烁的花纹。超过这个比值就把
 * near 一起推远——退到那么远时，眼前 0.1 m 处本来也不该有需要正确排序的东西。
 *
 * 20000 是配合 24 位深度缓冲挑的：再放大一档，1 km 处的深度分辨率就掉到米级。
 */
const MAX_DEPTH_RATIO = 20000;

/**
 * 远平面的硬上界，单位米。
 *
 * 不是性能考虑，是防脏数据：轨道距离由相机位置减注视点得出，两边都可能被导入的场景
 * 写成天文数字。没有这道闸，一次坏数据就能把投影矩阵推成实际上无穷远，画面全黑。
 */
const MAX_FAR_M = 5_000_000;

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

export interface PrevizDepthRange {
  near: number;
  far: number;
}

/**
 * 按相机到轨道中心的距离，算这一帧视口相机的深度范围。
 *
 * **挂在轨道距离上，而不是场景包围盒上。** 包围盒当然更准，但它要遍历整棵场景图逐个
 * mesh 求世界盒，而这个值每一帧都要用；轨道距离只是一次减法加一次 hypot。更重要的是
 * 它跟得住用户的动作：滚轮推拉、按 F 聚焦、切六视图，动的正好都是这个距离。
 *
 * 代价写在这里：相机贴着一栋巨大建筑站时，远平面按「贴着」算，建筑深处会被裁掉。那时
 * 画面里本来也就是眼前这一片墙，而真要按整栋楼开远平面，深度精度会赔在这片墙上。
 *
 * 全函数（`domain/` 的横切约定）：距离是 NaN、负数或 Infinity 时回落到那对写死的老值。
 * 绝不能把非有限数交给 `updateProjectionMatrix()`——three 拿到 NaN 不报错，只给一片黑。
 */
export function orbitDepthRange(distance: number): PrevizDepthRange {
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 0;
  const far = Math.min(MAX_FAR_M, Math.max(PREVIZ_VIEW_FAR_M, safeDistance * FAR_DISTANCE_RATIO));
  return { near: Math.max(PREVIZ_VIEW_NEAR_M, far / MAX_DEPTH_RATIO), far };
}

/**
 * 正交取景：四视图那两块预览用的相机参数。
 *
 * 这里才是真正换投影的地方，`viewPlacement()` 不是——那条路要保住 OrbitControls 的推拉
 * 手感和属性面板按透视相机算出的读数。预览画布上没有这两样顾虑，而俯视/侧视要的正是
 * 正交：透视下平行的走位轨迹会往灭点收，「这两条路线是不是平行」「人从机位前面过还是
 * 后面过」这类判断当场就不成立了。
 *
 * 取景窗按包围**球**开，所以同一个场景六个方向的窗口一样大，来回切不会忽大忽小。
 */
export function orthoPlacement(
  direction: PrevizViewDirection,
  bounds: PrevizBounds,
  aspect: number,
): PrevizOrthoPlacement {
  const target = boundsCenter(bounds);
  const radius = boundsRadius(bounds);
  const safeAspect = clampToRange(aspect, FRAMING_ASPECT);
  // 半窗至少 1 米：场景空了（半径 0）也得是一块看得见东西的窗口，而不是一个点。
  const half = Math.max(MIN_FRAMING_DISTANCE, radius * FRAMING_PADDING);
  // 竖幅画布上紧的那一边是水平方向，得反过来由它定高，否则左右会切掉。
  const halfHeight = safeAspect >= 1 ? half : half / safeAspect;
  const halfWidth = halfHeight * safeAspect;

  // 站得比包围球远一倍再加 1 米。正交投影下站多远不影响画面大小，只影响裁切：
  // 站进球里会把靠近相机的那半个场景切掉。
  const distance = radius * 2 + MIN_FRAMING_DISTANCE;
  const unit = VIEW_DIRECTION_UNIT[direction];

  return {
    position: [
      target[0] + unit[0] * distance,
      target[1] + unit[1] * distance,
      target[2] + unit[2] * distance,
    ],
    target,
    // 顶/底视图的视线与世界 up 平行，`lookAt` 会退化。这里显式给一个 up，顺带定死
    // 「俯视图里 +X 朝右、+Z 朝下」——不定的话姿态由 three 内部那个 0.0001 的兜底
    // 扰动决定，换个 three 版本画面就可能整个转过去。
    up: direction === 'top' ? [0, 0, -1] : direction === 'bottom' ? [0, 0, 1] : [0, 1, 0],
    halfWidth,
    halfHeight,
    // 近平面贴着相机、远平面兜住整个包围球：正交的深度是线性的，把范围开大不像透视
    // 那样折损深度精度。
    near: PREVIZ_VIEW_NEAR_M,
    far: distance + radius * 2 + MIN_FRAMING_DISTANCE,
  };
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
