// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { OutputAspect, PrevizCamera } from './scene';

/**
 * 镜头换算全仓只此一份：属性面板、监看取景框、截图尺寸都从这里取值。
 * 本模块的换算函数都是**全函数**——焦距先过 `clampFocalMm`，视场角先验区间，
 * 越界与非有限输入在内部收敛掉，调用方不需要也不应该自己先夹一遍。之所以要这样，
 * 是因为 three 的 `PerspectiveCamera` 拿到 0 / 180 / 负数 / NaN 的 fov 不会报错，
 * 只会给出零宽或 NaN 的视锥、甚至悄悄翻转手性，症状离病因隔着好几层。
 */

/** 两种机身的成像面物理尺寸，单位毫米。s35 取 Super 35 的常见值 24.89 × 18.66。 */
export const PREVIZ_SENSOR_MM: Readonly<
  Record<PrevizCamera['sensor'], Readonly<{ width: number; height: number }>>
> = {
  ff: { width: 36, height: 24 },
  s35: { width: 24.89, height: 18.66 },
};

export const PREVIZ_FOCAL_MM = { min: 12, max: 200, default: 50 } as const;
export const PREVIZ_APERTURE = { min: 1.2, max: 22, default: 2.8 } as const;

/** 出片像素尺寸。边长全取偶数：编码器与多数缩放路径对奇数边不友好。 */
export const OUTPUT_PIXEL_SIZE: Readonly<
  Record<OutputAspect, Readonly<{ width: number; height: number }>>
> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1440, height: 1440 },
  '4:3': { width: 1600, height: 1200 },
};

export function aspectRatio(aspect: OutputAspect): number {
  const size = OUTPUT_PIXEL_SIZE[aspect];
  return size.width / size.height;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** 水平视场角只由传感器宽度与焦距决定，与出片画幅无关。 */
export function horizontalFovDeg(focalMm: number, sensor: PrevizCamera['sensor']): number {
  return 2 * Math.atan(PREVIZ_SENSOR_MM[sensor].width / (2 * clampFocalMm(focalMm))) * RAD_TO_DEG;
}

/**
 * 反解焦距。区间外的视场角没有可用的解——0 与 180 分别对应无穷远与零焦距，负角还会
 * 把焦距解成负数——一律回落到默认焦距。解出来的焦距本身也要夹：170° 是合法角，
 * 对应的却是 1.6 mm，早出了镜头库的范围。
 */
export function focalFromHorizontalFovDeg(fovDeg: number, sensor: PrevizCamera['sensor']): number {
  if (!(fovDeg > 0 && fovDeg < 180)) return PREVIZ_FOCAL_MM.default;
  return clampFocalMm(PREVIZ_SENSOR_MM[sensor].width / (2 * Math.tan((fovDeg * DEG_TO_RAD) / 2)));
}

/**
 * three 的 `PerspectiveCamera.fov` 是**垂直**视场角，所以喂给相机的是这个函数。
 * 本模块钉死的约定是：水平角只由焦距与传感器宽度决定，出片画幅只改垂直角。
 * 于是出片比机身原生比例更竖时（全画幅原生 3:2，出 9:16 时垂直角 65.2°），垂直角会
 * **故意**超出 24 mm 成像面的物理覆盖——这是取景约定，不是在模拟真机的画幅裁切。
 */
export function verticalFovDeg(
  focalMm: number,
  sensor: PrevizCamera['sensor'],
  aspect: OutputAspect,
): number {
  const sensorWidth = PREVIZ_SENSOR_MM[sensor].width;
  return 2 * Math.atan(sensorWidth / (2 * clampFocalMm(focalMm) * aspectRatio(aspect))) * RAD_TO_DEG;
}

interface PrevizRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/**
 * 非有限输入回落到默认值而不是边界值：NaN / Infinity 更可能是上游算错了或输入框空着，
 * 不是用户想要长焦。
 * 属性面板（Task 14）注意：这条约定只适合在 blur 时调用。逐键调用的话，清空输入框会
 * 立刻跳回 50，想输 120 时先敲的那个 1 会被夹成 12，用户根本没法把数字打完。
 */
function clampToRange(value: number, range: PrevizRange): number {
  if (!Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, value));
}

export function clampFocalMm(value: number): number {
  return clampToRange(value, PREVIZ_FOCAL_MM);
}

export function clampAperture(value: number): number {
  return clampToRange(value, PREVIZ_APERTURE);
}
