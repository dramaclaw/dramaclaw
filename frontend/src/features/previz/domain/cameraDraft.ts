// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  DEG_TO_RAD,
  PREVIZ_APERTURE,
  PREVIZ_FOCAL_MM,
  RAD_TO_DEG,
  clampAperture,
  clampFocalMm,
  clampToRange,
} from './camera';
import type { PrevizRange } from './camera';
import type { PrevizObjectOverrides } from './objects';
import type { PrevizCamera, Vec3 } from './scene';

/**
 * 「摄影机创建」对话框正在编辑的那一份机位——还没进场景，所以不是 `PrevizCamera`：
 * 没有 id、没有名字，角度也拆成了三根滑杆各自的语义（偏航 / 俯仰 / 横滚），而不是
 * `transform.rotation` 那个 `[x, y, z]` 数组。两者的桥是 `cameraDraftOverrides`。
 *
 * 拆开是有意的：对话框上三根滑杆的区间各不相同（水平 0–360 循环、俯仰 ±90 夹死、
 * 横滚 ±180），把它们塞进一个匿名三元组之后，「第 0 个分量是俯仰」这件事就只剩注释
 * 在守着了。这里给它们名字，`cameraDraftOverrides` 里那一次换序就是唯一的转换点。
 */
export interface PrevizCameraDraft {
  cameraBody: PrevizCamera['cameraBody'];
  lensSeries: PrevizCamera['lensSeries'];
  focalMm: number;
  aperture: number;
  sensor: PrevizCamera['sensor'];
  /** 世界坐标里的站位，单位米。 */
  position: Vec3;
  /** 偏航，度。0 朝 -Z，正向是从 +Y 往下看的逆时针（与 three 的 +Y 旋转同向）。 */
  yawDeg: number;
  /** 俯仰，度。正是抬头。 */
  pitchDeg: number;
  /** 横滚，度。正是画面顺时针。 */
  rollDeg: number;
}

export const PREVIZ_PITCH_RANGE: PrevizRange = { min: -90, max: 90, default: 0 };
export const PREVIZ_ROLL_RANGE: PrevizRange = { min: -180, max: 180, default: 0 };

/**
 * 新机位沿视线往前挪多少（占眼位到轨道中心距离的比例）。
 *
 * 建在眼位上的机位，机身盒体正好糊在视口相机的近裁面上——用户按完「创建」，画面上
 * 要么什么都没变、要么被机身糊死，唯一的反馈只剩图层里多了一行。往前挪一小段，机身
 * 就落进画面里了。upstream 是同一个做法，实测比例正是 20%（视角 6.0/5.0/8.0、轨道
 * 中心 0/0.5/0 建出来的机位在 4.8/4.1/6.4）。
 *
 * 挪的是站位，不是朝向：机位仍在原来那条视线上，取景框里的东西与视口所见一致，
 * 对话框上「创建的机位方向与此一致」那句话仍然成立。
 */
export const PREVIZ_CAMERA_LEAD_RATIO = 0.2;

/**
 * 把任意角度收进 `[0, 360)`。水平角是循环量：滑杆推到 360 再往上、或者按「-」按钮从
 * 0 往下，得到的应该是绕回来的那个角，不是被夹在端点上。JS 的 `%` 对负数返回负值，
 * 所以要再加一圈。非有限输入回落到 0——与 `clampToRange` 对齐，见那里的说明。
 */
export function normalizeYawDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/**
 * 偏航 / 俯仰对应的单位视线向量。
 *
 * 与 `sceneGraph` 钉死的 YXZ 次序、以及 three「对象在零旋转时朝 -Z」的约定同源：
 * `R_y(yaw)·R_x(pitch)·(0, 0, -1)`。横滚绕的就是这条视线自己，不影响它，所以不收。
 */
export function cameraDraftForward(draft: { yawDeg: number; pitchDeg: number }): Vec3 {
  const yaw = normalizeYawDeg(draft.yawDeg) * DEG_TO_RAD;
  const pitch = clampToRange(draft.pitchDeg, PREVIZ_PITCH_RANGE) * DEG_TO_RAD;
  const cosPitch = Math.cos(pitch);
  return [-cosPitch * Math.sin(yaw), Math.sin(pitch), -cosPitch * Math.cos(yaw)];
}

/**
 * 从当前导演视角推一份机位草稿：站位取眼位（按 `PREVIZ_CAMERA_LEAD_RATIO` 往前挪），
 * 朝向取眼位到轨道中心的视线，镜头参数取新建机位的默认值。
 *
 * 横滚固定 0 而不是从视口读：OrbitControls 全程保持 up 朝天，视口相机的滚转恒为 0，
 * 读回来也只会是 0——但那是「读不到」而不是「就是 0」，写死更诚实。
 */
export function createCameraDraft(placement: {
  // 收 readonly 而不是直接收 `PrevizViewPlacement`：本函数只读两个坐标，而
  // `PREVIZ_DEFAULT_VIEW` 是 `as const` 的只读常量，用可变形状会把它挡在门外。
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}): PrevizCameraDraft {
  const { position: eye, target } = placement;
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const length = Math.hypot(dx, dy, dz);

  // 轨道中心被拖到眼位上时视线是零向量，`atan2(0, 0)` 与 `asin(NaN)` 都给不出可用的
  // 角度。此时机位保持零朝向（朝 -Z），也不必往前挪——没有「前」可言。
  const hasDirection = Number.isFinite(length) && length > 0;
  const yawDeg = hasDirection ? normalizeYawDeg(Math.atan2(-dx, -dz) * RAD_TO_DEG) : 0;
  const pitchDeg = hasDirection ? Math.asin(dy / length) * RAD_TO_DEG : 0;
  const lead = hasDirection ? PREVIZ_CAMERA_LEAD_RATIO : 0;

  return {
    cameraBody: 'cine',
    lensSeries: 'prime',
    focalMm: PREVIZ_FOCAL_MM.default,
    aperture: PREVIZ_APERTURE.default,
    sensor: 'ff',
    position: [eye[0] + dx * lead, eye[1] + dy * lead, eye[2] + dz * lead],
    yawDeg,
    pitchDeg,
    rollDeg: 0,
  };
}

/**
 * 把草稿的每个数值字段收进各自的区间。
 *
 * 对话框上的数字输入框存的是**用户敲进去的原样**——逐键夹取会让「先删空再重输」
 * 变得没法用（见 `clampToRange` 的说明），所以收敛推迟到提交与落盘这两个出口。
 * 水平角走的是循环而不是夹取：滑杆推过 360 或敲进 -30，得到的应该是绕回来的那个角。
 */
export function clampCameraDraft(draft: PrevizCameraDraft): PrevizCameraDraft {
  return {
    ...draft,
    focalMm: clampFocalMm(draft.focalMm),
    aperture: clampAperture(draft.aperture),
    yawDeg: normalizeYawDeg(draft.yawDeg),
    pitchDeg: clampToRange(draft.pitchDeg, PREVIZ_PITCH_RANGE),
    rollDeg: clampToRange(draft.rollDeg, PREVIZ_ROLL_RANGE),
  };
}

/**
 * 草稿 → `createPrevizObject('camera', …)` 的初始字段。
 *
 * 这里是「三根有名字的滑杆」变回「`[x, y, z]` 三元组」的唯一一处，换序就发生在这一行：
 * rotation 的 x 是俯仰、y 是偏航、z 是横滚。夹取按对话框的三个区间来，和 schema 落盘时
 * 会做的那次夹取一致——UI 上滑杆到不了界外，但数字输入框能敲进去。
 */
export function cameraDraftOverrides(draft: PrevizCameraDraft): PrevizObjectOverrides<'camera'> {
  const safe = clampCameraDraft(draft);
  return {
    transform: {
      position: [...safe.position],
      rotation: [safe.pitchDeg, safe.yawDeg, safe.rollDeg],
      scale: [1, 1, 1],
    },
    focalMm: safe.focalMm,
    aperture: safe.aperture,
    sensor: safe.sensor,
    cameraBody: safe.cameraBody,
    lensSeries: safe.lensSeries,
  };
}
