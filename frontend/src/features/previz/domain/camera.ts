// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { OutputAspect, PrevizCamera } from './scene';

/** 两种机身的成像面物理尺寸，单位毫米。s35 取 Super 35 的常见值 24.89 × 18.66。 */
export const PREVIZ_SENSOR_MM: Record<PrevizCamera['sensor'], { width: number; height: number }> = {
  ff: { width: 36, height: 24 },
  s35: { width: 24.89, height: 18.66 },
};

export const PREVIZ_FOCAL_MM = { min: 12, max: 200, default: 50 } as const;
export const PREVIZ_APERTURE = { min: 1.2, max: 22, default: 2.8 } as const;

/** 出片像素尺寸。边长全取偶数：编码器与多数缩放路径对奇数边不友好。 */
export const OUTPUT_PIXEL_SIZE: Record<OutputAspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1440, height: 1440 },
  '4:3': { width: 1600, height: 1200 },
};

export function aspectValue(aspect: OutputAspect): number {
  const size = OUTPUT_PIXEL_SIZE[aspect];
  return size.width / size.height;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** 水平视场角只由传感器宽度与焦距决定，与出片画幅无关。 */
export function horizontalFovDeg(focalMm: number, sensor: PrevizCamera['sensor']): number {
  return 2 * Math.atan(PREVIZ_SENSOR_MM[sensor].width / (2 * focalMm)) * RAD_TO_DEG;
}

export function focalFromHorizontalFovDeg(fovDeg: number, sensor: PrevizCamera['sensor']): number {
  return PREVIZ_SENSOR_MM[sensor].width / (2 * Math.tan((fovDeg * DEG_TO_RAD) / 2));
}

/**
 * three 的 `PerspectiveCamera.fov` 是**垂直**视场角。先由传感器宽度算水平角，再按
 * 出片画幅换成垂直角——而不是直接拿传感器高度算。区别在于：拿传感器高度算等于把
 * 画幅当成机身的原生比例，全画幅是 3:2，出 16:9 时上下要裁，裁完的垂直角比原生
 * 小；直接用传感器高度会把这块裁掉的也算进去，取景框比实际出片更松。
 */
export function verticalFovDeg(
  focalMm: number,
  sensor: PrevizCamera['sensor'],
  aspect: OutputAspect,
): number {
  const halfHorizontal = Math.atan(PREVIZ_SENSOR_MM[sensor].width / (2 * focalMm));
  return 2 * Math.atan(Math.tan(halfHorizontal) / aspectValue(aspect)) * RAD_TO_DEG;
}

/** 非有限输入回落到默认焦距而不是边界值：NaN 更可能是上游算错了，不是用户想要长焦。 */
export function clampFocalMm(value: number): number {
  if (!Number.isFinite(value)) return PREVIZ_FOCAL_MM.default;
  return Math.min(PREVIZ_FOCAL_MM.max, Math.max(PREVIZ_FOCAL_MM.min, value));
}

export function clampAperture(value: number): number {
  if (!Number.isFinite(value)) return PREVIZ_APERTURE.default;
  return Math.min(PREVIZ_APERTURE.max, Math.max(PREVIZ_APERTURE.min, value));
}
