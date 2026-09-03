// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { DEG_TO_RAD, RAD_TO_DEG, type PrevizRange } from './camera';
import { normalizeYawDeg } from './cameraDraft';
import type { PrevizObject, PrevizRigClip, RigAnchorPart, Vec3 } from './scene';

/**
 * 特写跟踪的几何。
 *
 * 「特写」在预演里不是一段轨迹，而是一条约束：机位跟着某个对象的某一处身体部位，
 * 停在离它多远、哪个方位、多高的地方，并且始终看着它。人物走动、转身、被重新摆位，
 * 机位自己跟上去——用路径去追一个会动的人，每改一次人物走位就得重画一遍轨迹。
 *
 * 本模块只管几何：给一个锚点和一条片段，算出机位这一帧站在哪、朝哪。片段的增删改
 * 在 `closeupClip.ts`，逐帧求值在 `evaluate.ts`——那两处都依赖这里，所以这里一个都
 * 不能反向依赖，否则就是循环 import。
 */

/**
 * 各部位离地高度占身高的比例。取的是常见人体比例：髋关节约半身高，重心略高于它，
 * 胸口在四分之三上下，眼睛与头顶之间还有约半个头。
 *
 * 用比例而不是固定的厘米数：120 cm 的孩子和 200 cm 的人，脸的高度差了 60 cm，
 * 固定偏移会让其中一个的「面部特写」拍到胸口或者头顶的空气。
 */
export const PREVIZ_RIG_ANCHOR_FRACTION: Readonly<Record<RigAnchorPart, number>> = {
  pelvis: 0.5,
  body: 0.55,
  chest: 0.72,
  face: 0.93,
  head: 0.96,
};

/** 机位到锚点的距离区间，单位米。下界不取 0：机位穿进人物身体里只会拍到模型内壁。 */
export const PREVIZ_RIG_DISTANCE_RANGE = { min: 0.2, max: 50, default: 2.75 } as const;

/**
 * 俯仰区间，单位度。两端各留 5°：YXZ 次序在正负 90° 上是万向节奇点，
 * 水平角在那里失去意义，环绕运镜会在顶点上突然打转。
 */
export const PREVIZ_RIG_ELEVATION_RANGE = { min: -85, max: 85, default: 0 } as const;

/** 机位相对锚点的额外抬高，单位米。上下各 5 m 足够涵盖俯拍与地面仰角。 */
export const PREVIZ_RIG_HEIGHT_RANGE = { min: -5, max: 5, default: 0 } as const;

/** 环绕运镜在整条片段里绕的角度。整整一圈——半圈会停在人物背后。 */
export const PREVIZ_RIG_ORBIT_DEG = 360;

/** 推镜头收到起始距离的这个比例。 */
export const PREVIZ_RIG_PUSH_RATIO = 0.45;

/** 拉镜头放到起始距离的这个比例。 */
export const PREVIZ_RIG_PULL_RATIO = 2.2;

/** 夹取用的区间表，属性面板与落盘校验共用同一份边界。 */
export const PREVIZ_RIG_RANGES: Readonly<Record<'distance' | 'elevation' | 'height', PrevizRange>> =
  {
    distance: PREVIZ_RIG_DISTANCE_RANGE,
    elevation: PREVIZ_RIG_ELEVATION_RANGE,
    height: PREVIZ_RIG_HEIGHT_RANGE,
  };

/**
 * 一个对象「有多高」，单位米。
 *
 * 只有人物有身高。机位、灯、道具返回 0，于是它们的锚点就是自己的原点——硬套人体
 * 比例只会把跟着道具的特写架到它上方一米处的空气里。
 *
 * 乘上 Y 向缩放：画面上实际的高度是 `heightCm × scale.y`，只看 heightCm 的话，
 * 被放大一倍的人物「面部特写」会卡在他胸口。
 */
export function anchorHeightM(object: PrevizObject): number {
  if (object.kind !== 'character') return 0;
  const scaleY = object.transform.scale[1];
  return (object.heightCm / 100) * (Number.isFinite(scaleY) ? scaleY : 1);
}

/** 锚点世界坐标：对象站的地方，往上抬到指定部位。 */
export function rigAnchorPoint(position: Vec3, heightM: number, part: RigAnchorPart): Vec3 {
  return [position[0], position[1] + heightM * PREVIZ_RIG_ANCHOR_FRACTION[part], position[2]];
}

/** 某一刻的取景三元组。运镜就是让它随片段进度变化。 */
export interface RigFraming {
  azimuth: number;
  elevation: number;
  distance: number;
}

/**
 * 片段内归一化进度 `u` 处的取景。
 *
 * 运镜写成「对静态取景的插值」而不是各存一份起止值：属性面板上调的是同一组数字，
 * 换个运镜方式不该把已经摆好的角度清掉。
 */
export function rigFramingAt(clip: PrevizRigClip, u: number): RigFraming {
  const progress = Math.min(1, Math.max(0, Number.isFinite(u) ? u : 0));
  const base: RigFraming = {
    azimuth: clip.azimuth,
    elevation: clip.elevation,
    distance: clip.distance,
  };

  if (clip.motion === 'orbit') {
    return { ...base, azimuth: clip.azimuth + PREVIZ_RIG_ORBIT_DEG * progress };
  }
  if (clip.motion === 'push' || clip.motion === 'pull') {
    const ratio = clip.motion === 'push' ? PREVIZ_RIG_PUSH_RATIO : PREVIZ_RIG_PULL_RATIO;
    const end = clip.distance * ratio;
    return {
      ...base,
      // 夹回区间：推镜头的终点乘出来可能比下界还小，那时机位会穿进人物身体里。
      distance: Math.min(
        PREVIZ_RIG_DISTANCE_RANGE.max,
        Math.max(PREVIZ_RIG_DISTANCE_RANGE.min, clip.distance + (end - clip.distance) * progress),
      ),
    };
  }
  return base;
}

/**
 * 机位这一帧站在哪。
 *
 * 球坐标：水平角绕锚点转，俯仰把机位抬起来同时收短水平半径（`distance` 是球面半径，
 * 不是水平距离——否则「距离 3」在俯角 60° 时实际离了 6 米），最后叠上高度偏移。
 *
 * 水平角零点是被跟踪对象的**正面**：零朝向的对象面朝 -Z（`sceneGraph` 钉死的约定），
 * 所以 0° 把机位放在 -Z 那一侧。`bearing` 为 `front` 时再叠上对象这一帧的偏航，
 * 人一转身机位跟着转到他脸前。
 */
export function rigCameraPosition(
  anchor: Vec3,
  anchorYawDeg: number,
  clip: PrevizRigClip,
  u: number,
): Vec3 {
  const framing = rigFramingAt(clip, u);
  const bearing =
    (framing.azimuth + (clip.bearing === 'front' ? anchorYawDeg : 0)) * DEG_TO_RAD;
  const elevation = framing.elevation * DEG_TO_RAD;
  const radius = framing.distance * Math.cos(elevation);

  return [
    anchor[0] - radius * Math.sin(bearing),
    anchor[1] + framing.distance * Math.sin(elevation) + clip.height,
    anchor[2] - radius * Math.cos(bearing),
  ];
}

/**
 * 从 `eye` 看向 `target` 的欧拉角，单位度，顺序与全局一致：`[俯仰, 偏航, 横滚]`，
 * 按 YXZ 施加。
 *
 * YXZ 次序下这两个角是解耦的，不必分解旋转矩阵：
 * `R_y(yaw)·R_x(pitch)·(0,0,-1) = (-cos p·sin y, sin p, -cos p·cos y)`，
 * 对着单位视线向量逐项解出来就是下面两行。换成 three 默认的 XYZ 次序，同样一对角
 * 会引入一个非零横滚——地平线会歪。
 *
 * 横滚恒为 0：绕视线轴翻转在预演里没有来源，算出个非零值只可能是数值噪声。
 */
export function lookAtEulerDeg(eye: Vec3, target: Vec3): Vec3 {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const length = Math.hypot(dx, dy, dz);
  // 机位被拖到锚点上时视线是零向量，`atan2(0,0)` 与 `asin(NaN)` 都给不出可用的角度。
  if (!Number.isFinite(length) || length === 0) return [0, 0, 0];

  // 偏航收进 `[0, 360)`，与机位草稿同一套约定。不收的话正后方那个角会随着 dx 的
  // 正负零在 +180 与 -180 之间跳，属性面板上看是数字自己在闪。
  // 俯仰末尾那个 `+ 0` 把 -0 抹成 0：数值上没差别，但它会原样显示成一个「-0」。
  return [
    Math.asin(Math.min(1, Math.max(-1, dy / length))) * RAD_TO_DEG + 0,
    normalizeYawDeg(Math.atan2(-dx, -dz) * RAD_TO_DEG),
    0,
  ];
}
