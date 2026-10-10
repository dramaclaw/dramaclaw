// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Vec3 } from './scene';
import type { PrevizViewDirection } from './view';

/**
 * 视口左上角那个坐标轴小球：把世界的六个半轴投影到一块二维小面板上，好让用户一眼看出
 * 「现在是从哪个方向在看」，点一下某个球再切到那个方向的正视图。
 *
 * 这里只做投影，不碰 DOM 也不碰 three。理由有两条：
 *
 * 一是这块面板不该为了「知道相机转到哪儿了」而去开第二个 WebGL 上下文——浏览器对同时
 * 存活的上下文有个位数的上限，而预演台已经用掉一个了。拿到相机的机位与注视点就够算，
 * 这是纯几何。
 *
 * 二是投影里真正容易写错的是退化情况（顶视图时视线与 up 平行）与前后遮挡顺序，而这两样
 * 在浏览器里只表现为「小球叠错了」或「小球全糊在中心」，肉眼极难判断对错。放在这里，
 * 一个纯函数用例就钉死了。
 */

export type PrevizAxisName = 'x' | 'y' | 'z';

/**
 * 只读的三分量向量。入参一律收这个：`PREVIZ_DEFAULT_VIEW` 是 `as const` 的只读元组，
 * 收 `Vec3` 会把它挡在门外，而这里从头到尾只读不写。
 */
type ReadonlyVec3 = readonly [number, number, number];

/** 相机的机位与注视点。比 `PrevizViewPlacement` 松一档，只读版本也能直接传进来。 */
export interface PrevizAxisView {
  readonly position: ReadonlyVec3;
  readonly target: ReadonlyVec3;
}

export interface PrevizAxisDot {
  /** 点它之后要切去的视角。 */
  readonly direction: PrevizViewDirection;
  readonly axis: PrevizAxisName;
  /** 正半轴（画实心带字母的球）还是负半轴（画空心小圈）。 */
  readonly positive: boolean;
  /**
   * 小面板里的位置，原点在中心、范围 [-1, 1]：x 向右，**y 向下**（跟着 CSS 走，
   * 免得每个调用方各翻一次符号）。
   */
  readonly x: number;
  readonly y: number;
  /** 朝观众为正。调用方只用它排先后，不用它的绝对值。 */
  readonly depth: number;
}

/** 六个半轴：正半轴各自对应的视角与 `view.ts` 的 `VIEW_DIRECTION_UNIT` 严格一致。 */
const AXES: readonly {
  axis: PrevizAxisName;
  unit: Vec3;
  positive: boolean;
  direction: PrevizViewDirection;
}[] = [
  { axis: 'x', unit: [1, 0, 0], positive: true, direction: 'right' },
  { axis: 'x', unit: [-1, 0, 0], positive: false, direction: 'left' },
  { axis: 'y', unit: [0, 1, 0], positive: true, direction: 'top' },
  { axis: 'y', unit: [0, -1, 0], positive: false, direction: 'bottom' },
  { axis: 'z', unit: [0, 0, 1], positive: true, direction: 'front' },
  { axis: 'z', unit: [0, 0, -1], positive: false, direction: 'back' },
];

const WORLD_UP: Vec3 = [0, 1, 0];
/** 相机停在注视点上（视线长度 0）时的兜底朝向：正视图。 */
const FALLBACK_FORWARD: Vec3 = [0, 0, 1];
/**
 * 视线正好竖直（顶/底视图）时给它加的一点 +Z，再重新求基。
 *
 * 方向必须与 `view.ts` 的 `POLE_TILT_RATIO` 同为 +Z：那边摆顶/底视图时就是这么把相机
 * 挪开极轴的，跟着它走小球的姿态才与画面一致。换成「视线与 up 平行时改用某个备用 up」
 * 那种写法很难同时对上顶和底——同一个备用 up 在这两者上给出的左右恰好相反。
 *
 * 取多大不影响结果（基向量最后都归一化），只有方向有意义。
 */
const POLE_TILT: Vec3 = [0, 0, 1e-3];
/**
 * 叉积退化的判定阈值。两个单位向量的叉积模长就是夹角的正弦，1e-6 对应约 0.00006°；
 * 比这更小的时候归一化出来的方向已经完全由浮点误差决定了。
 */
const DEGENERATE = 1e-6;

function subtract(a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: ReadonlyVec3, b: ReadonlyVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 归一化；长度小到没有方向可言时返回 null，交给上面挑兜底方向。 */
function normalize(v: ReadonlyVec3): Vec3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length < DEGENERATE) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function isFinite3(v: readonly number[]): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

interface CameraBasis {
  /** 屏幕向右。 */
  right: Vec3;
  /** 屏幕向上。 */
  up: Vec3;
  /** 从注视点指向相机，即屏幕朝外。 */
  back: Vec3;
}

/**
 * 相机的三根轴，取法与 three 的 `Matrix4.lookAt` 一致（z = 眼位−注视点，x = up×z，
 * y = z×x），所以小球的朝向与画面里所见严格一致。
 *
 * 全函数：机位或注视点出现 NaN（上游漏了护栏）、两者重合、视线正好竖直，都在这里
 * 收敛掉。返回一组歪的轴顶多是小球指错方向，返回 NaN 则是六个球一起消失。
 */
function cameraBasis(view: PrevizAxisView): CameraBasis {
  const offset =
    isFinite3(view.position) && isFinite3(view.target)
      ? subtract(view.position, view.target)
      : FALLBACK_FORWARD;
  const straight = normalize(offset) ?? FALLBACK_FORWARD;
  // 顶/底视图正踩在这条分支上：视线与世界 up 平行，叉积是零向量。
  const back =
    normalize(cross(WORLD_UP, straight)) === null
      ? (normalize([
          straight[0] + POLE_TILT[0],
          straight[1] + POLE_TILT[1],
          straight[2] + POLE_TILT[2],
        ]) ?? FALLBACK_FORWARD)
      : straight;
  const right = normalize(cross(WORLD_UP, back)) ?? [1, 0, 0];
  return { right, up: cross(back, right), back };
}

/**
 * 六个半轴在小面板里的位置，**由远及近**排好序——调用方按数组顺序画下去，近的自然盖住
 * 远的。同深度时按 `AXES` 的书写顺序，免得每帧抖动。
 */
export function axisGizmoDots(view: PrevizAxisView): PrevizAxisDot[] {
  const basis = cameraBasis(view);
  return AXES.map((entry) => ({
    direction: entry.direction,
    axis: entry.axis,
    positive: entry.positive,
    x: dot(entry.unit, basis.right),
    // 世界的「上」在屏幕上是「向上」，而 CSS 的 y 向下，所以这里取负。
    y: -dot(entry.unit, basis.up),
    depth: dot(entry.unit, basis.back),
  })).sort((a, b) => a.depth - b.depth);
}
