// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { OutputAspect, PrevizCamera } from './scene';

/**
 * 镜头换算全仓只此一份：属性面板、监看取景框、截图尺寸都从这里取值。
 * 本模块的换算函数对**数值**参数是全函数——焦距先过 `clampFocalMm`，视场角先验区间，
 * 越界与非有限输入在内部收敛掉，调用方不需要也不应该自己先夹一遍。之所以要这样，
 * 是因为 three 的 `PerspectiveCamera` 拿到 0 / 180 / 负数 / NaN 的 fov 不会报错，
 * 只会给出零宽或 NaN 的视锥、甚至悄悄翻转手性，症状离病因隔着好几层。
 * `sensor` / `aspect` 这两个字符串参数不在此列：查表查空了会直接 TypeError。它们由
 * `parseScene` 在入口收敛到联合类型来保证，这里不再重复校验。
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

/** 导出给 `engine/gizmo.ts`：手柄读回的 Euler 是弧度，场景里存的是度。 */
export const RAD_TO_DEG = 180 / Math.PI;
/** 导出给 `domain/view.ts`：取景那边也要度转弧度，没必要各写一份。 */
export const DEG_TO_RAD = Math.PI / 180;

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

/** 一段带默认值的闭区间。预演台 domain 层的可夹字段都按这个形状声明。 */
export interface PrevizRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/**
 * 非有限输入回落到默认值而不是边界值：NaN / Infinity 更可能是上游算错了或输入框空着，
 * 不是用户想要长焦。
 * 属性面板（Task 14）注意：这条约定只适合在 blur 时调用。逐键调用的话，清空输入框会
 * 立刻跳回 50，想输 120 时先敲的那个 1 会被夹成 12，用户根本没法把数字打完。
 * 导出是为了让 domain 层只有这一套夹取语义——`scene.ts` 的逐字段夹取也走这里，
 * 免得两份实现日后对非有限输入给出不同答案。
 */
export function clampToRange(value: number, range: PrevizRange): number {
  if (!Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, value));
}

/** 见 `clampToRange`：非有限输入回落到默认焦距，所以只该在 blur 时调用。 */
export function clampFocalMm(value: number): number {
  return clampToRange(value, PREVIZ_FOCAL_MM);
}

/** 见 `clampToRange`：非有限输入回落到默认光圈，所以只该在 blur 时调用。 */
export function clampAperture(value: number): number {
  return clampToRange(value, PREVIZ_APERTURE);
}

/**
 * 镜头**自身**的视角，即成像面高度方向张开的角度。
 *
 * 这是印在镜头参数表上的那个数（全画幅 50 mm → 27.0°、Super 35 50 mm → 21.1°），
 * 属性面板与摄影机创建对话框的读数都用它，因为用户挑的是「一支多少度的镜头」。
 *
 * 与上面两个函数的分工要分清，三个都是「视场角」但答的不是同一个问题：
 * - `horizontalFovDeg` —— 画面**横向**张多少，由传感器宽度定，与出片画幅无关；
 * - `verticalFovDeg` —— 喂给 three 的 `PerspectiveCamera.fov`，由出片画幅回推，
 *   出片越竖它越大；
 * - 本函数 —— 机身原生的纵向角，既不随出片画幅变，也不是渲染用的值。
 * 出片画幅恰好是 3:2（全画幅的原生比例）时本函数与 `verticalFovDeg` 才相等，
 * 其余画幅下两者不同**是对的**，不要为了「统一」把其中一个改成另一个。
 */
export function sensorVerticalFovDeg(focalMm: number, sensor: PrevizCamera['sensor']): number {
  return 2 * Math.atan(PREVIZ_SENSOR_MM[sensor].height / (2 * clampFocalMm(focalMm))) * RAD_TO_DEG;
}

/**
 * 焦距档位，单位毫米。整段区间是连续的（`PREVIZ_FOCAL_MM` 12–200，属性面板可以随手
 * 敲 63），档位只服务「上一档 / 下一档」这种按钮式选择——照抄常见定焦镜头的那一套。
 * 首档 14 高于 `PREVIZ_FOCAL_MM.min` 是有意的：12 mm 留给手输与导入的场景，档位表
 * 只列真实镜头库里有的那几支。
 */
export const PREVIZ_FOCAL_STOPS: readonly number[] = [14, 18, 24, 35, 50, 85, 135, 200];

/** 光圈档位，标准整档序列。同样只服务按钮式选择，手输仍走 `PREVIZ_APERTURE` 整段区间。 */
export const PREVIZ_APERTURE_STOPS: readonly number[] = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

/**
 * 在档位表里挪一档。当前值不在表上（手输过、或是从别处导入的）时先落到**最近**的一档
 * 再挪：否则「下一档」得先猜用户想从哪儿开始，而落到最近档是唯一不会让人意外的答案。
 * 已经在两端时原地不动——返回值恒等于某一档，调用方不必再夹一次。
 */
export function stepStop(stops: readonly number[], value: number, direction: -1 | 1): number {
  // 空表在类型上进得来，返回入参比抛异常温和：调用方拿到的仍是一个可用的数。
  if (stops.length === 0) return value;
  let nearest = 0;
  for (let index = 1; index < stops.length; index += 1) {
    // 非有限的 value 让每次比较都是 false，nearest 停在 0——首档，等同于「没有当前值」。
    if (Math.abs(stops[index] - value) < Math.abs(stops[nearest] - value)) nearest = index;
  }
  return stops[Math.min(stops.length - 1, Math.max(0, nearest + direction))];
}

/** 焦距的口语分类，只用于读数文案（「标准 · 27.0°」里的前半截）。 */
export type PrevizFocalClass = 'ultrawide' | 'wide' | 'standard' | 'teleShort' | 'tele';

/**
 * 分界取在档位之间而不是等于某一档，这样手输的 63 mm 也分得出类。
 * 边界值本身归上一类（`< 20` 而不是 `<= 20`），与档位表对齐：14/18 超广角、24 广角、
 * 35/50 标准、85 中长焦、135/200 长焦。
 */
export function focalClass(focalMm: number): PrevizFocalClass {
  const focal = clampFocalMm(focalMm);
  if (focal < 20) return 'ultrawide';
  if (focal < 30) return 'wide';
  if (focal < 70) return 'standard';
  if (focal < 100) return 'teleShort';
  return 'tele';
}

/** 光圈的口语分类，只用于读数文案（「标准景深」）。 */
export type PrevizDepthOfField = 'shallow' | 'standard' | 'deep';

/** 分界同样取在档位上：f/2 及更大光圈算浅景深，f/5.6 及以内算标准，再收就是深景深。 */
export function depthOfFieldClass(aperture: number): PrevizDepthOfField {
  const value = clampAperture(aperture);
  if (value <= 2) return 'shallow';
  if (value <= 5.6) return 'standard';
  return 'deep';
}
